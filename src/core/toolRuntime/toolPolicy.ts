import type { Tool, ToolDefinition } from '../types.js'
import type { AgentConfig } from '../agentPresets.js'
import type { TaskIntent } from '../taskIntent.js'

export interface ToolPolicyConfig {
  agent?: AgentConfig
  taskIntent?: TaskIntent
}

export class ToolPolicy {
  private readonly config: ToolPolicyConfig

  constructor(config: ToolPolicyConfig) {
    this.config = config
  }

  getExposedDefinitions(allTools: Tool[], planMode: boolean): ToolDefinition[] {
    let defs = allTools.map((t) => t.definition)

    if (this.config.agent?.tools) {
      const allowed = new Set(this.config.agent.tools)
      defs = defs.filter((t) => allowed.has(t.function.name))
    }

    if (planMode) {
      // Filter by tool's own planModeAllowed declaration
      defs = defs.filter((_, i) => allTools[i].planModeAllowed !== false)
    }

    // TaskIntent-driven filtering: informational tasks get read-only tools
    if (!planMode && this.config.taskIntent?.kind === 'informational') {
      // Filter by tool's own informationalAllowed declaration
      defs = defs.filter((_, i) => allTools[i].informationalAllowed !== false)
    }

    return defs
  }

  checkExecutionAllowed(allTools: Tool[], toolName: string, planMode: boolean): string | null {
    // Find the tool to get its declarations
    const tool = allTools.find((t) => t.name === toolName)

    if (planMode) {
      if (tool && !tool.planModeAllowed) {
        return `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`
      }
    }

    // TaskIntent-driven enforcement: informational tasks block mutating tools
    if (!planMode && this.config.taskIntent?.kind === 'informational') {
      if (tool && !tool.informationalAllowed) {
        return `Tool "${toolName}" is not available for informational tasks. Only read-only tools are allowed.`
      }
    }

    if (this.config.agent?.tools) {
      if (!this.config.agent.tools.includes(toolName)) {
        return `Tool "${toolName}" is not available to this agent.`
      }
    }

    if (this.config.agent?.disallowedTools?.includes(toolName)) {
      return `Tool "${toolName}" is explicitly disallowed for this agent.`
    }

    return null
  }
}
