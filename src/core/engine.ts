/**
 * ExecutionEngine — assembly root + lifecycle facade.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────┐
 *   │              ExecutionEngine (facade)         │
 *   ├─────────────────────────────────────────────┤
 *   │  RuntimeCoordinator → main loop driver       │
 *   │    ├── ModelGateway     → LLM API + stream   │
 *   │    ├── ContextManager   → budget + compaction│
 *   │    ├── ToolScheduler    → partition + batch  │
 *   │    ├── ToolExecutor     → single tool exec   │
 *   │    ├── ToolPolicy       → exposure + exec    │
 *   │    ├── ToolRegistry     → tool lookup        │
 *   │    └── ModuleManager    → lifecycle hooks    │
 *   └─────────────────────────────────────────────┘
 */

import OpenAI from 'openai'
import type {
  EngineConfig,
  OpenAIMessage,
  TurnResult,
  Tool,
  ToolContext,
  TokenUsage,
} from './types.js'
import { createTools } from '../tools/index.js'
import { getPlanModePrefix } from '../prompts/system.js'
import type { Renderer } from '../ui/renderer.js'
import type { AgentModule, ModuleBootResult, ModuleBootContext } from './module.js'
import { globalModuleRegistry } from './moduleRegistry.js'
import { applyAgentToConfig } from './agentPresets.js'
import { ToolRegistry } from './toolRuntime/toolRegistry.js'
import { ToolPolicy } from './toolRuntime/toolPolicy.js'
import { ToolExecutor, type ParsedToolCall } from './toolRuntime/toolExecutor.js'
import { ToolScheduler } from './toolRuntime/toolScheduler.js'
import { ContextManager } from './context/contextManager.js'
import { RunEventEmitter } from './runtime/events.js'
import { SharedRuntimeState } from './runtime/sharedState.js'
import { ProgressMonitor } from './runtime/progressMonitor.js'
import { CostTracker } from './costTracker.js'
import { BackgroundTaskManager } from './backgroundTaskManager.js'
import { AsyncTaskManager } from './taskManager.js'
import { ResourceScheduler } from './resourceScheduler.js'
import { capabilitiesForModel } from './modelCapabilities.js'
import { buildExecutionContext, type ExecutionContext } from './executionContext.js'
import { emptyWorkingState, type WorkingState } from './workingState.js'
import { ThinkingTagFilter } from './thinkingTagFilter.js'
import { detectExecutionProfile, type ExecutionProfile } from './effort.js'
import { randomUUID } from 'crypto'
import { createProviderAdapter, type ProviderAdapter } from './providerAdapter.js'
import { ModelGateway } from './modelGateway.js'
import { classifyTaskIntent, type TaskIntent } from './taskIntent.js'

// ── Constants ────────────────────────────────────────────────────────────────

const CONCURRENCY_SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Bash',
  'Agent',
  'TmuxSession',
])

// ── Internal types ───────────────────────────────────────────────────────────

interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

// ── Engine class ─────────────────────────────────────────────────────────────

export class ExecutionEngine {
  private client: OpenAI
  private config: EngineConfig
  private renderer: Renderer
  private currentTurnAbortController: AbortController | null = null
  private softAbortRequested = false
  private eventLog: EngineConfig['eventLog']
  private modules: AgentModule[]
  private moduleBootResults: ModuleBootResult[] = []
  private allTools: Tool[]
  private concurrencySafeNames: ReadonlySet<string> = CONCURRENCY_SAFE_TOOLS

  // ── Subsystems ──
  private toolRegistry: ToolRegistry
  private toolPolicy: ToolPolicy
  private toolExecutor: ToolExecutor
  private toolScheduler: ToolScheduler
  private contextManager: ContextManager
  private eventEmitter: RunEventEmitter
  private sharedState: SharedRuntimeState
  private progressMonitor: ProgressMonitor
  private costTracker: CostTracker
  private backgroundTaskManager: BackgroundTaskManager
  private asyncTaskManager: AsyncTaskManager
  private resourceScheduler: ResourceScheduler

  // ── New subsystems ──
  private workingState: WorkingState
  private thinkingFilter: ThinkingTagFilter
  private currentExecutionProfile: ExecutionProfile
  private providerAdapter: ProviderAdapter
  private modelGateway: ModelGateway
  private taskIntent: TaskIntent

