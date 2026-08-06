import type { ToolContext, ToolResult, IHookRunner } from '../types.js'
import type { PermissionChecker } from '../permission.js'
import type { Renderer } from '../../ui/renderer.js'
import type { ToolPolicy } from './toolPolicy.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { ContextManager } from '../context/contextManager.js'
import type { RunEventEmitter } from '../runtime/events.js'
import type { ProgressMonitor } from '../runtime/progressMonitor.js'
import type { AgentModule } from '../module.js'
import type { WorkingState } from '../workingState.js'
import { recordFileRead, recordFileChange, recordVerification } from '../workingState.js'
import { classifyCommandRisk } from '../riskClassifier.js'

export interface ParsedToolCall {
  tc: { id: string; name: string; arguments: string }
  input: Record<string, unknown>
  parseError?: string
}

/** Strategy for detecting verification commands (e.g. test/lint/typecheck runs). */
export interface VerificationDetector {
  /** Returns true if the given tool call is performing verification. */
  isVerification(toolName: string, input: Record<string, unknown>): boolean
  /** Provided verification description extracted from the input. */
  describe(toolName: string, input: Record<string, unknown>): string
}

/** Default verification detector — detects common test/lint commands in Bash. */
export class DefaultVerificationDetector implements VerificationDetector {
  private readonly pattern = /\b(tsc|eslint|prettier --check|vitest|jest|pytest|cargo test|go test|npm test|npm run test|make test)\b/

  isVerification(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName !== 'Bash') return false
    const cmd = typeof input.command === 'string' ? input.command : ''
    return this.pattern.test(cmd)
  }

  describe(_toolName: string, input: Record<string, unknown>): string {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return cmd.slice(0, 80)
  }
}

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry
  toolPolicy: ToolPolicy
  permissionChecker?: PermissionChecker
  contextManager?: ContextManager
  hookRunner?: IHookRunner
  eventEmitter?: RunEventEmitter
  progressMonitor?: ProgressMonitor
  renderer: Renderer
  modules?: AgentModule[]
  workingState?: WorkingState
  /** Custom verification detector — defaults to DefaultVerificationDetector */
  verificationDetector?: VerificationDetector
}

export class ToolExecutor {
  private readonly deps: ToolExecutorDeps

  constructor(deps: ToolExecutorDeps) {
    this.deps = deps
  }

  /** Expose current workingState for re-sync by Engine after tool execution. */
  get currentWorkingState(): import('../workingState.js').WorkingState | undefined {
    return this.deps.workingState
  }

  async execute(
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    const { toolRegistry, toolPolicy, eventEmitter, progressMonitor, modules } = this.deps
    const allTools = toolRegistry.getAll()

    const tool = toolRegistry.get(toolName)
    if (!tool) {
      const result: ToolResult = { content: `Unknown tool: ${toolName}`, isError: true }
      eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
      return result
    }

    const policyError = toolPolicy.checkExecutionAllowed(allTools, toolName, planMode)
    if (policyError) {
      const result: ToolResult = { content: policyError, isError: true }
      eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
      return result
    }

    // Classify risk for Bash commands
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const riskLevel = classifyCommandRisk(input.command)
      if (riskLevel === 'dangerous' && this.deps.permissionChecker) {
        // Dangerous commands always require approval
        const decision = await this.deps.permissionChecker.check({ tool: toolName, input })
        if (!decision.allowed) {
          const result: ToolResult = {
            content: `Permission denied (dangerous command): ${decision.reason}. Tool "${toolName}" was not executed.`,
            isError: true,
          }
          eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
          return result
        }
      }
    } else if (this.deps.permissionChecker) {
      const decision = await this.deps.permissionChecker.check({ tool: toolName, input })
      if (!decision.allowed) {
        const result: ToolResult = {
          content: `Permission denied: ${decision.reason}. Tool "${toolName}" was not executed.`,
          isError: true,
        }
        eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
        return result
      }
    }

    this.deps.hookRunner?.runPreToolCall(toolName, input)

    let result: ToolResult
    try {
      result = await tool.execute(input, context)
    } catch (err) {
      result = {
        content: `Tool execution error: ${(err as Error).message}`,
        isError: true,
      }
    }

    if (this.deps.contextManager) {
      result.content = this.deps.contextManager.truncateToolResult(result.content)
    }

    this.deps.hookRunner?.runPostToolCall(toolName, result.content, result.isError)

    // Record to ProgressMonitor for stall detection
    if (progressMonitor) {
      progressMonitor.recordToolCall(toolName, input, result)
    }

    // Notify modules (e.g., episodic memory write)
    if (modules) {
      for (const module of modules) {
        module.onToolCall?.(toolName, input, result, turnNumber)
      }
    }

    eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })

    // ── Update WorkingState based on tool type ───────────────────────
    if (this.deps.workingState && !result.isError) {
      this.deps.workingState = updateWorkingState(
        this.deps.workingState,
        toolName,
        input,
        result,
        this.deps.verificationDetector,
      )
    }

    return result
  }
}

/** Update WorkingState based on tool type and result */
function updateWorkingState(
  state: import('../workingState.js').WorkingState,
  toolName: string,
  input: Record<string, unknown>,
  _result: ToolResult,
  verificationDetector?: VerificationDetector,
): import('../workingState.js').WorkingState {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
  switch (toolName) {
    case 'Read':
      if (filePath) return recordFileRead(state, filePath)
      break
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      if (filePath) return recordFileChange(state, filePath)
      break
    case 'Bash': {
      const detector = verificationDetector ?? new DefaultVerificationDetector()
      if (detector.isVerification(toolName, input)) {
        const passed = !_result.isError
        return recordVerification(state, detector.describe(toolName, input), passed)
      }
      break
    }
  }
  return state
}
