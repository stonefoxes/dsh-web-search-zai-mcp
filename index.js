/**
 * dsh-web-search-zai-mcp — host half.
 *
 * Registers one `WebSearchProvider` (id `zai-mcp`, configurable) in `ctx.web`
 * so the standard `web_search` tool works without DEEPSEEK_API_KEY:
 *
 * 1. z.ai Web Search MCP (primary): the GLM Coding Plan's remote MCP server
 *    (`https://api.z.ai/api/mcp/web_search_prime/mcp`, tool `webSearchPrime`),
 *    authenticated with the same ZAI_API_KEY credential the profile's GLM
 *    route already uses, drawn per search from the DSH credentials service.
 * 2. Local MCP fallback: a keyless stdio MCP search server (DuckDuckGo via
 *    `uvx duckduckgo-mcp-server` by default), spawned lazily on first use
 *    when the z.ai route is unconfigured or fails.
 *
 * Update resilience is deliberate: zero npm dependencies, no build step, no
 * Config schema (plain normalization with defaults), every harness import is
 * either a service call on `ctx` or one guarded dynamic import of
 * `@deepseek-ai/dsh-web` (resolved against the running DSH installation)
 * with a plain-Error fallback, and nothing asynchronous happens at plugin
 * activation. A failure of either MCP backend is one failed search, never a
 * failed boot.
 *
 * @module dsh-web-search-zai-mcp
 */

import { McpError, StdioMcp, StreamableHttpMcp } from './mcp.js'
import { buildToolArguments, normalizeToolResult, pickSearchTool } from './normalize.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-zai-mcp'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Configuration defaults; every field is overridable from the loader row. */
export const DEFAULTS = Object.freeze({
  /** Provider id registered into `ctx.web`; the bundle patch pins `searchProvider` to it. */
  providerId: 'zai-mcp',
  /** z.ai Web Search MCP backend. */
  zai: Object.freeze({
    enabled: true,
    /** Credential reference resolved per search; same ref as the GLM (`zai`) route. */
    apiKeyEnv: 'ZAI_API_KEY',
    /** Literal key override; prefer the credential reference so no secret sits in config. */
    apiKey: '',
    /** MCP endpoint; the CN mirror is https://open.bigmodel.cn/api/mcp/web_search_prime/mcp. */
    url: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
    /** Exact tool name; empty auto-detects the first tool whose name mentions "search". */
    tool: '',
    /** Per-request timeout. */
    timeoutMs: 25_000,
    /** Default result count sent when the caller sets none (z.ai caps at 50). */
    count: 10,
  }),
  /** Local keyless MCP fallback backend. */
  local: Object.freeze({
    enabled: true,
    command: 'uvx',
    /**
     * The `[browser]` extra installs the curl_cffi backend: DuckDuckGo's
     * endpoint fingerprint-blocks plain httpx TLS, yielding silent empty
     * results without it.
     */
    args: Object.freeze(['--with', 'duckduckgo-mcp-server[browser]', 'duckduckgo-mcp-server']),
    env: Object.freeze({}),
    cwd: '',
    /** Exact tool name; empty auto-detects the first tool whose name mentions "search". */
    tool: '',
    /** Per-call timeout. */
    timeoutMs: 30_000,
    /** Handshake timeout; a first `uvx` run downloads the server package. */
    startupTimeoutMs: 40_000,
  }),
  /** Fall through to the local backend when the z.ai backend errors. */
  fallbackOnError: true,
  /** Per-source snippet cap. */
  maxSnippetChars: 500,
  /** Cap on raw text returned as `content` when a server is text-only. */
  maxContentChars: 6_000,
})

