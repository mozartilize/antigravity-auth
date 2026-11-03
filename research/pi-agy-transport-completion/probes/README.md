# Transport probes

The primary probes run under **Node**, because Node's `Readable.toWeb()`
completes on Node stream close while bun's adapter completes on the readable
`end` event. Under bun the pre-fix conversion does not stall, so the defect is
not observable there.

## Framing and connection-lifetime matrix (Node)

Run from the repository root:

```bash
node research/pi-agy-transport-completion/probes/framing-lifetime-matrix.mjs
```

It imports the real decoders and `toAgyBodyStream()` from
`packages/core/src/agy-transport.ts` (Node strips the TypeScript types), then
runs both framings against a peer that keeps the socket open and a peer that
closes it, converting once through plain `Readable.toWeb()` and once through
`toAgyBodyStream()`. It asserts the expected matrix and exits non-zero on any
other outcome. No network and no credentials are used.

## Decoder-level mechanism witnesses

```bash
node research/pi-agy-transport-completion/probes/content-length-webstream.mjs
node research/pi-agy-transport-completion/probes/chunked-webstream.mjs
```

These compare `push(null)` against a deferred decoder-level `end()`. That was an
earlier revision of the fix. The shipped fix leaves the decoders unchanged and
handles completion in `toAgyBodyStream()`, so these two remain only as a record
of the underlying stream mechanism.

## Live transport probe

Build core first, provide a short-lived access token through the environment,
and select a backend model name if needed:

```bash
bun run --cwd packages/core build
PI_ANTIGRAVITY_ACCESS_TOKEN='...' \
  node research/pi-agy-transport-completion/probes/live-transport.mjs \
  claude-sonnet-5-5
```

The script prints the HTTP status and at most 4,000 response characters. It
sends a real request and consumes quota. Do not put the token on a shared shell
command line; the inline form above is shown only for brevity. Prefer exporting
it from a private shell or secret manager, then unsetting it after the run.

This is a sanitized, repository-runnable version of the temporary
`replay.mjs`, `body-state.mjs`, and `reader-trace.mjs` probes. Those temporary
scripts read the operator's Pi auth file directly and were not copied.

## Recorded outputs

- `../results/framing-lifetime-matrix.txt`
- `../results/webstream-probes.txt`
