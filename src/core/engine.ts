/**
 * Think-Act-Observe Engine — with streaming output
 *
 * Key features:
 * 1. Parallel tool execution — read-only tools batched via Promise.all;
 *    state-mutating tools run serially.
 * 2. AbortController per turn — engine.abort() cancels in-flight API calls
 *    and tool executions.
 * 3. Plan mode — only read-only tools are exposed/executed.
 * 4. Hook callbacks around every tool call.
 * 5. Critic loop — every N iterations a lightweight LLM call reviews recent
 *    context for common failure modes and injects corrections.
 * 6. Context budget management — automatic compression with anchor preservation.
 *
 * Architecture:
 *   runTurn() orchestrates the high-level loop, delegating to:
 *     - buildSystemPrompt()        → compose system prompt
 *     - evaluateContextBudget()    → check token usage, compact if needed
 *     - maybeRunCritic()           → inject correction every N iterations
 *     - callLLM()                  → streaming LLM invocation
 *     - consumeStream()            → parse streamed response
 *     - scheduleToolCalls()        → partition + execute tool calls
 *     - executeToolCall()          → single tool execution
 */

import OpenAI from 'openai'
import type {
  EngineConfig,
  OpenAIMessage,
  Tool,
  ToolContext,
  ToolResult,
  TurnResult,
  ToolDefinition,
} from './types.js'
import { createTools, findTool, getToolDefinitions } from '../tools/index.js'
import { getPlanModePrefix } from '../prompts/system.js'
import type { Renderer } from '../ui/renderer.js'
import {
  maybeCompact,
  calculateContextState,
  MODEL_MAX_CONTEXT_TOKENS,
} from './compact.js'
import { ContextBudgetManager, CompressionStrategy } from './contextBudget.js'
import {
  CRITIC_INTERVAL,
  CRITIC_MIN_ITERATIONS,
  CRITIC_CONTEXT_MESSAGES,
  CRITIC_MAX_TOKENS,
  DEFAULT_CRITIC_SYSTEM_PROMPT,
  formatMessagesForCritic,
  parseCriticOutput,
} from '../prompts/critic.js'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TOOL_RESULT_LENGTH = 20_000

/** Plan mode — only read-only tools are exposed */
const PLAN_MODE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
])

/**
 * Concurrency-safe tools: run in parallel within a single LLM response.
 * When the LLM emits multiple tool calls in one response, they are intended
 * to be independent — execute them concurrently.
 */
const CONCURRENCY_SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Bash', // parallel — dependent ops should use && in one call
  'Agent', // parallel — multiple sub-agents run simultaneously
  'ShellSession', // parallel — different sessions
  'TmuxSession', // parallel — different sessions
])

// ── Internal types ───────────────────────────────────────────────────────────

interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

interface ParsedToolCall {
  tc: StreamingToolCall
  input: Record<string, unknown>
}

interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
}

// ── Pure helper functions ────────────────────────────────────────────────────

/**
 * Partition tool calls into scheduling batches:
 * - All safe tools → merged into one parallel batch (Promise.all)
 * - Stateful tools (Write, Edit, etc.) → each gets its own serial batch
 */
function partitionToolCalls(calls: ParsedToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    const safe = CONCURRENCY_SAFE_TOOLS.has(call.tc.name)
    const last = batches[batches.length - 1]

    if (last && last.safe && safe) {
      last.calls.push(call) // extend existing parallel batch
    } else {
      batches.push({ safe, calls: [call] }) // new batch
    }
  }

  return batches
}

/** Truncate a tool result to stay within token budget */
function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result
  const half = MAX_TOOL_RESULT_LENGTH / 2
  return (
    result.slice(0, half) +
    `\n\n[... ${result.length - MAX_TOOL_RESULT_LENGTH} chars truncated ...]\n\n` +
    result.slice(result.length - half)
  )
}

// ── Engine class ─────────────────────────────────────────────────────────────

export class ExecutionEngine {
  private client: OpenAI
  private tools: Tool[]
  private config: EngineConfig
  private renderer: Renderer
  /** Abort controller for the current turn — null when idle */
  private currentTurnAbortController: AbortController | null = null
  /** Soft-interrupt flag: pause after current tool finishes */
  private softAbortRequested = false
  /** Event log — may be undefined if not configured */
  private eventLog: EngineConfig['eventLog']
  /** Context budget manager — may be undefined if not configured */
  private contextBudget: EngineConfig['contextBudget']

