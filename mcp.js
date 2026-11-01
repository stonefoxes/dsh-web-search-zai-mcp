/**
 * Minimal MCP client for dsh-web-search-zai-mcp: JSON-RPC 2.0 over the two
 * transports this plugin needs, with no third-party dependency.
 *
 * - StreamableHttpMcp: MCP "Streamable HTTP" transport (one POST per message;
 *   the answer is either an `application/json` body or a `text/event-stream`
 *   body whose `data:` events carry the JSON-RPC response). Tracks the
 *   server-issued `Mcp-Session-Id`, and re-initializes once when the server
 *   answers 404 for an expired session.
 * - StdioMcp: spawns a local server as a child process and speaks
 *   newline-delimited JSON over its stdin/stdout. The child is spawned lazily
 *   on first use, restarted once when it dies before finishing a handshake,
 *   respawned by the next call when it dies later, and killed on dispose.
 *
 * Both classes expose the same four-method surface: ensureReady(), listTools(),
 * callTool(name, args, signal?), dispose(). Requests the server directs AT the
 * client are answered with JSON-RPC method-not-found, which keeps servers that
 * probe the client (e.g. `ping`) well behaved.
 *
 * @module dsh-web-search-zai-mcp/mcp
 */

/** MCP protocol revision this client announces on initialize. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** JSON-RPC error code the spec assigns to method-not-found. */
const METHOD_NOT_FOUND = -32601

/** Attribution announced in initialize. Bump with the package version. */
const CLIENT_INFO = { name: 'dsh-web-search-zai-mcp', version: '0.1.0' }

/** Milliseconds after which an aborted fetch surfaces as `TimeoutError`. */
const ABORT_NAMES = new Set(['AbortError', 'TimeoutError'])

/**
 * One MCP-level failure carrying the transport detail needed for actionable
 * diagnostics. `reason: 'child-exit'` marks a stdio failure caused by the
 * server process dying, which is the one situation the caller respawns for.
 */
export class McpError extends Error {
  /**
   * @param {string} message - human-readable failure, safe for model output.
   * @param {{ transport?: string, status?: number, reason?: string, cause?: unknown }} [detail]
   *   originating transport, HTTP status, machine-readable cause kind, and the
   *   underlying error.
   */
  constructor(message, detail = {}) {
    super(message, detail.cause !== undefined ? { cause: detail.cause } : {})
    this.name = 'McpError'
    this.transport = detail.transport
    this.status = detail.status
    this.reason = detail.reason
  }
}

/** True when the error is an AbortError/TimeoutError from fetch or a signal. */
function isAbortError(error) {
  return error instanceof Error && ABORT_NAMES.has(error.name)
}

/** A timeout-only signal when the caller passed none. */
function composeSignal(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (external === undefined) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, external])
  return timeout
}

/** True for a finite positive integer a count argument can carry. */
function isCount(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Extract the JSON-RPC response whose `id` matches `wantId` from one HTTP
 * response body, honoring both declared content kinds.
 *
 * @param {number} wantId - the request id this body answers.
 * @param {string} contentType - the response `content-type` header value.
 * @param {string} text - the complete decoded body.
 * @returns {{ result?: unknown, error?: { message: string } } | undefined} the
 *   matched response payload, or undefined when the body carries none.
 */
export function parseHttpResponseBody(wantId, contentType, text) {
  if (contentType.includes('text/event-stream')) {
    let data = ''
    const flush = () => {
      if (data === '') return undefined
      const hit = matchResponse(wantId, data)
      data = ''
      return hit
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trimEnd()
      if (line === '') {
        const hit = flush()
        if (hit !== undefined) return hit
        continue
      }
      if (line.startsWith('data:')) data += (data === '' ? '' : '\n') + line.slice(5).trimStart()
    }
    return flush()
  }
  return matchResponse(wantId, text)
}

/** Parse one candidate JSON text as a JSON-RPC response for `wantId`. */
function matchResponse(wantId, text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
    if (entry !== null && typeof entry === 'object' && entry.id === wantId
      && ('result' in entry || 'error' in entry)) {
      return entry.error !== undefined
        ? { error: { message: typeof entry.error.message === 'string' ? entry.error.message : 'MCP server returned an error' } }
        : { result: entry.result }
    }
  }
  return undefined
}

