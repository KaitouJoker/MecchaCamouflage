function reportUiStartupFailure(kind, value) {
  try {
    const message = value instanceof Error ? value.message : String(value ?? "unknown JavaScript error");
    window.chrome?.webview?.postMessage({
      type: "uiStartupFailure",
      kind,
      message: message.slice(0, 2000)
    });
  } catch {
    // A broken WebView bridge must not turn error reporting into another page error.
  }
}

window.addEventListener("error", event => {
  const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
  reportUiStartupFailure("error", `${event.message || "JavaScript error"}${location}`);
});

window.addEventListener("unhandledrejection", event => {
  reportUiStartupFailure("unhandledrejection", event.reason);
});

const pending = new Map();
const hotkeyKeys = [
  "app.startHotkey",
  "app.previewHotkey",
  "app.unpreviewHotkey",
  "app.stopHotkey"
];

let liveSnapshot = null;
let draftSnapshot = null;
let editing = false;
let activeLogFilter = "all";
let recordingHotkey = null;
let lastRenderedLogValue = null;
const hostedWebView = window.chrome?.webview || null;
const webview = hostedWebView || {
  addEventListener: () => {},
  postMessage: () => {}
};
const imagePickerMaximumBytes = 20 * 1024 * 1024;
const imagePickerMaximumEdge = 8192;
const imageDesignDatabaseName = "MecchaCamouflageImageDesigns";
const imageDesignStoreName = "designs";
const imagePickerState = {
  images: [],
  imageCount: 1,
  mirrorMode: "none",
  placement: "fit",
  alphaMode: "background",
  backgroundColor: "#BCBCBC",
  wrapMode: "meet",
  layers: [
    { centerX: 0.125, centerY: 0.5, width: 0.5, height: 1 },
    { centerX: 0.625, centerY: 0.5, width: 0.5, height: 1 }
  ],
  selectedLayer: 0
};

const imagePaintMapWidth = 512;
const imagePaintMapHeight = 128;
let imagePaintArmGeneration = 0;
let imagePaintArmTimer = null;
let imageEditorDrag = null;
let imageDesignDatabasePromise = null;
let selectedImageDesignId = "";
let cropEditorState = null;

webview.addEventListener("message", event => {
  const message = event.data;
  if (message.type === "response") {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.ok ? entry.resolve(message.data) : entry.reject(message.data);
    }
    return;
  }
  if (message.type === "event" && message.name === "snapshotChanged") {
    liveSnapshot = message.data;
    render();
    return;
  }
  if (message.type === "event" && message.name === "toast") {
    toast(message.data.message, message.data.level || "success");
  }
});

function send(command, payload = {}) {
  const id = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  webview.postMessage({ id, command, payload });
  return promise;
}

function byId(id) {
  return document.getElementById(id);
}

function text(id, value) {
  byId(id).textContent = value;
}

function setValue(id, next) {
  const element = byId(id);
  if (document.activeElement !== element) {
    element.value = next;
  }
}

function setChecked(id, next) {
  byId(id).checked = Boolean(next);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function imagePickerFileAllowed(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return type === "image/png" || type === "image/jpeg" ||
    name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg");
}

function imageDimensions(objectUrl) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => reject(new Error("That image could not be decoded."));
    probe.src = objectUrl;
  });
}

function revokeImageSource(source) {
  if (String(source || "").startsWith("blob:")) {
    URL.revokeObjectURL(source);
  }
}

function imageAt(slot) {
  return imagePickerState.images[slot] || null;
}

function imageSource(slot) {
  return imageAt(slot)?.objectUrl || null;
}

async function selectImagePickerFile(file, slot = 0, armAfter = true) {
  if (!file) {
    return;
  }
  if (!imagePickerFileAllowed(file)) {
    throw new Error("Choose a PNG, JPG, or JPEG image.");
  }
  if (file.size <= 0 || file.size > imagePickerMaximumBytes) {
    throw new Error("Choose an image smaller than 20 MB.");
  }

  const nextUrl = URL.createObjectURL(file);
  try {
    const dimensions = await imageDimensions(nextUrl);
    if (dimensions.width <= 0 || dimensions.height <= 0 ||
        dimensions.width > imagePickerMaximumEdge || dimensions.height > imagePickerMaximumEdge) {
      throw new Error("Choose an image no larger than 8192 x 8192 pixels.");
    }
    const existing = imageAt(slot);
    if (existing) {
      revokeImageSource(existing.objectUrl);
    }
    imagePickerState.images[slot] = {
      objectUrl: nextUrl,
      fileBlob: file,
      fileName: file.name,
      width: dimensions.width,
      height: dimensions.height,
      crop: null
    };
    if (!imagePickerState.layers[slot]) {
      resetImageLayerTransform(slot);
    }
    imagePickerState.selectedLayer = slot;
    renderImagePicker();
    if (armAfter) {
      await armImagePaint();
    }
  } catch (error) {
    revokeImageSource(nextUrl);
    throw error;
  }
}

async function addImagePickerFiles(files) {
  const allowedFiles = Array.from(files || []);
  if (allowedFiles.length === 0) {
    return;
  }
  for (const file of allowedFiles) {
    await selectImagePickerFile(file, imagePickerState.images.length, false);
  }
  renderImagePicker();
  await armImagePaint();
}

async function clearImagePicker(slot = 0) {
  imagePaintArmGeneration += 1;
  clearTimeout(imagePaintArmTimer);
  const existing = imageAt(slot);
  if (existing) {
    revokeImageSource(existing.objectUrl);
  }
  imagePickerState.images.splice(slot, 1);
  imagePickerState.layers.splice(slot, 1);
  imagePickerState.selectedLayer = Math.max(0, Math.min(imagePickerState.selectedLayer, imagePickerState.images.length - 1));
  byId("image-picker-input").value = "";
  byId("image-picker-input-2").value = "";
  renderImagePicker();
  if (!imageSource(0)) {
    await send("setImagePaint", { enabled: false });
  } else {
    await armImagePaint();
  }
}

async function clearAddedImagePickerFiles() {
  for (const image of imagePickerState.images.slice(1)) {
    revokeImageSource(image.objectUrl);
  }
  imagePickerState.images.splice(1);
  imagePickerState.layers.splice(1);
  imagePickerState.selectedLayer = 0;
  byId("image-picker-input-2").value = "";
  renderImagePicker();
  if (imageSource(0)) {
    await armImagePaint();
  }
}

function scheduleImagePaintArm(delay = 150) {
  clearTimeout(imagePaintArmTimer);
  imagePaintArmTimer = setTimeout(() => {
    imagePaintArmTimer = null;
    armImagePaint().catch(error => showError(error.message || String(error)));
  }, delay);
}

