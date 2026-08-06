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

export type ProviderId = 'openai' | 'anthropic' | 'custom' | 'unknown'

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

  async stream(
    req: ProviderStreamRequest,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const { model, systemPrompt, messages, tools, temperature, maxOutputTokens, signal } = req

    const baseBody = {
      model,
      messages: [{ role: 'system' as const, content: systemPrompt }, ...messages],
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

// ── Anthropic types ───────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicToolDef {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

interface AnthropicSSEEvent {
  type: string
  message?: {
    id: string
    model: string
    usage?: { input_tokens: number }
  }
  index?: number
  content_block?: { type: string; text?: string; id?: string; name?: string }
  delta?: {
    type: string
    text?: string
    partial_json?: string
    stop_reason?: string
    stop_sequence?: string
  }
  usage?: { output_tokens: number }
}

/**
 * Anthropic 适配器 — 通过 fetch() 调用 Anthropic Messages API
 *
 * 将 Anthropic SSE 流转换为 OpenAI ChatCompletionChunk 格式。
 * 处理 Anthropic 特有的 system prompt（顶层字段）、
 * tool schema（input_schema）、以及 content block 增量事件。
 *
 * Known limitations:
 * - Does not support prompt caching (ephemeral / cache_control) headers yet.
 * - image / document content blocks in messages are not converted; text-only.
 * - If these features are needed, consider using @anthropic-ai/sdk directly.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = 'anthropic'
  private _streamUsageSupported = true
  private readonly baseURL: string
  private readonly apiVersion = '2023-06-01'

  constructor(
    private readonly _client: OpenAI, // kept for interface compatibility
    private readonly apiKey: string,
    baseURL: string = 'https://api.anthropic.com',
  ) {
    this.baseURL = baseURL.replace(/\/+$/, '')
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

  async stream(
    req: ProviderStreamRequest,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const { model, systemPrompt, messages, tools, temperature, maxOutputTokens, signal } = req

    const anthropicMessages = convertMessages(messages)
    const anthropicTools = tools.length > 0 ? convertTools(tools) : undefined

    const body: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      max_tokens: maxOutputTokens,
      stream: true,
    }

    if (systemPrompt) body.system = systemPrompt
    if (anthropicTools) body.tools = anthropicTools
    if (temperature !== undefined) body.temperature = temperature

    const response = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`)
    }

    if (!response.body) {
      throw new Error('Anthropic API returned no response body')
    }

    return anthropicSSEToOpenAIChunks(response.body, model)
  }
}

// ── Message conversion helpers ──────────────────────────────────────

function convertMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') continue // system is extracted separately

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      result.push({ role: 'user', content })
      continue
    }

    if (msg.role === 'assistant') {
      const toolCalls = (
        msg as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
      ).tool_calls
      if (toolCalls && toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = []
        // Text content first
        if (typeof msg.content === 'string' && msg.content) {
          blocks.push({ type: 'text', text: msg.content })
        }
        for (const tc of toolCalls) {
          let parsedArgs: Record<string, unknown> = {}
          try {
            parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>
          } catch {
            /* keep empty */
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedArgs,
          })
        }
        result.push({ role: 'assistant', content: blocks })
      } else {
        const content = typeof msg.content === 'string' ? msg.content : ''
        result.push({ role: 'assistant', content })
      }
      continue
    }

    if (msg.role === 'tool') {
      const toolMsg = msg as { tool_call_id: string; content: string; name?: string }
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolMsg.tool_call_id,
            content: toolMsg.content,
          },
        ],
      })
    }
  }

  return result
}

function convertTools(tools: ToolDefinition[]): AnthropicToolDef[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: {
      type: 'object' as const,
      properties: t.function.parameters?.properties ?? {},
      required: t.function.parameters?.required,
    },
  }))
}

// ── SSE → OpenAI chunk conversion ──────────────────────────────────

/** Map Anthropic stop_reason to OpenAI finish_reason. */
function mapAnthropicFinishReason(
  reason: string | null,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null {
  if (!reason) return null
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'stop'
  }
}

