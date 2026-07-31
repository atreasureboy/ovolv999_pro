export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'openrouter'
  | 'together'
  | 'groq'
  | 'deepseek'
  | 'ollama'
  | 'mistral'
  | 'cohere'
  | 'perplexity'
  | 'unknown'

export interface ModelCapabilities {
  toolCalling: boolean
  parallelToolCalling: boolean
  reasoningTokens: boolean
  promptCaching: boolean
  usageStreaming: boolean
  imageInput: boolean
  maxContext: number
  maxOutput: number
}

export interface ModelInfo {
  id: string
  provider: ProviderId
  contextWindow: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsParallelTools?: boolean
  supportsReasoning?: boolean
  supportsVision?: boolean
}

const PROVIDER_DEFAULTS: Record<
  ProviderId,
  Pick<ModelCapabilities, 'promptCaching' | 'usageStreaming'>
> = {
  openai: { promptCaching: true, usageStreaming: false },
  anthropic: { promptCaching: true, usageStreaming: true },
  google: { promptCaching: false, usageStreaming: true },
  xai: { promptCaching: false, usageStreaming: false },
  openrouter: { promptCaching: false, usageStreaming: false },
  together: { promptCaching: false, usageStreaming: false },
  groq: { promptCaching: false, usageStreaming: true },
  deepseek: { promptCaching: true, usageStreaming: true },
  ollama: { promptCaching: false, usageStreaming: true },
  mistral: { promptCaching: false, usageStreaming: true },
  cohere: { promptCaching: false, usageStreaming: true },
  perplexity: { promptCaching: false, usageStreaming: false },
  unknown: { promptCaching: false, usageStreaming: false },
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

export function detectProvider(model: string): ProviderId {
  const lower = model.toLowerCase()
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai'
  if (lower.startsWith('claude')) return 'anthropic'
  if (lower.startsWith('gemini')) return 'google'
  if (lower.startsWith('grok')) return 'xai'
  if (lower.startsWith('deepseek')) return 'deepseek'
  if (lower.startsWith('llama')) return 'ollama'
  if (lower.startsWith('mistral') || lower.startsWith('mixtral')) return 'mistral'
  if (lower.startsWith('command')) return 'cohere'
  if (lower.startsWith('sonar')) return 'perplexity'
  return 'unknown'
}

export function capabilitiesForModel(
  model: string,
  contextWindow?: number,
): ModelCapabilities {
  const provider = detectProvider(model)
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.unknown
  const ctx = contextWindow ?? 128_000

  return {
    toolCalling: true,
    parallelToolCalling: true,
    reasoningTokens: provider === 'openai' || provider === 'anthropic' || provider === 'deepseek',
    promptCaching: defaults.promptCaching,
    usageStreaming: defaults.usageStreaming,
    imageInput: provider === 'openai' || provider === 'anthropic' || provider === 'google',
    maxContext: ctx,
    maxOutput: DEFAULT_MAX_OUTPUT_TOKENS,
  }
}

export function effectiveInputBudget(
  caps: ModelCapabilities,
  opts: { reserveForOutput?: number; reserveForWorkingState?: number } = {},
): number {
  const reserveForOutput = Math.min(
    opts.reserveForOutput ?? caps.maxOutput,
    caps.maxOutput,
  )
  const reserveForState = opts.reserveForWorkingState ?? 0
  return Math.max(0, caps.maxContext - reserveForOutput - reserveForState)
}
