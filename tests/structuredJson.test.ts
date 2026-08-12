import { describe, it, expect } from 'vitest'
import { parseTolerantJson, extractJsonBlock } from '../src/core/structuredJson.js'

describe('StructuredJSONExtractor', () => {
  it('extracts JSON from markdown codeblock fences', () => {
    const raw = 'Here is the result:\n```json\n{"status": "ok", "value": 42}\n```'
    const res = parseTolerantJson<{ status: string; value: number }>(raw)
    expect(res.ok).toBe(true)
    expect(res.data?.status).toBe('ok')
    expect(res.data?.value).toBe(42)
  })

  it('handles trailing commas and unclosed objects gracefully', () => {
    const truncated = '{"name": "Alice", "tags": ["admin", "dev"],'
    const res = parseTolerantJson<{ name: string; tags: string[] }>(truncated)
    expect(res.ok).toBe(true)
    expect(res.data?.name).toBe('Alice')
    expect(res.data?.tags).toEqual(['admin', 'dev'])
  })

  it('handles truncated strings gracefully', () => {
    const truncatedStr = '{"greeting": "Hello World'
    const res = parseTolerantJson<{ greeting: string }>(truncatedStr)
    expect(res.ok).toBe(true)
    expect(res.data?.greeting).toBe('Hello World')
  })
})
