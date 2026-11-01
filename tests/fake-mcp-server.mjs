/**
 * Fake stdio MCP server for tests. Implements the exact protocol subset the
 * plugin speaks, plus three test hooks driven by the search query:
 *   - "crash"  : exits without answering (tests child-death respawn)
 *   - "fail"   : answers with a JSON-RPC error
 *   - "istool" : answers with an isError tool result
 * After initialize it sends one `ping` request at the client to verify the
 * client answers server-initiated requests instead of stalling.
 */
import { exit } from 'node:process'

let sawPingAnswer = false
let buffer = ''

const send = (frame) => {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

const searchResult = (query) => ({
  content: [{ type: 'text', text: `results for ${query}` }],
  structuredContent: {
    search_result: [
      { title: `${query} docs`, link: `https://example.test/${encodeURIComponent(query)}/docs`, content: 'snippet one' },
      { title: `${query} blog`, link: 'https://example.test/blog', content: 'snippet two', publish_date: '2026-02-03' },
    ],
  },
})

const handle = (frame) => {
  if (frame.method === 'initialize') {
    reply(frame.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } })
    return
  }
  if (frame.method === 'notifications/initialized') {
    send({ jsonrpc: '2.0', method: 'ping', params: {}, id: 999 })
    return
  }
  if (frame.method === 'tools/list') {
    reply(frame.id, {
      tools: [{
        name: 'search',
        description: 'search the fake web',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, max_results: { type: 'number' } },
          required: ['query'],
        },
      }],
    })
    return
  }
  if (frame.method === 'tools/call') {
    const query = String(frame.params?.arguments?.query ?? '')
    if (query === 'crash') {
      // Never answer; the child death must surface to the caller.
      exit(7)
    }
    if (query === 'fail') {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'upstream exploded' } })
      return
    }
    if (query === 'slow') {
      setTimeout(() => reply(frame.id, searchResult(query)), 2000)
      return
    }
    if (query === 'istool') {
      reply(frame.id, { content: [{ type: 'text', text: 'the tool says no' }], isError: true })
      return
    }
    reply(frame.id, searchResult(query))
    return
  }
  if (frame.id !== undefined && frame.error !== undefined) {
    // The ping answer from the client under test.
    sawPingAnswer = true
    return
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line !== '') {
      try {
        handle(JSON.parse(line))
      } catch {
        /* unparseable input is the caller's problem */
      }
    }
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => exit(sawPingAnswer ? 0 : 1))
