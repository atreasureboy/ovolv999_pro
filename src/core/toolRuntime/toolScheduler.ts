import type { OpenAIMessage, Tool, ToolContext, IHookRunner } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolExecutor, ParsedToolCall } from './toolExecutor.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { SharedRuntimeState } from '../runtime/sharedState.js'
import type { RunEventEmitter } from '../runtime/events.js'
import type { ResourceScheduler } from '../resourceScheduler.js'
import { claimsConflictBetween } from '../resourceScheduler.js'
import type { ResourceClaim } from '../resourceScheduler.js'

export interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
  accumulatedClaims: ResourceClaim[]
}

export function partitionToolCalls(calls: ParsedToolCall[], tools?: Tool[]): ToolBatch[] {
  const batches: ToolBatch[] = []
  const findTool = (name: string) => tools?.find((t) => t.name === name)

  // Fallback to legacy safe tools set when no tools are provided
  const LEGACY_SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash', 'Agent', 'TmuxSession'])

  for (const call of calls) {
    const tool = findTool(call.tc.name)
    let claims: ResourceClaim[] = []
    let parallelizable = false

    if (tool?.metadata?.claims) {
      // New path: use resource claims
      claims = tool.metadata.claims(call.input)
      parallelizable = claims.length > 0
    } else if (!tools) {
      // Legacy path: use hardcoded safe tools set when no tools array provided
      parallelizable = LEGACY_SAFE_TOOLS.has(call.tc.name)
    }

    const last = batches[batches.length - 1]

    if (
      parallelizable &&
      last?.safe &&
      last.accumulatedClaims.length > 0 &&
      claims.length > 0 &&
      !claimsConflictBetween(last.accumulatedClaims, claims)
    ) {
      last.calls.push(call)
      last.accumulatedClaims.push(...claims)
    } else if (parallelizable && last?.safe && claims.length === 0) {
      // Legacy path: parallelizable but no claims, just merge into safe batch
      last.calls.push(call)
    } else {
      batches.push({
        safe: parallelizable,
        calls: [call],
        accumulatedClaims: [...claims],
      })
    }
  }

  return batches
}

function legacyPartitionToolCalls(
  calls: ParsedToolCall[],
  safeNames: ReadonlySet<string>,
): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    const safe = safeNames.has(call.tc.name)
    const last = batches[batches.length - 1]

    if (last && last.safe && safe) {
      last.calls.push(call)
    } else {
      batches.push({ safe, calls: [call], accumulatedClaims: [] })
    }
  }

  return batches
}

export interface ToolSchedulerDeps {
  executor: ToolExecutor
  toolRegistry: ToolRegistry
  renderer: Renderer
  eventLog?: EventLog
  hookRunner?: IHookRunner
  contextManager?: ContextManager
  sharedState: SharedRuntimeState
  eventEmitter?: RunEventEmitter
  claimSoftAbort?: (controller: AbortController) => boolean
  resourceScheduler?: ResourceScheduler
  useResourceClaims?: boolean
}

export class ToolScheduler {
  private readonly deps: ToolSchedulerDeps

  constructor(deps: ToolSchedulerDeps) {
    this.deps = deps
  }

  async schedule(
    parsedCalls: ParsedToolCall[],
    toolContext: ToolContext,
    planMode: boolean,
    turnAbortController: AbortController,
    messages: OpenAIMessage[],
    turnNumber: number,
    safeNames?: ReadonlySet<string>,
  ): Promise<{ aborted: boolean }> {
    const turnAbortSignal = turnAbortController.signal

    // Handle parse errors first (self-heal)
    const validCalls: ParsedToolCall[] = []
    for (const call of parsedCalls) {
      if (call.parseError) {
        const { tc } = call
        const errContent =
          `Error: malformed arguments for ${tc.name} — ${call.parseError}. ` +
          `Re-emit the call with valid JSON matching the tool's schema. Raw: ${tc.arguments.slice(0, 200)}`
        this.deps.renderer.toolResult(tc.name, errContent, true)
        this.deps.eventLog?.append(
          'tool_result',
          tc.name,
          { parse_error: call.parseError, isError: true },
          [tc.name, 'parse_error'],
        )
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: errContent,
          name: tc.name,
        })
      } else {
        validCalls.push(call)
      }
    }
    if (validCalls.length === 0) return { aborted: false }

    const hasClaimTools = this.deps.toolRegistry.getAll().some((t) => t.metadata?.claims)
    const batches = hasClaimTools && this.deps.useResourceClaims
      ? partitionToolCalls(validCalls, this.deps.toolRegistry.getAll())
      : legacyPartitionToolCalls(validCalls, safeNames ?? new Set())

    for (const batch of batches) {
      if (turnAbortSignal.aborted) return { aborted: true }

      if (batch.safe && batch.calls.length > 1) {
        await this.executeParallelBatch(batch, toolContext, planMode, turnNumber, messages)
      } else {
        const aborted = await this.executeSerialBatch(
          batch, toolContext, planMode, turnNumber, messages, turnAbortSignal, turnAbortController,
        )
        if (aborted) return { aborted: true }
      }

      if (this.deps.claimSoftAbort?.(turnAbortController)) {
        return { aborted: true }
      }
    }

    return { aborted: false }
  }

  private async executeParallelBatch(
    batch: ToolBatch,
    toolContext: ToolContext,
    planMode: boolean,
    turnNumber: number,
    messages: OpenAIMessage[],
  ): Promise<void> {
    const { executor, renderer, eventLog, eventEmitter, sharedState } = this.deps

    eventEmitter?.emit({ type: 'TOOL_BATCH_STARTED', count: batch.calls.length, parallel: true })

    for (const { tc, input } of batch.calls) {
      renderer.toolStart(tc.name, input)
      sharedState.addActiveToolCall({
        callId: tc.id,
        toolName: tc.name,
        startedAt: Date.now(),
      })
    }

    const results = await Promise.all(
      batch.calls.map(({ tc, input }) =>
        executor.execute(tc.id, tc.name, input, toolContext, planMode, turnNumber),
      ),
    )

    for (let i = 0; i < batch.calls.length; i++) {
      const { tc } = batch.calls[i]
      const result = results[i]
      sharedState.removeActiveToolCall(tc.id)

      renderer.toolResult(tc.name, result.content, result.isError)
      eventLog?.append(
        'tool_result',
        tc.name,
        { content: result.content.slice(0, 500), isError: result.isError },
        [tc.name, result.isError ? 'error' : 'success'],
      )
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.content,
        name: tc.name,
      })
    }
  }

  private async executeSerialBatch(
    batch: ToolBatch,
    toolContext: ToolContext,
    planMode: boolean,
    turnNumber: number,
    messages: OpenAIMessage[],
    turnAbortSignal: AbortSignal,
    _turnAbortController: AbortController,
  ): Promise<boolean> {
    const { executor, renderer, eventLog, sharedState } = this.deps

    for (const { tc, input } of batch.calls) {
      if (turnAbortSignal.aborted) return true

      renderer.toolStart(tc.name, input)
      sharedState.addActiveToolCall({
        callId: tc.id,
        toolName: tc.name,
        startedAt: Date.now(),
      })

      const result = await executor.execute(
        tc.id, tc.name, input, toolContext, planMode, turnNumber,
      )

      sharedState.removeActiveToolCall(tc.id)

      renderer.toolResult(tc.name, result.content, result.isError)
      eventLog?.append(
        'tool_result',
        tc.name,
        { content: result.content.slice(0, 500), isError: result.isError },
        [tc.name, result.isError ? 'error' : 'success'],
      )

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.content,
        name: tc.name,
      })
    }

    return false
  }
}
