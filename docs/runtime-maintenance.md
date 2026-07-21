# Runtime Maintenance

This document defines how to change runtime, bridge, and reverse-engineering
code without growing accidental complexity.

## Default Workflow

1. Start from the source layout in `docs/repository-layout.md`.
2. Classify the change:
   - app/runtime infrastructure
   - bridge injection or IPC
   - WebView2 GUI
   - mesh profile generation
   - paint replication
   - research-only reverse engineering
3. Run the smallest useful static check.
4. Make a focused change.
5. Run `make build`.
6. Run maintainer game smoke tests when the change touches game behavior.
7. Run `make package` before release work.

Do not mix unrelated runtime, GUI, research, and packaging changes in one diff
unless the change is a deliberate architecture migration.

## Direct Bridge Startup

The production lifecycle entry point is `BridgeStartV1` in the directly injected
bridge DLL. The injector targets the selected game PID, waits for both remote
calls, and connects only to the authenticated loopback endpoint returned by
that bridge instance. The complete contract is documented in
[`runtime-direct-bridge.md`](runtime-direct-bridge.md).

Do not introduce loader switching, unloading, old-module compatibility checks,
or restart-required states merely because older bridge DLLs remain loaded.
There is no loader or compatibility path to preserve: each attempt stages and
authenticates its own direct bridge instance.

## Dead-Code Review

Generate a report-only inventory:

```bash
make review-dead-code
```

Review output is ignored under `artifacts/review/runtime-dead-code/`.

Static search is evidence, not proof. Do not delete code only because an
analyzer or `rg` shows few references.

The inventory intentionally reports dynamic bridge entry points, reflection
names/layouts, and research-only paths. Treat those categories as retained until
their runtime contract is disproved. A release review must record whether the
report contains a concrete, statically reachable deletion candidate; an
inventory containing only these protected categories is not authorization to
remove code.

Deletion requires:

- inventory evidence
- category review
- command/reflection/layout review
- focused diff
- `make build`
- live smoke coverage when the code is near paint, injection, startup, or
  multiplayer behavior

## Keep Categories

### Dynamic Runtime Entries

Keep sparse-looking entry points reached by runtime mechanisms:

- `DllMain`
- Win32 callbacks and message hooks
- bridge listener command handlers
- WebView2/C# command strings
- exported or `GetProcAddress`-reachable functions

### Unreal Reflection And SDK Layout

Keep code that preserves binary or reflection compatibility:

- `ProcessEvent` wrappers
- `FName`, `UObject`, `UFunction`, and `FProperty` helpers
- reflected function and property name strings
- RPC parameter structs
- padding fields
- `static_assert` layout checks

Do not rename, reorder, or delete these without live verification.

### Research-Only Reverse Engineering

Keep research helpers out of normal UI and normal paint decisions, but do not
delete them just because production code does not call them.

Research-only code includes:

- paint replication probes
- pressure probes
- packed replay probes
- event-watch sidecars
- dump and trace helpers
- `MECCHA_RESEARCH_ARTIFACTS` paths

Repeatable research entry points belong under `scripts/research/`. Generated
research output belongs under `artifacts/research/` or another ignored local
directory.

## Paint Replication Rules

Normal paint submits packed AMRE strokes through `ServerPackedPaintBatch` and
applies those submitted strokes through the validated internal no-resend
renderer. The AMRE target is one packed material-properties texture:
`R=Metallic`, `G=Roughness`, and `B=Emissive`. Do not split it into separate
PBR imports or replay it through reflected `PaintAtUVWithBrush`; both have
previously created a second local pass or overwritten packed channels.

`ImportChannelFromBytes` is the Preview/Unpreview transport. The reflected
`PaintAtUVWithBrush` and native packed receiver queue routes are explicit
research A/B modes only.

Auto Detect applies only to Paint regions. It obtains one global dominant
material pattern from `GetDominantPaintMaterialPatterns`, including M/R/E, and
therefore intentionally ignores the manual Paint PBR values for that request.
Fill is always an explicit manual material, even when Auto Detect is on. Record
the returned candidate list, selection, and first-stroke M/R/E before judging
an Auto Detect result.

The server schema, packed payload, source ID, and internal no-resend resolver
remain fatal requirements. Do not silently switch normal paint to texture
import, reflected local paint, or an unverified local route.

When changing replication behavior, verify host and joining-client behavior
separately. Painter-side completion is not enough; a normal other client must
also receive the final result without returning to the old multi-minute drain
path.

## Debugging Game Updates And PBR

Build a short numeric feedback loop before changing the production route.

1. Reproduce with one region, one stroke, and a fresh research artifact
   directory. Run only one research runner while its event-watch bridge is
   active.
2. Use distinguishable manual PBR values such as `M=.21`, `R=.83`, `E=.47`.
   The packed texture result should be approximately `R=54`, `G=212`,
   `B=120`; quantization is expected.
3. Run the same controlled probe with Auto Detect on. Compare
   `material_properties_candidates`, `material_properties_selection`, and the
   first-stroke values. Auto Detect succeeding at a global `M=0/R=1/E=0` is
   not evidence that the manual values were lost.
4. For Preview, test Paint and Fill independently. Front defaults to Fill, so
   changing Paint PBR does not change a Front Fill preview. Preview must be
   restored on the same bridge that captured its snapshot.
5. Treat a successful server RPC, a changed hash, an eyedropper reading, or a
   screenshot as incomplete evidence on its own. Record changed-pixel values
   and the selected component, then separately verify renderer/remote-client
   completion where that claim matters.

Never lower the recurring scheduler below its 1 ms safety floor or restore
zero-delay reposts to make a benchmark look faster; this can monopolize the
game thread and freeze the game. Do not reuse old RVAs, mutate queues or
render-target memory, use `TerminateThread`, unload a bridge, or restart the
game merely because a new controller starts. The direct bridge is designed to
authenticate a fresh controller-owned instance in an already-running game.

### Game-update revalidation

The native packed receiver route is not exact-build gated. After a game update,
record the PE and `.text` identity for diagnosis, then verify the packed
format, `FPaintChannelData`/`FPaintStroke` reflection layout (including
Emissive), and the unique masked-signature chain from UFunction thunk through
the internal no-resend renderer. Never copy old RVAs forward as acceptance
criteria. A missing, changed-ABI, or ambiguous candidate must fail explicitly;
do not substitute another local transport. Then repeat both multiplayer
directions with event-watch, pressure/queue samples, and painter/receiver
texture checksums.

## Bridge File Structure

`src/native/bridge/bridge.cpp` remains a single translation unit unless there
is a focused reason to split further.

Low-risk helpers may move to `.inc` files when that reduces local complexity and
does not change behavior. Full `.cpp/.h` splitting should wait until the moved
section has focused build and live verification.

Existing `.inc` files:

- `src/native/bridge/bridge_json.inc`
- `src/native/bridge/bridge_sidecar.inc` (progress and research sidecar paths)

## Research Tool Policy

Prefer maintained source under `scripts/research/` or `third_party/` over
untracked binary output.

`tools/asset_probe/` is currently ignored local output from an old research
tool. Only local `bin/` and `obj/` output remains. Keep it only when a local
investigation still needs it.
