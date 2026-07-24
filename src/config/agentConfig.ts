/**
 * Agent config — declarative extension surface (.ovogo/agent.json).
 *
 * Why this exists: adding tools, modules, permission rules, the verify gate, or
 * the model context window previously required editing bin source. This file is
 * the single config-driven extension point — downstream consumers configure the
 * base without forking it.
 *
 * Resolution order (later wins, deep-merged):
 *   1. built-in defaults (this module)
 *   2. ~/.ovogo/agent.json   (user global)
 *   3. .ovogo/agent.json     (project)
 *   4. CLI flags / env       (applied by bin)
 *
 * Schema (all fields optional — omit = keep defaults):
 *   {
 *     "model": "gpt-4o",
 *     "maxIterations": 30,
 *     "maxContextTokens": 128000,
 *     "modules": ["memory", "critic", "workspace"],
 *     "permission": { "mode": "ask", "rules": [ { "tool": "Bash", "pattern": "rm -rf", "action": "ask" } ] },
 *     "mcpServers": {
 *       "time": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
 *     },
 *     "verifyCommands": ["npm run typecheck", "npm test"],
 *     "pricing": { "inputPer1M": 2.5, "outputPer1M": 10 }
 *   }
 *
 * mcpServers: each entry spawns a stdio MCP server; its tools are discovered at
 * startup and surfaced to the agent as `mcp__<server>__<tool>`.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { z } from 'zod'

// ── Schemas (runtime validators + the single source of truth for the types) ──
// A misconfigured .ovogo/agent.json was previously parsed with a bare cast and
// silently used (typos like "models" or "permission":"asky" were swallowed).
// These schemas validate shape + enums; unknown keys are reported as likely
// typos rather than dropped without a trace.

const permissionRuleSchema = z.object({
  tool: z.string().optional(),
  pattern: z.string().optional(),
  action: z.enum(['allow', 'deny', 'ask']),
})

const permissionSchema = z.object({
  mode: z.enum(['auto', 'ask', 'deny']).optional(),
  rules: z.array(permissionRuleSchema).optional(),
})

/** A stdio MCP server declaration. */
export const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
})

export const pricingSchema = z.object({
  /** USD per 1M input (prompt) tokens. */
  inputPer1M: z.number().optional(),
  /** USD per 1M output (completion) tokens. */
  outputPer1M: z.number().optional(),
})

export const agentConfigSchema = z.object({
  model: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  /** Context window for the selected model. Falls back to a model→tokens map. */
  maxContextTokens: z.number().int().positive().optional(),
  modules: z.array(z.string()).optional(),
  permission: permissionSchema.optional(),
  mcpServers: z.record(z.string(), mcpServerSchema).optional(),
  /** Commands run by the Agent verification gate (replaces hardcoded `tsc`). */
  verifyCommands: z.array(z.string()).optional(),
  pricing: pricingSchema.optional(),
})

// Types are derived from the schemas so structure and validator can never drift.
export type McpServerConfig = z.infer<typeof mcpServerSchema>
export type PricingConfig = z.infer<typeof pricingSchema>
export type AgentConfigFile = z.infer<typeof agentConfigSchema>

/** Known top-level keys — used to flag likely-typo unknown keys. */
const KNOWN_KEYS = new Set(Object.keys(agentConfigSchema.shape))

/** Known model → context window map, so consumers don't hardcode token counts. */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  o1: 200_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'claude-sonnet-4-x': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-opus-4-x': 200_000,
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
}

/** Fallback when neither config nor the model map know the window. */
export const DEFAULT_CONTEXT_TOKENS = 128_000

/** Resolve the context window for a model from the map, else the default. */
export function contextTokensForModel(model: string, override?: number): number {
  if (typeof override === 'number') return override
  // Exact match first, then prefix match (handles dated variants like gpt-4o-2024-08-06)
  if (MODEL_CONTEXT_TOKENS[model]) return MODEL_CONTEXT_TOKENS[model]
  for (const key of Object.keys(MODEL_CONTEXT_TOKENS)) {
    if (model.startsWith(key)) return MODEL_CONTEXT_TOKENS[key]
  }
  return DEFAULT_CONTEXT_TOKENS
}

function tryParse(path: string): AgentConfigFile {
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(
      `[agentConfig] warning: ${path} has invalid JSON (${(err as Error).message}); ignoring this file\n`,
    )
    return {}
  }
  // Validate against the schema. A structural failure (bad type / bad enum)
  // rejects the whole file with an actionable message.
  const result = agentConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  · ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    process.stderr.write(
      `[agentConfig] warning: ${path} has invalid config:\n${issues}\nignoring this file\n`,
    )
    return {}
  }
  // Warn about unknown top-level keys (likely typos, e.g. "models" vs "model")
  // without rejecting the otherwise-valid fields.
  if (parsed && typeof parsed === 'object') {
    const extras = Object.keys(parsed as Record<string, unknown>).filter((k) => !KNOWN_KEYS.has(k))
    if (extras.length > 0) {
      process.stderr.write(
        `[agentConfig] warning: ${path} has unknown key(s): ${extras.join(', ')} (ignored). Known keys: ${[...KNOWN_KEYS].join(', ')}\n`,
      )
    }
  }
  return result.data
}

/** Deep-merge two config files (b wins). Arrays and objects replace by key. */
function mergeConfigs(a: AgentConfigFile, b: AgentConfigFile): AgentConfigFile {
  return {
    model: b.model ?? a.model,
    maxIterations: b.maxIterations ?? a.maxIterations,
    maxContextTokens: b.maxContextTokens ?? a.maxContextTokens,
    modules: b.modules ?? a.modules,
    // Only synthesize a permission/pricing object when at least one side
    // actually has one — otherwise a fully-rejected file would still leak an
    // empty { mode: undefined, rules: [] } shape to consumers.
    permission:
      a.permission || b.permission
        ? {
            mode: b.permission?.mode ?? a.permission?.mode,
            rules: [...(a.permission?.rules ?? []), ...(b.permission?.rules ?? [])],
          }
        : undefined,
    mcpServers: { ...(a.mcpServers ?? {}), ...(b.mcpServers ?? {}) },
    verifyCommands: b.verifyCommands ?? a.verifyCommands,
    pricing: a.pricing || b.pricing ? { ...a.pricing, ...b.pricing } : undefined,
  }
}

/**
 * Load and merge agent config from global + project locations.
 * Returns {} if no config files exist (caller applies built-in defaults).
 */
export function loadAgentConfig(cwd: string): AgentConfigFile {
  const globalPath = join(homedir(), '.ovogo', 'agent.json')
  const projectPath = resolve(cwd, '.ovogo', 'agent.json')
  let cfg: AgentConfigFile = {}
  if (existsSync(globalPath)) cfg = mergeConfigs(cfg, tryParse(globalPath))
  if (existsSync(projectPath)) cfg = mergeConfigs(cfg, tryParse(projectPath))
  return cfg
}
