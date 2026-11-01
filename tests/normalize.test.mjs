/**
 * Unit tests for the pure mapping layer and config normalization.
 * Run: node --test tests/
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS, normalizeConfig } from '../index.js'
import { parseHttpResponseBody } from '../mcp.js'
import { buildToolArguments, normalizeToolResult, parseFormattedText, pickSearchTool } from '../normalize.js'

test('pickSearchTool prefers the configured name, then any search-named tool', () => {
  const tools = [{ name: 'webSearchPrime' }, { name: 'fetch_content' }, { name: 'search' }]
  assert.equal(pickSearchTool(tools, 'webSearchPrime').name, 'webSearchPrime')
  assert.equal(pickSearchTool(tools, 'search').name, 'search')
  assert.equal(pickSearchTool(tools, 'nope'), undefined)
  assert.equal(pickSearchTool(tools, '').name, 'webSearchPrime')
  assert.equal(pickSearchTool([{ name: 'fetch' }, { name: 'web_search' }], '').name, 'web_search')
})

test('buildToolArguments maps query and count onto recognized properties', () => {
  const schema = {
    type: 'object',
    properties: { search_query: { type: 'string' }, count: { type: 'number' }, engine: { type: 'string' } },
    required: ['search_query'],
  }
  assert.deepEqual(buildToolArguments(schema, 'q', 5), { search_query: 'q', count: 5 })
  assert.deepEqual(buildToolArguments(schema, 'q', undefined), { search_query: 'q' })
  assert.deepEqual(buildToolArguments(undefined, 'q', 5), { query: 'q' })
})

test('buildToolArguments fails loud on requirements it cannot satisfy', () => {
  const schema = {
    type: 'object',
    properties: { query: { type: 'string' }, engine: { type: 'string' } },
    required: ['query', 'engine'],
  }
  assert.throws(() => buildToolArguments(schema, 'q'), /engine/)
})

test('normalizeToolResult reads z.ai structured payloads', () => {
  const result = {
    structuredContent: {
      search_result: [
        { title: 'A', link: 'https://a.example', content: 'x'.repeat(600), publish_date: '2026-01-02', media: 'M' },
        { title: 'B', link: 'https://b.example' },
      ],
    },
  }
  const normalized = normalizeToolResult(result, { maxSnippetChars: 50 })
  assert.equal(normalized.sources.length, 2)
  assert.equal(normalized.sources[0].url, 'https://a.example')
  assert.equal(normalized.sources[0].publishedAt, '2026-01-02')
  assert.equal(normalized.sources[0].snippet.length, 50)
  assert.ok(normalized.sources[0].snippet.endsWith('…'))
  assert.equal(normalized.sources[1].snippet, undefined)
})

test('normalizeToolResult reads JSON text payloads', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://x', title: 'X' }] }) }] }
  const normalized = normalizeToolResult(result)
  assert.equal(normalized.sources[0].url, 'https://x')
})

test('normalizeToolResult parses formatted text from text-only servers', () => {
  const text = [
    '1. First Hit',
    '   URL: https://first.example/a?b=1',
    '   Snippet line one',
    '   continued on the next line',
    '',
    '2. Second Hit',
    '   URL: https://second.example',
    '   Another snippet',
  ].join('\n')
  const normalized = normalizeToolResult({ content: [{ type: 'text', text }] })
  assert.equal(normalized.sources.length, 2)
  assert.equal(normalized.sources[0].title, 'First Hit')
  assert.equal(normalized.sources[0].snippet, 'Snippet line one continued on the next line')
  assert.equal(normalized.sources[1].url, 'https://second.example')
})

test('normalizeToolResult keeps capped raw text when nothing parses', () => {
  const normalized = normalizeToolResult(
    { content: [{ type: 'text', text: 'loose prose about results' }] },
    { maxContentChars: 10 },
  )
  assert.deepEqual(normalized.sources, [])
  assert.equal(normalized.content.length, 10)
})

test('parseFormattedText falls back to markdown links', () => {
  const sources = parseFormattedText('see [Docs](https://docs.example) and [Spec](https://spec.example/x)')
  assert.deepEqual(sources, [
    { url: 'https://docs.example', title: 'Docs' },
    { url: 'https://spec.example/x', title: 'Spec' },
  ])
})

test('parseHttpResponseBody reads JSON bodies and SSE bodies', () => {
  const json = parseHttpResponseBody(7, 'application/json', '{"jsonrpc":"2.0","id":7,"result":{"ok":1}}')
  assert.deepEqual(json, { result: { ok: 1 } })
  const sseText = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    '',
    'data: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}',
    '',
  ].join('\n')
  const sse = parseHttpResponseBody(7, 'text/event-stream', sseText)
  assert.deepEqual(sse, { result: { tools: [] } })
  const errorBody = parseHttpResponseBody(3, 'application/json', '{"jsonrpc":"2.0","id":3,"error":{"message":"nope"}}')
  assert.deepEqual(errorBody, { error: { message: 'nope' } })
})

test('normalizeConfig applies defaults, overrides, and fails loud on misuse', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.providerId, DEFAULTS.providerId)
  assert.equal(defaults.zai.url, DEFAULTS.zai.url)
  assert.deepEqual(defaults.local.args, [...DEFAULTS.local.args])

  const merged = normalizeConfig({
    providerId: 'custom',
    zai: { apiKeyEnv: 'OTHER_KEY', count: 5 },
    local: { args: ['--x'] },
    maxSnippetChars: 100,
  })
  assert.equal(merged.providerId, 'custom')
  assert.equal(merged.zai.apiKeyEnv, 'OTHER_KEY')
  assert.equal(merged.zai.count, 5)
  assert.deepEqual(merged.local.args, ['--x'])
  assert.equal(merged.maxSnippetChars, 100)
  // Untouched sections keep their defaults.
  assert.equal(merged.zai.url, DEFAULTS.zai.url)
  assert.equal(merged.local.command, DEFAULTS.local.command)

  assert.throws(() => normalizeConfig({ zai: { enabled: false }, local: { enabled: false } }), /both backends/)
  assert.throws(() => normalizeConfig({ zai: { url: 'not a url' } }), /valid URL/)
  assert.throws(() => normalizeConfig({ zai: { timeoutMs: 0 } }), /positive integer/)
  assert.throws(() => normalizeConfig({ local: { args: [1] } }), /array of strings/)
  assert.throws(() => normalizeConfig({ fallbackOnError: 'yes' }), /boolean/)
})
