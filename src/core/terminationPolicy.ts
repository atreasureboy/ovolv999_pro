/**
 * TerminationPolicy — 终止策略
 *
 * 统一的终止决策，替代内联的 check_abort 逻辑。
 * 纯函数，无副作用。
 *
 * 决策优先级（首次匹配）：
 * 1. 硬中止（Ctrl+C / engine.abort()）
 * 2. 软中止（Esc / engine.softAbort()）
 * 3. 达到最大迭代
 * 4. 继续
 */

export type TerminationDecision =
  | { kind: 'continue' }
  | { kind: 'hard_abort' }
  | { kind: 'soft_abort' }
  | { kind: 'max_iterations'; maxIterations: number }

export function checkTermination(params: {
  hardAborted: boolean
  softAborted: boolean
  iteration: number
  maxIterations: number
}): TerminationDecision {
  if (params.hardAborted) return { kind: 'hard_abort' }
  if (params.softAborted) return { kind: 'soft_abort' }
  if (params.iteration > params.maxIterations) {
    return { kind: 'max_iterations', maxIterations: params.maxIterations }
  }
  return { kind: 'continue' }
}
