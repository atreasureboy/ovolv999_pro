/**
 * Critic system prompt — runs every N iterations to review recent
 * conversation history for common failure modes and inject corrections.
 *
 * Extracted from engine.ts so the prompt is domain-specific and can be
 * swapped without touching the engine loop.
 */

import type { OpenAIMessage } from '../core/types.js'

// ── Critic configuration ──────────────────────────────────────────────

/** Run critic every N iterations (only when there are enough messages to review) */
export const CRITIC_INTERVAL = 5
/** Don't bother before this many iterations */
export const CRITIC_MIN_ITERATIONS = 4
/** How many recent messages to feed the critic */
export const CRITIC_CONTEXT_MESSAGES = 24
/** Max tokens the critic can produce */
export const CRITIC_MAX_TOKENS = 400

// ── Default critic prompt (domain-neutral) ──────────────────────────

export const DEFAULT_CRITIC_SYSTEM_PROMPT = `你是一个会话的批判性监督 agent。
你只阅读操作历史，不执行操作。你的职责是发现以下常见失误并给出简短纠正：

1. **目标偏离** — 执行了用户明确要求范围之外的操作
2. **重复劳动** — 正在重复已经完成过的操作
3. **工具误用** — 用错了工具（如用 Read 执行命令、用 Bash 读大文件）
4. **错误忽略** — 工具返回错误但没有处理或重试，直接继续下一步
5. **上下文丢失** — 任务委派中没有提供足够的上下文信息
6. **输出冗余** — 输出大量无意义的文本，偏离任务执行

输出规则：
- 发现问题：用 "[问题] {描述}" + "[纠正] {具体应执行什么}" 格式，最多 3 条
- 没有问题：只输出 "OK"
- 不解释你的角色，不废话，直接结论`

// ── Formatting helpers ────────────────────────────────────────────────

/**
 * Serialize recent messages into a compact text format for the critic.
 * Truncates long fields to keep the critic prompt within budget.
 */
export function formatMessagesForCritic(messages: OpenAIMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'assistant') {
        const toolCalls = (m as { tool_calls?: Array<{ function: { name: string; arguments: string } }> }).tool_calls
        if (toolCalls && toolCalls.length > 0) {
          const calls = toolCalls
            .map((tc) => {
              let args: Record<string, unknown>
              try { args = JSON.parse(tc.function.arguments) as Record<string, unknown> } catch { args = {} }
              const truncated = Object.fromEntries(
                Object.entries(args).map(([k, v]) => [
                  k,
                  typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '...' : v,
                ]),
              )
              return `  [TOOL_CALL] ${tc.function.name}(${JSON.stringify(truncated)})`
            })
            .join('\n')
          const text = typeof m.content === 'string' && m.content ? `  ${m.content}\n` : ''
          return `[ASSISTANT]\n${text}${calls}`
        }
        return `[ASSISTANT] ${m.content ?? ''}`
      }
      if (m.role === 'tool') {
        const content = typeof m.content === 'string' ? m.content.slice(0, 800) : ''
        const name = (m as { name?: string }).name ?? 'tool'
        return `[TOOL_RESULT:${name}] ${content}${content.length >= 800 ? '...' : ''}`
      }
      if (m.role === 'user') {
        const content = typeof m.content === 'string' ? m.content.slice(0, 400) : ''
        return `[USER] ${content}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Parse the critic's response. Returns null if the critic found no issues,
 * or the correction string if it did.
 */
export function parseCriticOutput(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed || /^ok$/i.test(trimmed)) return null
  return trimmed
}
