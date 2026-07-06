# Runtime Bridge Responsibility Map

This document is the cleanup map for `runtime/src/bridge.cpp`. Its purpose is
to make dead-code review safer before any deletion or file split.

Current policy: do not delete or split bridge code before the code path is
classified. Static reference count is not enough in this runtime because many
entries are reached by IPC command strings, Win32 callbacks, UE reflection, or
runtime RPC layout.

## Cleanup Categories

### KEEP_DYNAMIC_ENTRY

Code may be reached through a runtime entry point rather than a normal C++ call.
Examples include `DllMain`, Win32 callbacks, message hooks, bridge listener
handlers, IPC command handlers, WebView2/C# command names, and exported or
`GetProcAddress`-reachable functions.

Do not delete solely because references are sparse.

### KEEP_REFLECTION_ENTRY

Code may be reached by Unreal runtime reflection, `FName` / `UObject` /
`UFunction` lookup, `ProcessEvent`, or reflected property names. Reflection
wrappers and schema probes often look unused from static analysis.

Do not rename reflected function/property strings without a runtime compatibility
review.

### KEEP_SDK_LAYOUT

Types, padding fields, and `static_assert` checks may preserve runtime memory
layout. These are not dead just because a field is not read by C++ code.

Do not delete or reorder RPC parameter structs, SDK structs, padding, or layout
assertions without a binary-layout test or live verification.

### LEGACY_FALLBACK

Old compact/adaptive/send-custom paint paths are not the normal user-facing
route, but may still be useful for diagnostics, research, or rollback during
packed-route stabilization.

Do not delete before beta.3 packed paint behavior is validated and the command
surface confirms no production path depends on the code.

### RESEARCH_ONLY

Probe, pressure, event-watch, dump, and research-artifact helpers are not normal
runtime behavior. Quarantine before deletion. Keep enough context to reproduce
multiplayer or game-update investigations.

Runtime paint replication research is tracked in
`docs/runtime-paint-replication-research.md`. Repeatable runtime probes should
live under `scripts/research/` and write generated data under
`artifacts/research/` or another untracked local directory.

### DELETE_CANDIDATE

Code can be considered for deletion only after it is not a dynamic entry, not a
reflection entry, not SDK layout, not a legacy fallback, and not a research-only
helper still needed for issue triage.

## High-Risk Areas Before beta.3

- Runtime startup, injected thread setup, `DllMain`, hooks, and listener
  lifecycle.
- C# / WebView2 / bridge IPC command names and response shape.
- UE object scanning, reflection lookup, `ProcessEvent`, and RPC wrappers.
- `ServerPackedPaintBatch` default route and packed payload layout.
- Async paint lifecycle, queue draining, cancellation, and pawn/component guards.
- Preview/unpreview texture import/export and local snapshot behavior.
- Runtime asset cache repair, startup diagnostics, injector diagnostics, and
  Fixed Version WebView2 preparation.

Before beta.3, changes in these areas should be limited to comments, additive
diagnostics, or tightly scoped bug fixes with live verification.

## bridge.cpp Sections

`bridge.cpp` currently contains these broad responsibilities:

- Runtime startup, globals, sidecars, diagnostics, and listener state.
- UE reflection, object scanning, `FName` resolution, and `ProcessEvent`.
- SDK context resolution and low-level reflected call helpers.
- Mesh profile loading, mesh identity matching, pose and runtime-triangle
  planning.
- Preview/unpreview texture channel export/import and local snapshot handling.
- Paint sample generation and material/color transfer.
- Packed paint serialization and `ServerPackedPaintBatch` RPC dispatch.
- Async paint job lifecycle, progress sidecar writing, cancellation, and guards.
- Research/probe commands and bridge IPC dispatch.

Replication-specific research notes live in
`docs/runtime-paint-replication-research.md`.

The first cleanup pass should add inventory and labels only. Later passes may
move code into `.inc` files while preserving a single translation unit. Full
`.cpp/.h` splitting should wait until behavior is stable and each moved section
has focused verification.

## Review Commands

Generate a report-only inventory:

```bash
make review-dead-code
```

Canonical build remains:

```bash
make build
```

Review output is written under `artifacts/review/runtime-dead-code/` and is not
tracked by git.

## Deletion Rule

No code is deleted because one tool says it is unused. A deletion needs:

- inventory evidence,
- category review,
- command/reflection/layout review,
- a focused diff,
- `make build`,
- and live smoke coverage if the code is near paint, injection, or startup.