function hexByte(value) {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function defaultImageLayerTransform(slot) {
  const width = imagePickerState.wrapMode === "base" ? 0.25 :
    imagePickerState.wrapMode === "meet" ? 0.5 : 1;
  if (slot === 0) {
    return { centerX: imagePickerState.wrapMode === "full" ? 0.5 : 0.125, centerY: 0.5, width, height: 1 };
  }
  return {
    centerX: (0.125 + 0.25 * slot) % 1,
    centerY: 0.5,
    width: imagePickerState.wrapMode === "base" ? 0.25 : 0.5,
    height: 1
  };
}

function resetImageLayerTransform(slot) {
  imagePickerState.layers[slot] = defaultImageLayerTransform(slot);
}

function resetImageLayerTransforms() {
  const layerCount = Math.max(1, imagePickerState.images.length, imagePickerState.mirrorMode === "mirror" ? 2 : 1);
  imagePickerState.layers = Array.from({ length: layerCount }, (_, slot) => defaultImageLayerTransform(slot));
  syncMirroredLayer();
}

function syncMirroredLayer() {
  if (imagePickerState.mirrorMode !== "mirror") {
    return;
  }
  const source = imagePickerState.layers[0];
  const mirroredCenterX = imagePickerState.wrapMode === "meet"
    ? (0.75 - source.centerX + 1) % 1
    : (source.centerX + 0.5) % 1;
  imagePickerState.layers[1] = {
    centerX: mirroredCenterX,
    centerY: source.centerY,
    width: source.width,
    height: source.height
  };
}

function clampImageLayer(layer) {
  layer.width = Math.max(0.1, Math.min(2, layer.width));
  layer.height = Math.max(0.1, Math.min(2, layer.height));
  layer.centerX = (layer.centerX % 1 + 1) % 1;
  layer.centerY = Math.max(-0.5, Math.min(1.5, layer.centerY));
}

function loadedImage(slot) {
  const container = byId("image-picker-sources");
  let image = byId(`image-picker-source-${slot}`);
  if (!image) {
    image = document.createElement("img");
    image.id = `image-picker-source-${slot}`;
    image.alt = `Source image ${slot + 1}`;
    container.append(image);
  }
  image.dataset.imageSlot = String(slot);
  const source = imageSource(slot);
  if (source && image.src !== source) {
    image.src = source;
  }
  return image;
}

function defaultCropForSlot(slot) {
  const image = imageAt(slot);
  const layer = imagePickerState.layers[slot] || defaultImageLayerTransform(slot);
  if (!image?.width || !image?.height) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const sourceAspect = image.width / image.height;
  const targetAspect = (Math.max(0.01, layer.width) * imagePaintMapWidth) /
    (Math.max(0.01, layer.height) * imagePaintMapHeight);
  if (sourceAspect > targetAspect) {
    const width = targetAspect / sourceAspect;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }
  const height = sourceAspect / targetAspect;
  return { x: 0, y: (1 - height) / 2, width: 1, height };
}

function renderCropEditorSelection() {
  if (!cropEditorState) {
    return;
  }
  const selection = byId("crop-editor-selection");
  const crop = cropEditorState.draft;
  selection.style.left = `${crop.x * 100}%`;
  selection.style.top = `${crop.y * 100}%`;
  selection.style.width = `${crop.width * 100}%`;
  selection.style.height = `${crop.height * 100}%`;
}

function openCropEditor(slot = 0) {
  const image = imageAt(slot);
  if (!image) {
    return;
  }
  const base = defaultCropForSlot(slot);
  const draft = clone(image.crop || base);
  cropEditorState = { slot, base, draft, drag: null };
  byId("crop-editor-image").src = image.objectUrl;
  const zoom = Math.max(100, Math.min(400, Math.round(Math.min(base.width / draft.width, base.height / draft.height) * 100)));
  byId("crop-editor-zoom").value = String(zoom);
  byId("crop-editor-dialog").hidden = false;
  renderCropEditorSelection();
}

function closeCropEditor() {
  cropEditorState = null;
  byId("crop-editor-dialog").hidden = true;
}

function beginCropEditorDrag(event) {
  if (!cropEditorState) {
    return;
  }
  const stage = byId("crop-editor-stage");
  cropEditorState.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    crop: clone(cropEditorState.draft)
  };
  byId("crop-editor-selection").setPointerCapture(event.pointerId);
}

function moveCropEditorDrag(event) {
  const drag = cropEditorState?.drag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  const bounds = byId("crop-editor-stage").getBoundingClientRect();
  const dx = (event.clientX - drag.startX) / bounds.width;
  const dy = (event.clientY - drag.startY) / bounds.height;
  cropEditorState.draft.x = Math.max(0, Math.min(1 - drag.crop.width, drag.crop.x + dx));
  cropEditorState.draft.y = Math.max(0, Math.min(1 - drag.crop.height, drag.crop.y + dy));
  renderCropEditorSelection();
}

function endCropEditorDrag(event) {
  if (cropEditorState?.drag?.pointerId === event.pointerId) {
    cropEditorState.drag = null;
  }
}

function updateCropEditorZoom(value) {
  if (!cropEditorState) {
    return;
  }
  const factor = Math.max(1, Number(value) / 100);
  const previous = cropEditorState.draft;
  const centerX = previous.x + previous.width / 2;
  const centerY = previous.y + previous.height / 2;
  const width = cropEditorState.base.width / factor;
  const height = cropEditorState.base.height / factor;
  cropEditorState.draft = {
    x: Math.max(0, Math.min(1 - width, centerX - width / 2)),
    y: Math.max(0, Math.min(1 - height, centerY - height / 2)),
    width,
    height
  };
  renderCropEditorSelection();
}

async function waitForLoadedImage(slot) {
  const image = loadedImage(slot);
  if (image.complete && image.naturalWidth) {
    return image;
  }
  await new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", () => reject(new Error("The image preview could not be prepared.")), { once: true });
  });
  return image;
}

