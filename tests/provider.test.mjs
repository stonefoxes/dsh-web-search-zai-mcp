/**
 * Provider-level regression tests through the real plugin entry: the z.ai
 * route disabled, so every search exercises the local stdio fake end to end.
 * The cancellation case guards the transport-wrapped cancellation reason
 * (a caller cancel must surface WEB_ABORTED, not a route failure).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as plugin from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_STDIO_SERVER = readFileSync(join(here, 'fake-mcp-server.mjs'), 'utf8')
  .split('\n')
  .filter(line => !line.startsWith('/**') && !line.startsWith(' *') && !line.startsWith(' */'))
  .join('\n')

/** Boot the plugin against a fake web seam and return the provider. */
function bootProvider(overrides = {}) {
  let registered
  const ctx = {
    web: { registerSearchProvider: (provider) => { registered = provider; return () => {} } },
    get: () => undefined,
    logger: { warn: () => {} },
    effect: () => () => {},
  }
  plugin.apply(ctx, {
    zai: { enabled: false },
    local: {
      command: process.execPath,
      args: ['--input-type=module', '-e', FAKE_STDIO_SERVER],
      timeoutMs: 4000,
      startupTimeoutMs: 10000,
      ...overrides.local ?? {},
    },
    ...overrides.config,
  })
  return registered
}

test('a local search flows end to end through the provider', async () => {
  const provider = bootProvider()
  try {
    const result = await provider.search({ query: 'regression', maxResults: 2 })
    assert.equal(result.sources.length, 2)
    assert.ok(result.sources[0].url.includes('example.test/regression'))
  } finally {
    provider.dispose()
  }
})

test('a caller cancellation surfaces WEB_ABORTED, not a route failure', async () => {
  const provider = bootProvider()
  try {
    const controller = new AbortController()
    const pending = provider.search({ query: 'slow' }, controller.signal)
    setTimeout(() => { controller.abort() }, 150)
    const error = await pending.then(() => { throw new Error('expected a rejection') }, (thrown) => thrown)
    assert.equal(error.code, 'WEB_ABORTED', `got: ${String(error.message)}`)
  } finally {
    provider.dispose()
  }
}, 10000)

test('a timeout on the local route is a route failure, not a cancellation', async () => {
  const provider = bootProvider({ local: { timeoutMs: 150 } })
  try {
    const error = await provider.search({ query: 'slow' }).then(
      () => { throw new Error('expected a rejection') },
      (thrown) => thrown,
    )
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /timed out/)
  } finally {
    provider.dispose()
  }
}, 10000)
