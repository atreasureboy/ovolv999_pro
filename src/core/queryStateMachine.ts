/**
 * QueryStateMachine — 显式状态机 + 预算追踪
 *
 * 状态：boot → check_abort → budget_check → llm_call → tool_execution → complete
 * 纯 reducer，可单元测试
 *
 * BudgetTracker 检测递减收益：
 * - 3+ 次 continuation 且 <500 token 增量 → 强制停止
 */

import type { TurnResult } from './types.js'

export type QueryState =
  | { kind: 'boot' }
  | { kind: 'check_abort'; iteration: number }
  | { kind: 'budget_check'; iteration: number }
  | { kind: 'llm_call'; iteration: number }
  | { kind: 'tool_execution'; iteration: number }
  | { kind: 'complete'; reason: TurnResult['reason']; output: string }

export type QueryEvent =
  | { type: 'booted' }
  | { type: 'continue' }
  | { type: 'stop' }
  | { type: 'hard_abort'; output: string }
  | { type: 'soft_abort'; output: string }
  | { type: 'max_iterations'; output: string }
  | { type: 'llm_done'; finishReason: string | null; hasToolCalls: boolean; output: string }
  | { type: 'tools_done'; aborted: boolean; output: string }
  | { type: 'error'; output: string }

export function transitionQueryState(state: QueryState, event: QueryEvent): QueryState {
  switch (state.kind) {
    case 'boot':
      if (event.type === 'booted') return { kind: 'check_abort', iteration: 1 }
      return state

    case 'check_abort': {
      if (event.type === 'hard_abort')
        return { kind: 'complete', reason: 'interrupted', output: event.output }
      if (event.type === 'soft_abort')
        return { kind: 'complete', reason: 'interrupted', output: event.output }
      if (event.type === 'max_iterations')
        return { kind: 'complete', reason: 'max_iterations', output: event.output }
      if (event.type === 'error')
        return { kind: 'complete', reason: 'error', output: event.output }
      if (event.type === 'continue')
        return { kind: 'budget_check', iteration: state.iteration }
      return state
    }

    case 'budget_check':
      if (event.type === 'continue')
        return { kind: 'llm_call', iteration: state.iteration }
      return state

    case 'llm_call': {
      if (event.type === 'hard_abort')
        return { kind: 'complete', reason: 'interrupted', output: event.output }
      if (event.type === 'error')
        return { kind: 'complete', reason: 'error', output: event.output }
      if (event.type === 'llm_done') {
        const stopped = event.finishReason === 'stop' || !event.hasToolCalls
        if (stopped)
          return { kind: 'complete', reason: 'stop_sequence', output: event.output }
        return { kind: 'tool_execution', iteration: state.iteration }
      }
      return state
    }

    case 'tool_execution':
      if (event.type === 'tools_done') {
        if (event.aborted) {
          return { kind: 'complete', reason: 'interrupted', output: event.output }
        }
        return { kind: 'check_abort', iteration: state.iteration + 1 }
      }
      return state

    case 'complete':
      return state
  }
}

export function isTerminal(state: QueryState): boolean {
  return state.kind === 'complete'
}

const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

export interface BudgetTracker {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

export type TokenBudgetDecision =
  | { action: 'continue'; nudgeMessage: string; continuationCount: number }
  | { action: 'stop'; diminishingReturns: boolean }

export function checkTokenBudget(
  tracker: BudgetTracker,
  budget: number | null,
  turnTokens: number,
): TokenBudgetDecision {
  if (budget === null || budget <= 0) {
    return { action: 'stop', diminishingReturns: false }
  }

  const deltaSinceLastCheck = turnTokens - tracker.lastGlobalTurnTokens

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = turnTokens
    return {
      action: 'continue',
      nudgeMessage: `[budget] ${Math.round((turnTokens / budget) * 100)}% used. Continue your work.`,
      continuationCount: tracker.continuationCount,
    }
  }

  return { action: 'stop', diminishingReturns: isDiminishing }
}