/**
 * One MCP session over Streamable HTTP.
 */
export class StreamableHttpMcp {
  /**
   * @param {{ url: string, headers?: Record<string, string>, timeoutMs?: number,
   *   logger?: { warn: (error: Error) => void } }} options - endpoint URL,
   *   extra headers (authentication), per-request timeout, and an optional
   *   logger that receives non-fatal retry explanations.
   */
  constructor(options) {
    this.url = options.url
    this.headers = { ...options.headers }
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.logger = options.logger
    /** Server-issued session id sent back on every request after initialize. */
    this.sessionId = undefined
    this.#initPromise = undefined
    this.#id = 0
  }

  #initPromise

  #id

  #nextId() {
    this.#id += 1
    return this.#id
  }

  /**
   * Complete the MCP handshake once; concurrent callers share one attempt,
   * and a failed attempt is retried by the next caller.
   * @returns {Promise<void>}
   */
  ensureReady() {
    this.#initPromise ??= this.#initialize().catch((error) => {
      this.#initPromise = undefined
      throw error
    })
    return this.#initPromise
  }

  async #initialize() {
    await this.#request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    // Spec: the client acknowledges the negotiated protocol before any call.
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /**
   * POST one already-built JSON-RPC frame and return the raw HTTP outcome.
   * One connection-level retry: api.z.ai resolves to a rotating address set
   * where individual addresses can be unreachable, and a fresh socket re-rolls
   * that dice (observed in this deployment's z.ai quota plugin).
   */
  async #post(frame, signal) {
    const send = async () => {
      const response = await fetch(this.url, {
        method: 'POST',
        // Credential-bearing provider requests never follow redirects.
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.headers,
          ...(this.sessionId !== undefined ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: frame,
        signal: composeSignal(this.timeoutMs, signal),
      })
      const sessionId = response.headers.get('mcp-session-id')
      if (sessionId !== null && sessionId.length > 0) this.sessionId = sessionId
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        text: await response.text(),
      }
    }
    try {
      return await send()
    } catch (error) {
      if (isAbortError(error)) throw error
      this.logger?.warn(new Error(`MCP HTTP request to ${this.url} failed once, retrying: ${String(error)}`))
      return await send()
    }
  }

  /**
   * POST one request and unwrap its JSON-RPC outcome. An HTTP 404 while a
   * session was in flight means the session expired: drop it, re-initialize,
   * and send exactly one fresh request.
   */
  async #request(method, params, signal) {
    for (let attempt = 0; ; attempt += 1) {
      const id = this.#nextId()
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      const response = await this.#post(frame, signal)
      if (response.status === 404 && this.sessionId !== undefined && attempt === 0) {
        this.reset()
        await this.ensureReady()
        continue
      }
      if (response.status >= 400) {
        throw new McpError(`MCP server at ${this.url} answered HTTP ${String(response.status)} for ${method}`, {
          transport: 'streamable-http',
          status: response.status,
        })
      }
      const matched = parseHttpResponseBody(id, response.contentType, response.text)
      if (matched === undefined) {
        throw new McpError(`MCP server at ${this.url} returned no response for ${method}`, {
          transport: 'streamable-http',
          status: response.status,
        })
      }
      if (matched.error !== undefined) {
        throw new McpError(`MCP call ${method} failed: ${matched.error.message}`, { transport: 'streamable-http' })
      }
      return matched.result
    }
  }

  /**
   * List the server's tools.
   * @returns {Promise<ReadonlyArray<{ name: string, description?: string, inputSchema?: unknown }>>}
   */
  async listTools() {
    await this.ensureReady()
    const result = await this.#request('tools/list', {})
    const tools = result?.tools
    return Array.isArray(tools) ? tools : []
  }

  /**
   * Invoke one tool.
   * @param {string} name - tool name as the server declares it.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<unknown>} the raw `tools/call` result object.
   */
  async callTool(name, args, signal) {
    await this.ensureReady()
    return await this.#request('tools/call', { name, arguments: args }, signal)
  }

  /** Drop the cached session so the next call re-initializes. */
  reset() {
    this.sessionId = undefined
    this.#initPromise = undefined
  }

  /** Nothing to close for HTTP; clearing the session is the whole teardown. */
  dispose() {
    this.reset()
  }
}

