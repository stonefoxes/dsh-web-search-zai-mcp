/**
 * Protocol smoke tests: the stdio and Streamable HTTP MCP clients against
 * local fake servers, driven exactly the way the provider drives them
 * (pick tool, build arguments, call, normalize).
 * Run: node --test tests/
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { McpError, StdioMcp, StreamableHttpMcp } from '../mcp.js'
import { buildToolArguments, normalizeToolResult, pickSearchTool } from '../normalize.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Drive one endpoint end to end the way the provider does. */
async function searchThrough(endpoint, configuredTool, query, maxResults = 5) {
  const tools = await endpoint.listTools()
  const tool = pickSearchTool(tools, configuredTool)
  assert.notEqual(tool, undefined, 'a search tool must be discoverable')
  const args = buildToolArguments(tool.inputSchema, query, maxResults)
  const raw = await endpoint.callTool(tool.name, args)
  return { raw, normalized: normalizeToolResult(raw) }
}

test('StdioMcp completes the full search flow and survives a crashed child', async () => {
  const endpoint = new StdioMcp({
    command: process.execPath,
    args: [join(here, 'fake-mcp-server.mjs')],
    timeoutMs: 5_000,
    startupTimeoutMs: 10_000,
  })
  try {
    const first = await searchThrough(endpoint, '', 'hello')
    assert.equal(first.normalized.sources.length, 2)
    assert.equal(first.normalized.sources[0].url, 'https://example.test/hello/docs')

    // The fake server crashes without answering; the pending call must fail
    // with the child-exit reason...
    await assert.rejects(
      () => searchThrough(endpoint, '', 'crash'),
      (error) => error instanceof McpError,
    )
    // ...and the very next call must respawn and succeed.
    const second = await searchThrough(endpoint, '', 'again')
    assert.equal(second.normalized.sources[0].title, 'again docs')

    // JSON-RPC-level errors surface as McpError; isError tool results are the
    // provider layer's concern, observable here as text content and no items.
    await assert.rejects(
      () => searchThrough(endpoint, '', 'fail'),
      (error) => error instanceof McpError && /upstream exploded/.test(error.message),
    )
    const errored = await searchThrough(endpoint, '', 'istool')
    assert.deepEqual(errored.normalized.sources, [])
    assert.equal(errored.normalized.content, 'the tool says no')
  } finally {
    endpoint.dispose()
  }
})

/** Start one fake HTTP MCP server and resolve its port. */
function startHttpFake(engine) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'fake-mcp-http.mjs'), engine], { stdio: ['ignore', 'pipe', 'inherit'] })
    let port = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      port += chunk
    })
    child.on('error', reject)
    const ready = () => {
      const parsed = Number.parseInt(port.trim(), 10)
      if (Number.isInteger(parsed)) resolve({ child, port: parsed })
    }
    child.stdout.on('end', ready)
    setTimeout(ready, 500)
  })
}

for (const engine of ['json', 'sse', 'expire']) {
  test(`StreamableHttpMcp completes the full search flow (${engine} mode)`, async () => {
    const { child, port } = await startHttpFake(engine)
    const endpoint = new StreamableHttpMcp({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { authorization: 'Bearer test-key' },
      timeoutMs: 5_000,
    })
    try {
      const { normalized } = await searchThrough(endpoint, 'webSearchPrime', `q-${engine}`)
      assert.equal(normalized.sources.length, 1)
      assert.equal(normalized.sources[0].url, `https://http.example/q-${engine}`)
    } finally {
      endpoint.dispose()
      child.kill('SIGTERM')
    }
  })
}
