import { describe, it, expect } from 'vitest'
import {
  evaluateCompletion,
  type CompletionInput,
  type CompletionStatus,
} from '../src/core/completionContract.js'

function makeInput(overrides: Partial<CompletionInput> = {}): CompletionInput {
  return {
    taskKind: 'mutation',
    modelStopped: true,
    acceptanceCriteria: [],
    verification: { executed: false, passed: false, failed: [] },
    activeWorkers: [],
    unresolvedBlockers: [],
    changedFiles: [],
    ...overrides,
  }
}

describe('evaluateCompletion', () => {
  // ── Cancelled / Failed ────────────────────────────────────────────

  it('returns cancelled when cancelled flag is set', () => {
    const result = evaluateCompletion(makeInput({ cancelled: true }))
    expect(result.status).toBe('cancelled' satisfies CompletionStatus)
  })

  it('returns failed when failed flag is set', () => {
    const result = evaluateCompletion(makeInput({ failed: true }))
    expect(result.status).toBe('failed' satisfies CompletionStatus)
  })

  it('cancelled takes priority over failed', () => {
    const result = evaluateCompletion(makeInput({ cancelled: true, failed: true }))
    expect(result.status).toBe('cancelled' satisfies CompletionStatus)
  })

  // ── Exhausted ─────────────────────────────────────────────────────

  it('returns exhausted when iterations hit max', () => {
    const result = evaluateCompletion(makeInput({ iterationsUsed: 100, iterationsMax: 100 }))
    expect(result.status).toBe('exhausted' satisfies CompletionStatus)
    if (result.status === 'exhausted') {
      expect(result.iterationsUsed).toBe(100)
      expect(result.iterationsMax).toBe(100)
    }
  })

  it('does not return exhausted when under max', () => {
    const result = evaluateCompletion(makeInput({ iterationsUsed: 99, iterationsMax: 100 }))
    expect(result.status).not.toBe('exhausted')
  })

  // ── Blocked ────────────────────────────────────────────────────────

  it('returns blocked when workers are still running', () => {
    const result = evaluateCompletion(
      makeInput({
        activeWorkers: [
          { id: 'w1', status: 'running' },
          { id: 'w2', status: 'pending' },
        ],
      }),
    )
    expect(result.status).toBe('blocked' satisfies CompletionStatus)
    if (result.status === 'blocked') {
      expect(result.blockers.length).toBeGreaterThan(0)
    }
  })

  it('returns blocked when unresolved blockers exist', () => {
    const result = evaluateCompletion(makeInput({ unresolvedBlockers: ['Missing dependency'] }))
    expect(result.status).toBe('blocked' satisfies CompletionStatus)
  })

  it('returns blocked when verification executed but failed', () => {
    const result = evaluateCompletion(
      makeInput({
        verification: { executed: true, passed: false, failed: ['tsc', 'lint'] },
      }),
    )
    expect(result.status).toBe('blocked' satisfies CompletionStatus)
  })

  // ── Informational / Analysis tasks ────────────────────────────────

  it('returns completed for informational task with no criteria', () => {
    const result = evaluateCompletion(makeInput({ taskKind: 'informational' }))
    expect(result.status).toBe('completed' satisfies CompletionStatus)
  })

  it('returns completed for analysis task with no criteria', () => {
    const result = evaluateCompletion(makeInput({ taskKind: 'analysis' }))
    expect(result.status).toBe('completed' satisfies CompletionStatus)
  })

  it('returns completed for informational task with all criteria met', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'informational',
        acceptanceCriteria: [{ id: 'c1', description: 'Answer the question', satisfied: true }],
      }),
    )
    expect(result.status).toBe('completed' satisfies CompletionStatus)
  })

  it('returns partial for analysis task with unsatisfied criteria', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'analysis',
        acceptanceCriteria: [{ id: 'c1', description: 'Complete audit', satisfied: false }],
      }),
    )
    expect(result.status).toBe('partial' satisfies CompletionStatus)
  })

  // ── Mutation tasks ─────────────────────────────────────────────────

  it('returns completed for mutation with changes and passed verification', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts'],
        verification: { executed: true, passed: true, failed: [] },
        acceptanceCriteria: [{ id: 'c1', description: 'Fix the bug', satisfied: true }],
      }),
    )
    expect(result.status).toBe('completed' satisfies CompletionStatus)
  })

  it('returns incomplete for mutation with no changes and no criteria', () => {
    const result = evaluateCompletion(makeInput({ taskKind: 'mutation', changedFiles: [] }))
    expect(result.status).toBe('incomplete' satisfies CompletionStatus)
  })

  it('returns blocked when all criteria met but verification failed', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts'],
        acceptanceCriteria: [{ id: 'c1', description: 'Fix bug', satisfied: true }],
        verification: { executed: true, passed: false, failed: ['tsc'] },
      }),
    )
    expect(result.status).toBe('blocked' satisfies CompletionStatus)
  })

  it('returns partial for mutation with changes but unsatisfied criteria', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts'],
        acceptanceCriteria: [
          { id: 'c1', description: 'Fix', satisfied: false },
          { id: 'c2', description: 'Test', satisfied: true },
        ],
      }),
    )
    expect(result.status).toBe('partial' satisfies CompletionStatus)
  })

  it('returns incomplete for mutation with unsatisfied criteria and no changes', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: [],
        acceptanceCriteria: [{ id: 'c1', description: 'Fix bug', satisfied: false }],
      }),
    )
    expect(result.status).toBe('incomplete' satisfies CompletionStatus)
  })

  it('returns partial for mutation with changes but no verification executed', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts'],
        verification: { executed: false, passed: false, failed: [] },
      }),
    )
    expect(result.status).toBe('partial' satisfies CompletionStatus)
  })

  it('returns completed for mutation with no criteria but verification passed', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts'],
        verification: { executed: true, passed: true, failed: [] },
      }),
    )
    expect(result.status).toBe('completed' satisfies CompletionStatus)
  })

  it('returns blocked for mutation with no criteria but verification failed', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts'],
        verification: { executed: true, passed: false, failed: ['tsc'] },
      }),
    )
    expect(result.status).toBe('blocked' satisfies CompletionStatus)
  })

  // ── Edge cases ─────────────────────────────────────────────────────

  it('completed workers do not block', () => {
    const result = evaluateCompletion(
      makeInput({
        activeWorkers: [
          { id: 'w1', status: 'completed' },
          { id: 'w2', status: 'failed' },
          { id: 'w3', status: 'cancelled' },
        ],
      }),
    )
    expect(result.status).not.toBe('blocked')
  })

  it('evidence includes changed file count', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts', 'b.ts'],
        verification: { executed: true, passed: true, failed: [] },
        acceptanceCriteria: [{ id: 'c1', description: 'Fix', satisfied: true }],
      }),
    )
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.evidence.some((e) => e.includes('2 file'))).toBe(true)
    }
  })

  it('evidence includes acceptance criteria count', () => {
    const result = evaluateCompletion(
      makeInput({
        taskKind: 'mutation',
        changedFiles: ['a.ts'],
        verification: { executed: true, passed: true, failed: [] },
        acceptanceCriteria: [
          { id: 'c1', description: 'Fix', satisfied: true },
          { id: 'c2', description: 'Test', satisfied: true },
        ],
      }),
    )
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.evidence.some((e) => e.includes('2/2'))).toBe(true)
    }
  })
})