function drawPlacedImage(context, source, x, y, width, height) {
  if (imagePickerState.placement === "fit") {
    const scale = Math.min(width / source.naturalWidth, height / source.naturalHeight);
    const drawWidth = source.naturalWidth * scale;
    const drawHeight = source.naturalHeight * scale;
    context.drawImage(source, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
    return;
  }
  const crop = imageAt(Number(source.dataset.imageSlot))?.crop || defaultCropForSlot(Number(source.dataset.imageSlot));
  const sourceX = crop.x * source.naturalWidth;
  const sourceY = crop.y * source.naturalHeight;
  const sourceWidth = crop.width * source.naturalWidth;
  const sourceHeight = crop.height * source.naturalHeight;
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function imageLayersForPaint() {
  const first = { slot: 0, ...imagePickerState.layers[0] };
  if (imagePickerState.wrapMode === "full") {
    return [first];
  }
  if (imagePickerState.imageCount === 2) {
    return imagePickerState.images.map((_, slot) => ({ slot, ...imagePickerState.layers[slot] }));
  }
  if (imagePickerState.mirrorMode === "mirror") {
    const mirrored = {
      centerX: imagePickerState.wrapMode === "meet"
        ? (0.75 - first.centerX + 1) % 1
        : (first.centerX + 0.5) % 1,
      centerY: first.centerY,
      width: first.width,
      height: first.height
    };
    return [first, { slot: 0, mirrored: true, ...mirrored }];
  }
  return [first];
}

function drawWrappedLayer(context, source, layer) {
  const width = Math.max(16, layer.width * imagePaintMapWidth);
  const height = Math.max(16, layer.height * imagePaintMapHeight);
  const centerX = layer.centerX * imagePaintMapWidth;
  const centerY = layer.centerY * imagePaintMapHeight;
  for (const offset of [-imagePaintMapWidth, 0, imagePaintMapWidth]) {
    const x = centerX - width / 2 + offset;
    const y = centerY - height / 2;
    if (layer.mirrored) {
      context.save();
      context.translate(x + width, y);
      context.scale(-1, 1);
      drawPlacedImage(context, source, 0, 0, width, height);
      context.restore();
    } else {
      drawPlacedImage(context, source, x, y, width, height);
    }
  }
}

function buildWrapAtlas() {
  const canvas = document.createElement("canvas");
  canvas.width = imagePaintMapWidth;
  canvas.height = imagePaintMapHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (imagePickerState.alphaMode === "background") {
    context.fillStyle = imagePickerState.backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  for (const layer of imageLayersForPaint()) {
    const source = loadedImage(layer.slot);
    if (source.complete && source.naturalWidth) {
      drawWrappedLayer(context, source, layer);
    }
  }
  return canvas;
}

function traceBody(context, panel, sideView) {
  const x = panel * 128;
  const center = x + 64;
  const bodyWidth = sideView ? 38 : 66;
  context.arc(center, 59, sideView ? 20 : 25, 0, Math.PI * 2);
  context.roundRect(center - bodyWidth / 2, 80, bodyWidth, 79, 24);
  context.roundRect(center - bodyWidth / 2 - (sideView ? 8 : 18), 84, sideView ? 11 : 18, 70, 9);
  context.roundRect(center + bodyWidth / 2 + (sideView ? -3 : 0), 84, sideView ? 11 : 18, 70, 9);
  context.roundRect(center - bodyWidth / 2 + 4, 145, bodyWidth / 2 - 5, 65, 10);
  context.roundRect(center + 1, 145, bodyWidth / 2 - 5, 65, 10);
}

function visibleEditorHandle(x, y) {
  return {
    x: Math.max(5, Math.min(507, x)),
    y: Math.max(33, Math.min(215, y))
  };
}

function renderWrapEditor() {
  const canvas = byId("image-wrap-editor");
  if (!canvas || !imageSource(0)) {
    return;
  }
  const context = canvas.getContext("2d");
  const atlas = buildWrapAtlas();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#141414";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const labels = ["FRONT", "RIGHT", "BACK", "LEFT"];
  for (let panel = 0; panel < 4; panel += 1) {
    const panelX = panel * 128;
    context.save();
    context.beginPath();
    traceBody(context, panel, panel === 1 || panel === 3);
    context.clip();
    context.fillStyle = "#BCBCBC";
    context.fillRect(panelX, 28, 128, 192);
    context.drawImage(atlas, panelX, 0, 128, 128, panelX, 28, 128, 192);
    context.restore();
    context.strokeStyle = "rgba(255,255,255,0.18)";
    context.strokeRect(panelX + 0.5, 27.5, 127, 192);
    context.fillStyle = "#d8d8d8";
    context.font = "700 11px sans-serif";
    context.textAlign = "center";
    context.fillText(labels[panel], panelX + 64, 16);
  }
  const selected = imagePickerState.layers[imagePickerState.selectedLayer];
  if (selected) {
    const rectWidth = selected.width * 512;
    const rectHeight = selected.height * 192;
    const rectY = 28 + (selected.centerY - selected.height / 2) * 192;
    for (const offset of [-512, 0, 512]) {
      const rectX = (selected.centerX - selected.width / 2) * 512 + offset;
      context.fillStyle = "#d8d8d8";
      for (const rawHandle of [
        [rectX, rectY],
        [rectX + rectWidth, rectY],
        [rectX, rectY + rectHeight],
        [rectX + rectWidth, rectY + rectHeight]
      ]) {
        const handle = visibleEditorHandle(rawHandle[0], rawHandle[1]);
        context.fillRect(handle.x - 5, handle.y - 5, 10, 10);
      }
    }
  }
}

function editorPoint(event) {
  const canvas = byId("image-wrap-editor");
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height
  };
}

function editorLayerHit(point) {
  const layerIndexes = imagePickerState.imageCount === 2
    ? imagePickerState.images.map((_, index) => index).reverse()
    : [0];
  for (const layerIndex of layerIndexes) {
    const layer = imagePickerState.layers[layerIndex];
    const width = layer.width * 512;
    const height = layer.height * 192;
    const y = 28 + (layer.centerY - layer.height / 2) * 192;
    for (const offset of [-512, 0, 512]) {
      const x = (layer.centerX - layer.width / 2) * 512 + offset;
      const handles = [
        { name: "top-left", ...visibleEditorHandle(x, y) },
        { name: "top-right", ...visibleEditorHandle(x + width, y) },
        { name: "bottom-left", ...visibleEditorHandle(x, y + height) },
        { name: "bottom-right", ...visibleEditorHandle(x + width, y + height) }
      ];
      const handle = handles.find(candidate => Math.abs(point.x - candidate.x) <= 12 && Math.abs(point.y - candidate.y) <= 12);
      if (handle || (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height)) {
        return {
          layerIndex,
          mode: handle ? "resize" : "move",
          handle: handle?.name || null,
          rect: { left: x, top: y, right: x + width, bottom: y + height }
        };
      }
    }
  }
  return null;
}

function beginImageEditorDrag(event) {
  if (!imageSource(0)) {
    return;
  }
  const point = editorPoint(event);
  const hit = editorLayerHit(point);
  if (!hit) {
    return;
  }
  const layer = imagePickerState.layers[hit.layerIndex];
  imagePickerState.selectedLayer = hit.layerIndex;
  imageEditorDrag = { pointerId: event.pointerId, start: point, mode: hit.mode, handle: hit.handle, rect: hit.rect, layer: { ...layer } };
  byId("image-wrap-editor").setPointerCapture(event.pointerId);
  renderWrapEditor();
}

function moveImageEditorDrag(event) {
  if (!imageEditorDrag || event.pointerId !== imageEditorDrag.pointerId) {
    return;
  }
  const point = editorPoint(event);
  const dx = (point.x - imageEditorDrag.start.x) / 512;
  const dy = (point.y - imageEditorDrag.start.y) / 192;
  const layer = imagePickerState.layers[imagePickerState.selectedLayer];
  if (imageEditorDrag.mode === "move") {
    layer.centerX = (imageEditorDrag.layer.centerX + dx + 1) % 1;
    layer.centerY = imageEditorDrag.layer.centerY + dy;
    clampImageLayer(layer);
  } else {
    const minimumSize = 24;
    let { left, top, right, bottom } = imageEditorDrag.rect;
    if (imageEditorDrag.handle.includes("left")) {
      left = Math.min(point.x, right - minimumSize);
    } else {
      right = Math.max(point.x, left + minimumSize);
    }
    if (imageEditorDrag.handle.includes("top")) {
      top = Math.max(28, Math.min(point.y, bottom - minimumSize));
    } else {
      bottom = Math.min(220, Math.max(point.y, top + minimumSize));
    }
    layer.width = (right - left) / 512;
    layer.height = (bottom - top) / 192;
    layer.centerX = ((left + right) / 2) / 512;
    layer.centerY = ((top + bottom) / 2 - 28) / 192;
    clampImageLayer(layer);
  }
  syncMirroredLayer();
  renderWrapEditor();
}

function endImageEditorDrag(event) {
  if (!imageEditorDrag || event.pointerId !== imageEditorDrag.pointerId) {
    return;
  }
  imageEditorDrag = null;
  scheduleImagePaintArm(50);
}

function imageDropSlot(explicitSlot) {
  if (explicitSlot !== null) {
    return explicitSlot;
  }
  return imagePickerState.imageCount === 2 ? imagePickerState.images.length : 0;
}

function bindImageDropTarget(element, explicitSlot = null) {
  for (const eventName of ["dragenter", "dragover"]) {
    element.addEventListener(eventName, event => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      element.classList.add("drag-over");
    });
  }
  element.addEventListener("dragleave", event => {
    if (!element.contains(event.relatedTarget)) {
      element.classList.remove("drag-over");
    }
  });
  element.addEventListener("drop", event => {
    event.preventDefault();
    element.classList.remove("drag-over");
    const files = event.dataTransfer?.files || [];
    if (imagePickerState.imageCount === 2 && explicitSlot !== 0) {
      addImagePickerFiles(files).catch(error => showError(error.message || String(error)));
    } else {
      selectImagePickerFile(files[0], imageDropSlot(explicitSlot)).catch(error => showError(error.message || String(error)));
    }
  });
}

function openImageDesignDatabase() {
  if (imageDesignDatabasePromise) {
    return imageDesignDatabasePromise;
  }
  imageDesignDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(imageDesignDatabaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(imageDesignStoreName)) {
        database.createObjectStore(imageDesignStoreName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Saved designs could not be opened."));
  });
  return imageDesignDatabasePromise;
}

function imageDesignRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("The saved design operation failed."));
  });
}

