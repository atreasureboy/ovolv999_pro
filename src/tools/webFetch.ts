/**
 * WebFetch — Fetch URL and convert content to clean structured Markdown
 *
 * Capabilities:
 * - HTML to Markdown converter (headings, links, lists, code blocks, tables)
 * - Metadata extraction (<title>, <meta description>)
 * - Direct JSON formatting for API endpoints
 * - Signal abortion support & 30s timeout
 * - SSRF protection: blocks private/internal IPs, cloud metadata, redirects
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { lookup } from 'dns/promises'

const MAX_CONTENT_LENGTH = 50_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024 // 10 MB hard limit on downloaded body

export interface WebFetchInput {
  url: string
  max_length?: number
  start_index?: number
}

// ── SSRF Protection ─────────────────────────────────────────────────────────

/**
 * Cloud metadata endpoints that must never be fetched.
 * Covers AWS, GCP, Azure, Alibaba, Tencent, and Oracle Cloud.
 */
const BLOCKED_HOSTS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / OpenStack IPv4
  'metadata.google.internal', // GCP DNS name
  'metadata', // GCP short name
  '100.100.100.200', // Alibaba Cloud
  '169.254.0.23', // Tencent Cloud
  '169.254.169.3', // Oracle Cloud
])

/**
 * Check if an IP address is in a private / reserved range.
 * Returns true for loopback, private, link-local, and unique-local addresses.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 checks
  // 127.0.0.0/8 — loopback
  if (/^127\./.test(ip)) return true
  // 10.0.0.0/8 — private class A
  if (/^10\./.test(ip)) return true
  // 172.16.0.0/12 — private class B
  const match172 = ip.match(/^172\.(\d+)\./)
  if (match172 && parseInt(match172[1], 10) >= 16 && parseInt(match172[1], 10) <= 31) return true
  // 192.168.0.0/16 — private class C
  if (/^192\.168\./.test(ip)) return true
  // 169.254.0.0/16 — link-local (includes all cloud metadata)
  if (/^169\.254\./.test(ip)) return true
  // 0.0.0.0 — unspecified
  if (ip === '0.0.0.0') return true
  // 100.64.0.0/10 — carrier-grade NAT
  const match100 = ip.match(/^100\.(\d+)\./)
  if (match100 && parseInt(match100[1], 10) >= 64 && parseInt(match100[1], 10) <= 127) return true

  // IPv6 checks
  // ::1 — loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true
  // fe80::/10 — link-local
  if (/^fe[89ab]/i.test(ip)) return true
  // fc00::/7 — unique-local
  if (/^f[cd]/i.test(ip)) return true
  // :: — unspecified
  if (ip === '::') return true

  return false
}

/**
 * Parse a hostname and check if it's a private/internal address.
 * Handles dotted-decimal, decimal, octal, and hex IP encodings.
 */
function isPrivateHostname(hostname: string): boolean {
  // Strip brackets from IPv6 notation
  const host = hostname.replace(/^\[|\]$/g, '')

  // Check blocked metadata hosts directly
  if (BLOCKED_HOSTS.has(host)) return true

  // Try to parse as IPv4 in various encodings
  // Dotted-decimal: 192.168.1.1
  // Decimal: 3232235777 (192.168.1.1 as single number)
  // Octal: 0300.0250.0001.0001
  // Hex: 0xc0.0xa8.0x01.0x01 or 0xc0a80101

  // Check for decimal-only IP (all digits, no dots)
  if (/^\d+$/.test(host)) {
    const num = parseInt(host, 10)
    if (num <= 0xffffffff) {
      const octet1 = (num >>> 24) & 0xff
      const octet2 = (num >>> 16) & 0xff
      const ip = `${octet1}.${octet2}.${(num >>> 8) & 0xff}.${num & 0xff}`
      if (isPrivateIP(ip)) return true
    }
  }

  // Check for hex IP (0x... format)
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const num = parseInt(host, 16)
    if (num <= 0xffffffff) {
      const ip = `${(num >>> 24) & 0xff}.${(num >>> 16) & 0xff}.${(num >>> 8) & 0xff}.${num & 0xff}`
      if (isPrivateIP(ip)) return true
    }
  }

  // Try parsing as dotted IPv4 (handles octal/hex components)
  const parts = host.split('.')
  if (parts.length === 4) {
    const octets = parts.map((p) => {
      if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16)
      if (/^0\d+$/.test(p) && p !== '0') return parseInt(p, 8)
      return parseInt(p, 10)
    })
    if (octets.every((o) => o >= 0 && o <= 255)) {
      const ip = octets.join('.')
      if (isPrivateIP(ip)) return true
    }
  }

  // Direct IPv4 check (normal dotted-decimal)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIP(host)) return true

  // IPv6 check
  if (host.includes(':') && isPrivateIP(host)) return true

  return false
}

