# Debug notes

This document records what is currently known about Meccha Camouflage runtime behavior, attempted camouflage routes, and failure modes. It is intentionally blunt: the goal is to avoid repeating experiments that have already failed.

## Current repository state

- Current runtime is a C++ controller EXE plus injected bridge DLL.
- Current public development mode is `static_hybrid_front_side`.
- The last uncommitted experiment set was stashed before this cleanup as:
  - `stash@{0}: wip static hybrid diagnostics before docs cleanup`
- The stashed experiment included additional diagnostics such as a fixed-color paint/source-map probe. That probe is not part of the current mainline unless the stash is reapplied.
- The runtime SDK is tracked under `dumper-sdk/`.
- Runtime logs are written under `%LOCALAPPDATA%\MecchaCamouflage\runtime\`.

## Current implemented route

### `static_hybrid_front_side`

Intent:

- Generate a static camouflage atlas once when the user presses F10.
- Use the current front view as the dominant source.
- Add side information from virtual side sampling.
- Apply the generated result through texture import plus texture sync RPC.

Current high-level flow:

1. Resolve game context and paintable component.
2. Collect front surface hits with the cached-triangle hit-test backend.
3. Capture front/background color data.
4. Collect side samples using side-view logic.
5. Build a hybrid atlas from front and side samples.
6. Import albedo/metallic/roughness channels.
7. Dispatch texture sync RPC.

Important limitation:

- The route does not currently have true mesh render-data / true UV chart information.
- It uses observed samples and derived/proxy masks instead of exact mesh topology.
- Because of that, UV island boundaries and body-part boundaries are not reliable enough.

Observed result:

- Front can be partially acceptable.
- Side/back areas can show holes, dots, wrong colors, or cross-part contamination.
- Some runs produced dark/black scribble-like artifacts on front or unexpected color streaks.
- Boundary areas between front and side remain unstable.

Conclusion:

- The route is not production quality yet.
- More heuristic fill, dilation, radius tuning, or sample-count tuning is unlikely to fix the root problem.

## Routes and approaches tried

### Local texture import diagnostic

Intent:

- Quickly inspect generated atlas quality in-game.
- Avoid slow paint stroke streaming.

What worked:

- Local visual feedback is fast.
- Import can confirm whether generated texture bytes are being accepted by the runtime.

What failed:

- Local import alone is not a multiplayer guarantee.
- It polluted debugging because local-only success looked like real route success.
- It encouraged diagnosing texture artifacts that may not map to multiplayer behavior.

Current decision:

- Local-only import routes should not be treated as success paths.
- If used at all, they must be explicit diagnostics only.

### Texture sync strict probe

Intent:

- Use texture import plus the game's texture sync RPC as a fast multiplayer candidate.

What worked:

- It is much faster than stroke streaming.
- Local execution completed and visually applied texture changes.
- Texture sync RPC dispatch was observed.

What is unverified:

- Remote multiplayer sync has not been proven in a two-client test.
- A single client cannot prove remote replication.

Observed problems:

- Front could look acceptable but color was sometimes blue/dark shifted.
- Side/back quality remained poor with sparse dots, holes, or misplaced colors.
- Increasing precision alone did not solve the side/back problem.

Current decision:

- Texture sync is still the only fast multiplayer candidate, but remote behavior remains unverified.
- The side/back atlas source must be fixed before texture sync can be judged fairly.

### ServerPaintBatch / replicated paint stream

Intent:

- Convert generated atlas or samples into replicated paint strokes.
- Use `ServerPaintBatch` as the multiplayer-safe application path.

What worked:

- Server RPC dispatch can send many strokes.
- Fixed or sampled paint can visibly affect the local model in some cases.

What failed:

- Paint streaming is slow compared with texture sync.
- Large stroke counts are not practical for fast F10 use.
- Export hash observation was unreliable in some runs: server dispatch happened, but exported albedo hash did not always change.
- Reducing stroke count improves speed but lowers quality, which is not acceptable for final camouflage.

Current decision:

- Paint stream is a useful diagnostic and possible fallback only if texture sync is proven unusable.
- It does not solve bad atlas/UV/source placement. If the atlas source is wrong, paint will reproduce the same wrong result more slowly.

### Front-only route

Intent:

- Avoid side/back complexity and confirm that front color/capture can work.

What worked:

- Front sampling became relatively fast after cached-triangle backend work.
- Front-only is more stable than side/back.

What failed:

- It does not solve whole-body camouflage.
- Edge and curved areas can still have gaps or mismatch.

Current decision:

- Front-only is a useful baseline, not the final goal.

### Full side/back virtual-view sampling

Intent:

- Fill side and back using virtual views and screen/ray queries.

What worked:

- It can generate some side/back samples.
- Increasing density can fill more area.

What failed:

- Back was often sparse or dotted.
- Larger radius/splat created visible large palette-like dots.
- Fill could place colors in the wrong body region.
- Arm/body/leg colors could appear on unrelated UV islands.
- More attempts or more views increased runtime and did not reliably improve correctness.

Current decision:

- The existing virtual-view side/back workflow is not converging.
- It should not be tuned further as a production route without true mesh topology.

### Static multi-view edge-weighted hybrid

Intent:

- Use front as dominant high-frequency source.
- Use side views for lower-frequency edge/side continuity.
- Avoid trying to fully solve rear/back.

What worked:

- Some areas became more filled than earlier sparse side/back attempts.
- Hole filling improved in some runs.

What failed:

- Color contamination remained at boundaries.
- Some body parts appeared to receive colors from unrelated parts.
- Fills can trade holes for contamination: reducing contamination reintroduces holes, while filling holes reintroduces wrong colors.
- Without true UV island/chart data, the route cannot reliably prevent cross-island propagation.

Current decision:

- The idea may still be valid, but the current implementation lacks the mesh/chart foundation needed to make it reliable.
- Continuing to tune weights without true chart data is low-value.

### Color transfer / sRGB / linear probes

Intent:

- Determine whether washed-out, blue-ish, or dark color issues were caused by sRGB/linear conversion or material channel import.

What was learned:

- Color transfer changed appearance, but did not explain side/back cross-region contamination.
- Gap fill disabled and material preservation did not eliminate the core side/back problem.
- Metallic/roughness changes affected perceived material, but did not fix wrong color placement.

Current decision:

- Color transfer is not the primary explanation for cross-region side/back contamination.
- It may still need final calibration later, but not before UV/source placement is correct.

### Metallic / roughness experiments

Intent:

- Use material channels to make the object less visibly wrong.
- Test white metallic base, high roughness, metallic zero, and imported material channels.

What was learned:

- Material settings can make artifacts less or more visible.
- They can obscure whether albedo resolution is actually correct.
- They do not solve incorrect UV/source placement.

Current decision:

- Do not use material tweaks to hide source placement bugs.
- Final material policy should be chosen only after atlas/source correctness is established.

### In-game overlay / external GUI / progress work

Intent:

- Make long-running routes understandable while F10 is running.

What worked:

- Terminal progress became more readable.
- Idle spam was reduced.

What failed:

- UE debug overlay was unreliable in shipping runtime.
- Better logging does not improve camouflage correctness.

Current decision:

- Keep concise terminal logs and runtime artifacts.
- Do not spend more time on UI until the algorithm is viable.

## Mesh / UV / chart investigation

### What was needed

The ideal route requires deterministic mesh data:

- current player mesh component
- skeletal/static mesh asset
- LOD render vertices
- index buffer
- UV buffer
- section/material data
- bone transforms / skinned pose
- UV island adjacency / chart map

With those, the correct route would be:

1. Snapshot mesh and pose.
2. Build CPU-side BVH.
3. Raycast front/side views on CPU.
4. Resolve exact triangle and exact paint UV.
5. Build true chart-aware atlas.
6. Fill only within the same chart/island.
7. Apply via texture sync or replicated strokes.

### What was actually obtained

Confirmed:

- The runtime can resolve world/controller/pawn/component context.
- External pointer-chain style checks reduced the chance that the wrong pawn/mesh was being targeted.
- `front_native_mesh` and initialized paint mesh appeared to match in prior diagnostics.

Not obtained:

- Exact `FSkeletalMeshRenderData` layout.
- Exact LOD vertex buffer.
- Exact index buffer.
- Exact UV buffer.
- True UV chart / island adjacency.
- Reliable triangle index from the paint hit-test result.

Important observation:

- Dumper7 generated public SDK data is useful for UObjects and UFUNCTION schemas, but it does not automatically expose private render buffers needed for exact CPU raycast/chart reconstruction.

### Failed or inconclusive mesh attempts

- Reflection/memory scan fallback produced unstable candidates and false positives.
- Candidate topology buffers sometimes looked mathematically plausible but were degenerate or raw/unorm data misread as topology.
- Recorded-stroke anchor attempts did not produce enough usable anchor data.
- Hit-test result data did not expose a reliable triangle/face index in the available struct.

Current decision:

- Exact mesh render-data decode remains the main unresolved blocker.
- Without it, side/back quality cannot be guaranteed by heuristics.

## Known failure modes

### Cross-region color contamination

Symptoms:

- A color that appears to belong near an arm boundary appears on a leg or torso side.
- Boundary colors leak into unrelated UV regions.
- Reducing fill can reduce contamination but creates holes.

Most likely cause:

- Fill or source accumulation crosses a UV island/body-part boundary because the current route lacks true chart topology.

What does not fix it:

- Increasing sample count.
- Increasing side/back view count.
- Increasing splat radius.
- Nearest-source fill without chart boundaries.
- Material changes.
- sRGB/linear toggles.

### Sparse dotted side/back output

Symptoms:

- Side/back has many visible dots with gaps between them.
- Dots can look like large palette stamps.

Most likely causes:

- Side/back sampling density is insufficient in UV space.
- Splat radius is too large visually but still does not cover correct UV area.
- Samples are not distributed according to true UV chart area.

What does not fix it reliably:

- Simply increasing attempts.
- Simply increasing radius.
- Mirroring front samples to back.

### Holes vs contamination tradeoff

Symptoms:

- Strict source constraints produce holes.
- Aggressive fill removes holes but introduces wrong colors.

Most likely cause:

- No true chart-aware fill boundary.

Current interpretation:

- This is not a tuning problem. It is a missing topology problem.

### Front dark scribble / unexpected black marks

Symptoms:

- Black or dark paint-like streaks appear over front in some runs.

Possible causes:

- Previous runtime state is not cleared before a new F10 run.
- Atlas preserve/original channel data can leak into final output.
- A failed or partial route may leave stale paint/texture state.
- Hybrid fill/source map may preserve dark pixels where it should not.

Current decision:

- Treat as a separate artifact-state/source-preserve bug after source placement is fixed.

## Things that are probably not worth repeating

Do not spend more cycles on these unless new evidence appears:

- More random side/back virtual views.
- Larger splat radii for side/back.
- Nearest-neighbor fill across unknown chart boundaries.
- Front-to-back mirror/reuse as a default route.
- sRGB/linear/material toggles as an explanation for cross-region contamination.
- More stroke merge tuning while atlas/source placement is wrong.
- Progress/log UI changes as an algorithmic fix.
- Memory-scan fallback that treats arbitrary pointer tables as mesh topology.

## Useful artifacts

Runtime directory:

```text
%LOCALAPPDATA%\MecchaCamouflage\runtime\
```

Important files:

- `events.jsonl`: event stream and route metadata.
- `last_status.json`: latest result.
- `.progress.json`: current/last progress state.
- `hybrid_quality.json`: hybrid atlas quality metrics when written.
- `hybrid_atlas_preview.ppm`: preview of generated atlas.
- `hybrid_source_map.ppm`: source ownership visualization.
- `hybrid_uv_chart_map.ppm`: current proxy chart visualization.

Important repository paths:

- `runtime/src/meccha_xenos_bridge.cpp`: injected bridge and route implementation.
- `runtime/src/meccha_runtime_controller.cpp`: controller, hotkey, process watch, bridge client, terminal output.
- `runtime/sdk/meccha_sdk_min.hpp`: minimal runtime SDK structs and offsets.
- `runtime/sdk/meccha_mesh_layout.hpp`: mesh-layout status and exact-layout gate.
- `dumper-sdk/`: generated game SDK reference.

## Current recommended direction

The next serious attempt should not be another heuristic side/back fill pass.

Preferred route:

1. Resume exact mesh render-data work.
2. Obtain deterministic vertex/index/UV/section data.
3. Build true UV island/chart map.
4. Validate CPU raycast UV against a small number of game hit-test samples.
5. Only then rebuild side/front hybrid atlas.

If exact mesh render-data remains unavailable:

- Treat high-quality side/back camouflage as not currently solved.
- Keep front-only or fast texture-sync candidate as the practical route.
- Avoid claiming full-body camouflage correctness.

## Multiplayer status

Known:

- `ServerPaintBatch` is the proper replicated-paint style API, but it is slow for dense high-quality output.
- Texture sync RPC dispatch has been observed locally and is much faster.

Unknown:

- Whether texture sync updates remote clients correctly in a real two-client lobby.

Current decision:

- A route using texture sync is only a multiplayer candidate until remote verification is performed.
- A route using local-only import is not a multiplayer route.
