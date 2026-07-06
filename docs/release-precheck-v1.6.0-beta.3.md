# v1.6.0-beta.3 Release Precheck

This checklist separates checks that can be completed without running the game
from checks that require the maintainer to run MECCHA CHAMELEON.

Do not tag or publish v1.6.0-beta.3 until the maintainer-owned game checks are
complete.

## Codex-Owned Checks

These do not require the game to be running.

- `git status --branch --short`
- `make review-dead-code`
- `make build`
- `make package`
- `git diff --check`
- Review `artifacts/review/runtime-dead-code/tool-availability.txt`.
- Review `artifacts/review/runtime-dead-code/legacy-fallbacks.txt`.
- Confirm release artifact is a single exe under `.build/package/`.
- Confirm build output embeds:
  - native bridge/injector
  - WebView2 Fixed Runtime
  - web assets
  - mesh profiles
- Confirm no release zip or loose WebView2 runtime is required.

## Maintainer-Owned Game Checks

These require the maintainer to run the game.

- Start app with no game running:
  - GUI initializes
  - error state is clear and diagnostic
  - no unhandled .NET dialog
- Start app with game at menu/lobby:
  - bridge connects or reports a clear state
  - paint in lobby fails as a paint-time pawn/component error, not startup error
- Start app with game in a valid paintable match:
  - preview applies
  - unpreview restores
  - repeated unpreview shows guard warning
  - cancel with no active paint shows guard warning
  - normal paint completes
  - progress shows packed pacing and queue/drain data
- Runtime cache repair:
  - delete LocalAppData runtime cache
  - start app
  - cache rebuilds automatically
  - fixed WebView2 starts from LocalAppData cache
- Injection lifecycle:
  - app restart against same game process does not double-inject unnecessarily
  - loaded-but-not-ready reports a diagnostic code instead of looping

## Multiplayer Checks

These require at least two normal multiplayer clients.

- Painter as host:
  - other players see final paint
  - painter completion time
  - other-client visible completion time
  - delay between the two
  - crashes/disconnects/freezes
- Painter as joining client:
  - other players see final paint
  - painter completion time
  - other-client visible completion time
  - delay between the two
  - server crash/disconnect behavior
- Event/watch expectation if available:
  - `ServerPackedPaintBatch > 0`
  - `SendCustomStrokeBatchToServer == 0`
  - `ServerRelayPackedStrokeBatch == 0`

## Release Gates

- Do not release if joining-client paint still crashes the server.
- Do not release if other clients finish closer to the old 2-3 minute path.
- Do not release if runtime cache/WebView2/injection startup errors cannot be
  diagnosed from copied diagnostics.
- Release can proceed only after the maintainer-owned game checks and at least
  one multiplayer verification pass are acceptable.
