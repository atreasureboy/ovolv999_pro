/**
 * ProviderAdapter — Provider 适配层
 *
 * 抽象不同 LLM Provider 的差异：
 * - 请求格式（system prompt 位置、工具定义）
 * - 流式传输（OpenAI chunks vs Anthropic SSE）
 * - 特殊处理（stream_options、usage 追踪）
 *
 * 所有 Provider 都标准化为 OpenAI ChatCompletionChunk 格式
 */

import type OpenAI from 'openai'
import type { ToolDefinition } from './types.js'

export type ProviderId = 'openai' | 'anthropic' | 'custom'

export interface ProviderStreamRequest {
  model: string
  systemPrompt: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools: ToolDefinition[]
  temperature?: number
  maxOutputTokens: number
  signal: AbortSignal
}

export interface ProviderAdapter {
  readonly providerId: ProviderId
  readonly streamUsageSupported: boolean
  resetStreamUsageLatch(): void
  markStreamUsageUnsupported(): void
  stream(req: ProviderStreamRequest): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>
}

/**
 * OpenAI 兼容适配器
 * 支持 OpenAI、Azure OpenAI、OpenRouter、Ollama 等兼容接口
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly providerId: ProviderId
  private _streamUsageSupported = true

  constructor(
    private readonly client: OpenAI,
    providerId: ProviderId = 'openai',
  ) {
    this.providerId = providerId
  }

  get streamUsageSupported(): boolean {
    return this._streamUsageSupported
  }

  resetStreamUsageLatch(): void {
    this._streamUsageSupported = true
  }

  markStreamUsageUnsupported(): void {
    this._streamUsageSupported = false
  }

  async stream(req: ProviderStreamRequest): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const { model, systemPrompt, messages, tools, temperature, maxOutputTokens, signal } = req

    const baseBody = {
      model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        ...messages,
      ],
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? ('auto' as const) : undefined,
      temperature: temperature ?? 0,
      max_tokens: maxOutputTokens,
      stream: true as const,
    }

    // 尝试使用 stream_options（部分 Provider 不支持）
    if (this._streamUsageSupported) {
      try {
        return await this.client.chat.completions.create(
          { ...baseBody, stream_options: { include_usage: true } },
          { signal },
        )
      } catch (err: unknown) {
        const msg = (err as Error).message || ''
        if (msg.includes('stream_options')) {
          this._streamUsageSupported = false
        } else {
          throw err
        }
      }
    }

    return this.client.chat.completions.create(baseBody, { signal })
  }
}

/**
 * Anthropic 适配器
 * 将 Anthropic Messages API 转换为 OpenAI 格式
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = 'anthropic'
  private _streamUsageSupported = true

  constructor(
    private readonly client: OpenAI,
    private readonly apiKey: string,
    private readonly baseURL: string = 'https://api.anthropic.com',
  ) {}

  get streamUsageSupported(): boolean {
    return this._streamUsageSupported
  }

  resetStreamUsageLatch(): void {
    this._streamUsageSupported = true
  }

  markStreamUsageUnsupported(): void {
    this._streamUsageSupported = false
  }

  async stream(req: ProviderStreamRequest): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    // Anthropic 需要特殊处理：system prompt 不在 messages 中
    // 这里简化实现，实际应该使用 Anthropic SDK 或 fetch
    // 暂时回退到 OpenAI 兼容模式
    const adapter = new OpenAICompatibleAdapter(this.client, 'anthropic')
    return adapter.stream(req)
  }
}

/**
 * 创建 Provider 适配器
 */
export function createProviderAdapter(
  client: OpenAI,
  provider: ProviderId = 'openai',
  apiKey?: string,
  baseURL?: string,
): ProviderAdapter {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter(client, apiKey || '', baseURL)
    case 'openai':
    case 'custom':
    default:
      return new OpenAICompatibleAdapter(client, provider)
  }
}
