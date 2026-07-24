/**
 * AgentTool — spawn a specialized sub-agent to handle a focused subtask.
 *
 * Features:
 *   - AgentConfig-driven (preset name or custom config)
 *   - Verification gate: auto-run tsc/lint after sub-agent completes
 *   - Call chain tracking: prevent infinite recursion + audit depth
 *   - Parallel execution (multiple Agent calls in one response)
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { EngineConfig } from '../core/types.js'
import type { AgentConfig } from '../core/agentPresets.js'
import { resolveAgentConfig, validateAgentConfig, PRESET_NAMES } from '../core/agentPresets.js'
import { Renderer } from '../ui/renderer.js'
import { tmuxLayout } from '../ui/tmuxLayout.js'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { AsyncLocalStorage } from 'async_hooks'
import { str } from '../core/strings.js'

// ── Call chain tracking (AgentOS §6 pattern) ─────────────────────────────────
//
// Per-call-chain depth via AsyncLocalStorage. This is concurrency-safe: when
// the main agent fans out several Agent calls with Promise.all, each chain has
// its own independent depth counter. A shared module-level counter would be
// incremented by every concurrent child before the first await, falsely tripping
// the MAX_CALL_DEPTH guard. ALS propagates correctly through awaits so each
// branch's depth reflects its actual ancestry.

const MAX_CALL_DEPTH = 5
const depthStorage = new AsyncLocalStorage<number>()

/** Depth of the currently-executing call chain (0 at the top level). */
function currentDepth(): number {
  return depthStorage.getStore() ?? 0
}

// ── Verification gate (AgentOS §6 "No Tuple, No Merge") ─────────────────────

/**
 * Fallback verification commands when none are configured on the engine.
 * A neutral base defaults to NO verification — TypeScript type-checking was
 * coding-specific. Consumers configure verifyCommands via .ovogo/agent.json
 * (e.g. ["npm run typecheck", "npm test"]) or EngineConfig.verifyCommands.
 */
const DEFAULT_VERIFY_COMMANDS: string[] = []

/**
 * Run verification commands and return results.
 * The command list comes from EngineConfig.verifyCommands (per-project, via
 * agent.json) so non-TypeScript projects can run `pytest`/`cargo test`/etc.
 * Returns null if all pass, or a formatted failure summary.
 */
function runVerification(
  cwd: string,
  commands: string[],
): { passed: boolean; output: string } | null {
  const results: string[] = []
  let allPassed = true

  for (const cmd of commands) {
    try {
      execSync(cmd, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      const label = cmd.split(' ')[1] || cmd
      results.push(`✓ ${label} — passed`)
    } catch (err: unknown) {
      allPassed = false
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const output = (e.stdout ?? '') + (e.stderr ?? '')
      const trimmed = output.trim().slice(0, 800)
      const label = cmd.split(' ')[1] || cmd
      results.push(`✗ ${label} — FAILED\n${trimmed}`)
    }
  }

  if (results.length === 0) return null
  return { passed: allPassed, output: results.join('\n\n') }
}

// ── Engine factory injection ─────────────────────────────────────────────────

type ChildEngine = {
  runTurn: (
    msg: string,
    history: never[],
  ) => Promise<{ result: { output: string; reason: string } }>
  abort: () => void
}
let _engineFactory: ((config: EngineConfig, renderer: unknown) => ChildEngine) | null = null
let _currentConfig: EngineConfig | null = null
let _currentRenderer: unknown = null
const AGENT_EVENT_LOG_FILE = 'agent_events.ndjson'

function normalizeDelegatedPrompt(prompt: string, config: EngineConfig): string {
  let normalized = prompt
  if (config.sessionDir) {
    normalized = normalized
      .replace(/\bSESSION_DIR\b/g, config.sessionDir)
      .replace(/\/SESSION\b/g, config.sessionDir)
  }
  return normalized
}

function appendAgentEvent(config: EngineConfig, event: Record<string, unknown>): void {
  if (!config.sessionDir) return
  const logPath = join(config.sessionDir, AGENT_EVENT_LOG_FILE)
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  }
  try {
    appendFileSync(logPath, JSON.stringify(payload) + '\n', 'utf8')
  } catch {
    // best-effort audit logging; never break execution on log failure
  }
}

export function registerAgentFactory(
  factory: (config: EngineConfig, renderer: unknown) => ChildEngine,
  config: EngineConfig,
  renderer: unknown,
): void {
  _engineFactory = factory
  _currentConfig = config
  _currentRenderer = renderer
}

// ── runAgentTask ─────────────────────────────────────────────────────────────

