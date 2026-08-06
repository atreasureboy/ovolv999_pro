/**
 * Module System — composable capability extensions for the unified Harness.
 *
 * Core principle (from AgentOS): all agents share one runtime (Harness).
 * Differentiated capabilities come from enabling/disabling modules, NOT from
 * hardcoded agent_type enums.
 *
 * Lifecycle hooks:
 *   boot()             — called once before the engine loop starts
 *   onIteration()      — called at the top of each loop iteration
 *   onBeforeToolCall() — called before each tool execution (can veto/modify)
 *   onToolCall()       — called after each tool execution
 *   onDelegation()     — called when a sub-agent is spawned (can modify config)
 *   onError()          — called when an error occurs (can suggest recovery)
 *   onComplete()       — called after the engine loop finishes
 *   onDispose()        — called when the engine shuts down (cleanup)
 *   onStateSnapshot()  — called to capture module state for snapshots
 *   onStateRestore()   — called to restore module state from a snapshot
 *   describe()         — returns self-description for CLI/UI display
 */

import type OpenAI from 'openai'
import type {
  Tool,
  ToolContext,
  ToolResult,
  OpenAIMessage,
  TurnResult,
  EngineConfig,
} from './types.js'
import type { EventLog } from './eventLog.js'
import type { AgentConfig } from './agentPresets.js'

/** Context passed to module factories — provides shared dependencies */
export interface ModuleContext {
  client: OpenAI
  model: string
  config: EngineConfig
}

/** Factory that creates a module instance from shared context */
export type ModuleFactory = (ctx: ModuleContext) => AgentModule

/** Context passed to module.boot() */
export interface ModuleBootContext {
  cwd: string
  sessionDir?: string
  config: EngineConfig
  /** The user's message for this run — used for relevance-based memory retrieval */
  userMessage?: string
}

/** Return value of module.boot() — what the module injects into the run */
export interface ModuleBootResult {
  /** Additional system prompt sections to inject */
  systemPromptSections?: string[]
  /** Additional tools this module provides */
  tools?: Tool[]
  /** Fields to merge into ToolContext */
  toolContextPatch?: Partial<ToolContext>
}

/** Context passed to module.onIteration() */
export interface ModuleIterationContext {
  iteration: number
  messages: OpenAIMessage[]
  abortSignal: AbortSignal
  /** Audit log — modules should record non-fatal failures here (e.g. LLM errors). */
  eventLog?: EventLog
}

/** Return value of module.onIteration() — can inject a message into the conversation */
export interface ModuleIterationResult {
  /** If set, this message is injected as a user message before the LLM call */
  injectMessage?: string
}

/** Context passed to module.onComplete() */
export interface ModuleRunContext {
  cwd: string
  sessionDir?: string
  turnResult: TurnResult
  messages: OpenAIMessage[]
  eventLog?: EventLog
}

/** Advice returned by onBeforeToolCall — can allow, deny, or modify the tool input */
export interface ToolCallAdvice {
  /** 'allow' | 'deny' | 'modify' — what the module recommends */
  action: 'allow' | 'deny' | 'modify'
  /** Reason for the advice (shown in logs / permission prompts) */
  reason?: string
  /** If action is 'modify', the modified input to use instead */
  modifiedInput?: Record<string, unknown>
}

/** Context passed to module.onError() */
export interface ModuleErrorContext {
  turnNumber: number
  lastToolName?: string
  lastInput?: Record<string, unknown>
  iteration: number
}

/** Recovery action suggested by onError() */
export interface ErrorRecoveryAction {
  /** What action the engine should take */
  action: 'continue' | 'skip_turn' | 'abort'
  /** Optional message to inject into the conversation (e.g. "The last tool failed, try a different approach") */
  injectMessage?: string
}

/** Classification of an engine error for structured recovery */
export type EngineErrorClass = 'recoverable' | 'degradable' | 'fatal'

/** Structured engine error with recovery hints */
export interface EngineError {
  class: EngineErrorClass
  source: 'llm' | 'tool' | 'module' | 'internal'
  originalError: Error
  message: string
  recoverySuggestion?: string
  retryable: boolean
}

/** Self-description returned by module.describe() */
export interface ModuleDescription {
  name: string
  capabilities: string[]
  version: string
  dependencies?: string[]
  tools?: string[]
}

/**
 * Agent Module — a composable capability extension.
 *
 * Implementations: MemoryModule, CriticModule, WorkspaceModule, ReflectionModule.
 * Custom modules can be registered via ModuleRegistry.register().
 *
 * Template: copy src/modules/_template.ts and fill in your hooks.
 */
export interface AgentModule {
  readonly name: string
  /** Modules that must be enabled before this one (resolved by registry) */
  readonly dependencies?: string[]

  // ── Birth ─────────────────────────────────────────────────────────────

  /** Boot Sequence — inject prompt sections, tools, context patches */
  boot(ctx: ModuleBootContext): ModuleBootResult | Promise<ModuleBootResult>

  // ── Run ───────────────────────────────────────────────────────────────

  /** Called at the top of each engine loop iteration (e.g. critic check) */
  onIteration?(ctx: ModuleIterationContext): void | Promise<ModuleIterationResult | void>

  /** Called before a tool executes — can veto or modify the tool call */
  onBeforeToolCall?(toolName: string, input: Record<string, unknown>): ToolCallAdvice | void

  /** Called after each tool execution (e.g. episodic memory write) */
  onToolCall?(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    turnNumber: number,
  ): void

  /** Called when a sub-agent is spawned — can modify the sub-agent config */
  onDelegation?(childConfig: AgentConfig): AgentConfig | void

  // ── Error ─────────────────────────────────────────────────────────────

  /** Called when an error occurs — returns a recovery recommendation */
  onError?(error: EngineError, ctx: ModuleErrorContext): ErrorRecoveryAction | void

  // ── Death ─────────────────────────────────────────────────────────────

  /** Called after the engine loop finishes (e.g. reflection knowledge extraction) */
  onComplete?(ctx: ModuleRunContext): void | Promise<void>

  /** Called when the engine shuts down — release resources, close connections */
  onDispose?(): void | Promise<void>

  // ── Persistence ───────────────────────────────────────────────────────

  /** Capture module state for engine snapshots (return null/undefined to skip) */
  onStateSnapshot?(): Record<string, unknown> | null | undefined

  /** Restore module state from a saved engine snapshot */
  onStateRestore?(state: Record<string, unknown>): void

  // ── Self-description ──────────────────────────────────────────────────

  /** Return module metadata for CLI display / debugging */
  describe?(): ModuleDescription
}
