/**
 * AgentToolFilter — 子 Agent 工具过滤
 *
 * 全局禁止列表（防止递归 spawn）：
 * - Agent: 防止递归
 * - EnterPlanMode/ExitPlanMode: 主线程专属
 */

export const SUB_AGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  'Agent',
  'EnterPlanMode',
  'ExitPlanMode',
  'VerifyPlanExecution',
])

export function filterToolsForSubAgent(
  toolNames: string[],
  allowlist: string[] | undefined,
  denylist: string[] | undefined,
): string[] {
  let result = toolNames

  if (allowlist) {
    const allowed = new Set(allowlist)
    result = result.filter((name) => allowed.has(name) || name.startsWith('mcp__'))
  }

  result = result.filter((name) => !SUB_AGENT_DISALLOWED_TOOLS.has(name))

  if (denylist) {
    const denied = new Set(denylist)
    result = result.filter((name) => !denied.has(name))
  }

  return result
}
