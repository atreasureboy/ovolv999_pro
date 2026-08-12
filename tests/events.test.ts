import { describe, it, expect } from 'vitest'
import { formatEventAsSSE, formatEventAsJsonL, type RunEvent } from '../src/core/runtime/events.js'

describe('RunEvent telemetry formatters', () => {
  it('formats events as SSE data blocks', () => {
    const event: RunEvent = { type: 'RUN_STARTED', userMessage: 'Hello World' }
    const sse = formatEventAsSSE(event)

    expect(sse).toContain('event: RUN_STARTED\n')
    expect(sse).toContain('data: {"type":"RUN_STARTED","userMessage":"Hello World"}\n\n')
  })

  it('formats events as JSON-L records', () => {
    const event: RunEvent = { type: 'MODEL_REQUESTED', model: 'gpt-4o' }
    const jsonl = formatEventAsJsonL(event)

    const parsed = JSON.parse(jsonl)
    expect(parsed.type).toBe('MODEL_REQUESTED')
    expect(parsed.model).toBe('gpt-4o')
    expect(parsed.timestamp).toBeDefined()
  })
})