/**
 * Merge a raw loader config over {@link DEFAULTS}, validating shapes.
 * Unknown keys are ignored, so a config written for a future version of this
 * plugin degrades to defaults instead of failing activation.
 *
 * @param {unknown} raw - the loader row's `config` value.
 * @returns {typeof DEFAULTS} the effective configuration.
 * @throws {Error} when a known field carries an unusable value (fail loud at
 *   activation: misconfiguration must not silently select a wrong backend).
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const zai = section(source.zai)
  const local = section(source.local)
  const merged = {
    providerId: stringField(source.providerId, DEFAULTS.providerId, 'providerId'),
    zai: {
      enabled: booleanField(zai.enabled, DEFAULTS.zai.enabled, 'zai.enabled'),
      apiKeyEnv: stringField(zai.apiKeyEnv, DEFAULTS.zai.apiKeyEnv, 'zai.apiKeyEnv'),
      apiKey: stringField(zai.apiKey, DEFAULTS.zai.apiKey, 'zai.apiKey'),
      url: stringField(zai.url, DEFAULTS.zai.url, 'zai.url'),
      tool: stringField(zai.tool, DEFAULTS.zai.tool, 'zai.tool'),
      timeoutMs: positiveInt(zai.timeoutMs, DEFAULTS.zai.timeoutMs, 'zai.timeoutMs'),
      count: positiveInt(zai.count, DEFAULTS.zai.count, 'zai.count'),
    },
    local: {
      enabled: booleanField(local.enabled, DEFAULTS.local.enabled, 'local.enabled'),
      command: stringField(local.command, DEFAULTS.local.command, 'local.command'),
      args: stringArray(local.args, DEFAULTS.local.args, 'local.args'),
      env: stringRecord(local.env, DEFAULTS.local.env, 'local.env'),
      cwd: stringField(local.cwd, DEFAULTS.local.cwd, 'local.cwd'),
      tool: stringField(local.tool, DEFAULTS.local.tool, 'local.tool'),
      timeoutMs: positiveInt(local.timeoutMs, DEFAULTS.local.timeoutMs, 'local.timeoutMs'),
      startupTimeoutMs: positiveInt(local.startupTimeoutMs, DEFAULTS.local.startupTimeoutMs, 'local.startupTimeoutMs'),
    },
    fallbackOnError: booleanField(source.fallbackOnError, DEFAULTS.fallbackOnError, 'fallbackOnError'),
    maxSnippetChars: positiveInt(source.maxSnippetChars, DEFAULTS.maxSnippetChars, 'maxSnippetChars'),
    maxContentChars: positiveInt(source.maxContentChars, DEFAULTS.maxContentChars, 'maxContentChars'),
  }
  if (!merged.zai.enabled && !merged.local.enabled) {
    throw new Error('web-search-zai-mcp: both backends are disabled; enable zai or local')
  }
  if (merged.zai.enabled && !URL.canParse(merged.zai.url)) {
    throw new Error(`web-search-zai-mcp: zai.url is not a valid URL: ${merged.zai.url}`)
  }
  return merged
}

/** Narrow `value` to a plain object; null/undefined become {}. */
function section(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {}
}

/** String field with a default; rejects non-strings. */
function stringField(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`web-search-zai-mcp: ${label} must be a string`)
  return value
}

/** Boolean field with a default; rejects non-booleans. */
function booleanField(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(`web-search-zai-mcp: ${label} must be a boolean`)
  return value
}

/** Positive integer field with a default; rejects other numbers. */
function positiveInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`web-search-zai-mcp: ${label} must be a positive integer`)
  }
  return value
}

/** String-array field with a default; rejects non-string members. */
function stringArray(value, fallback, label) {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`web-search-zai-mcp: ${label} must be an array of strings`)
  }
  return [...value]
}

/** Record-of-strings field with a default; rejects other shapes. */
function stringRecord(value, fallback, label) {
  if (value === undefined || value === null) return { ...fallback }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(entry => typeof entry !== 'string')) {
    throw new Error(`web-search-zai-mcp: ${label} must be a record of strings`)
  }
  return { .../** @type {Record<string, string>} */ (value) }
}

/**
 * The real `WebError` class when the running installation exports it, else a
 * shape-compatible stand-in (`message` + `code` + `cause`). Loaded once, on
 * the first failure, so module resolution problems can never break boot.
 */