/**
 * Comprehensive SSRF check: validates hostname string AND resolves DNS
 * to check the actual IP address (prevents DNS rebinding).
 */
async function checkSSRF(url: string): Promise<{ blocked: boolean; reason?: string }> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { blocked: true, reason: 'invalid URL' }
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '')

  // 1. Check hostname string against known blocked/patterns
  if (isPrivateHostname(hostname)) {
    return { blocked: true, reason: `host ${hostname} is a private/internal/blocked address` }
  }

  // 2. Resolve DNS and check the actual IP (prevents DNS rebinding)
  //    Skip for IP literals that were already checked above.
  const looksLikeIP = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')
  if (!looksLikeIP) {
    try {
      const addresses = await lookup(hostname, { all: true })
      for (const addr of addresses) {
        if (isPrivateIP(addr.address)) {
          return {
            blocked: true,
            reason: `host ${hostname} resolves to private address ${addr.address}`,
          }
        }
      }
    } catch {
      // DNS resolution failed — let fetch() handle the error naturally
    }
  }

  return { blocked: false }
}

/** Read at most maxBytes from a ReadableStream, aborting early if exceeded. */
async function readLimitedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        // Read one more chunk to confirm we exceeded, then stop
        chunks.push(value.slice(0, maxBytes - (totalBytes - value.byteLength)))
        try {
          await reader.cancel()
        } catch {
          /* stream already closed */
        }
        break
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged)
}

/** Convert HTML to Markdown format for enhanced LLM reading */
function htmlToMarkdown(html: string): { title?: string; description?: string; markdown: string } {
  // Extract Title & Meta Description
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : undefined

  const metaMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i,
  )
  const description = metaMatch ? metaMatch[1].trim() : undefined

  const md = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Headings
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n')
    // Links
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // Lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    // Code blocks & Inline Code
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // Blockquotes & Paragraphs
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
    .replace(/<\/?(p|div|section|article|header|footer|tr|br)[^>]*>/gi, '\n')
    // Strip remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse excess whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, description, markdown: md }
}

