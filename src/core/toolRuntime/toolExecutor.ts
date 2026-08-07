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
import { validatePathInputs } from '../pathSecurity.js'

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
  private readonly pattern =
    /\b(tsc|eslint|prettier --check|vitest|jest|pytest|cargo test|go test|npm test|npm run test|make test)\b/

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
  get currentWorkingState(): WorkingState | undefined {
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

    // ── Engine-level path security enforcement (defense-in-depth) ──
    // Even if individual tools implement their own path checks, the executor
    // validates known path fields centrally so no tool can skip validation.
    // MCP tools are exempt: user-configured external servers may legitimately
    // operate on roots outside the project cwd (their own sandboxing applies).
    if (!toolName.startsWith('mcp__')) {
      const pathError = validatePathInputs(input, context.cwd)
      if (pathError) {
        const result: ToolResult = { content: pathError, isError: true }
        eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
        return result
      }
    }

    // ── Permission gate — unified for ALL tools (including Bash) ──
    // Previously non-dangerous Bash commands bypassed the checker entirely,
    // so ask/deny modes and user-configured rules never applied to the shell.
    // The checker itself knows the mode (auto allows safe commands without
    // prompting), so routing everything through it is both safe and correct.
    const isDangerousBash =
      toolName === 'Bash' &&
      typeof input.command === 'string' &&
      classifyCommandRisk(input.command) === 'dangerous'
    if (this.deps.permissionChecker) {
      const decision = await this.deps.permissionChecker.check({ tool: toolName, input })
      if (!decision.allowed) {
        const prefix = isDangerousBash
          ? 'Permission denied (dangerous command)'
          : 'Permission denied'
        const result: ToolResult = {
          content: `${prefix}: ${decision.reason}. Tool "${toolName}" was not executed.`,
          isError: true,
        }
        eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
        return result
      }
    }

    this.deps.hookRunner?.runPreToolCall(toolName, input)

    let result: ToolResult
    try {
      // Run module onBeforeToolCall hooks — modules can veto or modify
      for (const module of this.deps.modules ?? []) {
        const advice = module.onBeforeToolCall?.(toolName, input)
        if (advice) {
          if (advice.action === 'deny') {
            const result: ToolResult = {
              content: `Tool "${toolName}" blocked by module: ${advice.reason}`,
              isError: true,
            }
            eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
            return result
          }
          if (advice.action === 'modify' && advice.modifiedInput) {
            input = advice.modifiedInput
          }
        }
      }
      result = await tool.execute(input, context)
    } catch (err: unknown) {
      result = {
        content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
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
  state: WorkingState,
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  verificationDetector?: VerificationDetector,
): WorkingState {
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
        // Bash reports non-zero exits with isError:false, so isError alone
        // can't distinguish a failing test run — exitCode is authoritative.
        const passed = !result.isError && (result.exitCode ?? 0) === 0
        return recordVerification(state, detector.describe(toolName, input), passed)
      }
      break
    }
  }
  return state
}
