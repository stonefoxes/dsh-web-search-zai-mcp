/**
 * Fake Streamable HTTP MCP server for tests. Implements the transport subset
 * the plugin's HTTP client relies on: `Mcp-Session-Id` issuance, JSON and
 * SSE-framed responses (engine `sse`), and one forced session expiry (engine
 * `expire`: the first post-handshake request 404s, so the client must
 * re-initialize and resend).
 */
import { createServer } from 'node:http'

const engine = process.argv[2] ?? 'json'
let generation = 0
let expectedSession = undefined
let rotated = false

const jsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let frame
    try {
      frame = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }
    const sessionHeader = req.headers['mcp-session-id']
    if (sessionHeader !== undefined && sessionHeader !== expectedSession) {
      res.writeHead(404).end()
      return
    }
    if (frame.method === 'initialize') {
      generation += 1
      expectedSession = `s-${generation}`
      respond(res, 200, jsonRpcResult(frame.id, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'fake-http', version: '0' },
      }), { 'mcp-session-id': expectedSession })
      return
    }
    if (sessionHeader === undefined) {
      res.writeHead(404).end()
      return
    }
    if (frame.method === 'notifications/initialized') {
      if (engine === 'expire' && !rotated) {
        // Expire the freshly established session exactly once.
        expectedSession = 's-gone'
        rotated = true
      }
      res.writeHead(202).end()
      return
    }
    if (frame.method === 'tools/list') {
      respond(res, 200, jsonRpcResult(frame.id, {
        tools: [{
          name: 'webSearchPrime',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, count: { type: 'number' } },
            required: ['query'],
          },
        }],
      }))
      return
    }
    if (frame.method === 'tools/call') {
      const query = String(frame.params?.arguments?.query ?? '')
      const payload = jsonRpcResult(frame.id, {
        structuredContent: {
          search_result: [{ title: query, link: `https://http.example/${encodeURIComponent(query)}`, content: 'http snippet' }],
        },
      })
      if (engine === 'sse') {
        const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\ndata: ${JSON.stringify(payload)}\n\n`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse)
        return
      }
      respond(res, 200, payload)
      return
    }
    respond(res, 200, { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `no method ${frame.method}` } })
  })
})

/** Send one JSON response body, mirroring the transport's JSON mode. */
function respond(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(payload))
}

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port))
})