async function readSavedImageDesigns() {
  const database = await openImageDesignDatabase();
  const transaction = database.transaction(imageDesignStoreName, "readonly");
  const records = await imageDesignRequest(transaction.objectStore(imageDesignStoreName).getAll());
  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

async function refreshSavedImageDesigns(preferredId = selectedImageDesignId) {
  const select = byId("image-design-list");
  const records = await readSavedImageDesigns();
  select.replaceChildren();
  if (records.length === 0) {
    select.add(new Option("No saved designs", ""));
    selectedImageDesignId = "";
  } else {
    for (const record of records) {
      select.add(new Option(record.name, record.id));
    }
    const exists = records.some(record => record.id === preferredId);
    selectedImageDesignId = exists ? preferredId : records[0].id;
    select.value = selectedImageDesignId;
  }
  const hasSelection = Boolean(selectedImageDesignId);
  byId("image-design-load").disabled = !hasSelection;
  byId("image-design-delete").disabled = !hasSelection;
}

function currentImageDesignRecord(name) {
  const activeImages = imagePickerState.imageCount === 1
    ? imagePickerState.images.slice(0, 1)
    : imagePickerState.images;
  return {
    id: selectedImageDesignId || crypto.randomUUID(),
    name,
    updatedAt: new Date().toISOString(),
    images: activeImages.map(image => ({
      blob: image.fileBlob,
      fileName: image.fileName,
      width: image.width,
      height: image.height,
      crop: image.crop ? clone(image.crop) : null
    })),
    layout: {
      imageCount: imagePickerState.imageCount,
      mirrorMode: imagePickerState.mirrorMode,
      placement: imagePickerState.placement,
      alphaMode: imagePickerState.alphaMode,
      backgroundColor: imagePickerState.backgroundColor,
      wrapMode: imagePickerState.wrapMode,
      layers: clone(imagePickerState.layers)
    }
  };
}

async function saveCurrentImageDesign() {
  if (!imageAt(0)?.fileBlob) {
    throw new Error("Choose an image before saving a design.");
  }
  const fallbackName = imageAt(0).fileName.replace(/\.[^.]+$/, "") || "Untitled design";
  const name = byId("image-design-name").value.trim() || fallbackName;
  const record = currentImageDesignRecord(name);
  const database = await openImageDesignDatabase();
  const transaction = database.transaction(imageDesignStoreName, "readwrite");
  await imageDesignRequest(transaction.objectStore(imageDesignStoreName).put(record));
  selectedImageDesignId = record.id;
  byId("image-design-name").value = name;
  await refreshSavedImageDesigns(record.id);
  toast("Design saved with its images and layout.");
}

function restoreImageDesignSource(slot, savedImage) {
  if (!savedImage?.blob) {
    return;
  }
  imagePickerState.images[slot] = {
    objectUrl: URL.createObjectURL(savedImage.blob),
    fileBlob: savedImage.blob,
    fileName: savedImage.fileName || `Image ${slot + 1}`,
    width: Number(savedImage.width || 0),
    height: Number(savedImage.height || 0),
    crop: savedImage.crop &&
      Number.isFinite(savedImage.crop.x) && Number.isFinite(savedImage.crop.y) &&
      Number.isFinite(savedImage.crop.width) && Number.isFinite(savedImage.crop.height)
      ? clone(savedImage.crop)
      : null
  };
}

async function loadSelectedImageDesign() {
  const id = byId("image-design-list").value;
  if (!id) {
    return;
  }
  const database = await openImageDesignDatabase();
  const transaction = database.transaction(imageDesignStoreName, "readonly");
  const record = await imageDesignRequest(transaction.objectStore(imageDesignStoreName).get(id));
  const savedImages = Array.isArray(record?.images)
    ? record.images
    : [record?.image1, record?.image2].filter(Boolean);
  if (!savedImages[0]?.blob) {
    throw new Error("That saved design is missing its first image.");
  }
  for (const image of imagePickerState.images) {
    revokeImageSource(image.objectUrl);
  }
  imagePickerState.images = [];
  savedImages.forEach((image, slot) => restoreImageDesignSource(slot, image));
  const layout = record.layout || {};
  imagePickerState.imageCount = layout.imageCount === 2 ? 2 : 1;
  imagePickerState.mirrorMode = layout.mirrorMode === "mirror" ? "mirror" : "none";
  imagePickerState.placement = layout.placement === "crop" ? "crop" : "fit";
  imagePickerState.alphaMode = layout.alphaMode === "skip" ? "skip" : "background";
  imagePickerState.backgroundColor = /^#[0-9a-f]{6}$/i.test(layout.backgroundColor || "") ? layout.backgroundColor : "#BCBCBC";
  imagePickerState.wrapMode = ["base", "meet", "full"].includes(layout.wrapMode) ? layout.wrapMode : "meet";
  if (imagePickerState.imageCount === 2) {
    imagePickerState.wrapMode = "base";
    imagePickerState.mirrorMode = "none";
  }
  imagePickerState.layers = Array.isArray(layout.layers) && layout.layers.length >= savedImages.length
    ? clone(layout.layers)
    : savedImages.map((_, slot) => defaultImageLayerTransform(slot));
  imagePickerState.selectedLayer = 0;
  syncMirroredLayer();
  selectedImageDesignId = record.id;
  byId("image-design-name").value = record.name;
  renderImagePicker();
  await armImagePaint();
  toast(`Loaded ${record.name}.`);
}

async function deleteSelectedImageDesign() {
  const id = byId("image-design-list").value;
  if (!id) {
    return;
  }
  const database = await openImageDesignDatabase();
  const transaction = database.transaction(imageDesignStoreName, "readwrite");
  await imageDesignRequest(transaction.objectStore(imageDesignStoreName).delete(id));
  selectedImageDesignId = "";
  byId("image-design-name").value = "";
  await refreshSavedImageDesigns();
  toast("Saved design deleted.");
}

async function armImagePaint() {
  if (!imageSource(0)) {
    return;
  }
  const generation = ++imagePaintArmGeneration;
  const placement = imagePickerState.placement;
  const alphaMode = imagePickerState.alphaMode;
  const backgroundColor = imagePickerState.backgroundColor;
  const wrapMode = imagePickerState.wrapMode;
  const fileName = imageAt(0).fileName;
  for (let slot = 0; slot < imagePickerState.images.length; slot += 1) {
    await waitForLoadedImage(slot);
  }
  renderWrapEditor();
  const canvas = buildWrapAtlas();
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = context.getImageData(0, 0, imagePaintMapWidth, imagePaintMapHeight).data;
  let rgbaHex = "";
  for (let index = 0; index < rgba.length; index += 1) {
    rgbaHex += hexByte(rgba[index]);
  }
  if (generation !== imagePaintArmGeneration) {
    return;
  }
  const result = await send("setImagePaint", {
    enabled: true,
    width: imagePaintMapWidth,
    height: imagePaintMapHeight,
    rgbaHex,
    alphaMode,
    backgroundColor,
    placement,
    wrapMode,
    bodyType: "round",
    fileName
  });
  if (generation !== imagePaintArmGeneration) {
    return;
  }
  if (!result?.success) {
    throw new Error(result?.message || "The image could not be armed for painting.");
  }
  byId("image-picker-metadata").textContent = `${imagePickerState.images.length} image${imagePickerState.images.length === 1 ? "" : "s"} - ready for F1`;
}

function renderImageLayerList() {
  const list = byId("image-layer-list");
  list.replaceChildren();
  imagePickerState.images.forEach((image, slot) => {
    const row = document.createElement("div");
    row.className = "image-layer-item";
    const select = document.createElement("button");
    select.type = "button";
    select.className = `image-layer-select${slot === imagePickerState.selectedLayer ? " active" : ""}`;
    select.dataset.imageLayerIndex = String(slot);
    select.textContent = `${slot + 1}. ${image.fileName}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.removeImageLayer = String(slot);
    remove.textContent = "Remove";
    remove.disabled = imagePickerState.images.length === 1;
    row.append(select, remove);
    list.append(row);
  });
}

function renderImagePicker() {
  const hasImage = Boolean(imageSource(0));
  const preview = byId("image-picker-preview");
  const backgroundMode = imagePickerState.alphaMode === "background";

  byId("image-picker-empty").hidden = hasImage;
  byId("image-picker-clear").disabled = !hasImage;
  byId("image-picker-reset-placement").disabled = !hasImage;
  byId("image-picker-filename").textContent = hasImage ? imageAt(0).fileName : "No image selected";
  byId("image-picker-choose").innerHTML = imagePickerState.imageCount === 1
    ? "Choose image <span>(or drop)</span>"
    : "Choose image 1 <span>(or drop)</span>";
  byId("image-picker-metadata").textContent = hasImage
    ? `${imagePickerState.images.length} image${imagePickerState.images.length === 1 ? "" : "s"} - preparing paint...`
    : "";
  imagePickerState.images.forEach((_, slot) => loadedImage(slot));
  const hasAdded = imagePickerState.images.length > 1;
  byId("image-picker-actions-2").hidden = imagePickerState.imageCount !== 2;
  byId("image-picker-mirror-row").hidden = imagePickerState.imageCount !== 1;
  byId("image-picker-placement-row").hidden = imagePickerState.imageCount === 2;
  byId("image-picker-wrap-row").hidden = imagePickerState.imageCount === 2;
  byId("image-layer-snap-row").hidden = imagePickerState.imageCount !== 2;
  byId("image-picker-clear-2").disabled = !hasAdded;
  byId("image-picker-filename-2").textContent = hasAdded
    ? `${imagePickerState.images.length} images in this design`
    : "Add as many images as you want";
  renderImageLayerList();
  byId("image-wrap-editor").hidden = !hasImage;

  preview.classList.toggle("crop", imagePickerState.placement === "crop");
  preview.classList.toggle("checkerboard", !backgroundMode);
  preview.style.backgroundColor = backgroundMode ? imagePickerState.backgroundColor : "";
  for (const button of document.querySelectorAll("[data-image-placement]")) {
    const active = button.dataset.imagePlacement === imagePickerState.placement;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const button of document.querySelectorAll("[data-alpha-mode]")) {
    const active = button.dataset.alphaMode === imagePickerState.alphaMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const button of document.querySelectorAll("[data-wrap-mode]")) {
    const active = button.dataset.wrapMode === imagePickerState.wrapMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const multipleImages = imagePickerState.imageCount === 2;
  const meetWrapButton = document.querySelector('[data-wrap-mode="meet"]');
  meetWrapButton.disabled = multipleImages;
  meetWrapButton.title = multipleImages ? "Multiple images use independent Base sides placement." : "";
  const fullWrapUnavailable = multipleImages || imagePickerState.mirrorMode === "mirror";
  const fullWrapButton = document.querySelector('[data-wrap-mode="full"]');
  fullWrapButton.disabled = fullWrapUnavailable;
  fullWrapButton.title = fullWrapUnavailable ? "Full wrap needs one unmirrored image." : "";
  for (const button of document.querySelectorAll("[data-mirror-mode]")) {
    const active = button.dataset.mirrorMode === imagePickerState.mirrorMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const button of document.querySelectorAll("[data-image-count]")) {
    const active = Number(button.dataset.imageCount) === imagePickerState.imageCount;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const backgroundInput = byId("image-picker-background");
  backgroundInput.disabled = !backgroundMode;
  backgroundInput.value = imagePickerState.backgroundColor;
  byId("image-picker-background-row").classList.toggle("disabled", !backgroundMode);
  const wrapLabel = multipleImages
    ? "Multiple layers • Manual placement"
    : { base: "Base sides", meet: "Meet at sides", full: "Full wrap" }[imagePickerState.wrapMode];
  const alphaLabel = backgroundMode
    ? `Background ${imagePickerState.backgroundColor.toUpperCase()}`
    : "Transparent areas unpainted";
  byId("image-editor-mode-summary").textContent = multipleImages
    ? `${wrapLabel} • ${alphaLabel}`
    : `${wrapLabel} • ${imagePickerState.placement === "crop" ? "Crop" : "Fit"} • ${alphaLabel}`;
  byId("image-design-save").disabled = !hasImage;
  renderWrapEditor();
}

function fmt(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function activeLocale() {
  return currentSnapshot()?.language || liveSnapshot?.language || "en";
}

function translationsFor(locale) {
  const translations = liveSnapshot?.translations || {};
  return translations[locale] || translations.en || {};
}

function i18n(key, ...args) {
  const locale = activeLocale();
  const local = translationsFor(locale);
  const english = translationsFor("en");
  let value = local[key] || english[key] || key;
  args.forEach((arg, index) => {
    value = value.replaceAll(`{${index}}`, arg);
  });
  return value;
}

function applyI18n() {
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = i18n(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", i18n(element.dataset.i18nAriaLabel));
  }
  document.title = i18n("app.title");
}

function currentSnapshot() {
  return editing && draftSnapshot ? draftSnapshot : liveSnapshot;
}

function render() {
  if (!liveSnapshot) {
    return;
  }
  applyI18n();
  renderRuntime(liveSnapshot);
  renderSettings(currentSnapshot());
  applyI18n();
  renderEditState();
}

function renderRuntime(snapshot) {
  const runtime = snapshot.runtime;
  setStatus("footer-process", runtime.process);
  setStatus("footer-bridge", runtime.bridge);
  text("version", snapshot.version);
  renderLogs(runtime);
}

function renderLogs(runtime) {
  const logs = runtime.logs || "";
  const value = logs.trim().length > 0 ? logs : "";
  if (activeLogFilter === "all") {
    const progressLine = buildProgressLine(runtime);
    setLogHtml([value, progressLine].filter(Boolean).join("\n"));
    return;
  }
  const token = `[${activeLogFilter.toUpperCase()}]`;
  const filtered = value
    .split(/\r?\n/)
    .filter(line => line.toUpperCase().includes(token))
    .join("\n");
  setLogHtml(filtered);
}

function buildProgressLine(runtime) {
  if (!runtime.progressVisible) {
    return "";
  }
  const percent = Math.max(0, Math.min(100, Math.round(runtime.progressPercent)));
  const passStage = runtime.paintProgressSource === "native_queue_backpressure"
    ? "painting"
    : runtime.paintProgressSource === "submission"
      ? "queueing"
      : "";
  const pass = [passStage, runtime.paintPass, runtime.paintPassProgress]
    .filter(value => value && value !== "-")
    .join(" ");
  const detail = [
    `pass ${pass || "-"}`,
    `pass ETA ${runtime.paintPassEta || "-"}`,
    `total ETA ${runtime.paintEta || "-"}`,
    `elapsed ${runtime.paintElapsed || "-"}`
  ].join(" | ");
  return `${logPrefix("INFO")} Paint: overall ${percent}% ${progressBar(percent)} | ${detail}`;
}

function progressBar(percent) {
  const width = 16;
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function logPrefix(level) {
  const now = new Date();
  const part = value => String(value).padStart(2, "0");
  return `${part(now.getHours())}:${part(now.getMinutes())}:${part(now.getSeconds())} [${level}]`;
}

function setLogHtml(value) {
  const logs = byId("logs");
  if (value === lastRenderedLogValue) {
    return;
  }
  const stickToBottom = lastRenderedLogValue === null || (logs.scrollHeight - logs.scrollTop - logs.clientHeight) < 24;
  lastRenderedLogValue = value;
  const lines = String(value).split(/\r?\n/);
  if (lines[lines.length - 1].length > 0) {
    lines.push("");
  }
  logs.innerHTML = lines
    .map(line => `<span class="${logLineClass(line)}">&gt; ${escapeHtml(line)}</span>`)
    .join("\n");
  if (stickToBottom) {
    requestAnimationFrame(() => {
      logs.scrollTop = logs.scrollHeight;
    });
  }
}

function logLineClass(line) {
  const upper = line.toUpperCase();
  if ((upper.startsWith("PAINT: ") || /\[INFO\]\s+PAINT:\s+\d+%/.test(upper)) && upper.includes("% [")) {
    return "log-line progress";
  }
  if (upper.includes("[ERROR]")) {
    return "log-line error";
  }
  if (upper.includes("[WARN]")) {
    return "log-line warn";
  }
  return "log-line";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(id, value) {
  const element = byId(id);
  element.textContent = localizedStatus(value);
  element.className = `status-token ${statusClass(value)}`;
}

function localizedStatus(value) {
  const normalized = String(value || "").toLowerCase();
  return i18n(`state.${normalized}`);
}

function statusClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (["attached", "connected", "ready", "running", "complete", "ok"].includes(normalized)) {
    return "ok";
  }
  if (["waiting", "starting", "pending"].includes(normalized)) {
    return "wait";
  }
  if (["failed", "error", "cancelled"].includes(normalized)) {
    return "bad";
  }
  return "idle";
}

function renderSettings(snapshot) {
  const paint = snapshot.settings.paint;
  setNumberPair("brush-size", "brush-size-number", paint.brushSizeTexels);
  setNumberPair("color-compression-tolerance", "color-compression-tolerance-number", paint.colorCompressionTolerance);
  setChecked("auto-material", paint.autoMaterial);
  setNumberPair("metallic", "metallic-number", paint.metallic);
  setNumberPair("roughness", "roughness-number", paint.roughness);
  setNumberPair("emissive", "emissive-number", paint.emissive);
  renderRegionButtons(document.querySelector('[data-region="paint.frontRegionMode"]'), "paint.frontRegionMode", paint.frontRegionMode);
  renderRegionButtons(document.querySelector('[data-region="paint.sideRegionMode"]'), "paint.sideRegionMode", paint.sideRegionMode);
  renderRegionButtons(document.querySelector('[data-region="paint.backRegionMode"]'), "paint.backRegionMode", paint.backRegionMode);
  setColor(paint.fillColor);
  setNumberPair("fill-metallic", "fill-metallic-number", paint.fillMetallic);
  setNumberPair("fill-roughness", "fill-roughness-number", paint.fillRoughness);
  setNumberPair("fill-emissive", "fill-emissive-number", paint.fillEmissive);

  const app = snapshot.settings.app;
  applyThemeColor(app.themeColor);
  setChecked("always-on-top", app.alwaysOnTop);
  setNumberPair("opacity", "opacity-number", Math.round(app.opacity * 100));
  setColorPair("theme-color-picker", "theme-color", app.themeColor);
  setValue("start-hotkey", app.startHotkey);
  setValue("preview-hotkey", app.previewHotkey);
  setValue("unpreview-hotkey", app.unPreviewHotkey);
  setValue("stop-hotkey", app.stopHotkey);

  const language = byId("language");
  if (language.options.length === 0) {
    for (const locale of liveSnapshot.locales) {
      const option = document.createElement("option");
      option.value = locale.code;
      option.textContent = locale.nativeName;
      language.append(option);
    }
  }
  setValue("language", snapshot.language);

  for (const control of document.querySelectorAll(".setting-control")) {
    setControlDisabled(control, !editing);
  }
  for (const button of document.querySelectorAll(".record-hotkey")) {
    button.disabled = !editing;
  }

  const materialLocked = paint.autoMaterial || !editing;
  setDisabled(["metallic", "metallic-number", "roughness", "roughness-number", "emissive", "emissive-number"], materialLocked);

  const fillLocked = !editing || !usesFill(paint);
  byId("fill-section").classList.toggle("disabled", !usesFill(paint));
  setDisabled([
    "fill-color-picker",
    "fill-color",
    "fill-metallic",
    "fill-metallic-number",
    "fill-roughness",
    "fill-roughness-number",
    "fill-emissive",
    "fill-emissive-number"
  ], fillLocked);
}

function setNumberPair(sliderId, numberId, value) {
  setValue(sliderId, value);
  setValue(numberId, fmt(value));
}

function setColor(value) {
  setColorPair("fill-color-picker", "fill-color", value);
}

function setColorPair(pickerId, inputId, value) {
  const color = normalizeColor(value) || "#FFFFFF";
  setValue(pickerId, color);
  setValue(inputId, color);
}

function applyThemeColor(value) {
  const color = normalizeColor(value) || "#FFFFFF";
  document.documentElement.style.setProperty("--primary", color);
}

function setDisabled(ids, disabled) {
  for (const id of ids) {
    setControlDisabled(byId(id), disabled);
  }
}

function isThemeVisibleReadOnlyControl(control) {
  return control instanceof HTMLInputElement &&
    (control.type === "range" || control.type === "checkbox");
}

function setControlDisabled(control, disabled) {
  const themeVisibleReadonly = disabled && isThemeVisibleReadOnlyControl(control);
  if (themeVisibleReadonly && document.activeElement === control) {
    control.blur();
  }
  control.disabled = disabled && !themeVisibleReadonly;
  control.classList.toggle("theme-visible-readonly", themeVisibleReadonly);
  if (themeVisibleReadonly) {
    control.setAttribute("aria-disabled", "true");
    control.tabIndex = -1;
  } else {
    control.removeAttribute("aria-disabled");
    control.removeAttribute("tabindex");
  }
}

function renderRegionButtons(container, key, current) {
  container.innerHTML = "";
  for (const mode of ["paint", "fill", "skip"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = i18n(`mode.${mode}`);
    button.className = mode === current ? "active" : "";
    button.disabled = !editing;
    button.addEventListener("click", () => {
      if (!editing) {
        return;
      }
      setDraftSetting(key, mode);
      renderSettings(draftSnapshot);
    });
    container.append(button);
  }
}

function renderEditState() {
  document.body.classList.toggle("editing", editing);
  byId("edit-settings").disabled = editing;
  byId("save-settings").disabled = !editing;
  byId("cancel-edit").disabled = !editing;
  byId("reset-settings").disabled = !editing;
}

function usesFill(paint) {
  return paint.frontRegionMode === "fill" || paint.sideRegionMode === "fill" || paint.backRegionMode === "fill";
}

function beginEdit() {
  if (!liveSnapshot) {
    return;
  }
  editing = true;
  draftSnapshot = clone(liveSnapshot);
  send("setEditing", { editing: true }).catch(error => showError(error.message || String(error)));
  render();
}

function cancelEdit() {
  editing = false;
  draftSnapshot = null;
  closeHotkeyDialog();
  send("setEditing", { editing: false }).catch(error => showError(error.message || String(error)));
  previewSavedWindow();
  render();
}

function resetDraft() {
  if (!editing || !liveSnapshot || !draftSnapshot) {
    return;
  }
  const currentProcessName = liveSnapshot.settings.app.processName;
  draftSnapshot.settings = clone(liveSnapshot.defaults);
  draftSnapshot.settings.app.processName = currentProcessName;
  draftSnapshot.language = liveSnapshot.language;
  render();
  previewDraftWindow();
}

async function saveDraft() {
  if (!editing || !liveSnapshot || !draftSnapshot) {
    return;
  }
  const changes = diffSnapshots(liveSnapshot, draftSnapshot);
  if (changes.length === 0) {
    cancelEdit();
    return;
  }
  const result = await send("updateSettings", { changes });
  if (!result.success) {
    showError(result.message || i18n("error.settings.not.saved"));
    document.activeElement?.blur();
    draftSnapshot = clone(liveSnapshot);
    previewSavedWindow();
    render();
    return;
  }
  editing = false;
  draftSnapshot = null;
  closeHotkeyDialog();
  await send("setEditing", { editing: false });
  toast(i18n("toast.settings.saved"));
  refresh().catch(error => showError(error.message || String(error)));
}

function previewSavedWindow() {
  if (!liveSnapshot) {
    return;
  }
  send("previewWindow", { opacity: liveSnapshot.settings.app.opacity }).catch(error => showError(error.message || String(error)));
  applyThemeColor(liveSnapshot.settings.app.themeColor);
}

function previewDraftWindow() {
  if (!draftSnapshot) {
    return;
  }
  send("previewWindow", { opacity: draftSnapshot.settings.app.opacity }).catch(error => showError(error.message || String(error)));
  applyThemeColor(draftSnapshot.settings.app.themeColor);
}

async function refresh() {
  liveSnapshot = await send("getSnapshot");
  render();
}

function setDraftSetting(key, value) {
  if (!draftSnapshot) {
    return;
  }
  if (key === "app.language") {
    draftSnapshot.language = value;
    return;
  }
  const path = snapshotPath(key);
  let node = draftSnapshot.settings;
  for (let index = 0; index < path.length - 1; ++index) {
    node = node[path[index]];
  }
  node[path.at(-1)] = value;
}

function canEditControl(control = null) {
  if (editing && control?.getAttribute("aria-disabled") !== "true" && !control?.disabled) {
    return true;
  }
  const snapshot = currentSnapshot();
  if (snapshot) {
    // Ranges and checkboxes stay paint-enabled solely so Chromium retains the
    // theme accent. Restore a keyboard/label-driven attempted change at once.
    renderSettings(snapshot);
  }
  return false;
}

function getSnapshotSetting(snapshot, key) {
  if (key === "app.language") {
    return snapshot.language;
  }
  const path = snapshotPath(key);
  let node = snapshot.settings;
  for (const part of path) {
    node = node[part];
  }
  return node;
}

function snapshotPath(key) {
  if (key === "app.unpreviewHotkey") {
    return ["app", "unPreviewHotkey"];
  }
  return key.split(".");
}

function diffSnapshots(before, after) {
  const keys = [
    "app.language",
    "paint.brushSizeTexels",
    "paint.colorCompressionTolerance",
    "paint.autoMaterial",
    "paint.metallic",
    "paint.roughness",
    "paint.emissive",
    "paint.frontRegionMode",
    "paint.sideRegionMode",
    "paint.backRegionMode",
    "paint.fillColor",
    "paint.fillMetallic",
    "paint.fillRoughness",
    "paint.fillEmissive",
    "app.alwaysOnTop",
    "app.opacity",
    "app.themeColor",
    "app.startHotkey",
    "app.previewHotkey",
    "app.unpreviewHotkey",
    "app.stopHotkey"
  ];
  const changes = [];
  for (const key of keys) {
    const oldValue = getSnapshotSetting(before, key);
    const newValue = getSnapshotSetting(after, key);
    if (oldValue !== newValue) {
      changes.push({ key, value: newValue });
    }
  }
  return changes;
}

function normalizeColor(value) {
  const textValue = String(value || "").trim();
  const match = /^#?[0-9a-fA-F]{6}$/.exec(textValue);
  if (!match) {
    return null;
  }
  return ("#" + textValue.replace("#", "")).toUpperCase();
}

function bindRangePair(sliderId, numberId, key, transform = Number) {
  const slider = byId(sliderId);
  const number = byId(numberId);
  const commit = source => {
    if (!canEditControl(source)) {
      return;
    }
    const raw = Number(source.value);
    if (!Number.isFinite(raw)) {
      return;
    }
    const minimum = Number(source.min);
    const maximum = Number(source.max);
    const step = Number(source.step);
    const clamped = clamp(raw, minimum, maximum);
    const stepped = Number.isFinite(step) && step > 0
      ? minimum + Math.round((clamped - minimum) / step) * step
      : clamped;
    const normalized = clamp(stepped, minimum, maximum);
    slider.value = String(normalized);
    number.value = fmt(normalized);
    setDraftSetting(key, transform(normalized));
    if (key === "app.opacity") {
      send("previewWindow", { opacity: transform(normalized) }).catch(error => showError(error.message || String(error)));
    }
  };
  slider.addEventListener("input", () => commit(slider));
  number.addEventListener("change", () => commit(number));
  number.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      number.blur();
    }
  });
}

function bindInput(id, key, transform = value => value) {
  const element = byId(id);
  element.addEventListener("change", () => {
    if (!canEditControl(element)) {
      return;
    }
    setDraftSetting(key, transform(element.value));
  });
  element.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      element.blur();
    }
  });
}

function bindCheckbox(id, key) {
  byId(id).addEventListener("change", event => {
    if (!canEditControl(event.target)) {
      return;
    }
    setDraftSetting(key, event.target.checked);
    renderSettings(draftSnapshot);
  });
}

function bindColorPair(pickerId, inputId, key) {
  const picker = byId(pickerId);
  const textInput = byId(inputId);
  picker.addEventListener("input", () => {
    if (!canEditControl(picker)) {
      return;
    }
    const color = normalizeColor(picker.value);
    if (!color) {
      return;
    }
    textInput.value = color;
    setDraftSetting(key, color);
    if (key === "app.themeColor") {
      applyThemeColor(color);
    }
  });
  textInput.addEventListener("change", () => {
    if (!canEditControl(textInput)) {
      return;
    }
    const color = normalizeColor(textInput.value);
    if (!color) {
      setDraftSetting(key, textInput.value);
      return;
    }
    picker.value = color;
    textInput.value = color;
    setDraftSetting(key, color);
    if (key === "app.themeColor") {
      applyThemeColor(color);
    }
  });
  textInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      textInput.blur();
    }
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function beginHotkeyRecord(key, inputId) {
  if (!editing) {
    return;
  }
  recordingHotkey = { key, inputId };
  send("setHotkeyRecording", { recording: true }).catch(error => showError(error.message || String(error)));
  setHotkeyDialogMessage(i18n("dialog.hotkey.supported"), false);
  byId("hotkey-dialog").hidden = false;
}

function closeHotkeyDialog() {
  recordingHotkey = null;
  send("setHotkeyRecording", { recording: false }).catch(error => showError(error.message || String(error)));
  byId("hotkey-dialog").hidden = true;
}

function recordHotkeyFromEvent(event) {
  if (!recordingHotkey) {
    return;
  }
  event.preventDefault();
  if (event.key === "Escape" || event.key === "Esc") {
    closeHotkeyDialog();
    return;
  }
  const key = event.key.toUpperCase();
  if (!/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    toast(i18n("toast.hotkey.unsupported"), "error");
    return;
  }
  if (isDuplicateHotkey(key, recordingHotkey.key)) {
    toast(i18n("toast.hotkey.duplicate", key), "error");
    return;
  }
  setDraftSetting(recordingHotkey.key, key);
  setValue(recordingHotkey.inputId, key);
  closeHotkeyDialog();
}

function isDuplicateHotkey(value, ownKey) {
  return hotkeyKeys.some(key => key !== ownKey && getSnapshotSetting(draftSnapshot, key).toUpperCase() === value);
}

function setHotkeyDialogMessage(message, error) {
  const dialog = byId("hotkey-dialog");
  dialog.classList.toggle("error", error);
  byId("hotkey-dialog-message").textContent = message;
}

function showError(message) {
  console.error(message);
  toast(message, "error");
}

function toast(message, level = "success") {
  const toastElement = byId("toast");
  toastElement.textContent = message;
  toastElement.className = `visible ${level}`;
  clearTimeout(toastElement._timer);
  toastElement._timer = setTimeout(() => {
    toastElement.className = "";
  }, 2400);
}

document.addEventListener("DOMContentLoaded", () => {
  const imagePickerInput = byId("image-picker-input");
  const imagePickerInput2 = byId("image-picker-input-2");
  byId("image-picker-choose").addEventListener("click", () => {
    imagePickerInput.value = "";
    imagePickerInput.click();
  });
  byId("image-picker-choose-2").addEventListener("click", () => {
    imagePickerInput2.value = "";
    imagePickerInput2.click();
  });
  byId("image-picker-clear").addEventListener("click", () => clearImagePicker(0).catch(error => showError(error.message || String(error))));
  byId("image-picker-clear-2").addEventListener("click", () => clearAddedImagePickerFiles().catch(error => showError(error.message || String(error))));
  byId("image-picker-reset-placement").addEventListener("click", () => {
    resetImageLayerTransforms();
    imagePickerState.selectedLayer = 0;
    renderImagePicker();
    armImagePaint().catch(error => showError(error.message || String(error)));
  });
  byId("image-design-save").addEventListener("click", () => {
    saveCurrentImageDesign().catch(error => showError(error.message || String(error)));
  });
  byId("image-design-load").addEventListener("click", () => {
    loadSelectedImageDesign().catch(error => showError(error.message || String(error)));
  });
  byId("image-design-delete").addEventListener("click", () => {
    deleteSelectedImageDesign().catch(error => showError(error.message || String(error)));
  });
  byId("image-design-list").addEventListener("change", event => {
    selectedImageDesignId = event.target.value;
    const option = event.target.selectedOptions?.[0];
    if (selectedImageDesignId && option) {
      byId("image-design-name").value = option.textContent;
    }
    byId("image-design-load").disabled = !selectedImageDesignId;
    byId("image-design-delete").disabled = !selectedImageDesignId;
  });
  imagePickerInput.addEventListener("change", event => {
    selectImagePickerFile(event.target.files?.[0], 0).catch(error => showError(error.message || String(error)));
  });
  imagePickerInput2.addEventListener("change", event => {
    addImagePickerFiles(event.target.files).catch(error => showError(error.message || String(error)));
  });
  byId("image-layer-list").addEventListener("click", event => {
    const selectButton = event.target.closest("[data-image-layer-index]");
    if (selectButton) {
      imagePickerState.selectedLayer = Number(selectButton.dataset.imageLayerIndex);
      renderImagePicker();
      return;
    }
    const removeButton = event.target.closest("[data-remove-image-layer]");
    if (removeButton) {
      clearImagePicker(Number(removeButton.dataset.removeImageLayer)).catch(error => showError(error.message || String(error)));
    }
  });
  for (const button of document.querySelectorAll("[data-snap-panel]")) {
    button.addEventListener("click", () => {
      const layer = imagePickerState.layers[imagePickerState.selectedLayer];
      if (!layer) {
        return;
      }
      const panel = Number(button.dataset.snapPanel);
      layer.centerX = 0.125 + panel * 0.25;
      layer.centerY = 0.5;
      layer.width = 0.25;
      layer.height = 1;
      renderImagePicker();
      scheduleImagePaintArm(50);
    });
  }
  for (const button of document.querySelectorAll("[data-image-placement]")) {
    button.addEventListener("click", () => {
      if (button.dataset.imagePlacement === "crop") {
        openCropEditor(0);
        return;
      }
      imagePickerState.placement = "fit";
      renderImagePicker();
      armImagePaint().catch(error => showError(error.message || String(error)));
    });
  }
  const cropSelection = byId("crop-editor-selection");
  cropSelection.addEventListener("pointerdown", beginCropEditorDrag);
  cropSelection.addEventListener("pointermove", moveCropEditorDrag);
  cropSelection.addEventListener("pointerup", endCropEditorDrag);
  cropSelection.addEventListener("pointercancel", endCropEditorDrag);
  byId("crop-editor-zoom").addEventListener("input", event => updateCropEditorZoom(event.target.value));
  byId("crop-editor-cancel").addEventListener("click", closeCropEditor);
  byId("crop-editor-use").addEventListener("click", () => {
    if (!cropEditorState) {
      return;
    }
    const image = imageAt(cropEditorState.slot);
    if (image) {
      image.crop = clone(cropEditorState.draft);
    }
    imagePickerState.placement = "crop";
    closeCropEditor();
    renderImagePicker();
    armImagePaint().catch(error => showError(error.message || String(error)));
  });
  for (const button of document.querySelectorAll("[data-alpha-mode]")) {
    button.addEventListener("click", () => {
      imagePickerState.alphaMode = button.dataset.alphaMode;
      renderImagePicker();
      armImagePaint().catch(error => showError(error.message || String(error)));
    });
  }
  for (const button of document.querySelectorAll("[data-wrap-mode]")) {
    button.addEventListener("click", () => {
      imagePickerState.wrapMode = button.dataset.wrapMode;
      resetImageLayerTransforms();
      renderImagePicker();
      armImagePaint().catch(error => showError(error.message || String(error)));
    });
  }
  for (const button of document.querySelectorAll("[data-image-count]")) {
    button.addEventListener("click", () => {
      imagePickerState.imageCount = Number(button.dataset.imageCount);
      if (imagePickerState.imageCount === 2) {
        imagePickerState.wrapMode = "base";
        imagePickerState.placement = "fit";
        imagePickerState.mirrorMode = "none";
      }
      imagePickerState.selectedLayer = 0;
      resetImageLayerTransforms();
      renderImagePicker();
      armImagePaint().catch(error => showError(error.message || String(error)));
    });
  }
  for (const button of document.querySelectorAll("[data-mirror-mode]")) {
    button.addEventListener("click", () => {
      imagePickerState.mirrorMode = button.dataset.mirrorMode;
      if (imagePickerState.mirrorMode === "mirror" && imagePickerState.wrapMode === "full") {
        imagePickerState.wrapMode = "meet";
      }
      imagePickerState.selectedLayer = 0;
      resetImageLayerTransforms();
      renderImagePicker();
      armImagePaint().catch(error => showError(error.message || String(error)));
    });
  }
  byId("image-picker-background").addEventListener("input", event => {
    imagePickerState.backgroundColor = event.target.value;
    renderImagePicker();
    scheduleImagePaintArm();
  });
  window.addEventListener("beforeunload", () => {
    imagePickerState.images.forEach(image => revokeImageSource(image.objectUrl));
  });
  const editor = byId("image-wrap-editor");
  editor.addEventListener("pointerdown", beginImageEditorDrag);
  editor.addEventListener("pointermove", moveImageEditorDrag);
  editor.addEventListener("pointerup", endImageEditorDrag);
  editor.addEventListener("pointercancel", endImageEditorDrag);
  bindImageDropTarget(byId("image-picker-choose"), 0);
  bindImageDropTarget(byId("image-picker-choose-2"));
  bindImageDropTarget(byId("image-picker-preview"));
  renderImagePicker();
  refreshSavedImageDesigns().catch(error => showError(error.message || String(error)));
  bindRangePair("brush-size", "brush-size-number", "paint.brushSizeTexels");
  bindRangePair("color-compression-tolerance", "color-compression-tolerance-number", "paint.colorCompressionTolerance");
  bindCheckbox("auto-material", "paint.autoMaterial");
  bindRangePair("metallic", "metallic-number", "paint.metallic");
  bindRangePair("roughness", "roughness-number", "paint.roughness");
  bindRangePair("emissive", "emissive-number", "paint.emissive");
  bindColorPair("fill-color-picker", "fill-color", "paint.fillColor");
  bindRangePair("fill-metallic", "fill-metallic-number", "paint.fillMetallic");
  bindRangePair("fill-roughness", "fill-roughness-number", "paint.fillRoughness");
  bindRangePair("fill-emissive", "fill-emissive-number", "paint.fillEmissive");
  bindCheckbox("always-on-top", "app.alwaysOnTop");
  bindRangePair("opacity", "opacity-number", "app.opacity", value => value / 100);
  bindColorPair("theme-color-picker", "theme-color", "app.themeColor");
  const languageSelect = byId("language");
  const languageWrap = languageSelect.closest(".select-wrap");
  languageSelect.addEventListener("pointerdown", () => languageWrap?.classList.add("open"));
  languageSelect.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      languageWrap?.classList.add("open");
    }
  });
  languageSelect.addEventListener("blur", () => languageWrap?.classList.remove("open"));
  languageSelect.addEventListener("change", event => {
    languageWrap?.classList.remove("open");
    if (!canEditControl(languageSelect)) {
      return;
    }
    setDraftSetting("app.language", event.target.value);
    render();
  });
  byId("edit-settings").addEventListener("click", beginEdit);
  byId("cancel-edit").addEventListener("click", cancelEdit);
  byId("reset-settings").addEventListener("click", resetDraft);
  byId("save-settings").addEventListener("click", () => saveDraft().catch(error => showError(error.message || String(error))));
  byId("open-logs").addEventListener("click", () => send("openLogs").catch(error => showError(error.message || String(error))));
  byId("copy-logs").addEventListener("click", async () => {
    try {
      await send("copyLogs");
      toast(i18n("toast.log.copied"));
    } catch (error) {
      showError(error.message || String(error));
    }
  });
  for (const button of document.querySelectorAll(".record-hotkey")) {
    button.addEventListener("click", () => beginHotkeyRecord(button.dataset.hotkeyKey, button.dataset.hotkeyInput));
  }
  for (const button of document.querySelectorAll(".tab")) {
    button.addEventListener("click", () => {
      activeLogFilter = button.dataset.logFilter;
      for (const tab of document.querySelectorAll(".tab")) {
        tab.classList.toggle("active", tab === button);
      }
      renderLogs(liveSnapshot?.runtime || { logs: "" });
    });
  }
  document.addEventListener("keydown", recordHotkeyFromEvent);
  webview.postMessage({ type: "uiReady" });
  if (hostedWebView) {
    refresh().catch(error => showError(error.message || String(error)));
  } else {
    document.documentElement.dataset.previewMode = "true";
  }
});
