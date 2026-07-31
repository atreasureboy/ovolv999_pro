import type { ToolContext, ToolResult, IHookRunner } from '../types.js'
import type { PermissionChecker } from '../permission.js'
import type { Renderer } from '../../ui/renderer.js'
import type { ToolPolicy } from './toolPolicy.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { ContextManager } from '../context/contextManager.js'
import type { RunEventEmitter } from '../runtime/events.js'
import type { ProgressMonitor } from '../runtime/progressMonitor.js'
import type { AgentModule } from '../module.js'
import { classifyCommandRisk } from '../riskClassifier.js'

export interface ParsedToolCall {
  tc: { id: string; name: string; arguments: string }
  input: Record<string, unknown>
  parseError?: string
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
}

export class ToolExecutor {
  private readonly deps: ToolExecutorDeps

  constructor(deps: ToolExecutorDeps) {
    this.deps = deps
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

    return result
  }
}