  constructor(config: EngineConfig, renderer: Renderer) {
    this.config = config
    this.renderer = renderer
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    })
    this.tools = createTools(config.extraTools ?? [])
    this.eventLog = config.eventLog
    this.contextBudget = config.contextBudget
  }

  /** Hard cancel — immediately aborts in-flight API calls and tool executions */
  abort(): void {
    this.currentTurnAbortController?.abort('user_cancelled')
  }

  /** Soft interrupt — pause after current tool, preserve history */
  softAbort(): void {
    this.softAbortRequested = true
  }

  // ── Critic ──────────────────────────────────────────────────────────────

  /**
   * Run a lightweight critic check over recent conversation history.
   * Returns a correction string to inject, or null if everything looks fine.
   * Errors are swallowed — critic failures must never break the main loop.
   */
  private async maybeRunCritic(
    messages: OpenAIMessage[],
    turnAbortSignal: AbortSignal,
  ): Promise<string | null> {
    const recent = messages.slice(-CRITIC_CONTEXT_MESSAGES)
    if (recent.length < 4) return null

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: DEFAULT_CRITIC_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `以下是最近的操作历史，请检查是否存在失误：\n\n${formatMessagesForCritic(recent)}`,
            },
          ],
          temperature: 0,
          max_tokens: CRITIC_MAX_TOKENS,
        },
        { signal: turnAbortSignal },
      )

      const output = response.choices[0]?.message?.content ?? ''
      return parseCriticOutput(output)
    } catch {
      return null
    }
  }

  // ── System prompt ───────────────────────────────────────────────────────

  private buildSystemPrompt(planMode: boolean): string {
    const baseSystemPrompt = this.config.systemPrompt ?? ''
    if (planMode) {
      return getPlanModePrefix() + baseSystemPrompt
    }
    return baseSystemPrompt
  }

  // ── Tool definitions ────────────────────────────────────────────────────

  private getToolDefinitions(planMode: boolean): ToolDefinition[] {
    const allToolDefs = getToolDefinitions(this.tools)
    if (planMode) {
      return allToolDefs.filter((t) => PLAN_MODE_TOOLS.has(t.function.name))
    }
    return allToolDefs
  }

  // ── Context budget ──────────────────────────────────────────────────────

  private async evaluateContextBudget(messages: OpenAIMessage[]): Promise<void> {
    const maxCtxTokens =
      this.config.maxContextTokens ?? MODEL_MAX_CONTEXT_TOKENS
    const baseCtxState = calculateContextState(messages, maxCtxTokens)

    let ctxState: ReturnType<typeof calculateContextState> & {
      strategy?: CompressionStrategy
    }
    if (this.contextBudget) {
      const budgetState = this.contextBudget.evaluate(baseCtxState.currentTokens)
      ctxState = {
        ...baseCtxState,
        strategy: budgetState.strategy,
        shouldCompact: budgetState.shouldCompact,
        shouldWarn: budgetState.shouldWarn,
      }
    } else {
      ctxState = { ...baseCtxState, strategy: undefined }
    }

    // Show context stats every 5 iterations (main agent only)
    if (this.config.sessionDir && ctxState.shouldWarn) {
      this.renderer.contextWarning(
        ctxState.currentTokens,
        ctxState.maxTokens,
        ctxState.pct,
      )
    }

    if (ctxState.shouldCompact) {
      this.renderer.compactStart(ctxState.currentTokens)
      this.eventLog?.append('context_compact', 'engine', {
        strategy: ctxState.strategy,
        tokens_before: ctxState.currentTokens,
        pct: ctxState.pct,
      })

      const compactResult = await maybeCompact(
        this.client,
        this.config.model,
        messages,
        undefined,
        this.config.sessionDir,
      )

      if (compactResult.compacted) {
        messages.length = 0
        messages.push(...compactResult.messages)
        this.renderer.compactDone(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
        this.eventLog?.append('context_compact', 'engine', {
          tokens_after: compactResult.summaryTokens,
          reduction: compactResult.originalTokens - compactResult.summaryTokens,
        })
      }
    }
  }

  // ── LLM call ────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    toolDefs: ReturnType<typeof getToolDefinitions>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
  }> {
    this.renderer.startSpinner()

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
          ],
          tools: toolDefs as OpenAI.Chat.ChatCompletionTool[],
          tool_choice: 'auto',
          temperature: 0,
          max_tokens: 8192,
          stream: true,
        },
        { signal: turnAbortSignal },
      )
    } catch (err: unknown) {
      this.renderer.stopSpinner()
      throw err
    }

    return this.consumeStream(stream, turnAbortSignal)
  }

  /** Consume the streaming response, accumulating text and tool calls */
  private async consumeStream(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
  }> {
    let assistantText = ''
    let finishReason: string | null = null
    const toolCallsMap = new Map<number, StreamingToolCall>()
    let firstToken = true

    try {
      for await (const chunk of stream) {
        if (turnAbortSignal.aborted) break

        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          if (firstToken) {
            this.renderer.stopSpinner()
            this.renderer.beginAssistantText()
            firstToken = false
          }
          this.renderer.streamToken(delta.content)
          assistantText += delta.content
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                index: idx,
                id: '',
                name: '',
                arguments: '',
              })
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
    } catch (err: unknown) {
      this.renderer.stopSpinner()
      throw err
    }

    this.renderer.stopSpinner()

    if (assistantText) {
      this.renderer.endAssistantText()
    }

    const rawToolCalls = Array.from(toolCallsMap.values()).sort(
      (a, b) => a.index - b.index,
    )

    return { assistantText, finishReason, rawToolCalls }
  }

  // ── Tool execution ──────────────────────────────────────────────────────

  private async executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    // In plan mode, block write tools (defence in depth)
    if (planMode && !PLAN_MODE_TOOLS.has(toolName)) {
      return {
        content: `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`,
        isError: true,
      }
    }

    const tool = findTool(this.tools, toolName)
    if (!tool) {
      return { content: `Unknown tool: ${toolName}`, isError: true }
    }

    const result = await tool.execute(input, context)

    // Write episodic memory entry
    const epiMem = this.config.episodicMemory
    if (epiMem && !result.isError) {
      epiMem.write({
        turn: turnNumber,
        toolName,
        inputSummary: JSON.stringify(input).slice(0, 200),
        resultSummary: result.content.slice(0, 300),
        outcome: 'success',
        timestamp: new Date().toISOString(),
      })
    }

    return result
  }

  // ── Tool scheduling ─────────────────────────────────────────────────────

  /**
   * Schedule tool calls: parallel batches for safe tools, serial for
   * state-mutating ones. Returns true if a soft abort was requested
   * during execution.
   */
  private async scheduleToolCalls(
    parsedCalls: ParsedToolCall[],
    toolContext: ToolContext,
    planMode: boolean,
    turnAbortSignal: AbortSignal,
    messages: OpenAIMessage[],
    turnNumber: number,
  ): Promise<{ aborted: boolean }> {
    const batches = partitionToolCalls(parsedCalls)

    for (const batch of batches) {
      if (turnAbortSignal.aborted) return { aborted: true }

      if (batch.safe && batch.calls.length > 1) {
        // ── Parallel batch ───────────────────────────────────
        for (const { tc, input } of batch.calls) {
          this.renderer.toolStart(tc.name, input)
          this.config.hookRunner?.runPreToolCall(tc.name, input)
          this.eventLog?.append('tool_call', tc.name, { input }, [tc.name])
        }

        const results = await Promise.all(
          batch.calls.map(({ tc, input }) =>
            this.executeToolCall(tc.name, input, toolContext, planMode, turnNumber),
          ),
        )

        for (let i = 0; i < batch.calls.length; i++) {
          const { tc } = batch.calls[i]
          const result = results[i]
          this.config.hookRunner?.runPostToolCall(
            tc.name,
            result.content,
            result.isError,
          )
          this.renderer.toolResult(tc.name, result.content, result.isError)
          this.eventLog?.append(
            'tool_result',
            tc.name,
            {
              content: result.content.slice(0, 500),
              isError: result.isError,
            },
            [tc.name, result.isError ? 'error' : 'success'],
          )
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateToolResult(result.content),
            name: tc.name,
          })
        }
      } else {
        // ── Serial batch ─────────────────────────────────────
        for (const { tc, input } of batch.calls) {
          if (turnAbortSignal.aborted) return { aborted: true }

          this.renderer.toolStart(tc.name, input)
          this.config.hookRunner?.runPreToolCall(tc.name, input)
          this.eventLog?.append('tool_call', tc.name, { input }, [tc.name])

          const result = await this.executeToolCall(
            tc.name,
            input,
            toolContext,
            planMode,
            turnNumber,
          )

          this.config.hookRunner?.runPostToolCall(
            tc.name,
            result.content,
            result.isError,
          )
          this.renderer.toolResult(tc.name, result.content, result.isError)
          this.eventLog?.append(
            'tool_result',
            tc.name,
            {
              content: result.content.slice(0, 500),
              isError: result.isError,
            },
            [tc.name, result.isError ? 'error' : 'success'],
          )

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateToolResult(result.content),
            name: tc.name,
          })

          // Soft-interrupt check after each serial tool
          if (this.softAbortRequested) {
            this.softAbortRequested = false
            return { aborted: true }
          }
        }
      }

      // Soft-interrupt check after each batch (parallel too)
      if (this.softAbortRequested) {
        this.softAbortRequested = false
        return { aborted: true }
      }
    }

    return { aborted: false }
  }

  // ── Build tool context ──────────────────────────────────────────────────

  private buildToolContext(
    turnAbortSignal: AbortSignal,
  ): ToolContext {
    return {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
      signal: turnAbortSignal,
      apiConfig: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
      sessionDir: this.config.sessionDir,
      eventLog: this.eventLog,
      semanticMemory: this.config.semanticMemory,
      episodicMemory: this.config.episodicMemory,
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  /**
   * Execute a single user turn with streaming output.
   * Full Think → Act → Observe loop.
   */
  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const planMode = this.config.planMode ?? false

    // Build system prompt and tool definitions
    const systemPrompt = this.buildSystemPrompt(planMode)
    const toolDefs = this.getToolDefinitions(planMode)

    // Per-turn AbortController
    const turnAbortController = new AbortController()
    this.currentTurnAbortController = turnAbortController

    // Initialize messages
    const messages: OpenAIMessage[] = [...history, { role: 'user', content: userMessage }]

    let iterations = 0
    let finalOutput = ''
    let turnNumber = 0
    const toolContext = this.buildToolContext(turnAbortController.signal)

    try {
      while (iterations < this.config.maxIterations) {
        // Check for cancellation
        if (turnAbortController.signal.aborted) {
          return {
            result: { stopped: true, reason: 'error', output: finalOutput },
            newHistory: messages,
          }
        }

        iterations++
        turnNumber++

        // Soft-interrupt check
        if (this.softAbortRequested) {
          this.softAbortRequested = false
          return {
            result: { stopped: true, reason: 'interrupted', output: finalOutput },
            newHistory: messages,
          }
        }

        // Context budget + auto-compact
        await this.evaluateContextBudget(messages)

        // Critic injection — every CRITIC_INTERVAL iterations
        if (
          iterations >= CRITIC_MIN_ITERATIONS &&
          iterations % CRITIC_INTERVAL === 0 &&
          !planMode &&
          this.config.sessionDir // only main agent has sessionDir
        ) {
          const criticism = await this.maybeRunCritic(
            messages,
            turnAbortController.signal,
          )
          if (criticism) {
            this.renderer.warn(`[批判检查] ${criticism.split('\n')[0]}`)
            this.eventLog?.append('critic_flag', 'critic', {
              criticism: criticism.slice(0, 500),
              iteration: iterations,
            })
            messages.push({
              role: 'user',
              content: `[🔍 自动纠错检查]\n${criticism}\n\n请根据以上纠错提示立即调整行动。`,
            })
          }
        }

        // ── Streaming LLM call ───────────────────────────────────
        const { assistantText, finishReason, rawToolCalls } =
          await this.callLLM(
            systemPrompt,
            messages,
            toolDefs,
            turnAbortController.signal,
          )

        if (assistantText) {
          finalOutput = assistantText
        }

        // Build assistant message
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

        // Check if we're done (no tool calls)
        if (finishReason === 'stop' || rawToolCalls.length === 0) {
          return {
            result: {
              stopped: true,
              reason: 'stop_sequence',
              output: finalOutput,
            },
            newHistory: messages,
          }
        }

        // Parse tool calls
        const parsedCalls: ParsedToolCall[] = rawToolCalls.map((tc) => {
          let input: Record<string, unknown>
          try {
            input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
          } catch {
            input = {}
          }
          return { tc, input }
        })

        // Schedule and execute tool calls
        const { aborted } = await this.scheduleToolCalls(
          parsedCalls,
          toolContext,
          planMode,
          turnAbortController.signal,
          messages,
          turnNumber,
        )

        if (aborted || turnAbortController.signal.aborted) {
          return {
            result: { stopped: true, reason: 'error', output: finalOutput },
            newHistory: messages,
          }
        }
      }
    } finally {
      this.currentTurnAbortController = null
    }

    this.renderer.warn(
      `Max iterations (${this.config.maxIterations}) reached`,
    )
    return {
      result: {
        stopped: true,
        reason: 'max_iterations',
        output: finalOutput,
      },
      newHistory: messages,
    }
  }

  getModel(): string {
    return this.config.model
  }
}

// Export partitionToolCalls for testing
export { partitionToolCalls }
