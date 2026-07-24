/**
 * Agent Configuration — replaces hardcoded AgentType enum with composable config.
 *
 * Core principle (from AgentOS): all agents share one runtime (Harness).
 * Differentiated capabilities come from module combination, NOT from type enum.
 *
 * Usage:
 *   // By preset name (backward compat with subagent_type)
 *   const config = resolveAgentConfig({ preset: 'explore' })
 *
 *   // Custom (no preset needed)
 *   const config = resolveAgentConfig({
 *     config: {
 *       identity: { systemPrompt: (cwd) => `...` },
 *       modules: { memory: { enabled: true } },
 *       tools: ['Bash', 'Read', 'Grep'],
 *       maxIterations: 50,
 *     }
 *   })
 */

import type { EngineConfig } from './types.js'

/** Module enablement configuration */
export interface ModuleConfig {
  memory?: { enabled: true; contextBudgetRatio?: number }
  critic?: { enabled: true; interval?: number }
  workspace?: { enabled: true; sessionDir?: string }
  reflection?: { enabled: true; minToolCalls?: number }
}

/** Agent identity — role persona and access mode */
export interface AgentIdentity {
  /** System prompt builder — receives cwd, returns the full identity prompt */
  systemPrompt: (cwd: string) => string
  /** If true, restrict to read-only tools (plan mode) */
  planMode?: boolean
}

/** Agent configuration — composable, no type enum */
export interface AgentConfig {
  /** Identity / role persona */
  identity: AgentIdentity
  /** Enabled capability modules */
  modules?: ModuleConfig
  /** Tool whitelist — undefined = all registered tools */
  tools?: string[]
  /** Skill IDs (future — for lazy-loaded skill system) */
  skills?: string[]
  /** Execution limits */
  maxIterations?: number
  maxOutputTokens?: number
  temperature?: number
}

/** Derive enabled module names from ModuleConfig */
export function deriveModuleNames(modules?: ModuleConfig): string[] | undefined {
  if (!modules) return undefined
  return Object.entries(modules)
    .filter(([, v]) => v != null && (v as { enabled?: boolean }).enabled === true)
    .map(([k]) => k)
}

// ─── Built-in Presets (replaces AgentType enum) ──────────────────────────────

