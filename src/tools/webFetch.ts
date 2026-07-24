/**
 * WebFetch — Fetch URL and convert content to clean structured Markdown
 *
 * Capabilities:
 * - HTML to Markdown converter (headings, links, lists, code blocks, tables)
 * - Metadata extraction (<title>, <meta description>)
 * - Direct JSON formatting for API endpoints
 * - Signal abortion support & 30s timeout
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

const MAX_CONTENT_LENGTH = 50_000
const FETCH_TIMEOUT_MS = 30_000

export interface WebFetchInput {
  url: string
  max_length?: number
  start_index?: number
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
  concurrencySafe = true

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
        response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; ovogogogo/0.1.0; +https://github.com/ovogogogo)',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          },
          signal: timeoutController.signal,
        })
      } finally {
        clearTimeout(timeoutId)
        if (context.signal) {
          context.signal.removeEventListener('abort', onParentAbort)
        }
      }

      if (!response.ok) {
        return {
          content: `HTTP Error ${response.status} ${response.statusText} fetching ${url}`,
          isError: true,
        }
      }

      const contentType = response.headers.get('content-type') || ''
      const rawText = await response.text()

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
