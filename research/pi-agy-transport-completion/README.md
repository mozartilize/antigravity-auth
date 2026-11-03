# Pi Antigravity response-completion investigation

Date: 2026-10-22  
Repository base: `d28fca6` (`release: v3.0.10`)  
Affected package: `@cortexkit/antigravity-auth-core`  
Observed through: `@cortexkit/pi-antigravity-auth` 3.0.10

## Executive summary

Pi appeared to hang, or sometimes exited successfully without output, when the
Antigravity backend returned a complete response on a persistent HTTP/1.1
connection. The first reported case was a Claude 5.5 quota error: the `agy` CLI
returned HTTP 429 immediately, while Pi emitted only the start of an assistant
message and did not surface the error.

The defect was in the custom `agy` HTTP transport, not in model selection,
OAuth, subscription tier, or the provider's interpretation of the 429. The
transport recognized the end of both content-length and chunked bodies, and its
decoders ended the readable side with `this.push(null)`. That leaves the
writable side open, which is correct for a keep-alive connection: the peer holds
the socket open for the next response. But Node's `Readable.toWeb()` completes
only when the whole Node stream closes, so consumers such as `Response.text()`
and `Response.json()` stayed pending on a body that had already fully arrived.

The fix is additive and lives at the single Node-to-Web conversion point in
`buildResponseStream()`. The decoders keep their existing readable-only end. A
new `toAgyBodyStream()` helper finishes the writable side once the readable side
has ended, so the Node stream completes and closes through its normal lifecycle
while the connection stays usable. `buildResponseStream()` keeps its previous
socket and abort handling.

The fix applies to both framing modes at once, because one helper wraps every
body decoder. Regression tests cover both HTTP body-framing modes, an open peer
connection, a closed peer connection, and one 300 KB body.

After the fix:

- Claude quota exhaustion reaches Pi as the backend's HTTP 429
  `RESOURCE_EXHAUSTED` error.
- `MODEL_PLACEHOLDER_M400` reaches Claude Opus 5.5 Low and reports quota
  exhaustion instead of hanging.
- `MODEL_PLACEHOLDER_M20` no longer completes silently; it reports that the
  response ended without a terminal candidate. The route maps to retired
  Gemini 3.5 Flash Medium, not Gemini 3.8 Flash.
- Gemini 3.8 Flash Medium (`M319`) still succeeds.

Pi still takes approximately 18–20 seconds to display retryable failures because
its agent loop performs three automatic attempts. That delay is separate from
the transport deadlock fixed here.

## User-visible symptoms

### Claude Sonnet and Opus 5.5

The Google Pro account used for the investigation had exhausted its Claude
weekly allowance. The direct CLI made the backend state clear:

```text
RESOURCE_EXHAUSTED (code 429): Individual quota reached.
Please upgrade your subscription to increase your limits.
```

The upgrade wording is generic backend text and does not prove that the account
lacks a paid subscription. The account was already Google Pro; its weekly
Claude allocation was exhausted.

With Pi and the unmodified transport, the equivalent request reached
`streamGenerateContent` and received the same HTTP 429, but Pi did not receive a
completed response body. In JSON mode, the observable sequence stopped after
`message_start`. In text mode, the command appeared to hang.

### Placeholder routes

Two opaque route identifiers were checked separately:

| Identifier | Resolved route | Result after transport fixes |
| --- | --- | --- |
| `MODEL_PLACEHOLDER_M400` | Claude Opus 5.5 Low | Visible HTTP 429 `RESOURCE_EXHAUSTED`; blocked by the account's weekly Claude quota |
| `MODEL_PLACEHOLDER_M20` | Gemini 3.5 Flash Medium | Visible terminal-candidate error; backend route is no longer available |
| `M319` | Gemini 3.8 Flash Medium | Successful response: `OK` |

`M20` is not a Gemini 3.8 route. Gemini 3.8 Flash uses `M318`, `M319`, and
`M320` for high, medium, and low thinking levels respectively.

## Why issue #35 did not resolve this symptom