/**
 * One MCP session over a spawned child process's stdio.
 */
export class StdioMcp {
  /**
   * @param {{ command: string, args?: string[], env?: Record<string, string>, cwd?: string,
   *   timeoutMs?: number, startupTimeoutMs?: number,
   *   logger?: { warn: (error: Error) => void } }} options - the server launch
   *   specification, per-call and handshake timeouts, and an optional logger.
   */
  constructor(options) {
    this.command = options.command
    this.args = options.args ?? []
    this.env = options.env ?? {}
    this.cwd = options.cwd !== undefined && options.cwd.length > 0 ? options.cwd : undefined
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.startupTimeoutMs = options.startupTimeoutMs ?? 45_000
    this.logger = options.logger
    this.#ready = undefined
    this.#child = undefined
    this.#pending = new Map()
    this.#buffer = ''
    this.#id = 0
    this.#disposed = false
  }

  #ready

  /** @type {import('node:child_process').ChildProcess | undefined} */
  #child

  #pending

  #buffer

  #id

  #disposed

  /**
   * Spawn the child and finish the handshake once. Concurrent callers share
   * one attempt; after a failure the next caller starts a fresh one. When the
   * child dies between calls, the shared readiness is dropped here and the
   * next call respawns it.
   * @returns {Promise<void>}
   */
  ensureReady() {
    if (this.#disposed) throw new McpError('MCP stdio endpoint is disposed', { transport: 'stdio' })
    this.#ready ??= this.#start().catch((error) => {
      this.#ready = undefined
      this.#killChild()
      throw error
    })
    return this.#ready
  }

  async #start() {
    await this.#spawnOnce()
    try {
      await this.#handshake()
    } catch (error) {
      // A first-run `uvx` package download or an early crash can kill the
      // child before the handshake lands; exactly one fresh child gets a
      // second chance, which also absorbs a crashed previous generation.
      if (error instanceof McpError && error.reason === 'child-exit' && !this.#disposed) {
        this.#killChild()
        await this.#spawnOnce()
        await this.#handshake()
        return
      }
      throw error
    }
  }

  #spawnOnce() {
    return new Promise((resolve, reject) => {
      // Loaded dynamically so importing this module stays side-effect free.
      import('node:child_process')
        .then(({ spawn }) => {
          const child = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.env },
            ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
          })
          this.#child = child
          const stderrTail = []
          const childExitError = (code, signal) => {
            const detail = stderrTail.join('').trim().slice(-1000)
            return new McpError(
              `MCP server "${this.command}" exited (code=${String(code)} signal=${String(signal)})`
              + (detail === '' ? '' : `: ${detail}`),
              { transport: 'stdio', reason: 'child-exit' },
            )
          }
          const failSpawn = (error) => {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
          child.on('error', (error) => {
            this.#failPending(new McpError(`failed to launch MCP server "${this.command}": ${error.message}`, {
              transport: 'stdio',
              cause: error,
            }))
            failSpawn(error)
          })
          child.on('exit', (code, signal) => {
            this.#failPending(childExitError(code, signal))
            if (this.#child === child) this.#child = undefined
            // A death after a successful handshake must invalidate readiness
            // so the next call respawns; during startup the handshake's own
            // rejection drives that instead.
            if (this.#ready !== undefined) this.#ready = undefined
            failSpawn(childExitError(code, signal))
          })
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (chunk) => this.#onStdout(chunk))
          child.stderr.setEncoding('utf8')
          child.stderr.on('data', (chunk) => {
            stderrTail.push(chunk)
            if (stderrTail.join('').length > 8192) stderrTail.splice(0, stderrTail.length - 4)
          })
          resolve(child)
        })
        .catch((error) => {
          failSpawn(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  async #handshake() {
    await this.#request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, this.startupTimeoutMs)
    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  #onStdout(chunk) {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '')
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.trim().length > 0) this.#handleFrame(line)
      newline = this.#buffer.indexOf('\n')
    }
  }

  /** Route one decoded JSON-RPC frame from the server. */
  #handleFrame(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.logger?.warn(new Error(`MCP stdio server "${this.command}" sent an unparseable line: ${line.slice(0, 200)}`))
      return
    }
    if (frame === null || typeof frame !== 'object') return
    if (frame.method !== undefined && frame.id !== undefined) {
      // A request directed at this client; the protocol requires an answer.
      this.#send({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: METHOD_NOT_FOUND, message: `method not found: ${String(frame.method)}` },
      })
      return
    }
    if (frame.id !== undefined) {
      const entry = this.#pending.get(frame.id)
      if (entry === undefined) return
      this.#pending.delete(frame.id)
      if (frame.error !== undefined) {
        const raw = frame.error !== null && typeof frame.error === 'object' ? frame.error.message : undefined
        entry.reject(new McpError(`MCP stdio call failed: ${typeof raw === 'string' ? raw : 'server error'}`, {
          transport: 'stdio',
        }))
      } else {
        entry.resolve(frame.result)
      }
    }
    // Pure notifications (no id) need no action: this client subscribes to none.
  }

  #send(frame) {
    const child = this.#child
    if (child === undefined || !child.stdin.writable) {
      this.logger?.warn(new Error(`MCP stdio server "${this.command}" is not writable; dropping a frame`))
      return
    }
    child.stdin.write(JSON.stringify(frame) + '\n')
  }

  #request(method, params, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      // A disposed endpoint answers new work immediately instead of leaving
      // it to the timeout; this also unblocks a handshake racing a dispose.
      if (this.#disposed) {
        reject(new McpError('MCP stdio endpoint is disposed', { transport: 'stdio' }))
        return
      }
      this.#id += 1
      const id = this.#id
      const settle = (fn, value) => {
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        this.#pending.delete(id)
        settle(reject, new McpError(`MCP stdio call "${method}" was cancelled`, { transport: 'stdio', reason: 'cancelled' }))
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        settle(reject, new McpError(`MCP stdio call "${method}" timed out after ${String(timeoutMs)}ms`, {
          transport: 'stdio',
        }))
      }, timeoutMs)
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new McpError(`MCP stdio call "${method}" was cancelled`, { transport: 'stdio', reason: 'cancelled' }))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#pending.set(id, {
        resolve: (result) => settle(resolve, result),
        reject: (error) => settle(reject, error),
      })
      this.#send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  /**
   * List the server's tools.
   * @returns {Promise<ReadonlyArray<{ name: string, description?: string, inputSchema?: unknown }>>}
   */
  async listTools() {
    await this.ensureReady()
    const result = await this.#request('tools/list', {}, this.timeoutMs)
    const tools = result?.tools
    return Array.isArray(tools) ? tools : []
  }

  /**
   * Invoke one tool.
   * @param {string} name - tool name as the server declares it.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<unknown>} the raw `tools/call` result object.
   */
  async callTool(name, args, signal) {
    await this.ensureReady()
    return await this.#request('tools/call', { name, arguments: args }, this.timeoutMs, signal)
  }

  #failPending(error) {
    for (const [, entry] of this.#pending) entry.reject(error)
    this.#pending.clear()
  }

  #killChild() {
    const child = this.#child
    this.#child = undefined
    if (child === undefined) return
    child.removeAllListeners('exit')
    child.removeAllListeners('error')
    child.stdout?.removeAllListeners('data')
    child.stderr?.removeAllListeners('data')
    child.kill('SIGTERM')
  }

  /** Stop the child and fail every in-flight call. Safe to call twice. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#failPending(new McpError('MCP stdio endpoint disposed', { transport: 'stdio' }))
    this.#killChild()
  }
}
