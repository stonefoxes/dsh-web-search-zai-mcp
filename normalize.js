/**
 * Pure mapping layer between generic MCP search tools and the harness
 * `WebSearchProvider` vocabulary (`{ sources: [{ url, title?, snippet?,
 * publishedAt? }], content?, truncated }`). Nothing here performs I/O, so the
 * whole adaptation surface is unit-testable and vendor changes (a renamed
 * tool, different argument spellings, a restructured payload) are absorbed by
 * these tolerances instead of a new plugin release.
 *
 * @module dsh-web-search-zai-mcp/normalize
 */

/** Property names JSON search tools commonly use for the query string. */
const QUERY_KEYS = ['query', 'search_query', 'q', 'keywords', 'search']

/** Property names JSON search tools commonly use for the result-count bound. */
const COUNT_KEYS = ['count', 'max_results', 'num_results', 'num', 'limit', 'maxResults']

/** Container keys a structured payload may wrap its result array in. */
const ITEM_CONTAINERS = ['search_result', 'search_results', 'searchResult', 'results', 'data']

/** Item keys read as the citeable URL, in preference order. */
const URL_KEYS = ['url', 'link', 'href', 'source']

/** Item keys read as the snippet, in preference order. */
const SNIPPET_KEYS = ['snippet', 'content', 'summary', 'description', 'text']

/** Item keys read as the publication timestamp, in preference order. */
const PUBLISHED_KEYS = ['publishedAt', 'published_at', 'publish_date', 'published_date', 'date', 'page_age']

/**
 * Pick the search tool to call from a server's tool list.
 *
 * @param {ReadonlyArray<{ name: string }>} tools - the server's declared tools.
 * @param {string} [preferred] - exact tool name from configuration.
 * @returns {{ name: string } | undefined} the configured tool when present,
 *   else the first tool whose name mentions "search", else undefined.
 */
export function pickSearchTool(tools, preferred) {
  if (preferred !== undefined && preferred.length > 0) {
    const exact = tools.find(tool => tool.name === preferred)
    if (exact !== undefined) return exact
    return undefined
  }
  return tools.find(tool => /search/i.test(tool.name))
}

/**
 * Build the arguments for one search tool call from its declared input
 * schema. The query fills the first recognized query property; the count
 * fills the first recognized count property when the schema offers one.
 *
 * @param {{ properties?: Record<string, unknown>, required?: ReadonlyArray<string> } | undefined} schema -
 *   the tool's `inputSchema`, when the server declared one.
 * @param {string} query - the search query.
 * @param {number} [maxResults] - caller's result bound, when present.
 * @returns {Record<string, unknown>} the tool arguments.
 * @throws {Error} when the schema requires a property this builder cannot
 *   fill; the message names them so the user can set `tool`/arguments config.
 */
export function buildToolArguments(schema, query, maxResults) {
  const properties = schema !== undefined && schema !== null && typeof schema === 'object'
    ? Object.keys(schema.properties ?? {})
    : []
  if (properties.length === 0) return { query }
  const arguments_ = {}
  const queryKey = properties.find(key => QUERY_KEYS.includes(key))
  if (queryKey !== undefined) arguments_[queryKey] = query
  if (maxResults !== undefined) {
    const countKey = properties.find(key => COUNT_KEYS.includes(key))
    if (countKey !== undefined) arguments_[countKey] = maxResults
  }
  const required = Array.isArray(schema.required) ? schema.required : []
  const unsatisfiable = required.filter(key => !(key in arguments_))
  if (queryKey === undefined || unsatisfiable.length > 0) {
    const missing = [...(queryKey === undefined ? ['<no recognized query property>'] : []), ...unsatisfiable]
    throw new Error(
      `the MCP search tool requires arguments this plugin cannot derive (${missing.join(', ')});`
      + ' point the plugin at a different tool or configure one with query/count-style arguments',
    )
  }
  return arguments_
}

/**
 * Normalize one MCP `tools/call` result into the web-provider vocabulary.
 *
 * Preference order: a structured result array inside `structuredContent`, a
 * JSON document inside a text content block, then formatted text parsing
 * (numbered entries or markdown links). When no structured items are found,
 * the joined text is returned as `content` (capped) so a text-only server
 * still surfaces its results to the model.
 *
 * @param {{ content?: ReadonlyArray<{ type?: string, text?: string }>,
 *   structuredContent?: unknown, isError?: boolean }} result - raw tool result.
 * @param {{ maxSnippetChars?: number, maxContentChars?: number }} [limits] -
 *   caps applied to per-source snippets and the raw-text fallback.
 * @returns {{ sources: ReadonlyArray<{ url: string, title?: string, snippet?: string, publishedAt?: string }>,
 *   content?: string, truncated: boolean }} the normalized result.
 */
