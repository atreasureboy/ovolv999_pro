import { describe, it, expect } from 'vitest'
import { classifyTaskIntent } from '../src/core/taskIntent.js'

describe('classifyTaskIntent', () => {
  // ── Explicit kind ──────────────────────────────────────────────────

  it('respects explicit kind override', () => {
    const result = classifyTaskIntent('what is the weather', { explicitKind: 'mutation' })
    expect(result.kind).toBe('mutation')
    expect(result.confidence).toBe(0.95)
    expect(result.source).toBe('user-stated')
    expect(result.requiresWorkspaceChange).toBe(true)
  })

  // ── Plan mode ──────────────────────────────────────────────────────

  it('classifies plan mode as analysis', () => {
    const result = classifyTaskIntent('fix the bug', { planMode: true })
    expect(result.kind).toBe('analysis')
    expect(result.requiresWorkspaceChange).toBe(false)
    expect(result.source).toBe('plan-mode')
    expect(result.confidence).toBe(0.9)
  })

  // ── Mutation keywords (English) ────────────────────────────────────

  const mutationPhrases = [
    'fix the authentication bug',
    'implement a new login page',
    'refactor the database layer',
    'rewrite the caching module',
    'add logout functionality',
    'remove deprecated code',
    'delete old config files',
    'rename the function to getUser',
    'edit the README file',
    'modify the settings',
    'patch the vulnerability',
    'build a new API endpoint',
    'create a new component',
    'update dependencies',
  ]

  for (const phrase of mutationPhrases) {
    it(`classifies "${phrase.slice(0, 40)}..." as mutation`, () => {
      const result = classifyTaskIntent(phrase)
      expect(result.kind).toBe('mutation')
      expect(result.requiresWorkspaceChange).toBe(true)
      expect(result.source).toBe('keyword')
    })
  }

  // ── Mutation keywords (Chinese) ────────────────────────────────────

  it('classifies Chinese mutation keywords', () => {
    expect(classifyTaskIntent('修复登录bug').kind).toBe('mutation')
    expect(classifyTaskIntent('修改配置文件').kind).toBe('mutation')
    expect(classifyTaskIntent('实现新功能').kind).toBe('mutation')
    expect(classifyTaskIntent('重构数据库层').kind).toBe('mutation')
    expect(classifyTaskIntent('迁移到新版本').kind).toBe('mutation')
  })

  // ── Analysis keywords ──────────────────────────────────────────────

  const analysisPhrases = [
    'audit the codebase for security issues',
    'analyze the performance',
    'review this PR',
    'design a new architecture',
    'investigate the memory leak',
    'examine the test failures',
    'evaluate the library options',
    'verify the deployment',
    'test the login flow',
    'diagnose the slow query',
  ]

  for (const phrase of analysisPhrases) {
    it(`classifies "${phrase.slice(0, 40)}..." as analysis`, () => {
      const result = classifyTaskIntent(phrase)
      expect(result.kind).toBe('analysis')
      expect(result.requiresWorkspaceChange).toBe(false)
      expect(result.source).toBe('keyword')
    })
  }

  // ── Informational keywords ─────────────────────────────────────────

  const informationalPhrases = [
    'what is the purpose of engine.ts',
    'how does the tool scheduler work',
    'where is the authentication logic',
    'show me the config',
    'list all files',
    'find where auth happens',
    'hello',
    'hi there',
  ]

  for (const phrase of informationalPhrases) {
    it(`classifies "${phrase.slice(0, 40)}..." as informational`, () => {
      const result = classifyTaskIntent(phrase)
      expect(result.kind).toBe('informational')
      expect(result.requiresWorkspaceChange).toBe(false)
    })
  }

  // ── Default ────────────────────────────────────────────────────────

  it('defaults to informational for unrecognized input', () => {
    const result = classifyTaskIntent('xyzzy blarg')
    expect(result.kind).toBe('informational')
    expect(result.confidence).toBe(0.3)
    expect(result.source).toBe('static-rule')
  })

  it('defaults to informational for empty input', () => {
    const result = classifyTaskIntent('')
    expect(result.kind).toBe('informational')
    expect(result.source).toBe('static-rule')
  })

  // ── Outcomes extraction ────────────────────────────────────────────

  it('extracts requestedOutcomes from user message', () => {
    const result = classifyTaskIntent('fix the login bug')
    expect(result.requestedOutcomes.length).toBeGreaterThan(0)
    expect(result.requestedOutcomes[0]).toBe('fix the login bug')
  })

  // ── Verification defaults ──────────────────────────────────────────

  it('provides default verification for mutation tasks', () => {
    const result = classifyTaskIntent('fix the bug')
    expect(result.kind).toBe('mutation')
    expect(result.expectedVerification.length).toBeGreaterThan(0)
    expect(result.expectedVerification.some((v) => v.kind === 'typecheck')).toBe(true)
    expect(result.expectedVerification.some((v) => v.kind === 'lint')).toBe(true)
  })

  it('does not provide default verification for informational tasks', () => {
    const result = classifyTaskIntent('what is git status')
    expect(result.kind).toBe('informational')
    expect(result.expectedVerification).toEqual([])
  })

  // ── Explicit acceptance criteria ───────────────────────────────────

  it('passes through explicit acceptance criteria', () => {
    const criteria = [{ id: 'c1', description: 'All tests pass' }]
    const result = classifyTaskIntent('fix it', {
      explicitAcceptanceCriteria: criteria,
    })
    expect(result.explicitAcceptanceCriteria).toEqual(criteria)
  })

  // ── Mutation keyword wins over analysis keyword ────────────────────

  it('mutation keyword wins over analysis keyword in same message', () => {
    // "fix" is mutation, "explain" is informational — mutation wins
    const result = classifyTaskIntent('fix the bug and explain the fix')
    expect(result.kind).toBe('mutation')
  })
})