async function* anthropicSSEToOpenAIChunks(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let msgId = ''
  let inputTokens = 0
  let outputTokens = 0
  let finishReason: string | null = null
  let chunkIndex = 0

  // Tool use accumulation state
  const toolUseMap = new Map<number, { id: string; name: string; arguments: string }>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (!trimmed.startsWith('data: ')) continue

        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        let event: AnthropicSSEEvent
        try {
          event = JSON.parse(data) as AnthropicSSEEvent
        } catch {
          continue
        }

        switch (event.type) {
          case 'message_start': {
            if (event.message) {
              msgId = event.message.id
              inputTokens = event.message.usage?.input_tokens ?? 0
            }
            break
          }

          case 'content_block_start': {
            if (event.content_block?.type === 'tool_use' && event.index !== undefined) {
              toolUseMap.set(event.index, {
                id: event.content_block.id ?? '',
                name: event.content_block.name ?? '',
                arguments: '',
              })
            }
            break
          }

          case 'content_block_delta': {
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              // Text delta
              const chunk: OpenAI.Chat.ChatCompletionChunk = {
                id: msgId || `chatcmpl-${chunkIndex++}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta.text },
                    finish_reason: null,
                  },
                ],
              }
              if (inputTokens > 0 || outputTokens > 0) {
                chunk.usage = {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                }
              }
              yield chunk
            } else if (
              event.delta?.type === 'input_json_delta' &&
              event.delta.partial_json !== undefined &&
              event.index !== undefined
            ) {
              // Tool use argument delta
              const existing = toolUseMap.get(event.index)
              if (existing) {
                existing.arguments += event.delta.partial_json
              }
            }
            break
          }

          case 'content_block_stop': {
            if (event.index !== undefined) {
              const tc = toolUseMap.get(event.index)
              if (tc) {
                // Emit tool call chunk
                const chunk: OpenAI.Chat.ChatCompletionChunk = {
                  id: msgId || `chatcmpl-${chunkIndex++}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: event.index,
                            id: tc.id,
                            type: 'function' as const,
                            function: { name: tc.name, arguments: tc.arguments },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }
                yield chunk
              }
            }
            break
          }

          case 'message_delta': {
            if (event.delta?.stop_reason) {
              finishReason = event.delta.stop_reason
            }
            if (event.usage?.output_tokens) {
              outputTokens = event.usage.output_tokens
            }
            break
          }

          case 'message_stop': {
            // Map Anthropic stop_reason → OpenAI finish_reason
            const mappedFinishReason = mapAnthropicFinishReason(finishReason)
            // Emit final chunk with usage
            const finalChunk: OpenAI.Chat.ChatCompletionChunk = {
              id: msgId || `chatcmpl-${chunkIndex++}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: mappedFinishReason,
                },
              ],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            }
            yield finalChunk
            break
          }

          case 'ping':
            // ignore keepalive pings
            break
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 创建 Provider 适配器
 *
 * @param client   OpenAI 客户端实例（Anthropic 适配器不使用它，但保留以维持接口一致性）
 * @param provider 目标 Provider ID
 * @param apiKey   API 密钥（Anthropic 适配器必需）
 * @param baseURL  自定义 API 端点
 */
export function createProviderAdapter(
  client: OpenAI,
  provider: ProviderId = 'openai',
  apiKey?: string,
  baseURL?: string,
): ProviderAdapter {
  switch (provider) {
    case 'anthropic':
      if (!apiKey) {
        // No API key → fall through to OpenAI-compatible with a warning.
        // Many gateways (OpenRouter, etc.) proxy Anthropic models through
        // an OpenAI-compatible endpoint, so this is a valid configuration.
        // eslint-disable-next-line no-console
        console.warn(
          '[ProviderAdapter] Anthropic provider selected but no apiKey provided. ' +
            'Falling back to OpenAI-compatible mode. If you are using a proxy/gateway ' +
            '(e.g. OpenRouter), this is expected.',
        )
        return new OpenAICompatibleAdapter(client, 'anthropic')
      }
      return new AnthropicAdapter(client, apiKey, baseURL)
    case 'openai':
    case 'custom':
    case 'unknown':
    default:
      return new OpenAICompatibleAdapter(client, provider)
  }
}
