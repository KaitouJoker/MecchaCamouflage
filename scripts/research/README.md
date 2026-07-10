# Runtime Research Notes

This directory is for report-only or explicitly invoked runtime investigation
helpers. These scripts are not part of normal app startup, normal paint, or
release packaging.

Use this area for research notes and future authenticated clients. Standalone
fixed-port bridge probes were removed in v1.6: every direct bridge uses an
instance-selected port and requires the GUID/token HELLO handshake documented
in [`docs/runtime-direct-bridge.md`](../../docs/runtime-direct-bridge.md).
Do not reintroduce port scanning or unauthenticated command scripts.

The native research commands remain available to an explicitly authenticated
research client, while the automatic event-watch sidecar writes snapshots next
to the staged bridge when enabled by the research environment.

## Policy

- Keep production paint behavior out of `scripts/research/`.
- Keep generated research output under `artifacts/research/` or a local temp
  directory.
- Do not commit game archives, mappings, dumps, event-watch output, or bridge
  replay payloads.
- Prefer adding a documented authenticated research client over adding one-off
  command strings to user-facing UI.
