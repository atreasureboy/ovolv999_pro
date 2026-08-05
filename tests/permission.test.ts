import { describe, it, expect } from 'vitest'
import {
  PermissionChecker,
  fingerprint,
  DEFAULT_PERMISSION_RULES,
  getModeBehavior,
  getNextPermissionMode,
  matchRule,
  type Approver,
} from '../src/core/permission.js'

describe('fingerprint', () => {
  it('extracts the Bash command', () => {
    expect(fingerprint('Bash', { command: 'ls -la' })).toBe('ls -la')
  })

  it('extracts file paths for filesystem tools with fallback field names', () => {
    expect(fingerprint('Write', { file_path: '/tmp/a.txt' })).toBe('/tmp/a.txt')
    expect(fingerprint('Edit', { file_path: '/tmp/b.ts' })).toBe('/tmp/b.ts')
    expect(fingerprint('Read', { file_path: '/tmp/c.md' })).toBe('/tmp/c.md')
    expect(fingerprint('Read', { path: '/tmp/d.json' })).toBe('/tmp/d.json')
    expect(fingerprint('Write', { file: '/tmp/e.py' })).toBe('/tmp/e.py')
    expect(fingerprint('Edit', { target_file: '/tmp/f.go' })).toBe('/tmp/f.go')
  })

  it('extracts patterns for search tools', () => {
    expect(fingerprint('Grep', { pattern: 'foo' })).toBe('foo')
    expect(fingerprint('Glob', { pattern: '*.ts' })).toBe('*.ts')
  })

  it('does not stringify objects as [object Object]', () => {
    // An object value should fall back to '' (default), not '[object Object]'.
    expect(fingerprint('Bash', { command: { nested: true } })).toBe('')
  })
})

describe('PermissionChecker — modes', () => {
  it('auto mode allows by default when no rule matches', async () => {
    const checker = new PermissionChecker('auto')
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(d.allowed).toBe(true)
  })

  it('deny mode blocks by default when no rule matches', async () => {
    const checker = new PermissionChecker('deny')
    const d = await checker.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(d.allowed).toBe(false)
  })

  it('ask mode prompts via the approver when no rule matches', async () => {
    let asked = false
    const approver: Approver = () => { asked = true; return Promise.resolve(true) }
    const checker = new PermissionChecker('ask', [], approver)
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(asked).toBe(true)
    expect(d.allowed).toBe(true)
  })
})

describe('PermissionChecker — rules', () => {
  it('default rule escalates rm -rf to ask even in auto mode', async () => {
    let asked = false
    const approver: Approver = () => { asked = true; return Promise.resolve(false) }
    const checker = new PermissionChecker('auto', [], approver)
    const d = await checker.check({ tool: 'Bash', input: { command: 'rm -rf /tmp/x' } })
    expect(asked).toBe(true)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('user')
  })

  it('a consumer allow rule overrides deny mode', async () => {
    const checker = new PermissionChecker('deny', [
      { tool: 'Read', action: 'allow' },
    ])
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(d.allowed).toBe(true)
  })

  it('fails safe (deny) when ask is required but no approver is wired', async () => {
    const checker = new PermissionChecker('auto') // no approver
    const d = await checker.check({ tool: 'Bash', input: { command: 'sudo rm -rf /' } })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('no approver')
  })

  it('approver rejection yields a denied decision', async () => {
    const approver: Approver = () => Promise.resolve(false)
    const checker = new PermissionChecker('ask', [], approver)
    const d = await checker.check({ tool: 'Write', input: { file_path: '/a' } })
    expect(d.allowed).toBe(false)
  })

  it('first matching rule wins (consumer rule before default)', async () => {
    // Consumer explicitly allows curl; the default rule would escalate to ask.
    const approver: Approver = () => Promise.resolve(true)
    const checker = new PermissionChecker('auto', [
      { tool: 'Bash', pattern: 'curl ', action: 'allow' },
    ], approver)
    const d = await checker.check({ tool: 'Bash', input: { command: 'curl http://x' } })
    expect(d.allowed).toBe(true)
  })

  it('a thrown approver error is caught and treated as deny', async () => {
    const approver: Approver = () => Promise.reject(new Error('boom'))
    const checker = new PermissionChecker('ask', [], approver)
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(d.allowed).toBe(false)
  })

  it('default rules include common destructive patterns', () => {
    const patterns = DEFAULT_PERMISSION_RULES.map(r => r.pattern)
    expect(patterns).toContain('rm -rf')
    expect(patterns).toContain('sudo ')
    expect(patterns).toContain('git push --force')
  })
})

describe('matchRule', () => {
  it('matches exact string', () => {
    expect(matchRule('rm -rf', 'rm -rf')).toBe(true)
    expect(matchRule('rm -rf', 'echo hello')).toBe(false)
  })

  it('matches wildcard suffix :*', () => {
    expect(matchRule('npm :*', 'npm install')).toBe(true)
    expect(matchRule('npm :*', 'npm test')).toBe(true)
    expect(matchRule('npm :*', 'npx test')).toBe(false)
  })

  it('matches glob patterns', () => {
    expect(matchRule('src/*.ts', 'src/file.ts')).toBe(true)
    expect(matchRule('src/*.ts', 'src/file.js')).toBe(false)
  })
})

describe('getModeBehavior', () => {
  it('plan mode denies non-read tools', () => {
    expect(getModeBehavior('plan', 'Read', false)).toBe('allow')
    expect(getModeBehavior('plan', 'Bash', false)).toBe('deny')
    expect(getModeBehavior('plan', 'Write', false)).toBe('deny')
  })

  it('auto mode allows safe, asks for dangerous', () => {
    expect(getModeBehavior('auto', 'Read', false)).toBe('allow')
    expect(getModeBehavior('auto', 'Bash', true)).toBe('ask')
  })

  it('acceptEdits allows edit tools', () => {
    expect(getModeBehavior('acceptEdits', 'Edit', false)).toBe('allow')
    expect(getModeBehavior('acceptEdits', 'Write', false)).toBe('allow')
    expect(getModeBehavior('acceptEdits', 'Bash', true)).toBe('ask')
  })

  it('bypassPermissions allows everything', () => {
    expect(getModeBehavior('bypassPermissions', 'Bash', true)).toBe('allow')
  })

  it('dontAsk allows everything', () => {
    expect(getModeBehavior('dontAsk', 'Bash', true)).toBe('allow')
  })

  it('ask mode always asks', () => {
    expect(getModeBehavior('ask', 'Read', false)).toBe('ask')
  })

  it('deny mode always denies', () => {
    expect(getModeBehavior('deny', 'Read', false)).toBe('deny')
  })
})

describe('getNextPermissionMode', () => {
  it('cycles through all modes', () => {
    expect(getNextPermissionMode('default')).toBe('acceptEdits')
    expect(getNextPermissionMode('ask')).toBe('deny')
    expect(getNextPermissionMode('deny')).toBe('default')
  })

  it('returns default for unknown mode', () => {
    expect(getNextPermissionMode('unknown' as never)).toBe('default')
  })
})
