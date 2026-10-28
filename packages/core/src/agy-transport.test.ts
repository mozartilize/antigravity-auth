import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as net from 'node:net'
import { PassThrough, Readable } from 'node:stream'

import {
  buildAgyCliHeaderPairs,
  ChunkedDecodeStream,
  ContentLengthStream,
  DEFAULT_AGY_IDLE_TIMEOUT_MS,
  DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS,
  fetchWithAgyCliTransport,
  toAgyBodyStream,
} from './agy-transport.ts'

type AgyWireFixture = {
  capture: {
    version: string
    endpoint: string
    httpVersion: string
  }
  headers: Array<[string, string]>
  envelopeKeys: string[]
  requestKeys: string[]
}

const AGY_1_1_24_WIRE_FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      '../../../test-fixtures/agy-cli-1.1.24-stream-request.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as AgyWireFixture

const savedProxyEnv = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
}

function restoreProxyEnv(): void {
  for (const [key, value] of Object.entries(savedProxyEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function disableProxyEnv(): void {
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  delete process.env.ALL_PROXY
  delete process.env.all_proxy
  process.env.NO_PROXY = '*'
  process.env.no_proxy = '*'
}

function setProxyEnv(port: number): void {
  process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`
  delete process.env.https_proxy
  delete process.env.ALL_PROXY
  delete process.env.all_proxy
  delete process.env.NO_PROXY
  delete process.env.no_proxy
}

type SocketProbe = {
  server: net.Server
  accepted: Promise<net.Socket>
  peerClosed: Promise<void>
  getPeer(): net.Socket | undefined
}

function createSocketProbe(
  onData: (socket: net.Socket, chunk: Buffer) => void = () => {},
): SocketProbe {
  let peer: net.Socket | undefined
  let acceptPeer: (socket: net.Socket) => void
  let markPeerClosed: () => void
  const accepted = new Promise<net.Socket>((resolve) => {
    acceptPeer = resolve
  })
  const peerClosed = new Promise<void>((resolve) => {
    markPeerClosed = resolve
  })
  const server = net.createServer((socket) => {
    peer = socket
    socket.on('data', (chunk) => onData(socket, chunk))
    socket.once('close', () => markPeerClosed())
    acceptPeer(socket)
  })
  return { server, accepted, peerClosed, getPeer: () => peer }
}

async function listen(server: net.Server, host: string): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

async function closeSocketProbe(probe: SocketProbe): Promise<void> {
  probe.getPeer()?.destroy()
  await closeServer(probe.server)
}

async function resolvesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function collect(
  stream: ContentLengthStream,
  inputs: Buffer[],
): Promise<Buffer> {
  const chunks: Buffer[] = []
  stream.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((resolve) => stream.on('end', resolve))
  for (const input of inputs) stream.write(input)
  stream.end()
  await done
  return Buffer.concat(chunks)
}

describe('agy transport', () => {
  afterEach(() => {
    restoreProxyEnv()
  })

  it('has bounded default header and idle timeouts', () => {
    expect(DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS).toBe(180_000)
    expect(DEFAULT_AGY_IDLE_TIMEOUT_MS).toBe(180_000)
  })

  it('serializes the captured agy CLI 1.1.24 stream header contract', () => {
    const pairs = buildAgyCliHeaderPairs(
      AGY_1_1_24_WIRE_FIXTURE.capture.endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'User-Agent':
            'antigravity/cli/1.1.24 (aidev_client; os_type=darwin; arch=arm64; cl=974782877; auth_method=consumer)',
          'Accept-Encoding': 'gzip',
          'x-opencode-session-id': 'synthetic-child',
          'x-opencode-parent-session-id': 'synthetic-parent',
        },
        body: JSON.stringify({ request: { contents: [] } }),
      },
    ).map(([name, value]) => [
      name,
      name === 'Authorization' ? '<redacted>' : value,
    ])

    expect(AGY_1_1_24_WIRE_FIXTURE.capture).toMatchObject({
      version: '1.1.24',
      httpVersion: 'HTTP/1.1',
    })
    expect(pairs).toEqual(AGY_1_1_24_WIRE_FIXTURE.headers)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchWithAgyCliTransport(
        'https://example.com/x',
        { method: 'POST' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/i)
  })

  it('destroys a direct TLS connection when aborted', async () => {
    disableProxyEnv()
    const probe = createSocketProbe()
    const port = await listen(probe.server, 'localhost')
    const controller = new AbortController()
    const request = fetchWithAgyCliTransport(
      `https://localhost:${port}/v1internal:streamGenerateContent`,
      { method: 'POST' },
      { signal: controller.signal, timeoutMs: 2_000 },
    )

    try {
      await probe.accepted
      controller.abort()
      await expect(request).rejects.toThrow(/aborted/i)
      await probe.peerClosed
    } finally {
      await closeSocketProbe(probe)
    }
  })

  it('destroys a proxy connection when aborted before CONNECT responds', async () => {
    const probe = createSocketProbe()
    const port = await listen(probe.server, '127.0.0.1')
    setProxyEnv(port)
    const controller = new AbortController()
    const request = fetchWithAgyCliTransport(
      'https://example.com/v1internal:streamGenerateContent',
      { method: 'POST' },
      { signal: controller.signal, timeoutMs: 2_000 },
    )

    try {
      await probe.accepted
      controller.abort()
      await expect(request).rejects.toThrow(/aborted/i)
      await probe.peerClosed
    } finally {
      await closeSocketProbe(probe)
    }
  })

  it('destroys a tunneled TLS connection when aborted during handshake', async () => {
    let connected = false
    let markTunnelStarted: () => void
    const tunnelStarted = new Promise<void>((resolve) => {
      markTunnelStarted = resolve
    })
    const probe = createSocketProbe((socket) => {
      if (!connected) {
        connected = true
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        return
      }
      markTunnelStarted()
    })
    const port = await listen(probe.server, '127.0.0.1')
    setProxyEnv(port)
    const controller = new AbortController()
    const request = fetchWithAgyCliTransport(
      'https://example.com/v1internal:streamGenerateContent',
      { method: 'POST' },
      { signal: controller.signal, timeoutMs: 2_000 },
    )

    try {
      await tunnelStarted
      controller.abort()
      await expect(request).rejects.toThrow(/aborted/i)
      await probe.peerClosed
    } finally {
      await closeSocketProbe(probe)
    }
  })

  it('times out while waiting for response headers', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        // Accept the connection but never respond.
      })
    })
    const port = await listen(server, '127.0.0.1')
    setProxyEnv(port)

    const debugLines: string[] = []
    try {
      await expect(
        fetchWithAgyCliTransport(
          'https://example.com/v1internal:streamGenerateContent',
          {
            method: 'POST',
            headers: {
              'User-Agent':
                'antigravity/cli/1.1.24 (aidev_client; os_type=darwin; arch=arm64; cl=974782877; auth_method=consumer)',
            },
            body: JSON.stringify({ x: 1 }),
          },
          {
            timeoutMs: 20,
            onDebug: (line) => debugLines.push(line),
          },
        ),
      ).rejects.toThrow(
        'Antigravity request timed out waiting for response headers after 20ms',
      )

      expect(
        debugLines.some((l) =>
          l.includes('proxy CONNECT response timeout after 20ms'),
        ),
      ).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it('rejects when the peer closes before response headers', async () => {
    const probe = createSocketProbe((socket) => {
      socket.end()
    })
    const port = await listen(probe.server, '127.0.0.1')
    setProxyEnv(port)
    const request = fetchWithAgyCliTransport(
      'https://example.com/v1internal:streamGenerateContent',
      { method: 'POST', body: '{}' },
      { timeoutMs: 750 },
    ).catch((error: unknown) => error)

    try {
      const error = await request
      await probe.peerClosed
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(
        'Socket closed before response headers',
      )
    } finally {
      await closeSocketProbe(probe)
      await request
    }
  })

  describe('ChunkedDecodeStream', () => {
    it('decodes the body and ends at the zero chunk', async () => {
      const stream = new ChunkedDecodeStream()
      const body = new Response(toAgyBodyStream(stream)).text()

      stream.write(Buffer.from('5\r\nhello\r\n0\r\n\r\n'))

      try {
        expect(await resolvesWithin(body, 250)).toBe(true)
        expect(await body).toBe('hello')
        expect(stream.readableEnded).toBe(true)
      } finally {
        stream.destroy()
      }
    })
  })

  describe('ContentLengthStream', () => {
    it('emits exactly contentLength bytes and ends', async () => {
      const out = await collect(new ContentLengthStream(5), [
        Buffer.from('hello'),
      ])
      expect(out.toString()).toBe('hello')
    })

    it('discards trailing bytes belonging to the next keep-alive response', async () => {
      const out = await collect(new ContentLengthStream(5), [
        Buffer.from('helloEXTRA_NEXT_RESPONSE'),
      ])
      expect(out.toString()).toBe('hello')
    })

    it('reassembles a body split across chunks', async () => {
      const out = await collect(new ContentLengthStream(6), [
        Buffer.from('foo'),
        Buffer.from('bar'),
        Buffer.from('baz'),
      ])
      expect(out.toString()).toBe('foobar')
    })
  })

  describe('body completion while the peer holds the connection open', () => {
    // A quota error carries a complete body while the TLS socket stays open for
    // the next keep-alive response, so only the readable side ever ends. The
    // body must still reach the consumer.

    it('completes a content-length body before the peer closes', async () => {
      const socket = new PassThrough()
      const stream = new ContentLengthStream(5)
      socket.pipe(stream)

      const body = new Response(toAgyBodyStream(stream), {
        headers: { 'Content-Length': '5' },
        status: 429,
      }).text()

      socket.write(Buffer.from('hello'))

      try {
        expect(await resolvesWithin(body, 250)).toBe(true)
        expect(await body).toBe('hello')
        expect(socket.writableEnded).toBe(false)
        expect(stream.readableEnded).toBe(true)
        // Node's Readable.toWeb() completes on stream close, so the body stream
        // must be closed even though the peer still holds the socket open.
        expect(stream.destroyed).toBe(true)
      } finally {
        socket.destroy()
        stream.destroy()
      }
    })

    it('completes a chunked body before the peer closes', async () => {
      const socket = new PassThrough()
      const stream = new ChunkedDecodeStream()
      socket.pipe(stream)

      const body = new Response(toAgyBodyStream(stream)).text()

      socket.write(Buffer.from('5\r\nhello\r\n0\r\n\r\n'))

      try {
        expect(await resolvesWithin(body, 250)).toBe(true)
        expect(await body).toBe('hello')
        expect(socket.writableEnded).toBe(false)
        expect(stream.readableEnded).toBe(true)
        expect(stream.destroyed).toBe(true)
      } finally {
        socket.destroy()
        stream.destroy()
      }
    })

    // Finishing the writable side on 'end' must not drop body bytes that the
    // Web consumer has not read yet.
    it('delivers a large body intact when the readable side ends early', async () => {
      const payload = 'x'.repeat(300_000)
      const socket = new PassThrough()
      const stream = new ContentLengthStream(payload.length)
      socket.pipe(stream)

      const body = new Response(toAgyBodyStream(stream), {
        headers: { 'Content-Length': String(payload.length) },
        status: 429,
      }).text()

      socket.write(Buffer.from(payload))

      try {
        expect(await resolvesWithin(body, 250)).toBe(true)
        expect(await body).toBe(payload)
        expect(socket.writableEnded).toBe(false)
      } finally {
        socket.destroy()
        stream.destroy()
      }
    })

    // Why toAgyBodyStream exists: the decoders keep their readable-only end, so
    // the Node stream stays open. Node's Readable.toWeb() then waits for a close
    // that never arrives, and the body read stalls. bun's adapter completes on
    // the readable 'end' event instead, so this test asserts the stream state
    // that stalls Node rather than the stall itself; the stall is proven under
    // Node by probes/framing-lifetime-matrix.mjs.
    it('leaves the Node stream open after a readable-only end through plain Readable.toWeb()', async () => {
      const socket = new PassThrough()
      const stream = new ContentLengthStream(5)
      socket.pipe(stream)

      const body = new Response(
        Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      ).text()
      body.catch(() => undefined)

      socket.write(Buffer.from('hello'))

      try {
        expect(await resolvesWithin(body, 100)).toBe(true)
        expect(stream.readableEnded).toBe(true)
        expect(stream.writableFinished).toBe(false)
        expect(stream.destroyed).toBe(false)
        expect(socket.writableEnded).toBe(false)
      } finally {
        socket.destroy()
        stream.destroy()
      }
    })

    // Closing the connection finished the writable side for free, which is why
    // the readable-only end stayed hidden until a peer kept the socket open.
    it('completes both framings when the peer closes', async () => {
      const cases: Array<
        [string, ContentLengthStream | ChunkedDecodeStream, Buffer]
      > = [
        ['content-length', new ContentLengthStream(5), Buffer.from('hello')],
        [
          'chunked',
          new ChunkedDecodeStream(),
          Buffer.from('5\r\nhello\r\n0\r\n\r\n'),
        ],
      ]

      for (const [name, stream, wire] of cases) {
        const socket = new PassThrough()
        socket.pipe(stream)
        const body = new Response(toAgyBodyStream(stream), {
          headers: { 'Content-Length': '5' },
          status: 429,
        }).text()

        socket.write(wire)
        socket.end()

        try {
          expect(await resolvesWithin(body, 250), name).toBe(true)
          expect(await body, name).toBe('hello')
        } finally {
          socket.destroy()
          stream.destroy()
        }
      }
    })
  })
})