export class WebFetchTool implements Tool {
  name = 'WebFetch'
  description = 'Fetch and analyze web page content'
  category = 'external' as const
  riskLevel = 'safe' as const
  concurrencySafe = true
  planModeAllowed = true
  informationalAllowed = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: `Fetch a URL and return its content as clean Markdown or JSON.
Supports HTML-to-Markdown conversion, meta-description extraction, and pagination via start_index.`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch (must start with http:// or https://)',
          },
          max_length: {
            type: 'number',
            description: `Maximum characters to return (default: ${MAX_CONTENT_LENGTH})`,
          },
          start_index: {
            type: 'number',
            description: 'Character offset to start from (default: 0)',
          },
        },
        required: ['url'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { url, max_length, start_index } = input as unknown as WebFetchInput

    if (!url || typeof url !== 'string') {
      return { content: 'Error: url is required', isError: true }
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { content: 'Error: URL must start with http:// or https://', isError: true }
    }

    // ── SSRF check: block private/internal/metadata endpoints ──
    // Resolves DNS to check actual IP (prevents DNS rebinding).
    const ssrf = await checkSSRF(url)
    if (ssrf.blocked) {
      return {
        content: `Error: fetching ${url} is blocked (${ssrf.reason})`,
        isError: true,
      }
    }

    const maxLen =
      typeof max_length === 'number' ? Math.min(max_length, MAX_CONTENT_LENGTH) : MAX_CONTENT_LENGTH
    const startIdx = typeof start_index === 'number' ? start_index : 0

    try {
      const timeoutController = new AbortController()
      const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS)

      const onParentAbort = () => timeoutController.abort()
      if (context.signal) {
        if (context.signal.aborted) {
          clearTimeout(timeoutId)
          return { content: 'Error: Fetch aborted by user', isError: true }
        }
        context.signal.addEventListener('abort', onParentAbort, { once: true })
      }

      let response: Response
      try {
        // redirect: 'manual' — do NOT follow redirects automatically.
        // A redirect to a private IP would bypass the SSRF check above.
        // We manually inspect each redirect target instead.
        response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ovogogogo/0.1.0; +https://github.com/ovogogogo)',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          },
          signal: timeoutController.signal,
          redirect: 'manual',
        })
      } finally {
        clearTimeout(timeoutId)
        if (context.signal) {
          context.signal.removeEventListener('abort', onParentAbort)
        }
      }

      // ── Manual redirect handling with SSRF re-check ──
      const MAX_REDIRECTS = 5
      let redirectCount = 0
      while (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get('location') &&
        redirectCount < MAX_REDIRECTS
      ) {
        const location = response.headers.get('location')!
        const redirectUrl = new URL(location, url).toString()

        // Re-check SSRF on the redirect target
        const redirectSSRF = await checkSSRF(redirectUrl)
        if (redirectSSRF.blocked) {
          return {
            content: `Error: redirect to ${redirectUrl} is blocked (${redirectSSRF.reason})`,
            isError: true,
          }
        }

        redirectCount++

        const redirectTimeoutController = new AbortController()
        const redirectTimeoutId = setTimeout(
          () => redirectTimeoutController.abort(),
          FETCH_TIMEOUT_MS,
        )
        if (context.signal) {
          if (context.signal.aborted) {
            clearTimeout(redirectTimeoutId)
            return { content: 'Error: Fetch aborted by user', isError: true }
          }
          context.signal.addEventListener('abort', () => redirectTimeoutController.abort(), {
            once: true,
          })
        }

        try {
          response = await fetch(redirectUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; ovogogogo/0.1.0; +https://github.com/ovogogogo)',
              Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            },
            signal: redirectTimeoutController.signal,
            redirect: 'manual',
          })
        } finally {
          clearTimeout(redirectTimeoutId)
        }
      }

      // If still a redirect after MAX_REDIRECTS, treat as error
      if (response.status >= 300 && response.status < 400) {
        return {
          content: `Error: too many redirects (max ${MAX_REDIRECTS})`,
          isError: true,
        }
      }

      if (!response.ok) {
        return {
          content: `HTTP Error ${response.status} ${response.statusText} fetching ${url}`,
          isError: true,
        }
      }

      const contentType = response.headers.get('content-type') || ''

      // ── Read body with size limit (prevents OOM from huge responses) ──
      let rawText: string
      if (response.body) {
        const reader = response.body.getReader()
        rawText = await readLimitedBody(reader, MAX_RESPONSE_BODY_BYTES)
      } else {
        rawText = ''
      }

      let textContent = ''
      if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(rawText) as unknown
          textContent = JSON.stringify(parsed, null, 2)
        } catch {
          textContent = rawText
        }
      } else {
        const { title, description, markdown } = htmlToMarkdown(rawText)
        const metaHeader = [
          title ? `# ${title}` : '',
          description ? `> **Description**: ${description}` : '',
        ]
          .filter(Boolean)
          .join('\n')

        textContent = metaHeader ? `${metaHeader}\n\n${markdown}` : markdown
      }

      const totalLen = textContent.length
      const slice = textContent.slice(startIdx, startIdx + maxLen)

      let resultText = slice
      if (startIdx > 0 || startIdx + maxLen < totalLen) {
        resultText += `\n\n[Content truncated: showing chars ${startIdx}-${startIdx + slice.length} of ${totalLen} total]`
      }

      return { content: resultText, isError: false }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error fetching ${url}: ${msg}`, isError: true }
    }
  }
}
