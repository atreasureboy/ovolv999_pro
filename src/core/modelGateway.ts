/**
 * ModelGateway — 模型网关
 *
 * 封装 LLM 调用逻辑：
 * - 使用 ProviderAdapter 处理 Provider 差异
 * - 处理上下文溢出错误（自动压缩重试）
 * - 处理 Provider 错误（降级到备用模型）
 * - 追踪 usage 和延迟
 */

import type OpenAI from 'openai'
import type { OpenAIMessage, ToolDefinition } from './types.js'
import type { TokenUsage } from './costTracker.js'
import type { Renderer } from '../ui/renderer.js'
import type { ProviderAdapter } from './providerAdapter.js'
import type { EventLog } from './eventLog.js'
import { detectProvider } from './modelCapabilities.js'

export interface ModelGatewayDeps {
  /** Primary adapter (used when model matches its provider). */
  adapter: ProviderAdapter
  /** Optional factory to create adapters for other providers dynamically. */
  adapterFactory?: (provider: string, model: string) => ProviderAdapter | null
  renderer: Renderer
  eventLog?: EventLog
}

export interface ModelCallParams {
  systemPrompt: string
  messages: OpenAIMessage[]
  toolDefs: ToolDefinition[]
  model: string
  temperature?: number
  maxOutputTokens: number
  abortSignal: AbortSignal
  turnAbortController: AbortController | null
}

export interface ModelGatewayCallbacks {
  onUsage?: (usage: TokenUsage | null, callStartMs: number) => void
  onContextOverflow?: (messages: OpenAIMessage[], abortSignal: AbortSignal) => Promise<boolean>
  onProviderError?: (failedModel: string, error: Error) => string | null
}

export interface ProviderAttempt {
  model: string
  provider: string
  success: boolean
  error?: string
  latencyMs: number
  usage: TokenUsage | null
}

export interface StreamResult {
  assistantText: string
  finishReason: string | null
  rawToolCalls: Array<{ id: string; name: string; arguments: string }>
  usage: TokenUsage | null
}

export type ModelGatewayResult = StreamResult & { attempts: ProviderAttempt[] }

export class ModelGatewayError extends Error {
  constructor(message: string, public readonly attempts: ProviderAttempt[]) {
    super(message)
    this.name = 'ModelGatewayError'
  }
}

export class ModelGateway {
  private readonly primaryAdapter: ProviderAdapter
  private readonly adapterFactory?: (provider: string, model: string) => ProviderAdapter | null
  private readonly renderer: Renderer
  private readonly eventLog?: EventLog

  /** Currently active adapter (may switch during fallback). */
  private activeAdapter: ProviderAdapter

  constructor(deps: ModelGatewayDeps) {
    this.primaryAdapter = deps.adapter
    this.activeAdapter = deps.adapter
    this.adapterFactory = deps.adapterFactory
    this.renderer = deps.renderer
    this.eventLog = deps.eventLog
  }

  get streamUsageSupported(): boolean {
    return this.activeAdapter.streamUsageSupported
  }

  markStreamUsageUnsupported(): void {
    this.activeAdapter.markStreamUsageUnsupported()
  }

  resetStreamUsageLatch(): void {
    this.activeAdapter.resetStreamUsageLatch()
  }

  /** Select the best adapter for a given model. */
  private selectAdapter(model: string): ProviderAdapter {
    if (this.adapterFactory) {
      // Detect provider from model name
      const provider = detectProvider(model)
      // Try factory; fall back to primary
      const custom = this.adapterFactory(provider, model)
      if (custom) return custom
    }
    return this.primaryAdapter
  }

