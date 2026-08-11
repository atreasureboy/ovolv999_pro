import { describe, it, expect } from 'vitest'
import { convertMessages } from '../src/core/providerAdapter.js'
import type OpenAI from 'openai'
import type { OpenAIMessage } from '../src/core/types.js'

// Build OpenAI-shaped messages and assert convertMessages groups consecutive
// tool messages into a single Anthropic user message (required by the API).
function toOpenAI(msgs: OpenAIMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return msgs as unknown as OpenAI.Chat.ChatCompletionMessageParam[]
}

describe('convertMessages (Anthropic tool_result grouping)', () => {
  it('groups consecutive tool messages into a single user message', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1', name: 'a' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2', name: 'b' },
      { role: 'assistant', content: 'done' },
    ]

    const converted = convertMessages(toOpenAI(messages))
    // assistant, user(tool_results), assistant — 3 messages, not 4.
    expect(converted.length).toBe(3)
    expect(converted[1].role).toBe('user')
    expect(Array.isArray(converted[1].content)).toBe(true)
    expect((converted[1].content as unknown[]).length).toBe(2)
  })

  it('flushes trailing tool results even with no following assistant message', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1', name: 'a' },
    ]
    const converted = convertMessages(toOpenAI(messages))
    expect(converted.length).toBe(2)
    expect(converted[1].role).toBe('user')
  })

  it('keeps separate groups for tool results separated by a non-tool message', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1', name: 'a' },
      { role: 'user', content: 'intervening' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c2', content: 'r2', name: 'b' },
    ]
    const converted = convertMessages(toOpenAI(messages))
    const groupedUsers = converted.filter((m) => m.role === 'user' && Array.isArray(m.content))
    expect(groupedUsers.length).toBe(2)
  })
})
