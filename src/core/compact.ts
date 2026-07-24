/**
 * Conversation Compact — auto-summarize when context grows too large
 *
 * Strategy:
 *   1. Estimate token count of current conversation (~4 chars/token)
 *   2. When context pressure exceeds the compact threshold (85%), call the LLM to summarize
 *   3. Replace old messages with a single system-style summary message
 *   4. Keep last N recent messages verbatim (fresh context)
 */

import type OpenAI from 'openai'
import type { OpenAIMessage } from './types.js'

// Rough chars-per-token estimate (conservative — better to compact early)
const CHARS_PER_TOKEN = 3.5

// Model max context window (tokens). Matches claude-sonnet-4-x 200k context.
// Sub-agents inherit the same model so one constant is sufficient here.
export const MODEL_MAX_CONTEXT_TOKENS = 200_000

// Percentage-based thresholds — the SINGLE source of truth for context pressure.
// Both the engine (evaluateContextBudget) and tests read these constants so the
// warn/compact boundaries can never drift between modules.
export const CONTEXT_WARN_PCT = 0.7 // 70%  → display yellow warning
export const CONTEXT_COMPACT_PCT = 0.85 // 85%  → force auto-compact

/** Compression strategy selected based on context pressure */
export type CompressionStrategy = 'proportional' | 'priority' | 'aggressive'

/** Determine compression strategy from usage fraction */
export function getCompressionStrategy(pct: number): CompressionStrategy {
  if (pct > 0.9) return 'aggressive'
  if (pct > 0.85) return 'priority'
  return 'proportional'
}

// Keep this many recent messages verbatim after compaction, varying by strategy:
//   proportional (low pressure) keeps the most, aggressive (near-overflow) keeps fewest
// so we maximise summarised headroom exactly when we need it most.
function keepRecentFor(strategy: CompressionStrategy): number {
  if (strategy === 'aggressive') return 4
  if (strategy === 'priority') return 6
  return 8 // proportional
}

// Reserve tokens for the summary output itself
const SUMMARY_OUTPUT_RESERVE = 4_000

// ── Context state ────────────────────────────────────────────────────────────

export interface ContextState {
  /** Estimated current token count (messages + system prompt) */
  currentTokens: number
  /** Token count attributable to the conversation messages only */
  messageTokens: number
  /** Token count attributable to the system prompt */
  systemPromptTokens: number
  /** Model maximum context window */
  maxTokens: number
  /** Usage fraction 0–1 */
  pct: number
  /** True when ≥ CONTEXT_WARN_PCT — show a yellow warning */
  shouldWarn: boolean
  /** True when ≥ CONTEXT_COMPACT_PCT — trigger auto-compact immediately */
  shouldCompact: boolean
  /** Compression strategy based on current pressure */
  strategy: CompressionStrategy
}

/**
 * Calculate current context usage and determine whether to warn or compact.
 *
 * This is the single computation path for context pressure: the engine calls it
 * (passing `systemPromptTokens` for an accurate budget) and tests call it too.
 * Both reference the exported `CONTEXT_WARN_PCT` / `CONTEXT_COMPACT_PCT`.
 */
export function calculateContextState(
  messages: OpenAIMessage[],
  maxTokens: number = MODEL_MAX_CONTEXT_TOKENS,
  systemPromptTokens: number = 0,
): ContextState {
  const messageTokens = estimateTokens(messages)
  const currentTokens = messageTokens + systemPromptTokens
  const pct = currentTokens / maxTokens
  return {
    currentTokens,
    messageTokens,
    systemPromptTokens,
    maxTokens,
    pct,
    shouldWarn: pct >= CONTEXT_WARN_PCT,
    shouldCompact: pct >= CONTEXT_COMPACT_PCT,
    strategy: getCompressionStrategy(pct),
  }
}

/**
 * Rough token count estimate from message array.
 * Counts all content strings + JSON overhead.
 */
export function estimateTokens(messages: OpenAIMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (msg.content === null) {
      chars += 4
    }
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length
    }
    if (msg.name) chars += msg.name.length
    chars += 20 // message envelope overhead
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

// ── Compact prompt ──────────────────────────────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Do NOT use any tools. Your entire response must be a plain text summary.
Tool calls will be IGNORED — you have one turn to produce text.

`

const SUMMARY_SYSTEM_PROMPT = `${NO_TOOLS_PREAMBLE}You are summarizing a conversation between a user and an AI coding assistant.

Your summary will replace the full conversation history. The assistant must be able to continue the conversation from your summary with complete context.

