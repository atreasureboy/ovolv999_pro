import { describe, it, expect } from 'vitest'
import { partitionToolCalls } from '../src/core/toolRuntime/toolScheduler.js'
import type { Tool } from '../src/core/types.js'
import {
  calculateContextState,
  estimateTokens,
  getCompressionStrategy,
  MODEL_MAX_CONTEXT_TOKENS,
} from '../src/core/compact.js'
import { parseCriticOutput, formatMessagesForCritic } from '../src/prompts/critic.js'

// ── partitionToolCalls ──────────────────────────────────────────────────────

function makeParsedToolCall(
  name: string,
  args: Record<string, unknown> = {},
): {
  tc: { index: number; id: string; name: string; arguments: string }
  input: Record<string, unknown>
} {
  return {
    tc: { index: 0, id: `tc_${name}`, name, arguments: JSON.stringify(args) },
    input: args,
  }
}

/** Create a minimal tool stub for scheduler tests. */
function makeTool(name: string, concurrencySafe: boolean): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    category: concurrencySafe ? 'readonly' : 'mutation',
    riskLevel: 'safe',
    concurrencySafe,
    planModeAllowed: true,
    informationalAllowed: true,
    definition: {
      type: 'function',
      function: {
        name,
        description: `Test tool: ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: () => Promise.resolve({ content: 'ok', isError: false }),
  }
}

describe('partitionToolCalls', () => {
  it('groups safe tools into a single parallel batch', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Glob', { pattern: '*.ts' }),
      makeParsedToolCall('Grep', { pattern: 'foo' }),
    ]
    const tools = [makeTool('Read', true), makeTool('Glob', true), makeTool('Grep', true)]

    const batches = partitionToolCalls(calls, tools)
    expect(batches).toHaveLength(1)
    expect(batches[0].safe).toBe(true)
    expect(batches[0].calls).toHaveLength(3)
  })

  it('separates Write/Edit into their own serial batches', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Write', { file_path: 'b.ts', content: 'hello' }),
      makeParsedToolCall('Glob', { pattern: '*.ts' }),
    ]
    const tools = [makeTool('Read', true), makeTool('Write', false), makeTool('Glob', true)]

    const batches = partitionToolCalls(calls, tools)
    // Read is safe (batch 1), Write is unsafe (batch 2), Glob is safe but
    // follows unsafe so it starts a new batch (batch 3)
    expect(batches).toHaveLength(3)
    expect(batches[0].safe).toBe(true)
    expect(batches[1].safe).toBe(false)
    expect(batches[2].safe).toBe(true)
  })

  it('merges consecutive safe tool calls into one batch', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Glob', { pattern: '*.ts' }),
      makeParsedToolCall('WebFetch', { url: 'http://example.com' }),
    ]
    const tools = [makeTool('Read', true), makeTool('Glob', true), makeTool('WebFetch', true)]

    const batches = partitionToolCalls(calls, tools)
    expect(batches).toHaveLength(1)
    expect(batches[0].safe).toBe(true)
  })

  it('handles empty input', () => {
    const batches = partitionToolCalls([])
    expect(batches).toHaveLength(0)
  })

  it('puts Bash in parallel batch (per design: dependent ops use &&)', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Bash', { command: 'ls' }),
    ]
    const tools = [makeTool('Read', true), makeTool('Bash', true)]

    const batches = partitionToolCalls(calls, tools)
    expect(batches).toHaveLength(1)
    expect(batches[0].safe).toBe(true)
  })

  it('starts new batch when unsafe tool interrupts safe sequence', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Edit', { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' }),
      makeParsedToolCall('Read', { file_path: 'b.ts' }),
      makeParsedToolCall('Edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
    ]
    const tools = [makeTool('Read', true), makeTool('Edit', false)]

    const batches = partitionToolCalls(calls, tools)
    // Read(safe) → Edit(unsafe) → Read(safe) → Edit(unsafe)
    expect(batches).toHaveLength(4)
  })

  it('honours tool concurrencySafe self-declaration (custom tools)', () => {
    // P2-7: the scheduler uses each tool's concurrencySafe field —
    // custom tools not in any hardcoded list can still be parallelized.
    const calls = [
      makeParsedToolCall('MySafeA', {}),
      makeParsedToolCall('MySafeB', {}),
      makeParsedToolCall('MyUnsafe', {}),
    ]
    const tools = [
      makeTool('MySafeA', true),
      makeTool('MySafeB', true),
      makeTool('MyUnsafe', false),
    ]
    const batches = partitionToolCalls(calls, tools)
    // MySafeA + MySafeB merge into one parallel batch; MyUnsafe is serial
    expect(batches).toHaveLength(2)
    expect(batches[0].safe).toBe(true)
    expect(batches[0].calls).toHaveLength(2)
    expect(batches[1].safe).toBe(false)
  })
})

// ── estimateTokens / calculateContextState ──────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('estimates tokens for simple text messages', () => {
    const messages = [{ role: 'user' as const, content: 'Hello world' }]
    // "Hello world" = 11 chars + 20 envelope = 31 chars / 3.5 ≈ 9 tokens
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('accounts for tool_calls JSON overhead', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'tc_1',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file_path":"test.ts"}' },
          },
        ],
      },
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
  })

  it('estimates more tokens for longer content', () => {
    const short = [{ role: 'user' as const, content: 'Hi' }]
    const long = [{ role: 'user' as const, content: 'A'.repeat(1000) }]
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short))
  })
})

describe('calculateContextState', () => {
  it('calculates percentage correctly', () => {
    const messages = [{ role: 'user' as const, content: 'A'.repeat(7000) }]
    const maxTokens = 10000
    const state = calculateContextState(messages, maxTokens)
    expect(state.maxTokens).toBe(maxTokens)
    expect(state.pct).toBeGreaterThan(0)
    expect(state.pct).toBeLessThanOrEqual(1)
  })

  it('should warn at 70%', () => {
    // 70% of 200k = 140k tokens
    const charsNeeded = Math.ceil(140000 * 3.5 - 20) // minus envelope overhead
    const messages = [{ role: 'user' as const, content: 'A'.repeat(charsNeeded) }]
    const state = calculateContextState(messages, MODEL_MAX_CONTEXT_TOKENS)
    expect(state.shouldWarn).toBe(true)
  })

  it('should compact at 85%', () => {
    // 85% of 200k = 170k tokens
    const charsNeeded = Math.ceil(170000 * 3.5 - 20)
    const messages = [{ role: 'user' as const, content: 'A'.repeat(charsNeeded) }]
    const state = calculateContextState(messages, MODEL_MAX_CONTEXT_TOKENS)
    expect(state.shouldCompact).toBe(true)
  })

  it('does not warn or compact under thresholds', () => {
    const messages = [{ role: 'user' as const, content: 'short message' }]
    const state = calculateContextState(messages, MODEL_MAX_CONTEXT_TOKENS)
    expect(state.shouldWarn).toBe(false)
    expect(state.shouldCompact).toBe(false)
  })

  it('includes system prompt tokens in the budget (single source of truth)', () => {
    // P1-3: the engine passes systemPromptTokens so the budget reflects the real
    // token footprint, not just the conversation messages.
    const messages = [{ role: 'user' as const, content: 'short' }]
    const msgTokens = estimateTokens(messages)
    const state = calculateContextState(messages, 10_000, 5_000)
    expect(state.messageTokens).toBe(msgTokens)
    expect(state.systemPromptTokens).toBe(5_000)
    expect(state.currentTokens).toBe(msgTokens + 5_000)
  })

  it('compacts based on system prompt + message tokens combined', () => {
    // Messages alone are tiny; with a large system prompt we cross the threshold.
    const messages = [{ role: 'user' as const, content: 'hi' }]
    expect(calculateContextState(messages, 10_000, 0).shouldCompact).toBe(false)
    // 9000 system tokens + tiny messages ≈ 90% → well past the 85% compact line
    expect(calculateContextState(messages, 10_000, 9_000).shouldCompact).toBe(true)
  })
})

// ── getCompressionStrategy ──────────────────────────────────────────────────

describe('getCompressionStrategy', () => {
  it('returns proportional under 85%', () => {
    expect(getCompressionStrategy(0.5)).toBe('proportional')
    expect(getCompressionStrategy(0.7)).toBe('proportional')
    expect(getCompressionStrategy(0.84)).toBe('proportional')
  })

  it('returns priority at 85%+', () => {
    expect(getCompressionStrategy(0.86)).toBe('priority')
    expect(getCompressionStrategy(0.9)).toBe('priority')
  })

  it('returns aggressive at 90%+', () => {
    expect(getCompressionStrategy(0.91)).toBe('aggressive')
    expect(getCompressionStrategy(0.99)).toBe('aggressive')
  })
})

// ── Critic ──────────────────────────────────────────────────────────────────

describe('parseCriticOutput', () => {
  it('returns null for OK response', () => {
    expect(parseCriticOutput('OK')).toBeNull()
    expect(parseCriticOutput('ok')).toBeNull()
    expect(parseCriticOutput('  OK  ')).toBeNull()
  })

  it('returns null for empty response', () => {
    expect(parseCriticOutput('')).toBeNull()
  })

  it('returns structured issues for non-OK responses', () => {
    const output = '[问题] 重复劳动\n[纠正] 换个策略'
    const result = parseCriticOutput(output)
    expect(result).toEqual([{ problem: '重复劳动', correction: '换个策略' }])
  })

  it('falls back to raw mode when structured markers are absent', () => {
    const output = '[问题] something'
    const result = parseCriticOutput('  ' + output + '  ')
    expect(result).toEqual([{ problem: '[问题] something', correction: '' }])
  })
})

describe('formatMessagesForCritic', () => {
  it('formats assistant messages correctly', () => {
    const messages = [{ role: 'assistant' as const, content: 'Hello' }]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[ASSISTANT]')
    expect(formatted).toContain('Hello')
  })

  it('formats tool results with truncation', () => {
    const longResult = 'A'.repeat(1000)
    const messages = [{ role: 'tool' as const, content: longResult, name: 'Bash' }]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[TOOL_RESULT:Bash]')
    expect(formatted.length).toBeLessThan(longResult.length)
  })

  it('formats user messages', () => {
    const messages = [{ role: 'user' as const, content: 'Do something' }]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[USER]')
    expect(formatted).toContain('Do something')
  })

  it('handles empty input', () => {
    expect(formatMessagesForCritic([])).toBe('')
  })

  it('formats assistant messages with tool calls', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: 'Let me check',
        tool_calls: [
          {
            id: 'tc_1',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file_path":"test.ts"}' },
          },
        ],
      },
    ]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[ASSISTANT]')
    expect(formatted).toContain('Let me check')
    expect(formatted).toContain('[TOOL_CALL]')
    expect(formatted).toContain('Read')
  })
})
