import { Readable, Transform } from 'node:stream'

class ChunkedStream extends Transform {
  buffer = Buffer.alloc(0)
  endMode

  constructor(endMode) {
    super()
    this.endMode = endMode
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const lineEnd = this.buffer.indexOf('\r\n')
      if (lineEnd === -1) break
      const size = Number.parseInt(this.buffer.subarray(0, lineEnd), 16)
      const chunkStart = lineEnd + 2
      const chunkEnd = chunkStart + size
      const nextOffset = chunkEnd + 2
      if (this.buffer.length < nextOffset) break
      if (size === 0) {
        this.buffer = Buffer.alloc(0)
        if (this.endMode === 'before') this.push(null)
        else process.nextTick(() => this.end())
        break
      }
      this.push(this.buffer.subarray(chunkStart, chunkEnd))
      this.buffer = this.buffer.subarray(nextOffset)
    }
    callback()
  }
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), milliseconds))

async function run(label, endMode) {
  const decoder = new ChunkedStream(endMode)
  const finished = new Promise((resolve) => decoder.once('finish', resolve))
  const body = new Response(Readable.toWeb(decoder), { status: 200 }).text()

  decoder.write('5\r\nhello\r\n0\r\n\r\n')
  const bodyResult = await Promise.race([body, delay(100)])
  const finishResult = await Promise.race([
    finished.then(() => 'finished'),
    delay(100),
  ])
  console.log(`${label}: body=${bodyResult} writable=${finishResult}`)
  decoder.destroy()
}

await run('before push(null)', 'before')
await run('after nextTick(end)', 'after')