let webErrorCtorPromise

async function webErrorCtor() {
  webErrorCtorPromise ??= import('@deepseek-ai/dsh-web')
    .then(mod => mod.WebError)
    .catch(() => class WebErrorFallback extends Error {
      constructor(message, code, options) {
        super(message, options)
        this.name = 'WebError'
        this.code = code
      }
    })
  return webErrorCtorPromise
}

/** Build the provider's typed failure. */
async function webError(message, code, cause) {
  const Ctor = await webErrorCtor()
  return new Ctor(message, code, cause !== undefined ? { cause } : {})
}

/**
 * True for caller-cancellation failures: a raw `AbortError` from fetch, or a
 * transport-wrapped cancellation. A timeout surfaces as `TimeoutError` and is
 * a route failure, not a cancellation.
 */
function isCancelled(error) {
  return error instanceof Error
    && (error.name === 'AbortError' || (error instanceof McpError && error.reason === 'cancelled'))
}

/** One backend failure rendered for the combined error message. */
function describeBackend(backend, error) {
  if (error instanceof McpError) return `${backend}: ${error.message}`
  return `${backend}: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * The search provider. One registry entry whose `search()` routes z.ai-first
 * and local-second; the web seam owns `maxResults` truncation, so `truncated`
 * is reported false here.
 */
class ZaiMcpSearchProvider {
  /**
   * @param {{ config: ReturnType<typeof normalizeConfig>, ctx: {
   *   get: (name: string) => unknown, logger: { warn: (error: Error) => void } } }} options -
   *   normalized configuration and the plugin context (credentials access and
   *   logging only).
   */
  constructor(options) {
    this.#config = options.config
    this.#ctx = options.ctx
    this.id = options.config.providerId
    this.#zaiEndpoint = undefined
    this.#localEndpoint = undefined
    /** @type {Map<string, { name: string, inputSchema?: unknown }>} */
    this.#tools = new Map()
  }

  #config

  #ctx

  #zaiEndpoint

  #localEndpoint

  #tools

  /** Cheap local check; never touches the network or spawns anything. */
  available() {
    return this.#config.zai.enabled || this.#config.local.enabled
  }

  /**
   * Run one search: z.ai MCP first, the local MCP fallback second. Cancellation
   * by the caller rethrows immediately as `WEB_ABORTED` without falling back;
   * every other backend failure is either absorbed by the fallback or reported
   * with both backends' reasons.
   *
   * @param {{ query: string, maxResults?: number }} request - the seam's search request.
   * @param {AbortSignal} [signal] - caller cancellation.
   */
  async search(request, signal) {
    const failures = []
    if (this.#config.zai.enabled) {
      try {
        return await this.#searchZai(request, signal)
      } catch (error) {
        if (isCancelled(error)) throw await webError('z.ai MCP search aborted', 'WEB_ABORTED', error)
        failures.push(describeBackend('z.ai MCP', error))
        if (!this.#config.fallbackOnError) throw await providerFailure(failures)
        this.#ctx.logger.warn(new Error(`web-search-zai-mcp falling back to the local MCP: ${String(failures[0])}`))
      }
    } else {
      failures.push('z.ai MCP backend disabled by configuration')
    }
    if (this.#config.local.enabled) {
      try {
        return await this.#searchLocal(request, signal)
      } catch (error) {
        if (isCancelled(error)) throw await webError('local MCP search aborted', 'WEB_ABORTED', error)
        failures.push(describeBackend('local MCP', error))
      }
    }
    throw await providerFailure(failures)
  }

  /** Resolve the z.ai credential: literal config, credentials service, env. */
  async #resolveZaiKey() {
    const zai = this.#config.zai
    if (zai.apiKey.length > 0) return zai.apiKey
    const credentials = this.#ctx.get('credentials')
    if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(zai.apiKeyEnv)
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) {
        return hit.value
      }
    }
    const ambient = process.env[zai.apiKeyEnv]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  /** One search through the z.ai remote MCP. */
  async #searchZai(request, signal) {
    const apiKey = await this.#resolveZaiKey()
    if (apiKey === undefined) {
      throw new Error(
        `no API key for "${this.#config.zai.apiKeyEnv}" — store it through the credentials service (the web`
        + ' Models page writes it), export it in the launching environment, or set zai.apiKey; the GLM route'
        + ' and this search share the reference',
      )
    }
    this.#zaiEndpoint ??= new StreamableHttpMcp({
      url: this.#config.zai.url,
      timeoutMs: this.#config.zai.timeoutMs,
      logger: this.#ctx.logger,
    })
    // Refresh the header every search so a rotated credential reaches the
    // next call without waiting for a plugin reload.
    this.#zaiEndpoint.headers.authorization = `Bearer ${apiKey}`
    return await this.#runTool(this.#zaiEndpoint, 'zai', this.#config.zai.tool, request, signal)
  }

  /** One search through the local stdio MCP. */
  async #searchLocal(request, signal) {
    this.#localEndpoint ??= new StdioMcp({
      command: this.#config.local.command,
      args: this.#config.local.args,
      env: this.#config.local.env,
      cwd: this.#config.local.cwd,
      timeoutMs: this.#config.local.timeoutMs,
      startupTimeoutMs: this.#config.local.startupTimeoutMs,
      logger: this.#ctx.logger,
    })
    return await this.#runTool(this.#localEndpoint, 'local', this.#config.local.tool, request, signal)
  }

  /**
   * Shared backend flow: pick (and cache) the tool, build arguments from the
   * tool's declared schema, call it, surface `isError` results as failures,
   * and normalize the payload.
   */
  async #runTool(endpoint, backend, configuredTool, request, signal) {
    if (!this.#tools.has(backend)) {
      this.#tools.set(backend, await this.#pickTool(endpoint, configuredTool))
    }
    const tool = this.#tools.get(backend)
    const maxResults = request.maxResults ?? (backend === 'zai' ? this.#config.zai.count : undefined)
    const args = buildToolArguments(tool.inputSchema, request.query, maxResults)
    const raw = await endpoint.callTool(tool.name, args, signal)
    if (raw !== null && typeof raw === 'object' && raw.isError === true) {
      const text = (raw.content ?? [])
        .map(block => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
        .join('\n')
        .trim()
      throw new Error(text !== '' ? text : 'the MCP search tool reported an error')
    }
    return normalizeToolResult(raw, {
      maxSnippetChars: this.#config.maxSnippetChars,
      maxContentChars: this.#config.maxContentChars,
    })
  }

  /** Pick this backend's search tool, listing the server's tools once. */
  async #pickTool(endpoint, configuredTool) {
    const tools = await endpoint.listTools()
    const tool = pickSearchTool(tools, configuredTool !== '' ? configuredTool : undefined)
    if (tool === undefined) {
      const names = tools.map(entry => entry.name).join(', ')
      throw new Error(`no search tool on this MCP server (available: ${names === '' ? 'none' : names})`)
    }
    return tool
  }

  /** Stop both endpoints; the registry disposer handles provider unregistration. */
  dispose() {
    this.#zaiEndpoint?.dispose()
    this.#localEndpoint?.dispose()
    this.#zaiEndpoint = undefined
    this.#localEndpoint = undefined
    this.#tools.clear()
  }
}

/** Build the combined both-backends-failed error. */
async function providerFailure(failures) {
  return await webError(
    `web search failed through every configured backend — ${failures.join('; ')}`,
    'WEB_PROVIDER_ERROR',
  )
}

/**
 * Register the provider. Synchronous by design: activation performs no I/O,
 * spawns nothing, and imports nothing, so this plugin can never delay or fail
 * a boot through its startup path.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the loader row's `config` value.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const provider = new ZaiMcpSearchProvider({ config, ctx })
  ctx.web.registerSearchProvider(provider)
  ctx.effect(() => () => provider.dispose(), 'web-search-zai-mcp: MCP endpoints')
}
