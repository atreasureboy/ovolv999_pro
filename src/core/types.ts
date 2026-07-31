// Core types for ovolv999 execution engine

import type { EventLog } from './eventLog.js'
import type { SemanticMemory } from './semanticMemory.js'
import type { EpisodicMemory } from './episodicMemory.js'
import type { AgentConfig } from './agentPresets.js'
import type { PermissionChecker } from './permission.js'
import type { PricingConfig } from '../config/agentConfig.js'
import type { ResourceClaim } from './resourceScheduler.js'
import type { BackgroundTaskManager } from './backgroundTaskManager.js'
import type { ExecutionContext } from './executionContext.js'
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
  runTurn: (msg: string, history: never[]) => Promise<{
    result: { output: string; reason: string; completionStatus?: string }
  }>
  abort: () => void
  dispose?: () => void
}

export type AgentChildEngineFactory = (
  config: EngineConfig,
  renderer: unknown,
) => ChildEngineLike

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

export interface Tool {
  name: string
  metadata?: ToolMetadata
  definition: ToolDefinition
  /**
   * True if this tool is safe to run concurrently with other safe tools within
   * a single LLM response (e.g. read-only tools, independent Bash calls).
   */
  concurrencySafe?: boolean
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
  /**
   * Per-input concurrency check. If implemented, engine uses this instead of
   * the static concurrencySafe flag.
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean
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
  execution?: ExecutionContext
  workingState?: WorkingState
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
  reason: 'max_iterations' | 'stop_sequence' | 'error' | 'interrupted'
  output: string
  error?: string
}
