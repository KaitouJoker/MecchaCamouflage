# Runtime Dead-Code Candidate Classification

This is the first classification pass from `make review-dead-code` after
commit `66b7cae`.

No native runtime code is deleted in this pass. The goal is to separate real
delete candidates from dynamic/reflection/research code that only looks unused
to static search.

## Summary

Highest-confidence cleanup candidates are outside the active packed paint path:

- legacy WPF controller project, if WebHost is the only supported UI
- unused localization strings for removed batch/adaptive controls
- legacy config write/edit surface for `adaptive_batching`,
  `server_batch_limit`, and `server_batch_delay_ms`
- old non-packed native paint RPC dispatch, after beta packed-route validation

The native bridge still has no "delete now" candidate that is safe without a
focused follow-up diff. Most obvious hits are either production paint,
reflection layout, dynamic IPC entrypoints, or research probes.

## Keep: Dynamic Entries

These are not dead even when references are sparse:

- `DllMain`
- Win32 hook/message dispatch
- bridge listener command dispatch
- C# / WebView2 command strings:
  - `ping`
  - `capabilities`
  - `paint_full_route`
  - `cancel_paint`
  - `shutdown`
  - `paint_replication_probe`
  - `paint_replication_pressure_probe`
  - `paint_packed_replay_probe`

Reason: runtime entry is by LoadLibrary, Win32 callbacks, TCP IPC, or
WebView2/C# message text rather than ordinary C++ references.

## Keep: Reflection And SDK Layout

These are not dead solely because static references are hard to follow:

- `ProcessEvent` wrappers and vtable lookup
- `FName`, `UObject`, `UFunction`, `FProperty` scanning helpers
- RPC parameter structs and padding/static assertions
- reflected function/property name strings

Reason: renaming, reordering, or deleting these can break binary layout or
runtime lookup without a compile error.

## Keep: Research-Only

These are intentionally outside production behavior but should remain available
for multiplayer and game-update investigations:

- `paint_replication_probe`
- `paint_replication_pressure_probe`
- `paint_packed_replay_probe`
- event-watch sidecar
- `MECCHA_RESEARCH_ARTIFACTS` debug output path
- projection/UV debug artifacts

Rule: keep them out of normal UI and normal paint decisions, but do not delete
until their investigation value is replaced by a better tool.

## Candidate: WPF Controller Project

Classification: `DELETE_CANDIDATE`, pending support decision.

Evidence:

- canonical `scripts/build.ps1` publishes
  `runtime/csharp/MecchaCamouflage.WebHost/MecchaCamouflage.WebHost.csproj`
- build script does not publish or test
  `runtime/csharp/MecchaCamouflage.Wpf/MecchaCamouflage.Wpf.csproj`
- WPF still contains old delay/batch-related UI, while the supported WebHost UI
  hides legacy batch tuning

Risk:

- low for release artifact if WebHost is the only supported controller
- medium for developers if anyone still runs the WPF project manually

Next action:

- confirm WPF is no longer supported
- either delete `runtime/csharp/MecchaCamouflage.Wpf/`, or move it to an
  explicit legacy/archive area outside the release path

## Candidate: Removed Batch/Adaptive Localization Keys

Classification: `DELETE_CANDIDATE`, after WPF decision.

Keys:

- `batch.size`
- `batch.delay`
- `adaptive.batching`

Evidence:

- Web UI no longer exposes legacy batch/adaptive controls
- search hits are only localization data, tests/docs, and legacy WPF surface

Risk:

- low after WPF removal
- medium before WPF removal because WPF still has legacy controls

Next action:

- remove keys from every locale only after the last UI consumer is gone
- update locale completeness tests in the same diff

## Candidate: Legacy Settings Edit/Write Surface

Classification: `DELETE_CANDIDATE`, after one compatibility window.

Fields:

- `PaintSettings.AdaptiveBatching`
- `PaintSettings.ServerBatchLimit`
- `PaintSettings.ServerBatchDelayMs`
- serialized keys:
  - `adaptive_batching`
  - `server_batch_limit`
  - `server_batch_delay_ms`

Current state:

- old values are not sent in the normal paint payload
- Web UI snapshot no longer exposes `adaptiveBatching` or `serverBatchLimit`
- settings loader still reads/clamps/writes them for old config compatibility
- progress formatting still uses batch/pacing values coming from bridge

Risk:

- medium. Removing read compatibility can silently discard old configs.
- low to stop writing old keys once a release has migrated users.

Next action:

- first stop exposing or editing the fields anywhere
- then stop writing legacy keys while still reading them
- later remove model fields and clamp tests

## Candidate: Legacy Native Non-Packed Paint RPC

Classification: `LEGACY_FALLBACK` now, `DELETE_CANDIDATE` after beta packed
route validation.

Code families:

- `ServerPaintBatch`
- `ServerCompactPaintBatch`
- `SendCustomStrokeBatchToServer`
- `FCompactPaintStroke` / `FCompactPaintStrokeBatch`
- `sdk_call_server_paint_batch`
- `sdk_call_server_compact_paint_batch`
- compact/send-custom metadata fields

Evidence:

- normal paint requires the packed component route
- `use_send_custom_server_batch` is forced false
- `use_compact_server_batch` is forced false
- failure to prepare packed route stops paint instead of falling back

Why not delete yet:

- these functions are still useful as research/rollback reference while beta.3
  multiplayer verification is active
- compact struct layout is part of the known game RPC map
- event-watch/probe metadata still compares old and new routes

Next action:

- after community confirmation, remove production fallback branches first
- keep reflected route names in research docs/scripts if still useful
- only then remove compact structs and SDK layout assertions

## Candidate: Internal `adaptive_*` Names

Classification: `RENAME_CANDIDATE`, not dead code.

Evidence:

- UI no longer lets users tune adaptive batching
- bridge still uses these fields for packed-route pacing, queue gate, drain
  estimate, and progress text

Risk:

- high if deleted: this code still protects packed replication pacing

Next action:

- rename internal terms from `adaptive_*` to `replication_pacing_*` or
  `packed_queue_gate_*`
- keep JSON compatibility for progress parsing during the rename
- do this as a behavior-preserving refactor after beta.3 stabilization

## Candidate: Native Metadata Noise

Classification: `DELETE_CANDIDATE`, low priority.

Examples:

- metadata fields that only report ignored old routes
- fields describing disabled texture sync experiments
- old `experimental_*_requested` metadata once no caller can send them

Risk:

- low for behavior
- medium for issue triage because old logs may become harder to compare

Next action:

- remove only fields that are not used by WebHost progress parsing, community
  diagnostics, or research scripts

## Not Candidates

Do not treat these as dead in this cleanup cycle:

- `ServerPackedPaintBatch` route and payload structs
- packed source id read at component offset `0x2A8`
- local visual sync with `PaintAtUVWithBrush`
- preview/unpreview snapshot code
- runtime triangle cache and unsafe-sample guards
- startup diagnostics, asset cache repair, fixed WebView2 setup
- injector phase diagnostics

These are active beta.3 behavior or high-risk infrastructure.

## Suggested Cleanup Order

1. Decide whether WPF is supported. If not, remove/archive WPF first.
2. Remove unused batch/adaptive localization keys after WPF is gone.
3. Stop writing legacy batch/adaptive config keys while keeping read
   compatibility.
4. Rename internal `adaptive_*` pacing names to packed replication pacing names.
5. After multiplayer validation, remove old non-packed native paint RPC dispatch.
6. Re-run `make review-dead-code` and update this document after each cleanup.
