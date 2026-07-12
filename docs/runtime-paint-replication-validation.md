# Runtime Paint Replication Validation

This document records the durable conclusions from the Issue #87 multiplayer
paint investigation. It is not a release claim: a result is valid only for the
tested game build, topology, and route described here.

Runtime logs, event-watch data, texture exports, screenshots, and injected
artifacts are intentionally kept outside the repository. The relevant runner
and collection procedure are documented in
[`scripts/research/README.md`](../scripts/research/README.md).

The normal ReleaseSingleFile build does not compile the research runner or
enable WebView DevTools through `MECCHA_RESEARCH_ARTIFACTS`. Use the explicit
research build script when those capabilities are required.

## Evidence Terms

- **Verified**: supported by code inspection and one or more runtime probes,
  event-watch captures, queue snapshots, texture exports, or controlled A/B
  tests.
- **Tested**: exercised in a named runtime topology, but not generalized beyond
  it.
- **Unverified**: plausible or observed once, but insufficient for a product or
  release claim.

## Production Route

Normal multiplayer paint uses a paired packed route:

- `RuntimePaintableComponent.ServerPackedPaintBatch` sends the server batch.
- The painter's local game-owned packed receiver queue receives the same packed
  batch boundaries and cadence through the exact-build native receiver path.
- Each paired commit is fail-closed: resolver, payload, queue, and component
  continuity checks must pass before the first stroke is sent.
- No automatic fallback is allowed to reflected `PaintAtUVWithBrush`, the
  legacy per-stroke internal-common route, compact/adaptive routes, or a
  texture-sync route.
- Batch controls range from 1--20 strokes and 50--500 ms. The default is
  20 strokes / 50 ms.

The planner produces `Fill -> Brush 1 -> Brush 2`; no packed batch crosses a
pass boundary. Brush 1 ranges from 10--30 texels and defaults to 30. Brush 2
ranges from 5--10 texels. Coverage is intentionally synchronized to Brush 2:
setting Brush 2 to 5 also sets coverage to 5.

Completion means that the initiating client's local game queue drained. It
does **not** prove that a joining client has presented its final pixels. The UI
therefore says that joined clients may still be rendering after a host-side
completion.

## Bounded Cancellation

Cancellation is designed to stop future work, not to rewrite game state:

- Before each paired server/local commit, the exact local component queue is
  read. Only enough strokes to keep `queued + nextBatch <= configuredBatchLimit`
  are submitted.
- Once a cancel is latched, no later server RPC or local enqueue starts.
- Already committed work, at most one configured batch ahead locally, drains
  naturally through the game queue before the terminal result is emitted.
- The implementation never calls `ClearRecordedStrokes`, rewrites queue memory,
  or attempts to purge remote queues.
- The terminal UI text is simply `Paint: canceled.`; pending acknowledgement is
  `Paint: cancel requested.`

On the host, a 400-stroke run at 20/50 with cancellation after three seconds
submitted 204 paired strokes, left 196 unsubmitted, never exceeded the 20-stroke
local queue cap, and terminalized only after two zero-queue observations. This
verifies host-local cancellation behavior. It does not retroactively stop work
already delivered to a joining client.

## Joining-Client Throughput

In a host plus Hyper-V joining-client comparison with variable colors and 400
planned strokes:

| Measurement | Observed result |
| --- | ---: |
| Host sender at 20/50 | about 272 strokes/s |
| Joining-client renderer drain | about 30--31.5 strokes/s |
| Host local renderer drain | about 54.7 strokes/s |

The sender stayed within its configured transport contract, but it outran the
joining client's game-owned renderer, so a remote backlog was expected. This
does not prove that Hyper-V alone caused the difference; it has not been
repeated on comparable physical joining hardware.

There is intentionally no profile that slows a host to the slowest receiver.
That policy cannot resolve the reciprocal case where a joining client initiates
paint, and it would require receiver-specific acknowledgements that the current
route does not provide.

In a later session, a fresh joining-client observer saw zero
`MulticastPackedPaintBatch` calls for 60 seconds. That session therefore did
not establish a valid multiplayer delivery path, and no remote cancel or PNG
claim was made from it. Confirm the game topology before repeating a
joining-client measurement.

## Brush 2 Seam Finding

The apparent oversized Brush 2 mark at the arm/torso seam is not Brush 1
leaking into the fine pass. A one-stroke Fine-pass experiment showed the
expected Brush 2 planner and packed-wire radius, and no packed batch crossed a
pass boundary.

The packed receiver instead applies a world-space sphere that can reach a
physically adjacent but separate UV island. In the measured case, the direct
UV reference produced one 314-texel blob; the packed host and joining receiver
both produced the same two blobs totaling 298 texels. Reducing the global
packed radius removed the cross-island mark only by reducing coverage to about
10% of the direct reference.

The current packed record has no UV-island clip field. A silent radius reduction,
stroke skip, or direct-UV fallback would trade the seam for underpaint and is
not a production fix. A real fix requires a validated UV-island-clipped packed
primitive, or an explicitly accepted coverage-erosion policy.

## Rejected Texture Multicast Candidate

`MulticastSyncChannelData` was tested only as a research candidate while the
host queue was empty. The host could execute a local 4 MiB Albedo loopback,
change one deterministic texel, and restore the original hash. A VM observer
received zero `MulticastSyncChannelData` calls during a 60-second discovery
window.

Therefore this call is **not validated as multiplayer transport** in this game.
The experiment was stopped before compression, other channels, queued-paint
mixing, or any fallback work. Its sender, runner option, and native command are
not part of the source or release path.

## Release Boundary

Before making a multiplayer release claim, collect fresh evidence for both
host-initiated and joining-client-initiated paint:

1. Verify the players are on the intended multiplayer topology.
2. Capture event-watch evidence for packed delivery and absence of legacy
   fallback routes.
3. Record sender counts, local queues, joining queues, and queue-zero times.
4. Export the selected texture before and after queue drain, and retain a
   changed-texel image rather than relying on checksum inequality alone.
5. Keep host-local terminal and remote visual completion as separate facts.

Do not claim EOS packet-level behavior, loss recovery, or remote GPU
presentation without measurements that specifically prove those properties.