async function runAgentTask(
  description: string,
  prompt: string,
  agentConfig: AgentConfig,
  agentLabel: string,
  verify: boolean,
  context: ToolContext,
): Promise<ToolResult> {
  if (!_engineFactory || !_currentConfig || !_currentRenderer) {
    return { content: 'Error: AgentTool 未初始化', isError: true }
  }

  // Call chain depth check (prevent infinite recursion).
  // Depth is derived from the current async call-chain context, so concurrent
  // sub-agents spawned in one response each carry their own depth lineage.
  const myDepth = currentDepth() + 1
  if (myDepth > MAX_CALL_DEPTH) {
    return {
      content: `Max agent call depth (${MAX_CALL_DEPTH}) exceeded — possible recursion. Call chain: ${myDepth - 1} levels deep.`,
      isError: true,
    }
  }

  // Run this entire sub-agent invocation inside a depth context = myDepth, so
  // any further Agent calls it makes see myDepth as their parent depth.
  return depthStorage.run(myDepth, async () =>
    runAgentTaskInner(description, prompt, agentConfig, agentLabel, verify, context, myDepth),
  )
}

// ── runAgentTaskInner (runs within the child depth context) ──────────────────

async function runAgentTaskInner(
  description: string,
  prompt: string,
  agentConfig: AgentConfig,
  agentLabel: string,
  verify: boolean,
  context: ToolContext,
  myDepth: number,
): Promise<ToolResult> {
  if (!_engineFactory || !_currentConfig || !_currentRenderer) {
    return { content: 'Error: AgentTool 未初始化', isError: true }
  }

  const mainRenderer = _currentRenderer as {
    agentStart: (desc: string, type: string) => void
    agentDone: (desc: string, success: boolean) => void
    agentSummary: (agentType: string, desc: string, summary: string) => void
    agentHeartbeat: (agentType: string, desc: string, elapsedSec: number) => void
  }
  mainRenderer.agentStart(description, agentLabel)
  const agentStartTime = Date.now()

  // Structured communication event: INVOKE_SENT (with call depth)
  context.eventLog?.append(
    'invoke_sent',
    agentLabel,
    {
      description,
      modules: agentConfig.modules ? Object.keys(agentConfig.modules) : [],
      planMode: agentConfig.identity.planMode ?? false,
      maxIterations: agentConfig.maxIterations,
      call_depth: myDepth,
      verify_enabled: verify,
    },
    [agentLabel, 'invoke'],
  )

  const paneLabel = `[${agentLabel}] ${description}`
  const paneSlot = tmuxLayout.acquireSlot(paneLabel)
  const childRenderer = paneSlot
    ? Renderer.forFile(paneSlot.logFile)
    : (_currentRenderer as Renderer)

  const childConfig: EngineConfig = {
    ..._currentConfig,
    agent: agentConfig,
    cwd: context.cwd,
    hookRunner: undefined,
    sessionDir: undefined,
  }

  const childEngine = _engineFactory(childConfig, childRenderer)

  const normalizedPrompt = normalizeDelegatedPrompt(prompt, _currentConfig)
  const placeholdersReplaced = normalizedPrompt !== prompt
  const inheritedContextLines = [
    `- session_dir: ${_currentConfig.sessionDir ?? '未设置'}`,
    `- call_depth: ${myDepth}`,
  ]

  const sessionDirHint = _currentConfig.sessionDir
    ? `\n- 会话目录固定为: ${_currentConfig.sessionDir}`
    : ''
  const delegatedPrompt = [
    '[任务委派契约]',
    '- 严格执行下方"子任务指令"，不得擅自替换任务目标或范围。',
    '- 若用户/主agent给了明确范围与约束，以该指令为最高优先级。',
    '- 若信息缺失导致无法执行，先报告缺失并请求补充，不要自行假设。',
    '- 如果子任务中仍出现占位符（SESSION_DIR），优先使用下面"继承上下文"中的值。',
    sessionDirHint,
    '',
    '[继承上下文]',
    ...inheritedContextLines,
    '',
    '[子任务描述]',
    description,
    '',
    '[子任务指令]',
    normalizedPrompt,
  ].join('\n')

  appendAgentEvent(_currentConfig, {
    event: 'delegation.start',
    agent_label: agentLabel,
    description,
    max_iterations: agentConfig.maxIterations,
    call_depth: myDepth,
    verify_enabled: verify,
    placeholders_replaced: placeholdersReplaced,
    prompt_preview: normalizedPrompt.slice(0, 500),
  })

  if (context.signal) {
    if (context.signal.aborted) {
      mainRenderer.agentDone(description, false)
      if (paneSlot) tmuxLayout.releaseSlot(paneSlot.slot)
      return { content: `[${agentLabel}] 已取消（父任务中止）`, isError: true }
    }
    context.signal.addEventListener('abort', () => childEngine.abort(), { once: true })
  }

  const HEARTBEAT_MS = 2 * 60 * 1000
  const heartbeatTimer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - agentStartTime) / 1000)
    mainRenderer.agentHeartbeat(agentLabel, description, elapsedSec)
  }, HEARTBEAT_MS)

  try {
    const { result } = await childEngine.runTurn(delegatedPrompt, [])
    clearInterval(heartbeatTimer)
    const durationMs = Date.now() - agentStartTime

    mainRenderer.agentDone(description, result.reason !== 'error')
    if (paneSlot) tmuxLayout.releaseSlot(paneSlot.slot)

    // ── Verification Gate (AgentOS "No Tuple, No Merge") ──
    let verifySection = ''
    if (verify && result.reason !== 'error' && !agentConfig.identity.planMode) {
      const verifyResult = runVerification(
        context.cwd,
        _currentConfig.verifyCommands ?? DEFAULT_VERIFY_COMMANDS,
      )
      if (verifyResult) {
        const icon = verifyResult.passed ? '✓' : '✗'
        verifySection = `\n\n---\n[验证闸门] ${icon}\n${verifyResult.output}`
        context.eventLog?.append(
          'invoke_completed',
          agentLabel,
          {
            description,
            verified: true,
            verification_passed: verifyResult.passed,
          },
          [agentLabel, 'verify', verifyResult.passed ? 'passed' : 'failed'],
        )
      }
    }

    context.eventLog?.append(
      'invoke_completed',
      agentLabel,
      {
        description,
        success: result.reason !== 'error',
        reason: result.reason,
        duration_ms: durationMs,
        call_depth: myDepth,
        output_preview: result.output.slice(0, 500),
      },
      [agentLabel, 'invoke', result.reason !== 'error' ? 'success' : 'error'],
    )

    if (!result.output) {
      return {
        content: `[${agentLabel}] "${description}" 完成（${result.reason}），无文本输出。${verifySection}`,
        isError: false,
      }
    }

    const summaryLines = result.output
      .split('\n')
      .map((l: string) => l.trimEnd())
      .filter((l: string) => l.trim().length > 0)
      .slice(0, 8)
      .join('\n')
    if (summaryLines) {
      mainRenderer.agentSummary(agentLabel, description, summaryLines)
    }

    return {
      content: `[${agentLabel}] "${description}":\n\n${result.output}${verifySection}`,
      isError: false,
    }
  } catch (err: unknown) {
    clearInterval(heartbeatTimer)
    mainRenderer.agentDone(description, false)
    if (paneSlot) tmuxLayout.releaseSlot(paneSlot.slot)
    appendAgentEvent(_currentConfig, {
      event: 'delegation.error',
      agent_label: agentLabel,
      description,
      success: false,
      duration_ms: Date.now() - agentStartTime,
      error: (err as Error).message,
    })
    return {
      content: `[${agentLabel}] "${description}" 异常: ${(err as Error).message}`,
      isError: true,
    }
  }
}

