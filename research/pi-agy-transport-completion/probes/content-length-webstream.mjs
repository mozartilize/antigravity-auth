import { PassThrough, Readable, Transform } from 'node:stream'

class ContentLengthStreamBefore extends Transform {
  remaining

  constructor(contentLength) {
    super()
    this.remaining = contentLength
  }

  _transform(chunk, _encoding, callback) {
    const emitted = chunk.subarray(0, this.remaining)
    this.remaining -= emitted.length
    this.push(emitted)
    if (this.remaining <= 0) this.push(null)
    callback()
  }
}

class ContentLengthStreamAfter extends Transform {
  remaining

  constructor(contentLength) {
    super()
    this.remaining = contentLength
  }

  _transform(chunk, _encoding, callback) {
    const emitted = chunk.subarray(0, this.remaining)
    this.remaining -= emitted.length
    this.push(emitted)
    if (this.remaining <= 0) process.nextTick(() => this.end())
    callback()
  }
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), milliseconds))

async function run(label, StreamClass) {
  const socket = new PassThrough()
  const decoder = socket.pipe(new StreamClass(5))
  const finished = new Promise((resolve) => decoder.once('finish', resolve))
  const body = new Response(
    Readable.toWeb(decoder),
    { headers: { 'Content-Length': '5' }, status: 429 },
  ).text()

  socket.write('hello')
  const bodyResult = await Promise.race([body, delay(100)])
  const finishResult = await Promise.race([
    finished.then(() => 'finished'),
    delay(100),
  ])
  console.log(`${label}: body=${bodyResult} writable=${finishResult}`)
  socket.destroy()
  decoder.destroy()
}

await run('before push(null)', ContentLengthStreamBefore)
await run('after nextTick(end)', ContentLengthStreamAfter)