export const AGENT_PRESETS: Record<string, AgentConfig> = {
  explore: {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\nYou are an Explore sub-agent. Your task is to investigate and analyze the codebase.\n\nRules:\n- Only READ operations are available to you (Read, Glob, Grep, WebFetch, WebSearch)\n- Do NOT write, edit, or execute anything\n- Be thorough: search broadly before drawing conclusions\n- Return a clear, structured summary of your findings\n- Include specific file paths and line numbers where relevant`,
      planMode: true,
    },
    modules: {}, // lightweight — no memory/critic/reflection side effects
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxIterations: 40,
  },

  plan: {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\nYou are a Plan sub-agent. Analyze the codebase and produce a detailed implementation plan.\nReturn the plan as a numbered list with concrete steps, file paths, and specific changes.`,
      planMode: true,
    },
    modules: {}, // lightweight
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxIterations: 30,
  },

  'code-reviewer': {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\nYou are a code-review sub-agent. Review code for correctness, maintainability, security, and performance.\n\nRules:\n- Only READ operations are available to you (Read, Glob, Grep)\n- Do NOT modify anything — analyze and report only\n- Review dimensions: bugs/logic errors, maintainability, security issues, performance, convention adherence\n- Group findings by severity: [CRITICAL] / [HIGH] / [MEDIUM] / [LOW]\n- Each finding: code location (path:line), issue, why it matters, suggested fix\n- If no issues found, say so explicitly`,
      planMode: true,
    },
    modules: {}, // lightweight
    tools: ['Read', 'Glob', 'Grep'],
    maxIterations: 30,
  },

  'security-auditor': {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\nYou are a Security Auditor sub-agent. Audit systems, configurations, permission boundaries, credentials, and data flows for security vulnerabilities, compliance risks, and credential leaks.\n\nRules:\n- Only READ operations are available to you (Read, Glob, Grep, WebFetch, WebSearch)\n- Do NOT write, edit, or execute anything\n- Categorize findings by severity: [CRITICAL] / [HIGH] / [MEDIUM] / [LOW]\n- Provide clear evidence, affected paths/components, and mitigation recommendations`,
      planMode: true,
    },
    modules: {},
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxIterations: 30,
  },

  manager: {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\nYou are a Manager/Coordinator sub-agent. Your goal is to orchestrate complex tasks by breaking down high-level objectives, delegating focused subtasks to sub-agents (Agent tool), tracking progress, and synthesizing overall results.`,
    },
    modules: {
      memory: { enabled: true },
      workspace: { enabled: true },
    },
    tools: [
      'Agent',
      'Task',
      'TodoWrite',
      'Read',
      'Write',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'memory_write',
      'memory_search',
      'memory_recall',
    ],
    maxIterations: 60,
  },

  'data-analyst': {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\nYou are a Data Analyst sub-agent. Analyze logs, datasets, metrics, and structured reports, extract insights, and present clean summaries.`,
      planMode: true,
    },
    modules: {},
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxIterations: 30,
  },

  'general-purpose': {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\nYou are a general-purpose sub-agent. Complete the specific task given in the user message without expanding scope.\nProvide a clear, complete summary when done (what you found, what you did, the result).\nIf unable to complete, explain why and what you tried.`,
    },
    modules: {
      memory: { enabled: true },
      workspace: { enabled: true },
    },
    // Exclude Agent to prevent recursion
    tools: [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Glob',
      'Grep',
      'TodoWrite',
      'WebFetch',
      'WebSearch',
      'TmuxSession',
      'Task',
      'load_skill',
      'memory_write',
      'memory_search',
      'memory_recall',
    ],
    maxIterations: 60,
  },
}

/** List of valid preset names (for tool enum) */
export const PRESET_NAMES = Object.keys(AGENT_PRESETS)

/**
 * Resolve agent configuration from either a preset name or a custom config.
 * Falls back to 'general-purpose' preset if nothing specified.
 */
export function resolveAgentConfig(input: { preset?: string; config?: AgentConfig }): AgentConfig {
  if (input.config) return input.config
  const preset = input.preset ?? 'general-purpose'
  const found = AGENT_PRESETS[preset] ?? AGENT_PRESETS['general-purpose']
  // Return a shallow clone so callers can safely mutate (e.g. maxIterations override)
  return { ...found, identity: { ...found.identity } }
}

/**
 * Validate and sanitize an LLM-supplied agent_config object.
 * Returns a safe AgentConfig or null if the input is malformed.
 */
export function validateAgentConfig(raw: unknown): AgentConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const identity = obj.identity
  if (typeof identity !== 'object' || identity === null) return null
  const id = identity as Record<string, unknown>
  // systemPrompt must be a function (preset pattern) — if LLM passes a string, wrap it
  let systemPrompt: (cwd: string) => string
  if (typeof id.systemPrompt === 'function') {
    systemPrompt = id.systemPrompt as (cwd: string) => string
  } else if (typeof id.systemPrompt === 'string') {
    const sp = id.systemPrompt
    systemPrompt = () => sp
  } else {
    return null
  }
  return {
    identity: {
      systemPrompt,
      planMode: id.planMode === true,
    },
    modules: typeof obj.modules === 'object' && obj.modules !== null ? obj.modules : undefined,
    tools: Array.isArray(obj.tools)
      ? (obj.tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined,
    maxIterations:
      typeof obj.maxIterations === 'number' ? Math.min(obj.maxIterations, 200) : undefined,
    temperature: typeof obj.temperature === 'number' ? obj.temperature : undefined,
    maxOutputTokens: typeof obj.maxOutputTokens === 'number' ? obj.maxOutputTokens : undefined,
  }
}

/**
 * Merge AgentConfig into EngineConfig fields.
 * Called by the engine constructor when config.agent is set.
 */
export function applyAgentToConfig(config: EngineConfig): EngineConfig {
  if (!config.agent) return config

  const agent = config.agent
  return {
    ...config,
    systemPrompt: agent.identity.systemPrompt(config.cwd),
    planMode: agent.identity.planMode ?? config.planMode,
    enabledModules: deriveModuleNames(agent.modules) ?? config.enabledModules,
    maxIterations: agent.maxIterations ?? config.maxIterations,
    temperature: agent.temperature ?? config.temperature,
    maxOutputTokens: agent.maxOutputTokens ?? config.maxOutputTokens,
  }
}
