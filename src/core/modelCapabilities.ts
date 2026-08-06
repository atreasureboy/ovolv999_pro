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
  openai: { promptCaching: false, usageStreaming: false },
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

// ── Known models map for exact matching ────────────────────────────
// Provider detection by prefix is a heuristic; this map handles ambiguous
// or commonly-misclassified model names.

const KNOWN_MODEL_MAP: Record<string, ProviderId> = {
  // Llama models are typically served via OpenRouter, not Ollama's API
  'llama-3': 'openrouter',
  'llama-3.1': 'openrouter',
  'llama-3.2': 'openrouter',
  'llama-3.3': 'openrouter',
  'llama-4': 'openrouter',
  // Mistral models via OpenRouter (not mistral API directly)
  'mistral-7b': 'openrouter',
  'mistral-8x7b': 'openrouter',
  'mistral-8x22b': 'openrouter',
  'mistral-small': 'openrouter',
  'mistral-medium': 'openrouter',
  'mistral-large': 'openrouter',
  'mixtral-8x7b': 'openrouter',
  'mixtral-8x22b': 'openrouter',
  // Specific OpenAI reasoning models
  o1: 'openai',
  'o1-mini': 'openai',
  'o1-preview': 'openai',
  o3: 'openai',
  'o3-mini': 'openai',
  o4: 'openai',
  'o4-mini': 'openai',
  // DeepSeek reasoning models
  'deepseek-r1': 'deepseek',
  'deepseek-r1-distill': 'deepseek',
}

export function detectProvider(model: string): ProviderId {
  const lower = model.toLowerCase()

  // Exact/slug match first (handles ambiguous prefixes)
  for (const [slug, provider] of Object.entries(KNOWN_MODEL_MAP)) {
    if (lower.startsWith(slug)) return provider
  }

  // Prefix-based detection
  if (
    lower.startsWith('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4')
  )
    return 'openai'
  if (lower.startsWith('claude')) return 'anthropic'
  if (lower.startsWith('gemini')) return 'google'
  if (lower.startsWith('grok')) return 'xai'
  if (lower.startsWith('deepseek')) return 'deepseek'
  if (lower.startsWith('llama')) return 'openrouter'
  if (lower.startsWith('mistral') || lower.startsWith('mixtral')) return 'openrouter'
  if (lower.startsWith('command')) return 'cohere'
  if (lower.startsWith('sonar')) return 'perplexity'
  return 'unknown'
}

/** Models that natively support reasoning/thinking tokens. */
const REASONING_MODEL_PREFIXES = ['o1', 'o3', 'o4', 'deepseek-r1']

export function supportsReasoningTokens(model: string): boolean {
  const lower = model.toLowerCase()
  return REASONING_MODEL_PREFIXES.some((p) => lower.startsWith(p))
}

/**
 * Known limitations:
 * - `maxOutput` is a fixed default (8192) rather than per-model; exact model
 *   output limits vary widely (4k–128k+).
 * - `promptCaching` is a coarse per-provider default; some providers offer it
 *   only on specific models or endpoints.
 * - The known-model map covers common cases but new models appear frequently.
 *   Extend `KNOWN_MODEL_MAP` for newly-released models that need precise
 *   provider assignment.
 */
export function capabilitiesForModel(model: string, contextWindow?: number): ModelCapabilities {
  const provider = detectProvider(model)
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.unknown
  const ctx = contextWindow ?? 128_000

  return {
    toolCalling: true,
    parallelToolCalling: true,
    reasoningTokens: supportsReasoningTokens(model),
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
  const reserveForOutput = Math.min(opts.reserveForOutput ?? caps.maxOutput, caps.maxOutput)
  const reserveForState = opts.reserveForWorkingState ?? 0
  return Math.max(0, caps.maxContext - reserveForOutput - reserveForState)
}
