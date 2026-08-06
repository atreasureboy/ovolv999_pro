/**
 * CompletionContract — 任务完成契约
 *
 * 防止过早完成：任务不能仅因为模型停止就标记为完成。
 * 这个纯函数检查结构化条件，返回判断结果。
 *
 * 状态：
 * - completed: 所有验收标准满足 + 验证通过 + 无未处理失败
 * - partial: 大部分标准满足但有些剩余
 * - blocked: 存在硬阻塞（验证失败、子 agent 停滞）
 * - failed: 终端失败（Provider/Engine 错误）
 * - cancelled: 用户/系统取消
 * - exhausted: 达到迭代上限
 * - incomplete: 验收未满足且不阻塞（继续执行）
 */

export type CompletionStatus =
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'exhausted'
  | 'incomplete'

export interface AcceptanceCriterion {
  id?: string
  description: string
  satisfied?: boolean
}

export interface VerificationState {
  executed: boolean
  passed: boolean
  failed: string[]
}

export interface WorkerSummary {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
}

export interface CompletionInput {
  /** 任务类型 */
  taskKind: 'informational' | 'analysis' | 'mutation'
  /** 模型是否停止（finish_reason: stop） */
  modelStopped: boolean
  /** 验收标准 */
  acceptanceCriteria: AcceptanceCriterion[]
  /** 验证状态 */
  verification: VerificationState
  /** 活跃的子 agent */
  activeWorkers: WorkerSummary[]
  /** 未解决的阻塞 */
  unresolvedBlockers: string[]
  /** 实际变更的文件 */
  changedFiles: string[]
  /** 迭代次数 */
  iterationsUsed?: number
  iterationsMax?: number
  /** 是否取消 */
  cancelled?: boolean
  /** 是否失败 */
  failed?: boolean
}

export type CompletionVerdict =
  | { status: 'completed'; evidence: string[]; residualRisks: string[] }
  | { status: 'partial'; evidence: string[]; remaining: string[]; residualRisks: string[] }
  | { status: 'blocked'; blockers: string[] }
  | { status: 'failed'; reason: string; evidence: string[] }
  | { status: 'cancelled'; reason: string }
  | { status: 'exhausted'; reason: string; iterationsUsed: number; iterationsMax: number }
  | { status: 'incomplete'; remaining: string[] }

/**
 * 评估完成契约
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const evidence: string[] = []
  const residual: string[] = []

  if (input.changedFiles.length > 0) {
    evidence.push(`${input.changedFiles.length} file(s) changed`)
  }

  // 取消是终端状态
  if (input.cancelled) {
    return { status: 'cancelled', reason: input.unresolvedBlockers[0] ?? 'user/system cancelled' }
  }

  // 失败是终端状态
  if (input.failed) {
    return {
      status: 'failed',
      reason: input.unresolvedBlockers[0] ?? 'engine/provider failure',
      evidence,
    }
  }

  // 达到迭代上限
  if (
    input.iterationsUsed !== undefined &&
    input.iterationsMax !== undefined &&
    input.iterationsUsed >= input.iterationsMax
  ) {
    return {
      status: 'exhausted',
      reason: `hit iteration limit (${input.iterationsUsed}/${input.iterationsMax})`,
      iterationsUsed: input.iterationsUsed,
      iterationsMax: input.iterationsMax,
    }
  }

  // 计算未满足的标准
  const criteria = input.acceptanceCriteria
  const satisfiedSet = new Set(
    criteria.filter((c) => c.satisfied === true).map((c) => c.id ?? c.description),
  )
  const unsatisfied = criteria.filter((c) => !satisfiedSet.has(c.id ?? c.description))

  if (satisfiedSet.size > 0) {
    evidence.push(`${satisfiedSet.size}/${criteria.length} acceptance criteria met`)
  }

  // 硬阻塞
  const blockers: string[] = []
  if (input.activeWorkers.some((w) => w.status === 'running' || w.status === 'pending')) {
    blockers.push(
      `${input.activeWorkers.filter((w) => w.status === 'running' || w.status === 'pending').length} worker(s) still running`,
    )
  }
  if (input.unresolvedBlockers.length > 0) {
    blockers.push(...input.unresolvedBlockers)
  }
  if (input.verification.executed && !input.verification.passed) {
    blockers.push('verification executed but FAILED')
  }
  if (blockers.length > 0) {
    return { status: 'blocked', blockers }
  }

  // 信息/分析任务：不需要文件变更
  if (input.taskKind === 'informational' || input.taskKind === 'analysis') {
    if (criteria.length === 0 || unsatisfied.length === 0) {
      return { status: 'completed', evidence, residualRisks: residual }
    }
    return {
      status: 'partial',
      evidence,
      remaining: unsatisfied.map((u) => u.description),
      residualRisks: residual,
    }
  }

  // 变更任务：需要文件变更 + 满足验收标准
  if (criteria.length === 0) {
    if (input.verification.executed && !input.verification.passed) {
      return { status: 'blocked', blockers: ['verification failed'] }
    }
    if (input.changedFiles.length === 0 && satisfiedSet.size === 0) {
      residual.push('no acceptance criteria declared and no changes produced')
      return { status: 'incomplete', remaining: ['produce a verifiable change'] }
    }
    if (input.changedFiles.length > 0 && !input.verification.executed) {
      residual.push('mutation with changes but no verification')
      return {
        status: 'partial',
        evidence,
        remaining: ['execute verification'],
        residualRisks: residual,
      }
    }
    return { status: 'completed', evidence, residualRisks: residual }
  }

  if (unsatisfied.length === 0) {
    if (input.verification.executed && !input.verification.passed) {
      return { status: 'blocked', blockers: ['all criteria claimed but verification failed'] }
    }
    if (!input.verification.executed) {
      residual.push('acceptance met but verification not executed')
    }
    return { status: 'completed', evidence, residualRisks: residual }
  }

  if (input.changedFiles.length === 0) {
    return { status: 'incomplete', remaining: unsatisfied.map((u) => u.description) }
  }

  return {
    status: 'partial',
    evidence,
    remaining: unsatisfied.map((u) => u.description),
    residualRisks: residual,
  }
}
