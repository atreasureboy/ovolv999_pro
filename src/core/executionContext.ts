/**
 * ExecutionContext — 每轮执行上下文
 *
 * 动态传播 runId，替代"Tool 构造时缓存 parentRunId"的错误模式。
 * 生命周期：
 * - Coordinator.run() 创建 TurnRun
 * - 构建 ExecutionContext { runId, parentRunId, ... }
 * - 通过 ToolContext.execution 传递给工具
 * - AgentTool 读取 context.execution.runId 作为 parentRunId
 */

export interface ExecutionContext {
  runId: string
  parentRunId?: string
  workspaceId: string
  workspacePath: string
  signal: AbortSignal
  model?: string
  provider?: string
  metadata?: Record<string, unknown>
}

export function buildExecutionContext(params: {
  runId: string
  parentRunId?: string
  cwd: string
  signal: AbortSignal
  model?: string
  provider?: string
  metadata?: Record<string, unknown>
}): ExecutionContext {
  return {
    runId: params.runId,
    parentRunId: params.parentRunId,
    workspaceId: workspaceIdFromPath(params.cwd),
    workspacePath: params.cwd,
    signal: params.signal,
    model: params.model,
    provider: params.provider,
    metadata: params.metadata,
  }
}

export function workspaceIdFromPath(cwd: string): string {
  let h = 0
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
  }
  return `ws-${(h >>> 0).toString(36)}`
}