  constructor(config: EngineConfig, renderer: Renderer) {
    this.config = applyAgentToConfig(config)
    this.renderer = renderer
    this.client =
      config.client ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: 5,
        timeout: 120_000,
      })
    const baseTools = createTools(config.extraTools ?? [])
    this.allTools = baseTools
    this.eventLog = config.eventLog

    // Resolve enabled modules
    const enabledNames = this.deriveEnabledModules()
    this.modules =
      enabledNames.length > 0
        ? globalModuleRegistry.resolve(enabledNames, {
            client: this.client,
            model: config.model,
            config,
          })
        : []

    // Initialize subsystems
    this.toolRegistry = new ToolRegistry()
    this.toolRegistry.registerAll(baseTools)

    this.toolPolicy = new ToolPolicy({ agent: config.agent })
    this.eventEmitter = new RunEventEmitter()
    this.sharedState = new SharedRuntimeState()
    this.progressMonitor = new ProgressMonitor()
    this.costTracker = new CostTracker()
    this.backgroundTaskManager = new BackgroundTaskManager(config.sessionDir)
    this.asyncTaskManager = new AsyncTaskManager()
    this.resourceScheduler = new ResourceScheduler()

    this.contextManager = new ContextManager({
      client: this.client,
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxOutputTokens: config.maxOutputTokens,
      sessionDir: config.sessionDir,
      renderer,
      eventLog: config.eventLog,
      hookRunner: config.hookRunner,
    })

    this.toolExecutor = new ToolExecutor({
      toolRegistry: this.toolRegistry,
      toolPolicy: this.toolPolicy,
      permissionChecker: config.permissionChecker,
      contextManager: this.contextManager,
      hookRunner: config.hookRunner,
      eventEmitter: this.eventEmitter,
      progressMonitor: this.progressMonitor,
      renderer,
      modules: this.modules,
    })

    this.toolScheduler = new ToolScheduler({
      executor: this.toolExecutor,
      toolRegistry: this.toolRegistry,
      renderer,
      eventLog: config.eventLog,
      hookRunner: config.hookRunner,
      contextManager: this.contextManager,
      sharedState: this.sharedState,
      eventEmitter: this.eventEmitter,
      resourceScheduler: this.resourceScheduler,
    })

    // Initialize new subsystems
    this.workingState = emptyWorkingState()
    this.thinkingFilter = new ThinkingTagFilter()
    this.currentExecutionProfile = detectExecutionProfile(config.systemPrompt ?? '')

    // Initialize ProviderAdapter and ModelGateway
    const providerId = config.provider ?? 'openai'
    this.providerAdapter = createProviderAdapter(this.client, providerId, config.apiKey, config.baseURL)
    this.modelGateway = new ModelGateway({
      adapter: this.providerAdapter,
      renderer,
      eventLog: config.eventLog,
    })

    // Classify task intent
    this.taskIntent = config.taskIntent ?? classifyTaskIntent(config.systemPrompt ?? '', {
      planMode: config.planMode,
    })

    // Wire EventLog as subscriber to RunEventEmitter
    if (this.eventLog) {
      this.eventEmitter.on('RUN_STARTED', (e) => {
        this.eventLog!.append('run_started', 'engine', { userMessage: e.userMessage.slice(0, 200) })
      })
      this.eventEmitter.on('RUN_COMPLETED', (e) => {
        this.eventLog!.append('run_completed', 'engine', { reason: e.result.reason, output: e.result.output.slice(0, 200) })
      })
      this.eventEmitter.on('RUN_FAILED', (e) => {
        this.eventLog!.append('run_failed', 'engine', { error: e.error, output: e.output.slice(0, 200) })
      })
      this.eventEmitter.on('MODEL_REQUESTED', (e) => {
        this.eventLog!.append('model_requested', 'engine', { model: e.model })
      })
      this.eventEmitter.on('MODEL_COMPLETED', (e) => {
        this.eventLog!.append('model_completed', 'engine', { finishReason: e.finishReason, toolCallCount: e.toolCallCount })
      })
      this.eventEmitter.on('STALL_DETECTED', (e) => {
        this.eventLog!.append('stall_detected', 'engine', { kind: e.kind, reason: e.reason, action: e.action })
      })
    }

    // Use model capabilities to set maxContextTokens if not configured
    if (!config.maxContextTokens) {
      const caps = capabilitiesForModel(config.model)
      this.contextManager.setMaxContextTokens(caps.maxContext)
      if (!config.maxOutputTokens) {
        this.contextManager.setMaxOutputTokens(caps.maxOutput)
      }
    }
  }

  private deriveEnabledModules(): string[] {
    if (this.config.enabledModules !== undefined) {
      return this.config.enabledModules
    }
    const auto: string[] = []
    if (this.config.semanticMemory && this.config.episodicMemory) {
      auto.push('memory')
    }
    if (this.config.sessionDir) {
      auto.push('workspace')
    }
    return auto
  }

  abort(): void {
    this.currentTurnAbortController?.abort('user_cancelled')
  }

  softAbort(): void {
    this.softAbortRequested = true
  }

  // ── System prompt ───────────────────────────────────────────────────────

  private buildSystemPrompt(planMode: boolean, moduleSections: string[] = []): string {
    const baseSystemPrompt = this.config.systemPrompt ?? ''
    const sections =
      moduleSections.length > 0
        ? baseSystemPrompt + '\n\n---\n\n' + moduleSections.join('\n\n---\n\n')
        : baseSystemPrompt
    if (planMode) {
      return getPlanModePrefix() + sections
    }
    return sections
  }

  // ── Tool definitions ────────────────────────────────────────────────────

  private getToolDefinitions(planMode: boolean, moduleTools: Tool[] = []): Tool[] {
    const allTools = [...this.toolRegistry.getAll(), ...moduleTools]
    const defs = this.toolPolicy.getExposedDefinitions(allTools, planMode)
    const exposedNames = new Set(defs.map((d) => d.function.name))
    return allTools.filter((t) => exposedNames.has(t.name))
  }

  // ── Context budget ──────────────────────────────────────────────────────

  private async evaluateContextBudget(messages: OpenAIMessage[]): Promise<void> {
    await this.contextManager.evaluateBudget(messages)
  }

  // ── LLM call ────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    exposedTools: Tool[],
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }> {
    this.renderer.startSpinner()

    this.eventEmitter.emit({ type: 'MODEL_REQUESTED', model: this.config.model })

    const toolDefs = exposedTools.map((t) => t.definition)

    try {
      // Use ModelGateway for LLM call
      const result = await this.modelGateway.call(
        {
          systemPrompt,
          messages,
          toolDefs,
          model: this.config.model,
          temperature: this.config.temperature,
          maxOutputTokens: this.config.maxOutputTokens ?? 8192,
          abortSignal: turnAbortSignal,
          turnAbortController: this.currentTurnAbortController,
        },
        {
          onUsage: (usage) => {
            // ModelGateway calls this after consuming the stream
            // We record usage here (only once per LLM call)
            if (usage) {
              this.recordUsage({
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.inputTokens + usage.outputTokens,
              })
            }
          },
          onContextOverflow: async (msgs, _signal) => {
            // Auto-compact on context overflow
            await this.contextManager.evaluateBudget(msgs)
            return true
          },
        },
      )

      // ModelGateway already consumed the stream and returned the result
      // We just need to render the assistant text
      this.renderer.stopSpinner()
      if (result.assistantText) {
        this.renderer.beginAssistantText()
        this.renderer.streamToken(result.assistantText)
        this.renderer.endAssistantText()
      }

      this.eventEmitter.emit({
        type: 'MODEL_COMPLETED',
        assistantText: result.assistantText,
        finishReason: result.finishReason,
        toolCallCount: result.rawToolCalls.length,
      })

      return {
        assistantText: result.assistantText,
        finishReason: result.finishReason,
        rawToolCalls: result.rawToolCalls.map((tc, idx) => ({
          index: idx,
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        usage: result.usage
          ? {
              prompt_tokens: result.usage.inputTokens,
              completion_tokens: result.usage.outputTokens,
              total_tokens: result.usage.inputTokens + result.usage.outputTokens,
            }
          : undefined,
      }
    } catch (err: unknown) {
      this.renderer.stopSpinner()
      const errMsg = err instanceof Error ? err.message : String(err)
      this.eventEmitter.emit({ type: 'MODEL_FAILED', error: errMsg })
      throw err
    }
  }

  // ── Build tool context ──────────────────────────────────────────────────

  private buildToolContext(
    turnAbortSignal: AbortSignal,
    execution: ExecutionContext,
    modulePatches: Partial<ToolContext> = {},
  ): ToolContext {
    return {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
      permissionChecker: this.config.permissionChecker,
      signal: turnAbortSignal,
      apiConfig: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
      eventLog: this.eventLog,
      backgroundTaskManager: this.backgroundTaskManager,
      asyncTaskManager: this.asyncTaskManager,
      execution,
      workingState: this.workingState,
      ...modulePatches,
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const planMode = this.config.planMode ?? false

    this.eventEmitter.emit({ type: 'RUN_STARTED', userMessage })

    // ── Boot Sequence ──
    const bootCtx: ModuleBootContext = {
      cwd: this.config.cwd,
      sessionDir: this.config.sessionDir,
      config: this.config,
      userMessage,
    }
    this.moduleBootResults = await Promise.all(
      this.modules.map((m) => Promise.resolve(m.boot(bootCtx))),
    )
    const moduleSections = this.moduleBootResults.flatMap((r) => r.systemPromptSections ?? [])
    const toolContextPatch = this.moduleBootResults.reduce(
      (acc, r) => ({ ...acc, ...r.toolContextPatch }),
      {} as Partial<ToolContext>,
    )
    const moduleTools = this.moduleBootResults.flatMap((r) => r.tools ?? [])
    this.allTools = [...this.toolRegistry.getAll(), ...moduleTools]
    this.concurrencySafeNames = new Set(
      this.allTools.filter((t) => t.concurrencySafe).map((t) => t.name),
    )

    this.eventEmitter.emit({
      type: 'BOOT_COMPLETED',
      moduleCount: this.modules.length,
      toolCount: this.allTools.length,
    })

    this.eventLog?.append('boot_context', 'engine', {
      trajectory: 'boot_context',
      modules: this.modules.map((m) => m.name),
      module_sections: moduleSections.length,
      module_tools: moduleTools.length,
      user_message_length: userMessage.length,
    })

    const systemPrompt = this.buildSystemPrompt(planMode, moduleSections)
    this.contextManager.setSystemPromptTokens(this.contextManager.estimateSystemPromptTokens(systemPrompt))
    const exposedTools = this.getToolDefinitions(planMode, moduleTools)

    const turnAbortController = new AbortController()
    this.currentTurnAbortController = turnAbortController

    const messages: OpenAIMessage[] = [...history, { role: 'user', content: userMessage }]

    let iterations = 0
    let finalOutput = ''
    let turnNumber = 0

    // Create ExecutionContext for this turn
    const execution: ExecutionContext = buildExecutionContext({
      runId: randomUUID(),
      cwd: this.config.cwd,
      signal: turnAbortController.signal,
      model: this.config.model,
      provider: 'openai',
    })

    const toolContext = this.buildToolContext(turnAbortController.signal, execution, {
      ...toolContextPatch,
      availableToolNames: exposedTools.map((t) => t.name),
    })

    let result: TurnResult = { stopped: true, reason: 'max_iterations', output: '' }
    let lastToolName: string | undefined
    try {
      while (iterations < this.config.maxIterations) {
        if (turnAbortController.signal.aborted) {
          result = { stopped: true, reason: 'error', output: finalOutput }
          break
        }

        iterations++
        turnNumber++
        this.sharedState.setIteration(iterations)
        this.progressMonitor.tick()

        this.eventEmitter.emit({ type: 'ITERATION_STARTED', iteration: iterations })

        if (this.softAbortRequested) {
          this.softAbortRequested = false
          result = { stopped: true, reason: 'interrupted', output: finalOutput }
          break
        }

        // Stall detection — drive actual action
        const stallVerdict = this.progressMonitor.detectStall()
        if (stallVerdict.kind !== 'progressing') {
          this.eventEmitter.emit({
            type: 'STALL_DETECTED',
            kind: stallVerdict.kind,
            reason: stallVerdict.reason,
            action: stallVerdict.action,
          })

          // Drive actual intervention based on stall kind
          if (stallVerdict.kind === 'soft-stall' || stallVerdict.kind === 'hard-stall') {
            const interventionMsg = `[SYSTEM: Stall detected — ${stallVerdict.reason}]\nAction: ${stallVerdict.action}. Please reassess your approach and make meaningful progress.`
            messages.push({ role: 'user', content: interventionMsg })
          }
        }

        await this.evaluateContextBudget(messages)

        for (const module of this.modules) {
          if (!module.onIteration) continue
          const iterResult = await module.onIteration({
            iteration: iterations,
            messages,
            abortSignal: turnAbortController.signal,
            eventLog: this.eventLog,
          })
          if (iterResult?.injectMessage) {
            const msg = iterResult.injectMessage
            this.renderer.warn(`[${module.name}] ${msg.split('\n')[0]}`)
            this.eventLog?.append('module_flag', module.name, {
              message: msg.slice(0, 500),
              iteration: iterations,
            })
            messages.push({ role: 'user', content: msg })
          }
        }

        // ── Streaming LLM call ──
        const { assistantText, finishReason, rawToolCalls } = await this.callLLM(
          systemPrompt,
          messages,
          exposedTools,
          turnAbortController.signal,
        )

        // Usage is already recorded in callLLM via ModelGateway's onUsage callback
        // Don't record again to avoid double-counting

        this.eventEmitter.emit({
          type: 'MODEL_COMPLETED',
          assistantText,
          finishReason,
          toolCallCount: rawToolCalls.length,
        })

        if (assistantText) {
          finalOutput = assistantText
        }

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: assistantText || null,
          tool_calls:
            rawToolCalls.length > 0
              ? rawToolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                }))
              : undefined,
        }
        messages.push(assistantMsg)

        if (finishReason === 'stop' || rawToolCalls.length === 0) {
          result = { stopped: true, reason: 'stop_sequence', output: finalOutput }
          break
        }

        const parsedCalls: ParsedToolCall[] = rawToolCalls.map((tc) => {
          let input: Record<string, unknown>
          let parseError: string | undefined
          try {
            input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
          } catch (err) {
            input = {}
            parseError = err instanceof Error ? err.message : String(err)
          }
          return { tc, input, parseError }
        })

        if (parsedCalls.length > 0) {
          lastToolName = parsedCalls[parsedCalls.length - 1].tc.name
        }

        // Delegate to ToolScheduler (which uses ToolExecutor internally)
        const { aborted } = await this.toolScheduler.schedule(
          parsedCalls,
          toolContext,
          planMode,
          turnAbortController,
          messages,
          turnNumber,
          this.concurrencySafeNames,
        )

        if (aborted || turnAbortController.signal.aborted) {
          result = { stopped: true, reason: 'error', output: finalOutput }
          break
        }
      }

      if (!result) {
        this.renderer.warn(`Max iterations (${this.config.maxIterations}) reached`)
        this.eventEmitter.emit({ type: 'MAX_ITERATIONS_REACHED', maxIterations: this.config.maxIterations })
        result = { stopped: true, reason: 'max_iterations', output: finalOutput }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.config.hookRunner?.runOnError?.(err instanceof Error ? err : new Error(errMsg), {
        turnNumber: iterations,
        lastToolName,
      })
      this.eventLog?.append('error', 'engine', {
        stage: 'run',
        turn: iterations,
        error: errMsg,
        ...(lastToolName ? { lastToolName } : {}),
      })
      this.eventEmitter.emit({ type: 'RUN_FAILED', error: errMsg, output: finalOutput })
      result = { stopped: true, reason: 'error', output: finalOutput, error: errMsg }
    } finally {
      this.currentTurnAbortController = null
    }

    // ── Module onComplete hooks ──
    for (const module of this.modules) {
      try {
        await module.onComplete?.({
          cwd: this.config.cwd,
          sessionDir: this.config.sessionDir,
          turnResult: result,
          messages,
          eventLog: this.eventLog,
        })
      } catch (err) {
        this.eventLog?.append('module_error', module.name, {
          stage: 'onComplete',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    this.config.hookRunner?.runOnComplete?.(result)
    this.eventEmitter.emit({ type: 'RUN_COMPLETED', result })

    return { result, newHistory: messages }
  }

  getModel(): string {
    return this.config.model
  }

  getSessionDir(): string | undefined {
    return this.config.sessionDir
  }

  getTokenUsage(): TokenUsage {
    // Read from CostTracker (single source of truth)
    return {
      promptTokens: this.costTracker.getTotalInputTokens(),
      completionTokens: this.costTracker.getTotalOutputTokens(),
      totalTokens: this.costTracker.getTotalInputTokens() + this.costTracker.getTotalOutputTokens(),
      costUsd: this.costTracker.getTotalCostUSD(),
      calls: this.costTracker.getTotalAPICalls(),
    }
  }

  getCostTracker(): CostTracker {
    return this.costTracker
  }

  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager
  }

  getProgressMonitor(): ProgressMonitor {
    return this.progressMonitor
  }

  getEventEmitter(): RunEventEmitter {
    return this.eventEmitter
  }

  getSharedState(): SharedRuntimeState {
    return this.sharedState
  }

  getContextManager(): ContextManager {
    return this.contextManager
  }

  private recordUsage(usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }): void {
    this.costTracker.addUsage(
      this.config.model,
      { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
      this.config.pricing,
    )

    this.eventLog?.append('token_usage', 'engine', {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      cumulative: this.getTokenUsage(),
    })
  }

  dispose(): void {
    this.backgroundTaskManager.dispose()
    this.resourceScheduler.releaseAll()
    this.eventEmitter.clear()
    this.sharedState.clear()
  }
}
