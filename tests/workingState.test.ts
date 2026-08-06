import { describe, it, expect } from 'vitest'
import {
  emptyWorkingState,
  addConstraint,
  addFact,
  addDecision,
  recordFileRead,
  recordFileChange,
  recordVerification,
  resolveUnresolved,
  pushNextAction,
  serializeWorkingState,
  compactionViolations,
  type WorkingState,
} from '../src/core/workingState.js'

describe('workingState', () => {
  // ── Initialization ───────────────────────────────────────────────

  it('creates empty state with defaults', () => {
    const state = emptyWorkingState()
    expect(state.objective).toBe('')
    expect(state.constraints).toEqual([])
    expect(state.confirmedFacts).toEqual([])
    expect(state.decisions).toEqual([])
    expect(state.filesRead).toEqual([])
    expect(state.filesChanged).toEqual([])
    expect(state.verification).toEqual({ passed: [], failed: [] })
    expect(state.unresolved).toEqual([])
    expect(state.nextActions).toEqual([])
  })

  it('creates empty state with objective', () => {
    const state = emptyWorkingState('Fix the auth bug')
    expect(state.objective).toBe('Fix the auth bug')
  })

  // ── Immutable updates ────────────────────────────────────────────

  it('addConstraint returns new object (immutable)', () => {
    const s1 = emptyWorkingState()
    const s2 = addConstraint(s1, 'Must support Node 18')
    expect(s1.constraints).toEqual([])
    expect(s2.constraints).toEqual(['Must support Node 18'])
    expect(s2).not.toBe(s1)
  })

  it('addConstraint deduplicates', () => {
    const s1 = addConstraint(emptyWorkingState(), 'C1')
    const s2 = addConstraint(s1, 'C1')
    expect(s2.constraints).toEqual(['C1'])
  })

  it('addFact returns new object (immutable)', () => {
    const s1 = emptyWorkingState()
    const s2 = addFact(s1, { claim: 'file.ts exists' })
    expect(s1.confirmedFacts).toEqual([])
    expect(s2.confirmedFacts).toEqual([{ claim: 'file.ts exists' }])
  })

  it('addFact updates existing fact with new source', () => {
    const s1 = addFact(emptyWorkingState(), { claim: 'X', source: 'Read' })
    const s2 = addFact(s1, { claim: 'X', source: 'Grep' })
    expect(s2.confirmedFacts).toHaveLength(1)
    expect(s2.confirmedFacts[0].source).toBe('Grep')
  })

  it('addDecision returns new object (immutable)', () => {
    const s1 = emptyWorkingState()
    const s2 = addDecision(s1, { choice: 'Use Redis', rationale: 'Faster' })
    expect(s1.decisions).toEqual([])
    expect(s2.decisions).toHaveLength(1)
  })

  it('recordFileRead records unique paths', () => {
    let s = emptyWorkingState()
    s = recordFileRead(s, 'a.ts')
    s = recordFileRead(s, 'b.ts')
    s = recordFileRead(s, 'a.ts') // duplicate
    expect(s.filesRead).toEqual(['a.ts', 'b.ts'])
  })

  it('recordFileChange records unique paths', () => {
    let s = emptyWorkingState()
    s = recordFileChange(s, 'a.ts')
    s = recordFileChange(s, 'b.ts')
    s = recordFileChange(s, 'a.ts') // duplicate
    expect(s.filesChanged).toEqual(['a.ts', 'b.ts'])
  })

  it('recordVerification tracks passed tests', () => {
    let s = emptyWorkingState()
    s = recordVerification(s, 'npx tsc --noEmit', true)
    expect(s.verification.passed).toContain('npx tsc --noEmit')
    expect(s.verification.failed).toEqual([])
  })

  it('recordVerification tracks failed tests', () => {
    let s = emptyWorkingState()
    s = recordVerification(s, 'npx vitest', false)
    expect(s.verification.failed).toContain('npx vitest')
    expect(s.verification.passed).toEqual([])
  })

  it('recordVerification moves from failed to passed on success', () => {
    let s = emptyWorkingState()
    s = recordVerification(s, 'npx vitest', false)
    expect(s.verification.failed).toContain('npx vitest')
    s = recordVerification(s, 'npx vitest', true)
    expect(s.verification.failed).toEqual([])
    expect(s.verification.passed).toContain('npx vitest')
  })

  it('recordVerification moves from passed to failed on failure', () => {
    let s = emptyWorkingState()
    s = recordVerification(s, 'npx vitest', true)
    expect(s.verification.passed).toContain('npx vitest')
    s = recordVerification(s, 'npx vitest', false)
    expect(s.verification.passed).toEqual([])
    expect(s.verification.failed).toContain('npx vitest')
  })

  it('resolveUnresolved removes item', () => {
    let s: WorkingState = { ...emptyWorkingState(), unresolved: ['Q1', 'Q2'] }
    s = resolveUnresolved(s, 'Q1')
    expect(s.unresolved).toEqual(['Q2'])
    s = resolveUnresolved(s, 'Q2')
    expect(s.unresolved).toEqual([])
  })

  it('pushNextAction records unique actions', () => {
    let s = emptyWorkingState()
    s = pushNextAction(s, 'Run tests')
    s = pushNextAction(s, 'Commit changes')
    s = pushNextAction(s, 'Run tests') // duplicate
    expect(s.nextActions).toEqual(['Run tests', 'Commit changes'])
  })

  // ── Serialization ────────────────────────────────────────────────

  it('serializeWorkingState returns empty string for empty state', () => {
    const s = emptyWorkingState()
    expect(serializeWorkingState(s)).toBe('')
  })

  it('serializeWorkingState includes objective', () => {
    const s = emptyWorkingState('Fix auth')
    const serialized = serializeWorkingState(s)
    expect(serialized).toContain('Fix auth')
  })

  it('serializeWorkingState includes constraints', () => {
    let s = emptyWorkingState()
    s = addConstraint(s, 'C1')
    const serialized = serializeWorkingState(s)
    expect(serialized).toContain('C1')
  })

  it('serializeWorkingState includes confirmedFacts', () => {
    let s = emptyWorkingState()
    s = addFact(s, { claim: 'file exists', source: 'Read' })
    const serialized = serializeWorkingState(s)
    expect(serialized).toContain('file exists')
  })

  it('serializeWorkingState includes decisions', () => {
    let s = emptyWorkingState()
    s = addDecision(s, { choice: 'Use Redis', rationale: 'Fast' })
    const serialized = serializeWorkingState(s)
    expect(serialized).toContain('Use Redis')
    expect(serialized).toContain('Fast')
  })

  it('serializeWorkingState includes filesRead and filesChanged', () => {
    let s = emptyWorkingState()
    s = recordFileRead(s, 'a.ts')
    s = recordFileChange(s, 'b.ts')
    const serialized = serializeWorkingState(s)
    expect(serialized).toContain('a.ts')
    expect(serialized).toContain('b.ts')
  })

  it('serializeWorkingState includes verification', () => {
    let s = emptyWorkingState()
    s = recordVerification(s, 'tsc', true)
    s = recordVerification(s, 'vitest', false)
    const serialized = serializeWorkingState(s)
    expect(serialized).toContain('tsc')
    expect(serialized).toContain('vitest')
  })

  it('serializeWorkingState includes unresolved and nextActions', () => {
    let s: WorkingState = { ...emptyWorkingState(), unresolved: ['Q1'] }
    s = pushNextAction(s, 'Run tests')
    const serialized = serializeWorkingState(s)
    expect(serialized).toContain('Q1')
    expect(serialized).toContain('Run tests')
  })

  // ── Compaction violations ─────────────────────────────────────────

  it('compactionViolations detects dropped constraints', () => {
    const before: WorkingState = { ...emptyWorkingState(), constraints: ['C1', 'C2'] }
    const after: WorkingState = { ...emptyWorkingState(), constraints: ['C1'] }
    const violations = compactionViolations(before, after)
    expect(violations.some((v) => v.field === 'constraints')).toBe(true)
    expect(violations.some((v) => v.detail.includes('C2'))).toBe(true)
  })

  it('compactionViolations detects dropped confirmedFacts', () => {
    const before: WorkingState = {
      ...emptyWorkingState(),
      confirmedFacts: [{ claim: 'F1' }, { claim: 'F2' }],
    }
    const after: WorkingState = {
      ...emptyWorkingState(),
      confirmedFacts: [{ claim: 'F1' }],
    }
    const violations = compactionViolations(before, after)
    expect(violations.some((v) => v.field === 'confirmedFacts')).toBe(true)
  })

  it('compactionViolations detects dropped filesChanged', () => {
    const before: WorkingState = { ...emptyWorkingState(), filesChanged: ['a.ts', 'b.ts'] }
    const after: WorkingState = { ...emptyWorkingState(), filesChanged: ['a.ts'] }
    const violations = compactionViolations(before, after)
    expect(violations.some((v) => v.field === 'filesChanged')).toBe(true)
  })

  it('compactionViolations detects dropped verification failures', () => {
    let before = emptyWorkingState()
    before = recordVerification(before, 'tsc', false)
    const after = emptyWorkingState()
    const violations = compactionViolations(before, after)
    expect(violations.some((v) => v.field === 'verification.failed')).toBe(true)
  })

  it('compactionViolations detects dropped unresolved', () => {
    const before: WorkingState = { ...emptyWorkingState(), unresolved: ['Q1'] }
    const after: WorkingState = emptyWorkingState()
    const violations = compactionViolations(before, after)
    expect(violations.some((v) => v.field === 'unresolved')).toBe(true)
  })

  it('compactionViolations returns empty for identical states', () => {
    const before: WorkingState = {
      ...emptyWorkingState(),
      constraints: ['C1'],
      filesChanged: ['a.ts'],
    }
    const violations = compactionViolations(before, before)
    expect(violations).toEqual([])
  })

  it('compactionViolations returns empty when nothing important dropped', () => {
    let before = emptyWorkingState()
    before = recordFileRead(before, 'a.ts')
    before = recordFileRead(before, 'b.ts')
    const after = recordFileRead(emptyWorkingState(), 'a.ts')
    // Dropped filesRead is not considered a compaction violation
    const violations = compactionViolations(before, after)
    expect(violations).toEqual([])
  })
})