export function normalizeToolResult(result, limits = {}) {
  const maxSnippetChars = limits.maxSnippetChars ?? 500
  const maxContentChars = limits.maxContentChars ?? 6000

  const structured = findSearchItems(result.structuredContent)
  if (structured !== undefined) {
    return { sources: structured.map(item => mapItem(item, maxSnippetChars)), truncated: false }
  }

  const texts = (result.content ?? [])
    .filter(block => block !== null && typeof block === 'object' && typeof block.text === 'string')
    .map(block => block.text)
  for (const text of texts) {
    const parsed = tryJson(text)
    if (parsed !== undefined) {
      const items = findSearchItems(parsed)
      if (items !== undefined) {
        return { sources: items.map(item => mapItem(item, maxSnippetChars)), truncated: false }
      }
    }
  }

  const joined = texts.join('\n').trim()
  const sources = parseFormattedText(joined, maxSnippetChars)
  if (sources.length > 0) return { sources, truncated: false }
  if (joined !== '') return { sources: [], content: cap(joined, maxContentChars), truncated: false }
  return { sources: [], truncated: false }
}

/** Parse `text` as JSON, returning undefined for any parse failure. */
function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Find the result-item array inside a structured payload: the value itself
 * when it is one, a known container key, or any array-valued key whose items
 * look like search results (string `url`/`link` members).
 *
 * @param {unknown} value - the structured payload.
 * @returns {ReadonlyArray<Record<string, unknown>> | undefined} the items, or
 *   undefined when nothing array-of-results-shaped is present.
 */
export function findSearchItems(value) {
  if (Array.isArray(value)) return looksLikeItems(value) ? value : undefined
  if (value === null || typeof value !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  for (const key of ITEM_CONTAINERS) {
    if (Array.isArray(record[key]) && looksLikeItems(record[key])) return record[key]
  }
  for (const member of Object.values(record)) {
    if (Array.isArray(member) && looksLikeItems(member)
      && member.some(item => hasAnyKey(item, URL_KEYS))) {
      return member
    }
  }
  return undefined
}

/** True when every non-empty entry of `items` has a string url-like member. */
function looksLikeItems(items) {
  const real = items.filter(item => item !== null && typeof item === 'object')
  return real.length > 0 && real.every(item => hasAnyKey(item, URL_KEYS))
}

/** True when `item` carries a non-empty string under one of `keys`. */
function hasAnyKey(item, keys) {
  const record = /** @type {Record<string, unknown>} */ (item)
  return keys.some(key => typeof record[key] === 'string' && record[key].length > 0)
}

/**
 * Map one provider item onto the source vocabulary, dropping nothing except
 * absent fields; snippets are capped.
 *
 * @param {Record<string, unknown>} item - one structured search hit.
 * @param {number} maxSnippetChars - snippet cap.
 * @returns {{ url: string, title?: string, snippet?: string, publishedAt?: string }}
 *   the normalized source.
 */
function mapItem(item, maxSnippetChars) {
  const source = {}
  for (const key of URL_KEYS) {
    if (typeof item[key] === 'string' && item[key].length > 0) {
      source.url = item[key]
      break
    }
  }
  const title = firstString(item, ['title', 'name', 'heading'])
  if (title !== undefined) source.title = title
  const snippet = firstString(item, SNIPPET_KEYS)
  if (snippet !== undefined) source.snippet = cap(snippet, maxSnippetChars)
  const publishedAt = firstString(item, PUBLISHED_KEYS)
  if (publishedAt !== undefined) source.publishedAt = publishedAt
  return source
}

/** First non-empty string value among `keys`, or undefined. */
function firstString(item, keys) {
  for (const key of keys) {
    if (typeof item[key] === 'string' && item[key].length > 0) return item[key]
  }
  return undefined
}

/** Cap one string at `max` characters, marking the cut with an ellipsis. */
function cap(text, max) {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * Parse formatted result text into sources. Recognizes the numbered-entry
 * layout MCP search servers commonly emit (title line, `URL:` line, snippet
 * remainder) and, failing that, bare markdown links.
 *
 * @param {string} text - the tool's joined text output.
 * @param {number} [maxSnippetChars] - cap applied to parsed snippets.
 * @returns {ReadonlyArray<{ url: string, title?: string, snippet?: string }>}
 *   parsed sources; empty when neither pattern matches.
 */
export function parseFormattedText(text, maxSnippetChars = 500) {
  if (text === '') return []
  const sources = []
  const entry = /(?:^|\n)\s*\d+[.)]\s*([^\n]+)\n\s*(?:URL|url|Url):\s*(\S+)\n?((?:(?!\s*\d+[.)]\s)[^\n]*\n?)*)/g
  for (const match of text.matchAll(entry)) {
    const title = match[1].trim()
    const url = match[2].trim()
    const snippet = cap(match[3].replace(/\s+/g, ' ').trim(), maxSnippetChars)
    if (URL.canParse(url)) {
      sources.push({
        url,
        ...(title !== '' ? { title } : {}),
        ...(snippet !== '' ? { snippet } : {}),
      })
    }
  }
  if (sources.length > 0) return sources
  for (const match of text.matchAll(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g)) {
    sources.push({ url: match[2], title: match[1] })
  }
  return sources
}
