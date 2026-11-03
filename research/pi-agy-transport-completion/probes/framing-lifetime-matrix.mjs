// Which server-side change could expose the completion bug, and does the
// boundary fix cover all of it?
//
// Hypothesis A: Google switched from chunked framing to Content-Length.
// Hypothesis B: Google kept the HTTP connection alive instead of closing it
//               promptly after the error response.
//
// The matrix runs the real decoders from
// packages/core/src/agy-transport.ts against both framings and both connection
// lifetimes, converted once through plain Readable.toWeb() and once through the
// fixed toAgyBodyStream().
//
//   node research/pi-agy-transport-completion/probes/framing-lifetime-matrix.mjs
//
// Node is required: Node's Readable.toWeb() waits for the whole Node stream to
// close, while bun's adapter completes on the readable 'end' event. Under bun
// the pre-fix column does not hang, so the hang is not observable there.
//
// Exit code 1 if the matrix differs from the expectation table below.

import { PassThrough, Readable } from 'node:stream'

import {
  ChunkedDecodeStream,
  ContentLengthStream,
  toAgyBodyStream,
} from '../../../packages/core/src/agy-transport.ts'

const BODY = 'hello'
const TIMEOUT_MS = 150
const SETTLE_MS = 50

const WIRE = {
  'content-length': Buffer.from(BODY),
  chunked: Buffer.from(`5\r\n${BODY}\r\n0\r\n\r\n`),
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), milliseconds))

// 'plain' is the conversion the transport used before the fix.
const CONVERSIONS = {
  plain: (readable) => Readable.toWeb(readable),
  fixed: toAgyBodyStream,
}

async function run({ framing, lifetime, conversion }) {
  const socket = new PassThrough()
  const stream =
    framing === 'chunked'
      ? new ChunkedDecodeStream()
      : new ContentLengthStream(BODY.length)

  socket.pipe(stream)

  // Settle rejections too: tearing down a stream whose web reader is still
  // pending rejects the body promise, and that rejection is expected here.
  const body = new Response(CONVERSIONS[conversion](stream), {
    headers:
      framing === 'content-length'
        ? { 'Content-Length': String(BODY.length) }
        : {},
    status: 429,
  })
    .text()
    .then(
      (text) => text,
      (error) => `error:${error.code ?? error.message}`,
    )

  socket.write(WIRE[framing])
  if (lifetime === 'close') socket.end()

  let text = await Promise.race([body, delay(TIMEOUT_MS)])
  if (text === 'timeout') text = await Promise.race([body, delay(SETTLE_MS)])

  const peerClosed = socket.writableEnded
  const nodeStreamClosed = stream.destroyed
  socket.destroy()
  stream.destroy()

  if (text === BODY) return { result: 'complete', peerClosed, nodeStreamClosed }
  if (text === 'timeout') return { result: 'HANG', peerClosed, nodeStreamClosed }
  return { result: String(text), peerClosed, nodeStreamClosed }
}

// The pre-fix conversion was correct whenever the peer closed the connection,
// because the socket close finished the decoder's writable side. Only a
// connection that stays open exposes the readable-only end.
const EXPECTED = {
  'content-length/keep-alive/plain': 'HANG',
  'content-length/keep-alive/fixed': 'complete',
  'content-length/close/plain': 'complete',
  'content-length/close/fixed': 'complete',
  'chunked/keep-alive/plain': 'HANG',
  'chunked/keep-alive/fixed': 'complete',
  'chunked/close/plain': 'complete',
  'chunked/close/fixed': 'complete',
}

const rows = []
let mismatches = 0
for (const framing of ['content-length', 'chunked']) {
  for (const lifetime of ['keep-alive', 'close']) {
    for (const conversion of ['plain', 'fixed']) {
      const key = `${framing}/${lifetime}/${conversion}`
      const outcome = await run({ framing, lifetime, conversion })
      const expected = EXPECTED[key]
      const ok = outcome.result === expected
      if (!ok) mismatches += 1
      rows.push({ framing, lifetime, conversion, ...outcome, ok })
    }
  }
}

const pad = (value, width) => String(value).padEnd(width)
console.log(
  `${pad('framing', 15)}${pad('connection', 12)}${pad('conversion', 12)}${pad('result', 10)}${pad('peer', 12)}node stream`,
)
for (const row of rows) {
  console.log(
    `${pad(row.framing, 15)}${pad(row.lifetime, 12)}${pad(row.conversion, 12)}${pad(row.result, 10)}${pad(row.peerClosed ? 'closed' : 'open', 12)}${row.nodeStreamClosed ? 'closed' : 'OPEN'}`,
  )
}

// Hypothesis A (framing) is refuted: the pre-fix conversion completes for both
// framings when the peer closes. Hypothesis B (connection lifetime) is
// confirmed, and the fixed conversion completes in every row.
const conclusion =
  mismatches === 0
    ? 'MATRIX MATCHES EXPECTATION: framing is irrelevant, connection lifetime decides, and the boundary fix covers every row'
    : `MATRIX MISMATCH: ${mismatches} row(s) differ from expectation`
console.log(`\nruntime: node ${process.versions.node}`)
console.log(conclusion)
process.exitCode = mismatches === 0 ? 0 : 1