// ── AgentTool ────────────────────────────────────────────────────────────────

export class AgentTool implements Tool {
  name = 'Agent'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Agent',
      description: `启动专用 sub-agent 执行聚焦任务。多个 Agent 调用在同一响应中并发执行（Promise.all）。

## 指定 Agent 配置

方式 1 — 预设名称: subagent_type: "explore" | "plan" | "code-reviewer" | "general-purpose"
方式 2 — 自定义配置: agent_config: { identity, modules, tools, maxIterations }

## 验证闸门

设置 verify: true 后，子 agent 完成代码修改会自动运行 tsc --noEmit 验证类型安全。
验证失败时结果中包含错误详情，便于主 agent 立即修复。

## 关键规则
- prompt 必须完全自包含
- Sub-agent 不能再调用 Agent（禁止递归，最大调用深度 5 层）
- 无依赖的多个子任务可并发执行`,
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '任务标签' },
          prompt: { type: 'string', description: '完整任务指令（必须自包含）' },
          subagent_type: {
            type: 'string',
            enum: PRESET_NAMES,
            description: '预设名称（默认 general-purpose）',
          },
          agent_config: { type: 'object', description: '自定义配置（覆盖 subagent_type）' },
          max_iterations: { type: 'number', description: '最大执行轮数（覆盖预设默认值）' },
          verify: {
            type: 'boolean',
            description: '验证闸门：完成后自动跑 tsc --noEmit 检查类型安全（默认 false）',
          },
        },
        required: ['description', 'prompt'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const description = str(input.description, 'subtask')
    const prompt = str(input.prompt, '')
    const verify = input.verify === true

    if (!prompt.trim()) {
      return { content: 'Error: prompt 不能为空', isError: true }
    }

    if (!_engineFactory || !_currentConfig || !_currentRenderer) {
      return {
        content: 'Error: AgentTool 未初始化，请先调用 registerAgentFactory。',
        isError: true,
      }
    }

    const presetName = str(input.subagent_type, '') || undefined
    const rawConfig = input.agent_config
    const customConfig = rawConfig ? (validateAgentConfig(rawConfig) ?? undefined) : undefined
    if (rawConfig && !customConfig) {
      return {
        content: 'Error: agent_config is malformed — need identity.systemPrompt at minimum',
        isError: true,
      }
    }
    const agentConfig = resolveAgentConfig({
      preset: customConfig ? undefined : presetName,
      config: customConfig,
    })
    const agentLabel = customConfig ? 'custom' : (presetName ?? 'general-purpose')

    if (typeof input.max_iterations === 'number') {
      agentConfig.maxIterations = Math.min(input.max_iterations, 200)
    }

    return runAgentTask(description, prompt, agentConfig, agentLabel, verify, context)
  }
}
