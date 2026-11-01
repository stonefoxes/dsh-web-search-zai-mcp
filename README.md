# dsh-web-search-zai-mcp

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
bundle that repairs the standard `web_search` tool when no
`DEEPSEEK_API_KEY` is stored, by registering one `WebSearchProvider` (id
`zai-mcp`) in `ctx.web` with two MCP-backed routes:

1. **z.ai Web Search MCP (primary).** The GLM Coding Plan's remote MCP server
   `https://api.z.ai/api/mcp/web_search_prime/mcp` (tool `webSearchPrime`),
   authenticated with the same `ZAI_API_KEY` credential a `zai` GLM route
   already uses — search draws from the plan's MCP quota, not a per-call
   platform API. When the session runs on GLM, that key is necessarily
   present, so search works exactly when GLM works.
2. **Local keyless MCP (fallback).** A stdio MCP search server — DuckDuckGo
   via `uvx duckduckgo-mcp-server` by default, with the `[browser]` extra
   because DuckDuckGo fingerprint-blocks plain httpx TLS — spawned lazily on
   first use when the z.ai route is unconfigured, out of quota, or failing.

The bundle patch also overrides the `web` service row to pin
`searchProvider: zai-mcp`. This pin is required: the shipped
`deepseek-official` provider reports itself available even with no key stored
(its availability check only sees that a key *resolver* exists), so
auto-selection can never route around it.

## Why the DeepSeek error happens

`dsh-base` pins `searchProvider: deepseek-official`. With no
`DEEPSEEK_API_KEY` in the credentials service, environment, or config, the
pinned provider is still "available" and fails only at dispatch with
`DeepSeek search has no API key for "DEEPSEEK_API_KEY"`. This bundle repins
search to a provider whose primary credential is the one your GLM session
already carries.

## Installation

Prerequisite, once: store `ZAI_API_KEY` (the harness web Models page writes
it; one stored key serves both the GLM route and this search).

From a clone of this repository:

```sh
git clone https://github.com/stonefoxes/dsh-web-search-zai-mcp
dsh plugin --profile <name> add ./dsh-web-search-zai-mcp
```

The GUI equivalent is the Settings → Plugins install-bundle action pointed at
the cloned directory. Both run the same flow: the package is linked into the
profile, its `cordis.patch.yml` inserts the plugin row and the `web` row
override, and the standard `web_search` tool starts resolving through the
z.ai MCP route. The plugin activates through HMR where the harness supports
it, or on the next profile start otherwise.

Inside a harness session with plugin-manager tooling, the equivalent is one
`plugin_manager` `install_bundle` call with the absolute package directory.

To remove: `dsh plugin --profile <name> remove dsh-web-search-zai-mcp`, then
restore the `web` row's `searchProvider` in your profile patch (or drop the
override the bundle added).

## Configuration

All fields optional; the loader row ships only `zai.apiKeyEnv: ZAI_API_KEY`
and everything else uses these defaults:

| Field | Default | Meaning |
|---|---|---|
| `providerId` | `zai-mcp` | Id registered in `ctx.web`; keep it in sync with the pinned `searchProvider` |
| `zai.enabled` | `true` | Enable the z.ai MCP route |
| `zai.apiKeyEnv` | `ZAI_API_KEY` | Credential reference resolved per search (credentials service, then process env) |
| `zai.apiKey` | *(empty)* | Literal key override; prefer the reference so no secret sits in config |
| `zai.url` | `https://api.z.ai/api/mcp/web_search_prime/mcp` | MCP endpoint; CN mirror: `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp` |
| `zai.tool` | *(empty)* | Exact tool name; empty auto-detects the first tool whose name mentions "search" |
| `zai.timeoutMs` | `25000` | Per-request timeout |
| `zai.count` | `10` | Result count sent when the caller sets none (z.ai caps at 50) |
| `local.enabled` | `true` | Enable the local MCP fallback |
| `local.command` | `uvx` | Executable for the stdio MCP server |
| `local.args` | `['--with', 'duckduckgo-mcp-server[browser]', 'duckduckgo-mcp-server']` | Server arguments; point at any stdio MCP search server (SearxNG, Tavily, …) |
| `local.env` | `{}` | Extra environment for the child |
| `local.tool` | *(empty)* | Exact tool name; empty auto-detects |
| `local.timeoutMs` | `30000` | Per-call timeout |
| `local.startupTimeoutMs` | `40000` | Handshake timeout; a first `uvx` run downloads the package |
| `fallbackOnError` | `true` | Also fall back when the z.ai route *errors* (not only when it is unconfigured) |
| `maxSnippetChars` | `500` | Per-source snippet cap |
| `maxContentChars` | `6000` | Cap on raw text returned as `content` by text-only servers |