Before writing the summary, analyze the conversation in <analysis> tags:
1. Go through each message chronologically
2. Identify: user requests, decisions made, files modified, commands run, errors encountered and fixed
3. Note any explicit user feedback or corrections
4. Identify what is still in progress or incomplete

Then write the summary in <summary> tags with these sections:

## Task Overview
What the user asked for and the overall goal.

## Work Completed
- Files created/modified (with paths and key changes)
- Commands run and their outcomes
- Problems solved and how

## Current State
What has been done, what is working, what is still pending.

## Key Context
Important decisions, patterns, constraints, or user preferences to remember.
Include relevant code snippets, function signatures, or file contents that are critical for continuing.

## Next Steps
What needs to be done next (if anything is incomplete).`

/**
 * Extract content between tags, stripping the analysis scratchpad.
 */
function extractSummary(text: string): string {
  // Try to get <summary>...</summary>
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim()
  }

  // Fall back: strip <analysis> block and return the rest
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim()
}

/**
 * Serialize messages to text for the summarization prompt.
 */
function serializeMessages(messages: OpenAIMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    const role = msg.role.toUpperCase()
    if (typeof msg.content === 'string' && msg.content) {
      parts.push(`[${role}]: ${msg.content}`)
    } else if (msg.content === null && msg.tool_calls?.length) {
      const calls = msg.tool_calls
        .map((tc) => `  → ${tc.function.name}(${tc.function.arguments.slice(0, 200)})`)
        .join('\n')
      parts.push(`[ASSISTANT tool calls]:\n${calls}`)
    }
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      const preview = msg.content.slice(0, 500)
      const truncated = msg.content.length > 500 ? ' ...[truncated]' : ''
      parts.push(`[TOOL RESULT: ${msg.name ?? '?'}]: ${preview}${truncated}`)
    }
  }
  return parts.join('\n\n')
}

export interface CompactResult {
  compacted: boolean
  messages: OpenAIMessage[]
  summaryTokens: number
  originalTokens: number
}

/**
 * Compact the conversation by summarizing older messages.
 * The engine gates this call — by the time we're here, compaction is needed.
 * Returns new (smaller) messages array.
 */
export async function maybeCompact(
  client: OpenAI,
  model: string,
  messages: OpenAIMessage[],
  strategy: CompressionStrategy = 'proportional',
): Promise<CompactResult> {
  const originalTokens = estimateTokens(messages)
  const keepRecent = keepRecentFor(strategy)

  // Keep the most recent messages verbatim — they're the freshest context.
  // Ensure we don't split between an assistant message with tool_calls and its
  // tool result messages (OpenAI API requires them to stay together).
  let splitPoint = messages.length - keepRecent
  if (splitPoint > 0) {
    // Walk forward from split point — if we're in the middle of tool results,
    // extend to include all results for the last assistant tool_calls.
    // Cap at messages.length - 2 to always keep at least 2 recent messages.
    const maxSplit = messages.length - 2
    while (splitPoint < maxSplit && messages[splitPoint]?.role === 'tool') {
      splitPoint++
    }
  }
  const recentMessages = messages.slice(splitPoint)
  const olderMessages = messages.slice(0, splitPoint)

  if (olderMessages.length === 0 || messages.length < keepRecent * 2) {
    // Not enough messages to compact meaningfully
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  // Build the summarization request
  const conversationText = serializeMessages(olderMessages)
  const userPrompt = `Please summarize the following conversation:\n\n${conversationText}`

  let summaryText: string
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: SUMMARY_OUTPUT_RESERVE,
      // No tools — we explicitly don't want tool calls here
    })
    summaryText = response.choices[0]?.message?.content ?? ''
  } catch {
    // If summarization fails, return original messages unchanged
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  const summary = extractSummary(summaryText)
  if (!summary) {
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  // Build compacted history: summary message + recent verbatim messages
  const summaryContent = `[CONVERSATION SUMMARY — previous context compacted]\n\n${summary}`

  const summaryMessage: OpenAIMessage = {
    role: 'user',
    content: summaryContent,
  }

  const syntheticAssistantAck: OpenAIMessage = {
    role: 'assistant',
    content: `I've reviewed the conversation summary and have the context needed to continue.`,
  }

  const compactedMessages: OpenAIMessage[] = [
    summaryMessage,
    syntheticAssistantAck,
    ...recentMessages,
  ]

  const summaryTokens = estimateTokens(compactedMessages)

  return {
    compacted: true,
    messages: compactedMessages,
    summaryTokens,
    originalTokens,
  }
}