  async call(
    params: ModelCallParams,
    callbacks?: ModelGatewayCallbacks,
  ): Promise<ModelGatewayResult> {
    const { systemPrompt, messages, toolDefs, model, temperature, maxOutputTokens, abortSignal, turnAbortController } = params

    // Select the appropriate adapter for this model
    this.activeAdapter = this.selectAdapter(model)

    this.renderer.startSpinner()
    const callStartMs = Date.now()
    const attempts: ProviderAttempt[] = []
    let activeModel = model
    let attemptStartMs = callStartMs

    const makeStreamReq = (m: string) => ({
      model: m,
      systemPrompt,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: toolDefs,
      temperature,
      maxOutputTokens,
      signal: abortSignal,
    })

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await this.activeAdapter.stream(makeStreamReq(model))
    } catch (caught: unknown) {
      this.renderer.stopSpinner()
      const err = caught instanceof Error ? caught : new Error(String(caught))
      const errMsg = err.message || ''

      attempts.push({
        model,
        provider: this.activeAdapter.providerId,
        success: false,
        error: errMsg,
        latencyMs: Date.now() - attemptStartMs,
        usage: null,
      })

      // 上下文溢出：自动压缩重试
      if (this.isContextOverflowError(errMsg) && callbacks?.onContextOverflow) {
        this.renderer.warn('Context too long — auto-compacting and retrying...')
        const compacted = await callbacks.onContextOverflow(messages, abortSignal)
        if (!compacted) throw new ModelGatewayError(err.message, attempts)

        attemptStartMs = Date.now()
        try {
          stream = await this.activeAdapter.stream(makeStreamReq(model))
        } catch (retryCaught) {
          const retryError = retryCaught instanceof Error ? retryCaught : new Error(String(retryCaught))
          attempts.push({
            model,
            provider: this.activeAdapter.providerId,
            success: false,
            error: retryError.message,
            latencyMs: Date.now() - attemptStartMs,
            usage: null,
          })
          throw new ModelGatewayError(retryError.message, attempts)
        }
      } else if (this.isRetryableProviderError(errMsg) && callbacks?.onProviderError) {
        // Provider 错误：降级到备用模型
        const fallbackModel = callbacks.onProviderError(model, err)
        if (!fallbackModel || fallbackModel === model) {
          throw new ModelGatewayError(err.message, attempts)
        }

        this.renderer.warn(`Provider error on "${model}" — falling back to "${fallbackModel}"`)
        activeModel = fallbackModel

        // Switch adapter if the fallback model belongs to a different provider
        this.activeAdapter = this.selectAdapter(fallbackModel)

        attemptStartMs = Date.now()

        try {
          stream = await this.activeAdapter.stream(makeStreamReq(fallbackModel))
        } catch (fallbackCaught) {
          const fallbackError = fallbackCaught instanceof Error ? fallbackCaught : new Error(String(fallbackCaught))
          attempts.push({
            model: fallbackModel,
            provider: this.activeAdapter.providerId,
            success: false,
            error: fallbackError.message,
            latencyMs: Date.now() - attemptStartMs,
            usage: null,
          })
          throw new ModelGatewayError(err.message, attempts)
        }
      } else {
        throw new ModelGatewayError(err.message, attempts)
      }
    }

    // 消费流
    let result: StreamResult
    try {
      result = await this.consumeStream(stream, abortSignal, turnAbortController)
    } catch (consumeCaught) {
      const consumeError = consumeCaught instanceof Error ? consumeCaught : new Error(String(consumeCaught))
      attempts.push({
        model: activeModel,
        provider: this.activeAdapter.providerId,
        success: false,
        error: consumeError.message,
        latencyMs: Date.now() - attemptStartMs,
        usage: null,
      })
      throw new ModelGatewayError(consumeError.message, attempts)
    }

    attempts.push({
      model: activeModel,
      provider: this.activeAdapter.providerId,
      success: true,
      latencyMs: Date.now() - attemptStartMs,
      usage: result.usage,
    })

    callbacks?.onUsage?.(result.usage, attemptStartMs)

    return { ...result, attempts }
  }

  private async consumeStream(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    abortSignal: AbortSignal,
    _turnAbortController: AbortController | null,
  ): Promise<StreamResult> {
    let assistantText = ''
    let finishReason: string | null = null
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()
    let usage: TokenUsage | null = null

    for await (const chunk of stream) {
      if (abortSignal.aborted) break

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        }
      }

      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        assistantText += delta.content
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, { id: '', name: '', arguments: '' })
          }
          const acc = toolCallsMap.get(idx)!
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name += tc.function.name
          if (tc.function?.arguments) acc.arguments += tc.function.arguments
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason
      }
    }

    const rawToolCalls = Array.from(toolCallsMap.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }))

    return {
      assistantText,
      finishReason,
      rawToolCalls,
      usage,
    }
  }

  private isRetryableProviderError(errMsg: string): boolean {
    return (
      /\b429\b/.test(errMsg) ||
      /\b5\d\d\b/.test(errMsg) ||
      /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/.test(errMsg) ||
      /\btime[\s_-]?out\b/i.test(errMsg) ||
      /\brate[\s_-]?limit\b/i.test(errMsg)
    )
  }

  private isContextOverflowError(errMsg: string): boolean {
    return (
      errMsg.includes('context_length_exceeded') ||
      errMsg.includes('maximum context length') ||
      /context[\s_-]{0,80}(?:is\s+)?too\s+long/i.test(errMsg)
    )
  }
}