Set `fallbackOnError: false` to make z.ai failures fail loud instead of
quietly degrading to DuckDuckGo.

### Vendor-drift tolerances

The tool is picked by configured name or by matching `search` in its name;
arguments are built from the tool's declared input schema (query/count-style
spellings); results are read from `structuredContent`, JSON text, formatted
text, or markdown links, in that order. A renamed z.ai tool or a restructured
payload is usually absorbed without a plugin release.

## Surviving harness updates

This bundle is built so a DSH update cannot turn it into a boot failure:

- **Zero npm dependencies.** Profile `pnpm install` can never break on it,
  and no install scripts run.
- **No build step, no Config schema.** Plain ESM JavaScript with manual
  normalization; a future schemastery change cannot reject this row.
- **Synchronous, I/O-free activation.** `apply()` registers the provider and
  nothing else: no network, no subprocess, no dynamic import. The MCP child
  is spawned lazily on the first fallback search and killed on dispose
  (HMR-safe).
- **One guarded harness import.** `@deepseek-ai/dsh-web` (for the `WebError`
  class) is imported dynamically on first failure and resolved against the
  running DSH installation's own copy — no version pinning. If the export
  ever disappears, searches still work and errors degrade to plain `Error`s.
- **Everything else is service calls** on the documented `ctx.web` provider
  seam (the same surface the shipped Exa/Perplexity/DeepSeek providers use)
  and optional `ctx.get('credentials')`.

If a future harness ever fails to boot with this bundle installed, recover
with either of these, then delete the plugin row:

```sh
# Disable the plugin row from the profile's user patch layer:
#   edit $DSH_PROFILE_DIR/cordis.patch.yml and add under the existing list:
#   - id: web-search-zai-mcp
#     disabled: true
dsh plugin list && dsh plugin remove dsh-web-search-zai-mcp
```

The `web` row override this bundle ships also replaces that row's complete
`config`, so `fetchProvider: http` is restated exactly as `dsh-base` ships
it. If a future `dsh-base` changes that row, revisit this patch after
updating.

## Tests

```sh
node --test tests/*.test.mjs
```

covers config normalization, tool/argument/result mapping, formatted-text
parsing, both MCP transports (stdio handshake, crash respawn, JSON, SSE,
session-expiry re-initialization, dispose races), and provider-level routing
including the cancellation and timeout contracts — all against local fakes,
no network and no real z.ai key needed.

## Known limitations

- **DuckDuckGo blocks some networks.** Observed in the original deployment:
  the DuckDuckGo MCP server answers "no results … bot detection" even with
  the `[browser]` (curl_cffi) extra installed and verified importable. When
  that happens the fallback returns that text as capped `content` instead of
  sources — degraded, not dead. Swap the local server via `local.command` /
  `local.args` (any stdio MCP search server works), or set
  `fallbackOnError: false` so a blocked fallback never delays a failing
  z.ai route.
- **Snippet quality on the fallback.** DuckDuckGo results arrive as formatted
  text; parsing is best-effort, and unparsable text is returned capped as
  `content` rather than dropped.
- **Count is a request-layer optimization only.** The web seam enforces
  `maxResults` regardless.
- **The z.ai route shares the Coding Plan's MCP quota.** Heavy search use is
  visible in the plan's monthly MCP usage.
- **`local.env` extends the ambient environment.** Keys in `process.env` are
  visible to the child; pass a minimal `env` if your fallback server needs
  secrets.

## License

MIT — see [LICENSE](LICENSE).
