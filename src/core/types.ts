// Core types for ovolv999 execution engine

import type { EventLog } from './eventLog.js'
import type { SemanticMemory } from './semanticMemory.js'
import type { EpisodicMemory } from './episodicMemory.js'
import type { AgentConfig } from './agentPresets.js'
import type { PermissionChecker } from './permission.js'
import type { PricingConfig } from '../config/agentConfig.js'
import type { ResourceClaim } from './resourceScheduler.js'
import type { BackgroundTaskManager } from './backgroundTaskManager.js'
import type { AsyncTaskManager } from './taskManager.js'
import type { ExecutionContext } from './executionContext.js'
import type { AgentModule } from './module.js'
import type { WorkingState } from './workingState.js'
import type { TaskIntent } from './taskIntent.js'
import type { ProviderId } from './providerAdapter.js'
import type OpenAI from 'openai'

// OpenAI-compatible tool call format
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Minimal surface a child engine needs to expose to AgentTool.
 */
export interface ChildEngineLike {
  runTurn: (
    msg: string,
    history: never[],
  ) => Promise<{
    result: { output: string; reason: string; completionStatus?: string }
  }>
  abort: () => void
  dispose?: () => void
}

export type AgentChildEngineFactory = (config: EngineConfig, renderer: unknown) => ChildEngineLike

/** Content part for multimodal messages (vision/image support). */
export interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ContentPart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export interface ToolResult {
  content: string
  isError: boolean
  // ── Structured result fields (optional, backward-compatible) ─────
  /** Exit code for command executions (0 = success, non-zero = failure) */
  exitCode?: number
  /** Captured stdout */
  stdout?: string
  /** Captured stderr */
  stderr?: string
  /** Number of lines changed by the operation (Edit/MultiEdit) */
  linesChanged?: number
  /** Number of bytes written (Write) */
  bytesWritten?: number
  /** Whether the operation is retryable */
  retryable?: boolean
}

export interface ToolMetadata {
  readOnly?: boolean
  concurrencySafe?: boolean
  mutatesState?: boolean
  longRunning?: boolean
  requiresNetwork?: boolean
  searchHint?: string
  shouldDefer?: boolean
  alwaysLoad?: boolean
  claims?: (input: Record<string, unknown>) => ResourceClaim[]
}

// ── Tool category: what class of operation this tool performs ──
export type ToolCategory = 'readonly' | 'mutation' | 'system' | 'external' | 'delegation'

// ── Risk level: how dangerous this tool is ──
export type RiskLevel = 'safe' | 'needs_approval' | 'dangerous'

export interface Tool {
  name: string
  description: string
  metadata?: ToolMetadata
  definition: ToolDefinition

  // ── Category (engine auto-decides filtering, concurrency, etc.) ──
  category: ToolCategory
  riskLevel: RiskLevel

  /**
   * True if this tool is safe to run concurrently with other safe tools within
   * a single LLM response (e.g. read-only tools, independent Bash calls).
   */
  concurrencySafe: boolean

  /** Whether this tool may exceed typical execution time */
  longRunning?: boolean

  // ── Declarations (engine auto-filters, no more hardcoded constants) ──
  /** Whether this tool is available in plan mode */
  planModeAllowed: boolean

  /** Whether this tool is available for informational tasks */
  informationalAllowed: boolean

  /** When user confirmation is required — kind + pattern */
  requiresConfirmation?: ToolConfirmationRequirement

  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>

  /**
   * Per-input concurrency check. If implemented, engine uses this instead of
   * the static concurrencySafe flag.
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean

  /** Pre-validation hook — validate input before execution */
  validateInput?(input: Record<string, unknown>): ToolValidationResult

  /** Post-processing hook — modify result after execution */
  postProcess?(result: ToolResult): ToolResult
}

/** When user confirmation is required */
export interface ToolConfirmationRequirement {
  kind: 'always' | 'outside_cwd' | 'pattern'
  pattern?: string // regex pattern string for pattern kind
}

export interface ToolValidationResult {
  valid: boolean
  errors?: string[]
}

export interface ToolContext {
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  permissionChecker?: PermissionChecker
  signal?: AbortSignal
  updateProgress?: (progress: number, recoveryData?: Record<string, unknown>) => void
  apiConfig?: { apiKey: string; baseURL?: string; model: string }
  sessionDir?: string
  eventLog?: EventLog
  semanticMemory?: SemanticMemory
  episodicMemory?: EpisodicMemory
  availableToolNames?: string[]
  excludedTools?: string[]
  backgroundTaskManager?: BackgroundTaskManager
  asyncTaskManager?: AsyncTaskManager
  execution?: ExecutionContext
  workingState?: WorkingState
  /** Parent engine modules — allows tools (e.g., AgentTool) to consult module hooks. */
  modules?: AgentModule[]
}

/**
 * Interface for hook runners — decouples engine from config layer.
 * Hooks are best-effort: implementations must never throw.
 */
export interface IHookRunner {
  runPreToolCall(toolName: string, input: Record<string, unknown>): void
  runPostToolCall(toolName: string, result: string, isError: boolean): void
  runUserPromptSubmit(prompt: string): void
  runOnError?(error: Error, context: { turnNumber: number; lastToolName?: string }): void
  runOnComplete?(result: TurnResult): void
  runOnContextOverflow?(tokensBefore: number, tokensAfter: number): void
}

export interface EngineConfig {
  model: string
  baseURL?: string
  apiKey: string
  client?: OpenAI
  maxIterations: number
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  systemPrompt?: string
  extraTools?: Tool[]
  planMode?: boolean
  hookRunner?: IHookRunner
  sessionDir?: string
  maxContextTokens?: number
  temperature?: number
  maxOutputTokens?: number
  eventLog?: EventLog
  semanticMemory?: SemanticMemory
  episodicMemory?: EpisodicMemory
  enabledModules?: string[]
  agent?: AgentConfig
  permissionChecker?: PermissionChecker
  pricing?: PricingConfig
  verifyCommands?: string[]
  /** Provider 类型（openai/anthropic/custom） */
  provider?: ProviderId
  /** 任务意图（自动分类或用户指定） */
  taskIntent?: TaskIntent
  /** Maximum USD cost before the agent stops (checked before each LLM call) */
  maxCostUsd?: number
  /** Token-bucket rate limiter for API calls (req/s). */
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  rateLimiter?: import('./rateLimiter.js').RateLimiter
  /** Wrap the system prompt in Anthropic cache_control breakpoints. */
  cacheSystemPrompt?: boolean
}

/** Cumulative token usage across one or more turns, for cost observability. */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number
  calls: number
}

export interface TurnResult {
  stopped: boolean
  reason: 'max_iterations' | 'stop_sequence' | 'error' | 'interrupted' | 'budget_exceeded'
  output: string
  error?: string
  /** Completion contract status — null when not evaluated */
  completionStatus?: string
}