The behavior was initially compared with
[cortexkit/antigravity-auth#35](https://github.com/cortexkit/antigravity-auth/issues/35)
and its fix commit
[`fb9eb2f`](https://github.com/cortexkit/antigravity-auth/commit/fb9eb2f32d1819bf47a32d2ce73c548930ff4759).
That change addresses model-unavailable handling. The failing Claude request in
this investigation was different: the backend returned a complete HTTP 429
quota response, but the transport never made the completed body observable to
the Web Stream consumer. Model-unavailable error mapping cannot run while body
parsing is still pending.

## Request path

The relevant request path is:

1. `@cortexkit/pi-antigravity-auth` registers the Antigravity-backed `google`
   provider.
2. The provider calls the core streaming implementation.
3. Core sends `streamGenerateContent` through the custom `agy` transport.
4. The transport parses the HTTP response head and selects a body decoder:
   - `ContentLengthStream` for a known `Content-Length`, or
   - `ChunkedDecodeStream` for `Transfer-Encoding: chunked`.
5. `buildResponseStream()` converts the Node stream with `Readable.toWeb()`.
6. A standard `Response` consumes that Web Stream body.

The server uses persistent HTTP/1.1 connections. Therefore, response-body
completion must come from HTTP framing; waiting for the socket to close is not
valid.

## Root cause

### Content-length responses

`ContentLengthStream` tracks the number of bytes still expected. On reaching
zero it calls:

```ts
this.push(null)
```

That marks the readable side as ended, but it does not end the transform's
writable side. Node's `Readable.toWeb()` waits for the whole stream to close, so
it kept its consumer pending even though every declared body byte had arrived.
The decoder code itself is correct and now unchanged; the missing writable-side
finish is supplied by the conversion helper.

This path explains the original Claude quota symptom: the backend sent a finite
JSON error body with a declared length and kept the connection alive.

### Chunked responses

`ChunkedDecodeStream` ends the readable side the same way when it parses the
terminal zero-size chunk. This produced the silent Pi completion observed on
routes such as `M20`: the parser knew the HTTP body was finished, but the Web
Stream consumer never observed full stream completion.

### Which server-side change exposed it

The bug is latent: it only becomes observable when the peer stops providing a
second completion signal. Two candidate causes were tested directly against the
real decoders, crossing both framings with both connection lifetimes and with
the conversion applied both before the fix (plain `Readable.toWeb()`) and after
it (`toAgyBodyStream()`), as reported by
`probes/framing-lifetime-matrix.mjs`:

| Framing | Connection | plain `Readable.toWeb()` | `toAgyBodyStream()` |
| --- | --- | --- | --- |
| content-length | peer keeps socket open | hangs | completes |
| content-length | peer closes socket | completes | completes |
| chunked | peer keeps socket open | hangs | completes |
| chunked | peer closes socket | completes | completes |

Framing is irrelevant. Connection lifetime alone decides the outcome, because
closing the socket finishes the writable side and hides the readable-only end.
Content-Length versus chunked framing, on its own, cannot produce this hang.

The revert check against the package test file agrees: removing the
writable-side finish from `toAgyBodyStream()` gives 15 passes and 2 failures,
and the two failures are exactly the keep-alive completion tests. See
`results/old-code-revert-check.txt`.

Node's own event trace shows the mechanism. With an open socket and no
writable-side finish, the decoder emits only `end`; `finish` and `close` never
arrive, and the stream stays open. With the fix, the decoder emits `end`, then
`finish`, then `close`.

### The Node/bun difference that hid this

Node's `Readable.toWeb()` waits for the Node stream to close. bun's adapter
completes on the readable `end` event. This investigation ran the package test
suite under bun and the transport under Node, so the same code stalls in
production and completes in the test runner.

A bun test therefore cannot reproduce the stall itself. The bun tests assert the
stream state that stalls Node — the body arrives, the readable side ends, and the
Node stream is closed by the fix while plain `Readable.toWeb()` leaves it open.
The stall is proven by `probes/framing-lifetime-matrix.mjs`, which imports the
real transport source and must be run under Node.

### Why the fix finishes the writable side

A first attempt completed the Web stream by destroying the Node stream when the
readable side ended. Under Node that fails:

```text
AbortError: The operation was aborted
  [cause]: Error [ERR_STREAM_PREMATURE_CLOSE]: Premature close
```

Destroying the stream while its writable side is still open is a premature close
as far as the adapter is concerned. Finishing the writable side instead lets the
stream complete and close through its normal lifecycle, and the body is
delivered intact. A 300 KB body and a 128 KB chunked body were both verified
byte-for-byte.

## Source changes

### `packages/core/src/agy-transport.ts`

Both body decoders are unchanged. `ContentLengthStream` and
`ChunkedDecodeStream` keep their existing `this.push(null)` completion;
body validation, trailing-byte handling, and decoded output are untouched.

One helper is added, and `buildResponseStream()` uses it for the single
Node-to-Web conversion:

```ts
export function toAgyBodyStream(readable: Duplex): ReadableStream<Uint8Array> {
  const webStream = Readable.toWeb(
    readable,
  ) as unknown as ReadableStream<Uint8Array>
  const finishWritableSide = () => {
    if (!readable.writableEnded && !readable.destroyed) readable.end()
  }
  if (readable.readableEnded) {
    finishWritableSide()
  } else {
    readable.once('end', finishWritableSide)
  }
  return webStream
}
```

`buildResponseStream()` now declares its body as `Duplex` and returns
`toAgyBodyStream(responseBody)`. Wrapping the final body stream rather than each
decoder means the completion requirement cannot be forgotten when a decoder or a
body filter is added later.

`ChunkedDecodeStream` is now exported so the regression test can drive it
directly; `ContentLengthStream` was already exported. Both reach the package
surface through the existing `export * from './agy-transport.ts'`.

### `packages/core/src/agy-transport.test.ts`

Seventeen tests run in this file, five of which cover response completion. Each
completion test builds a decoder, pipes it from an upstream socket stream,
converts it through `toAgyBodyStream()`, and consumes it through
`Response.text()`. Each requires the body promise to settle within 250 ms.

The `body completion while the peer holds the connection open` block contains:

- a content-length body that completes while `socket.writableEnded === false`;
- a chunked body that completes while `socket.writableEnded === false`;
- a 300 KB body delivered intact, which guards against the writable-side finish
dropping unread bytes;
- `completes both framings when the peer closes`, the path that used to hide the
defect;
- `leaves the Node stream open after a readable-only end through plain
Readable.toWeb()`, which pins the stream state that stalls Node.

The `ChunkedDecodeStream` block additionally decodes a body through the same
conversion helper. These tests do not depend on the remote service, credentials,
quota state, or real network socket-close timing.

## Verification

The final source passed the following gates:

```text
core build:                         passed
core TypeScript typecheck:          passed
agy-transport.test.ts:              17 passed, 0 failed
Biome check of both changed files:  passed
Git whitespace check:               passed
Node framing/lifetime matrix:       passed, exit 0
```

The focused test run completed in approximately 198 ms. Removing the
writable-side finish from `toAgyBodyStream()` turns the same file into 15 passes
and 2 failures, which is the discriminating check recorded in
`results/old-code-revert-check.txt`.

The full core suite has 33 pre-existing failures, confined to account-store,
management, roster, and repository suites that load a `../../dist/index.js`
fixture. The same 33 failures occur with the unmodified `HEAD` version of both
changed files; this change adds six passing tests and alters none of them.

### Live provider checks

Live checks used Pi in non-interactive mode with no tools and a short prompt,
run under Node against the local `packages/pi` build with no other extensions
loaded.

```text
Claude Sonnet 5.5 / google/antigravity-claude-sonnet-5-5
exit:     1
elapsed:  21 seconds
result:   HTTP 429 RESOURCE_EXHAUSTED, individual quota reached

Gemini 3.8 Flash Medium / google/antigravity-gemini-3.8-flash
run 1:    exit 0, 5 seconds, stdout "OK"
run 2:    exit 0, 6 seconds, stdout "OK"

M400 / Claude Opus 5.5 Low
exit:     1
elapsed:  approximately 18 seconds
result:   HTTP 429 RESOURCE_EXHAUSTED, individual quota reached

M20 / Gemini 3.5 Flash Medium
exit:     1
elapsed:  approximately 19 seconds
result:   Antigravity stream ended without a terminal candidate response

M319 / Gemini 3.8 Flash Medium
exit:     0
elapsed:  approximately 5 seconds
stdout:   OK
```

The Gemini runs matter for the boundary fix: a successful streaming response
travels the same conversion helper, and it still completes normally with the
decoders untouched.

A successful Claude generation could not be tested because the live account's
Claude quota had not reset. The live 429 is nevertheless sufficient to verify
the affected error-body completion path: Pi now receives, parses, retries, and
surfaces the complete backend response.

## Why errors still take about 18 seconds

Once body completion was repaired, Pi classified the resulting provider error
as retryable and made three attempts. The transport now completes each attempt;
the remaining delay is retry policy rather than a stalled body read.

A possible follow-up is to classify a response containing `Individual quota
reached` and a long reset interval as permanent for the current run. That is
not part of this transport fix because retry classification belongs to Pi's
agent/retry layer and can affect other providers and transient 429 responses.

## Preserved diagnostic artifacts

The proxy, probes, and useful outputs are stored beside this report:

```text
proxy/
  README.md
  capture_antigravity.py
probes/
  README.md
  content-length-webstream.mjs
  chunked-webstream.mjs
  framing-lifetime-matrix.mjs
  live-transport.mjs
results/
  README.md
  claude-sonnet-after.txt
  framing-lifetime-matrix.txt
  gemini-stream-after.txt
  model-route-checks.txt
  old-code-revert-check.txt
  proxy-claude-429.sanitized.jsonl
  transport-stall-before.sanitized.txt
  verification.txt
  webstream-probes.txt
```

`framing-lifetime-matrix.mjs` is the primary probe. It imports the real
transport source, compares plain `Readable.toWeb()` against `toAgyBodyStream()`
across both framings and both connection lifetimes, asserts the table above, and
exits non-zero on any other outcome. It must run under Node.

`content-length-webstream.mjs` and `chunked-webstream.mjs` are older offline
witnesses. They compare `push(null)` against a deferred decoder-level `end()`,
which was an earlier revision of this fix; the shipped fix keeps the decoders
unchanged and handles completion at the conversion boundary instead. They remain
as a record of the decoder-level mechanism. `live-transport.mjs` is a sanitized
version of the direct transport probes and requires a short-lived token supplied
through the environment.

The mitmproxy addon is also sanitized. The original temporary addon logged the
first six request headers, which included a live OAuth bearer token, and its
raw capture also contained an account email, request IDs, prompts, and system
instructions. Those raw files, generated CA material, and private keys were not
copied. `results/proxy-claude-429.sanitized.jsonl` retains the HTTP framing and
complete backend error needed for this diagnosis without those credentials or
personal fields.

See the README files in each subdirectory for reproduction and provenance.

## Local package installation

The repository root is a private workspace aggregator, not the Pi extension
package. It has no root `pi.extensions` manifest, so loading the repository root
as an extension produces a module-not-found error.

The loadable package is `packages/pi`. Local Pi packages are not built or have
their dependencies installed by Pi, so build the workspace first:

```bash
cd /home/mozart/Documents/workspace/zip-research/antigravity-auth

bun install --frozen-lockfile
bun run --cwd packages/core build
bun run --cwd packages/pi build
```

Test the local package for one invocation:

```bash
pi -ne \
  -e "$PWD/packages/pi" \
  --model google/antigravity-gemini-3.8-flash \
  --thinking medium \
  --no-session --no-tools \
  -p 'Reply with exactly OK'
```

That command was run after the build and returned exactly `OK`.

For a persistent personal installation, remove the npm copy first so two
extensions do not both register the `google` provider:

```bash
pi remove npm:@cortexkit/pi-antigravity-auth
pi install "$PWD/packages/pi"
```

After changing core transport source, rebuild both core and Pi before testing:

```bash
bun run --cwd packages/core build
bun run --cwd packages/pi build
```

Pi loads the child package's `dist/index.js`, and its workspace dependency on
`@cortexkit/antigravity-auth-core` resolves to the locally built core package.

## Temporary-runtime caveat

Direct edits to copies under `~/.pi/agent/npm/node_modules` or
`~/.pi/agent/tmp/extensions` are useful for diagnosis but are not durable.
Package reconciliation, cache cleanup, or an npm update can replace them. The
source changes in this repository, followed by a local `packages/pi` build and
installation, are the reproducible form of the fix.

## Scope and remaining limitations

Fixed:

- completion of exact-length response bodies on keep-alive connections;
- completion of chunked response bodies at the zero chunk;
- visibility of the observed Claude quota error;
- silent completion observed on the `M20` route;
- body completion for every decoder and body filter, from one conversion point;
- regression coverage through Node's Web Stream adapter, plus a Node-only probe
for the stall that bun cannot reproduce.

Not changed or not proven:

- Pi's three-attempt retry policy;
- backend quota allocation or reset behavior;
- availability of retired model routes such as Gemini 3.5 Flash;
- successful Claude generation during the original quota-limited tests (verified
  after quota recovery in the follow-up below);
- the model-unavailable behavior addressed independently by issue #35.

## Follow-up: tools-enabled Claude hangs after quota recovery (2026-10-28)

Plain CLI invocations of both Sonnet and Opus hung with all extensions enabled,
while `--no-tools` and Antigravity's own CLI succeeded. Transport tracing (only
connection milestones, byte counts and HTTP statuses; no credentials or bodies)
showed that the generation request had already received **HTTP 400**. The
installed npm **3.0.15** core still used plain `Readable.toWeb(responseBody)`;
it did not contain this repository's uncommitted body-completion fix. Applying
that fix made the error body visible instead of leaving the CLI waiting.

The visible error was `tools.12.custom.input_schema`: Claude rejected a tool
schema. A single synthetic tool reproduced it with a string-or-object `anyOf`
argument, as used by the MCP gateway. An otherwise identical tool with only an
integer bound (`minimum`/`maximum`) succeeded. The user's separate invocation
loading only Antigravity and `pi-auto-model-router` also reproduced a schema
rejection at `tools.4.custom.input_schema`. This is schema compatibility in the
AGY Claude bridge, not evidence that extension execution intercepted the call.

`packages/pi/src/convert.ts` now selects the existing core `claudeValidated`
schema adaptation for Claude models. It flattens unsupported unions and retains
string-literal alternatives as one enum. Gemini retains its existing schema
conversion. No changes were made to `pi-auto-model-router`.

Runtime repairs were applied to both the personal npm install (3.0.15) and the
separate explicit-`-e npm:` temporary install (3.0.10). These repairs are not an
upstream release and can be overwritten by package updates. The source fix and
tests are in this repository; see the local installation procedure above.

Verification after the repairs:

- Plain CLI, all configured extensions: Opus and Sonnet each returned `OK`,
  exit 0, about 8 seconds.
- Actual Bash tool round-trips: both models returned `TOOL_OK`, exit 0, about
  9 seconds.
- Gemini 3.8 Flash with all extensions: `OK`, exit 0, about 8 seconds.
- The user's exact `-ne -e npm:@cortexkit/pi-antigravity-auth -e
  ~/Documents/workspace/pi-auto-model-picker/pi-auto-model-router` Opus setup:
  greeting returned, exit 0, about 5 seconds.
- Pi package suite: 167 passed; combined converter, stream and transport checks:
  114 passed. Both package typechecks and builds passed.
- Node framing/lifetime matrix: plain conversion hangs on both keep-alive
  framings; the boundary fix completes all rows without changing the decoders.

The existing transport tests referenced a missing `resolvesWithin` helper after
upstream updates; the helper was restored so the completion assertions execute.
The pi-web service was inspected but **not restarted or end-to-end tested** in
this follow-up: the user requested CLI verification first. A running service
must reload its extension code before it can use these runtime repairs.
