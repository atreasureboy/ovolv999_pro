import type { Tool, ToolDefinition } from '../types.js'
import type { AgentConfig } from '../agentPresets.js'

const PLAN_MODE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
])

export interface ToolPolicyConfig {
  agent?: AgentConfig
}

export class ToolPolicy {
  private readonly config: ToolPolicyConfig

  constructor(config: ToolPolicyConfig) {
    this.config = config
  }

  getExposedDefinitions(
    allTools: Tool[],
    planMode: boolean,
  ): ToolDefinition[] {
    let defs = allTools.map((t) => t.definition)

    if (this.config.agent?.tools) {
      const allowed = new Set(this.config.agent.tools)
      defs = defs.filter((t) => allowed.has(t.function.name))
    }

    if (planMode) {
      defs = defs.filter((t) => PLAN_MODE_TOOLS.has(t.function.name))
    }

    return defs
  }

  checkExecutionAllowed(
    allTools: Tool[],
    toolName: string,
    planMode: boolean,
  ): string | null {
    if (planMode) {
      if (!PLAN_MODE_TOOLS.has(toolName)) {
        return `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`
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
