import type OpenAI from 'openai'
import type { OpenAIMessage, IHookRunner } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'
import {
  maybeCompact,
  calculateContextState,
  MODEL_MAX_CONTEXT_TOKENS,
} from '../compact.js'
import { truncateToolResult } from './toolResultBudget.js'
import { snipCompact, SNIP_KEEP_RECENT } from '../snipCompact.js'

export interface ContextManagerDeps {
  client: OpenAI
  model: string
  maxContextTokens?: number
  maxOutputTokens?: number
  sessionDir?: string
  renderer: Renderer
  eventLog?: EventLog
  hookRunner?: IHookRunner
}

export class ContextManager {
  private readonly deps: ContextManagerDeps
  private systemPromptTokens = 0
  private resolvedContextWindow: number | null = null

  constructor(deps: ContextManagerDeps) {
    this.deps = deps
  }

  get contextWindow(): number {
    if (this.resolvedContextWindow === null) {
      this.resolvedContextWindow = this.deps.maxContextTokens ?? MODEL_MAX_CONTEXT_TOKENS
    }
    return this.resolvedContextWindow
  }

  getSystemPromptTokens(): number {
    return this.systemPromptTokens
  }

  setSystemPromptTokens(n: number): void {
    this.systemPromptTokens = n
  }

  onModelChanged(model: string): void {
    if (this.deps.model === model) return
    ;(this as unknown as { deps: ContextManagerDeps }).deps = { ...this.deps, model }
    this.resolvedContextWindow = null
  }

  async evaluateBudget(messages: OpenAIMessage[]): Promise<void> {
    // First pass: snip compact (surgical trimming)
    const snipResult = snipCompact(messages, SNIP_KEEP_RECENT)
    if (snipResult.snipped) {
      messages.length = 0
      messages.push(...snipResult.messages)
      this.deps.eventLog?.append('snip_compact', 'context', {
        tokensBefore: snipResult.tokensBefore,
        tokensAfter: snipResult.tokensAfter,
        charsSaved: snipResult.charsSaved,
      })
    }

    // Second pass: full budget evaluation
    const maxCtxTokens = this.contextWindow
    const state = calculateContextState(messages, maxCtxTokens, this.systemPromptTokens)

    if (this.deps.sessionDir && state.shouldWarn) {
      this.deps.renderer.contextWarning(state.currentTokens, maxCtxTokens, state.pct)
    }

    if (state.shouldCompact) {
      this.deps.renderer.compactStart(state.currentTokens)
      this.deps.eventLog?.append('context_compact', 'engine', {
        strategy: state.strategy,
        tokens_before: state.currentTokens,
        system_prompt_tokens: this.systemPromptTokens,
        pct: state.pct,
      })

      const compactResult = await maybeCompact(
        this.deps.client,
        this.deps.model,
        messages,
        state.strategy,
      )

      if (compactResult.compacted) {
        messages.length = 0
        messages.push(...compactResult.messages)
        this.deps.renderer.compactDone(compactResult.originalTokens, compactResult.summaryTokens)
        this.deps.eventLog?.append('context_compact', 'engine', {
          tokens_after: compactResult.summaryTokens,
          reduction: compactResult.originalTokens - compactResult.summaryTokens,
        })
        this.deps.hookRunner?.runOnContextOverflow?.(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
      }
    }
  }

  truncateToolResult(content: string): string {
    return truncateToolResult(content)
  }

  estimateSystemPromptTokens(systemPrompt: string): number {
    return Math.ceil(systemPrompt.length / 3.5) + 20
  }
}
