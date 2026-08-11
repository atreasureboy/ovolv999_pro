import { describe, it, expect } from 'vitest'
import { snipCompact } from '../src/core/snipCompact.js'
import type { OpenAIMessage } from '../src/core/types.js'

describe('snipCompact dropEmptyMessages', () => {
  it('does not drop empty tool messages (preserves tool_call/result pairing)', () => {
    // Regression: isWhitespace("") was true so an empty tool result got
    // spliced out, orphaning its assistant tool_call and breaking the provider.
    const messages: OpenAIMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'doThing', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '', name: 'doThing' },
      { role: 'user', content: '' }, // empty user message — may be dropped
      { role: 'user', content: 'keep me' },
      { role: 'assistant', content: 'final' },
    ]

    const res = snipCompact(messages, 1)
    const toolMsgs = res.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(1)
    expect(toolMsgs[0].tool_call_id).toBe('call_1')

    // The assistant tool_call message must survive alongside its result.
    const assistantWithCalls = res.messages.find(
      (m) => m.role === 'assistant' && m.tool_calls?.length,
    )
    expect(assistantWithCalls).toBeDefined()
  })
})
