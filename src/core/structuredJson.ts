/**
 * StructuredJSONExtractor — Tolerant JSON parser for LLM outputs.
 *
 * Handles common LLM JSON formatting issues:
 * - Markdown codeblock fences (```json ... ```)
 * - Trailing commas in objects and arrays
 * - Truncated JSON strings/objects (attempts auto-closing)
 * - Leading/trailing text surrounding JSON blocks
 */

export function extractJsonBlock(text: string): string {
  let cleaned = text.trim()

  // Extract from markdown ```json fence if present
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(cleaned)
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim()
  }

  // If surrounding prose exists, extract first { ... } or [ ... ]
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const firstBrace = cleaned.indexOf('{')
    const firstBracket = cleaned.indexOf('[')
    let startIdx = -1

    if (firstBrace >= 0 && firstBracket >= 0) {
      startIdx = Math.min(firstBrace, firstBracket)
    } else if (firstBrace >= 0) {
      startIdx = firstBrace
    } else if (firstBracket >= 0) {
      startIdx = firstBracket
    }

    if (startIdx >= 0) {
      cleaned = cleaned.slice(startIdx)
    }
  }

  return cleaned
}

export function autoCloseJson(raw: string): string {
  let s = raw.trim()

  // Remove trailing commas before closing braces/brackets
  s = s.replace(/,\s*([\}\]])/g, '$1')

  let openBraces = 0
  let openBrackets = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < s.length; i++) {
    const char = s[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (!inString) {
      if (char === '{') openBraces++
      if (char === '}') openBraces = Math.max(0, openBraces - 1)
      if (char === '[') openBrackets++
      if (char === ']') openBrackets = Math.max(0, openBrackets - 1)
    }
  }

  // Close unclosed string if truncated inside a string
  if (inString) {
    s += '"'
  }

  // Remove trailing commas again if string closing created one
  s = s.replace(/,\s*$/, '')

  // Close unclosed brackets and braces in correct order
  while (openBrackets > 0) {
    s += ']'
    openBrackets--
  }
  while (openBraces > 0) {
    s += '}'
    openBraces--
  }

  return s
}

export function parseTolerantJson<T = unknown>(text: string): { data?: T; ok: boolean; error?: string } {
  if (!text || text.trim().length === 0) {
    return { ok: false, error: 'Empty JSON text' }
  }

  const block = extractJsonBlock(text)

  // First try direct standard parse
  try {
    const data = JSON.parse(block) as T
    return { data, ok: true }
  } catch {
    /* fallback to auto-close */
  }

  // Try parsing after auto-closing missing quotes/braces/brackets
  try {
    const closed = autoCloseJson(block)
    const data = JSON.parse(closed) as T
    return { data, ok: true }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
