/**
 * SnipCompact — 手术式压缩
 *
 * 在 microCompact (50%) 和完整 LLM 摘要 (85%) 之间的第二道防线：
 * 1. 截断超长工具结果（head+tail）
 * 2. 删除空消息
 * 3. 折叠连续重复用户消息
 * 4. 剥离旧思维内容
 */

import type { OpenAIMessage } from './types.js'
import { estimateTokens } from './compact.js'

export const SNIP_TOOL_RESULT_MAX_CHARS = 4_000
export const SNIP_HEAD_CHARS = 1_500
export const SNIP_TAIL_CHARS = 1_500
export const SNIP_KEEP_RECENT = 6
export const SNIP_MIN_SAVINGS_CHARS = 200

export interface SnipResult {
  snipped: boolean
  messages: OpenAIMessage[]
  tokensBefore: number
  tokensAfter: number
  messagesTrimmed: number
  messagesDropped: number
  thinkingStripped: number
  charsSaved: number
}

function isWhitespace(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length === 0
}

function headTailTruncate(text: string, maxChars: number, head: number, tail: number): string {
  if (text.length <= maxChars) return text
  const saved = text.length - (head + tail)
  if (saved < SNIP_MIN_SAVINGS_CHARS) return text
  const omitted = text.length - head - tail
  return (
    text.slice(0, head) +
    `\n\n[…snip: ${omitted} chars omitted…]\n\n` +
    text.slice(-tail)
  )
}

function snipToolResults(
  messages: OpenAIMessage[],
  protectedRange: number,
): { trimmed: number; charsSaved: number } {
  let trimmed = 0
  let charsSaved = 0

  for (let i = 0; i < messages.length - protectedRange; i++) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue
    if (typeof msg.content !== 'string') continue

    const original = msg.content
    if (original.length <= SNIP_TOOL_RESULT_MAX_CHARS) continue

    const snipped = headTailTruncate(
      original,
      SNIP_TOOL_RESULT_MAX_CHARS,
      SNIP_HEAD_CHARS,
      SNIP_TAIL_CHARS,
    )

    if (snipped !== original) {
      messages[i] = { ...msg, content: snipped }
      trimmed++
      charsSaved += original.length - snipped.length
    }
  }

  return { trimmed, charsSaved }
}

function dropEmptyMessages(
  messages: OpenAIMessage[],
  protectedRange: number,
): number {
  const original = messages.length
  for (let i = messages.length - 1 - protectedRange; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'system') continue
    if (isWhitespace(msg.content)) {
      messages.splice(i, 1)
    }
  }
  return original - messages.length
}

function collapseDuplicateUsers(
  messages: OpenAIMessage[],
  protectedRange: number,
): number {
  let dropped = 0
  for (let i = messages.length - 2 - protectedRange; i >= 0; i--) {
    const cur = messages[i]
    const next = messages[i + 1]
    if (cur.role !== 'user' || next.role !== 'user') continue
    if (cur.content === next.content) {
      messages.splice(i, 1)
      dropped++
    }
  }
  return dropped
}

function stripOldThinking(
  messages: OpenAIMessage[],
  protectedRange: number,
): number {
  let stripped = 0

  for (let i = 0; i < messages.length - protectedRange; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue

    const filtered = msg.content.filter((part) => {
      if (typeof part !== 'object' || part === null) return true
      const raw = part as unknown as Record<string, unknown>
      if (raw.type === 'thinking') {
        stripped++
        return false
      }
      if (typeof raw.text === 'string') {
        const t = raw.text.trim()
        if (t.startsWith('<thinking>') && t.endsWith('</thinking>')) {
          stripped++
          return false
        }
      }
      return true
    })

    if (filtered.length !== msg.content.length) {
      if (filtered.length === 0) {
        messages[i] = { ...msg, content: '[thinking stripped]' }
      } else {
        messages[i] = { ...msg, content: filtered }
      }
    }
  }

  return stripped
}

export function snipCompact(
  messages: OpenAIMessage[],
  protectRecent: number = SNIP_KEEP_RECENT,
): SnipResult {
  const tokensBefore = estimateTokens(messages)
  const working = [...messages]

  const thinkingStripped = stripOldThinking(working, protectRecent)
  const { trimmed, charsSaved } = snipToolResults(working, protectRecent)
  const messagesDropped = dropEmptyMessages(working, protectRecent)
  const duplicatesDropped = collapseDuplicateUsers(working, protectRecent)
  const totalDropped = messagesDropped + duplicatesDropped

  const tokensAfter = estimateTokens(working)
  const totalCharsSaved = charsSaved + thinkingStripped * 100 + totalDropped * 50

  const snipped = trimmed > 0 || totalDropped > 0 || thinkingStripped > 0

  return {
    snipped,
    messages: working,
    tokensBefore,
    tokensAfter,
    messagesTrimmed: trimmed,
    messagesDropped: totalDropped,
    thinkingStripped,
    charsSaved: totalCharsSaved,
  }
}
