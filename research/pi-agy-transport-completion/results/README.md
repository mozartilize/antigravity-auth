# Result bundle

These files preserve the useful outputs from the 2026-10-22 investigation.

| File | Meaning |
| --- | --- |
| `proxy-claude-429.sanitized.jsonl` | Actual Pi request/response captured through mitmproxy; bearer token, request IDs, prompt, and system prompt removed |
| `transport-stall-before.sanitized.txt` | Timeline showing the full 429 body arrived while the pre-fix transport remained unsettled |
| `framing-lifetime-matrix.txt` | Real decoders converted through plain `Readable.toWeb()` and through `toAgyBodyStream()`, crossed with both framings and both connection lifetimes, run under Node |
| `old-code-revert-check.txt` | The package test file with the writable-side finish removed from `toAgyBodyStream()`: 15 passed, 2 failed |
| `webstream-probes.txt` | Runs of the two decoder-level mechanism probes (`push(null)` versus deferred `end()`) |
| `claude-sonnet-after.txt` | Post-fix Claude Sonnet quota error and process result, run under Node |
| `gemini-stream-after.txt` | Post-fix successful streaming responses, which travel the same conversion helper |
| `model-route-checks.txt` | Post-fix M400, M20, and M319 live results |
| `verification.txt` | Build, typecheck, focused-test, formatter, whitespace, and matrix results |

## Runtime note

`framing-lifetime-matrix.txt` and the live checks were produced under Node.
Node's `Readable.toWeb()` waits for the Node stream to close, while bun's adapter
completes on the readable `end` event, so the stall is visible only under Node.
`old-code-revert-check.txt` was produced by `bun test`, where the discriminating
assertions are body delivery plus stream closure rather than the stall itself.

## Sanitization

The raw temporary capture is deliberately not copied. It contains an OAuth
bearer token, a Google account email address, request and trajectory IDs, and
full prompts. No private keys, certificates, auth files, tokens, cookies,
account email addresses, or raw request IDs belong in this directory.

Time-varying quota reset values are retained because they are part of the
observed backend error and are not credentials.
