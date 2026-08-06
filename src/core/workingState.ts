/**
 * WorkingState — 结构化任务状态
 *
 * 替代自由文本摘要，结构化携带长期任务上下文：
 * - objective: 目标
 * - constraints: 约束条件
 * - confirmedFacts: 已确认事实
 * - decisions: 决策记录
 * - filesRead/Changed: 文件操作记录
 * - verification: 验证结果
 * - unresolved: 未解决问题
 * - nextActions: 下一步行动
 *
 * 压缩不变量：
 * - constraints 永不丢失
 * - confirmedFacts 永不丢失
 * - filesChanged 永不丢失
 * - verification.failed 永不丢失
 * - unresolved 永不丢失
 */

export interface Fact {
  claim: string
  source?: string
  confirmedAt?: string
}

export interface Decision {
  choice: string
  rationale: string
  decidedAt?: string
}

export interface WorkingState {
  objective: string
  constraints: string[]
  confirmedFacts: Fact[]
  decisions: Decision[]
  filesRead: string[]
  filesChanged: string[]
  verification: {
    passed: string[]
    failed: string[]
  }
  unresolved: string[]
  nextActions: string[]
}

export function emptyWorkingState(objective = ''): WorkingState {
  return {
    objective,
    constraints: [],
    confirmedFacts: [],
    decisions: [],
    filesRead: [],
    filesChanged: [],
    verification: { passed: [], failed: [] },
    unresolved: [],
    nextActions: [],
  }
}

export function addConstraint(state: WorkingState, constraint: string): WorkingState {
  if (state.constraints.includes(constraint)) return state
  return { ...state, constraints: [...state.constraints, constraint] }
}

export function addFact(state: WorkingState, fact: Fact): WorkingState {
  if (state.confirmedFacts.some((f) => f.claim === fact.claim)) {
    return {
      ...state,
      confirmedFacts: state.confirmedFacts.map((f) =>
        f.claim === fact.claim
          ? {
              ...f,
              source: fact.source ?? f.source,
              confirmedAt: fact.confirmedAt ?? f.confirmedAt,
            }
          : f,
      ),
    }
  }
  return { ...state, confirmedFacts: [...state.confirmedFacts, fact] }
}

export function addDecision(state: WorkingState, decision: Decision): WorkingState {
  return { ...state, decisions: [...state.decisions, decision] }
}

export function recordFileRead(state: WorkingState, path: string): WorkingState {
  if (state.filesRead.includes(path)) return state
  return { ...state, filesRead: [...state.filesRead, path] }
}

export function recordFileChange(state: WorkingState, path: string): WorkingState {
  if (state.filesChanged.includes(path)) return state
  return { ...state, filesChanged: [...state.filesChanged, path] }
}

export function recordVerification(
  state: WorkingState,
  command: string,
  passed: boolean,
): WorkingState {
  const next = { ...state.verification }
  if (passed) {
    if (!next.passed.includes(command)) {
      next.passed = [...next.passed, command]
    }
    next.failed = next.failed.filter((c) => c !== command)
  } else {
    if (!next.failed.includes(command)) {
      next.failed = [...next.failed, command]
    }
    next.passed = next.passed.filter((c) => c !== command)
  }
  return { ...state, verification: next }
}

export function resolveUnresolved(state: WorkingState, item: string): WorkingState {
  return { ...state, unresolved: state.unresolved.filter((u) => u !== item) }
}

export function pushNextAction(state: WorkingState, action: string): WorkingState {
  if (state.nextActions.includes(action)) return state
  return { ...state, nextActions: [...state.nextActions, action] }
}

export function serializeWorkingState(state: WorkingState): string {
  const isEmpty =
    !state.objective &&
    state.constraints.length === 0 &&
    state.confirmedFacts.length === 0 &&
    state.decisions.length === 0 &&
    state.filesRead.length === 0 &&
    state.filesChanged.length === 0 &&
    state.verification.passed.length === 0 &&
    state.verification.failed.length === 0 &&
    state.unresolved.length === 0 &&
    state.nextActions.length === 0
  if (isEmpty) return ''

  const lines: string[] = []
  lines.push('# WorkingState (structured task context)')
  lines.push('')
  lines.push(`objective: ${state.objective}`)

  if (state.constraints.length > 0) {
    lines.push('constraints:')
    for (const c of state.constraints) lines.push(`  - ${c}`)
  }

  if (state.confirmedFacts.length > 0) {
    lines.push('confirmedFacts:')
    for (const f of state.confirmedFacts) {
      const src = f.source ? `  (source: ${f.source})` : ''
      lines.push(`  - ${f.claim}${src}`)
    }
  }

  if (state.decisions.length > 0) {
    lines.push('decisions:')
    for (const d of state.decisions) {
      lines.push(`  - choice: ${d.choice}`)
      lines.push(`    rationale: ${d.rationale}`)
    }
  }

  if (state.filesRead.length > 0) {
    lines.push('filesRead:')
    for (const p of state.filesRead) lines.push(`  - ${p}`)
  }

  if (state.filesChanged.length > 0) {
    lines.push('filesChanged:')
    for (const p of state.filesChanged) lines.push(`  - ${p}`)
  }

  if (state.verification.passed.length > 0 || state.verification.failed.length > 0) {
    lines.push('verification:')
    if (state.verification.passed.length > 0) {
      lines.push('  passed:')
      for (const c of state.verification.passed) lines.push(`    - ${c}`)
    }
    if (state.verification.failed.length > 0) {
      lines.push('  failed:')
      for (const c of state.verification.failed) lines.push(`    - ${c}`)
    }
  }

  if (state.unresolved.length > 0) {
    lines.push('unresolved:')
    for (const u of state.unresolved) lines.push(`  - ${u}`)
  }

  if (state.nextActions.length > 0) {
    lines.push('nextActions:')
    for (const a of state.nextActions) lines.push(`  - ${a}`)
  }

  lines.push('')
  lines.push('# End of WorkingState')
  return lines.join('\n')
}

export interface CompactionViolation {
  field: string
  detail: string
}

export function compactionViolations(
  before: WorkingState,
  after: WorkingState,
): CompactionViolation[] {
  const out: CompactionViolation[] = []

  const droppedConstraints = before.constraints.filter((c) => !after.constraints.includes(c))
  if (droppedConstraints.length > 0) {
    out.push({ field: 'constraints', detail: `dropped: ${droppedConstraints.join('; ')}` })
  }

  const beforeClaims = new Set(before.confirmedFacts.map((f) => f.claim))
  const afterClaims = new Set(after.confirmedFacts.map((f) => f.claim))
  const droppedFacts = [...beforeClaims].filter((c) => !afterClaims.has(c))
  if (droppedFacts.length > 0) {
    out.push({ field: 'confirmedFacts', detail: `dropped ${droppedFacts.length} fact(s)` })
  }

  const droppedChanges = before.filesChanged.filter((p) => !after.filesChanged.includes(p))
  if (droppedChanges.length > 0) {
    out.push({ field: 'filesChanged', detail: `dropped: ${droppedChanges.join('; ')}` })
  }

  const droppedFailed = before.verification.failed.filter(
    (c) => !after.verification.failed.includes(c),
  )
  if (droppedFailed.length > 0) {
    out.push({ field: 'verification.failed', detail: `dropped: ${droppedFailed.join('; ')}` })
  }

  const droppedUnresolved = before.unresolved.filter((u) => !after.unresolved.includes(u))
  if (droppedUnresolved.length > 0) {
    out.push({ field: 'unresolved', detail: `dropped: ${droppedUnresolved.join('; ')}` })
  }

  return out
}
