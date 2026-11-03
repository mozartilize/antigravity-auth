import {
  buildAntigravityHarnessUserAgent,
  fetchWithAgyCliTransport,
} from '../../../packages/core/dist/index.js'

const accessToken = process.env.PI_ANTIGRAVITY_ACCESS_TOKEN
if (!accessToken) {
  throw new Error('Set PI_ANTIGRAVITY_ACCESS_TOKEN to a short-lived access token')
}

const model = process.argv[2] ?? 'claude-sonnet-5-5'
const request = {
  project: 'aicode-consumers',
  requestId: `transport-probe-${Date.now()}`,
  request: {
    contents: [
      { role: 'user', parts: [{ text: 'Reply with the single word: ok' }] },
    ],
    generationConfig: {
      maxOutputTokens: 256,
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
    },
  },
  model,
  requestType: 'agent',
  userAgent: 'antigravity',
}

const response = await fetchWithAgyCliTransport(
  'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Accept-Encoding': 'gzip',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': buildAntigravityHarnessUserAgent(),
    },
    body: JSON.stringify(request),
  },
  { idleTimeoutMs: 10_000, timeoutMs: 30_000 },
)

console.log('status', response.status)
const body = await Promise.race([
  response.text(),
  new Promise((resolve) => setTimeout(() => resolve('BODY_TIMEOUT'), 15_000)),
])
console.log(String(body).slice(0, 4000))
