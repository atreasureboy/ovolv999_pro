import { describe, it, expect } from 'vitest'
import { classifyCommandRisk, type RiskLevel } from '../src/core/riskClassifier.js'

describe('classifyCommandRisk', () => {
  // ── Safe commands ──────────────────────────────────────────────────

  it('classifies basic safe commands', () => {
    expect(classifyCommandRisk('ls')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('cat file.txt')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('echo hello')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('pwd')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('whoami')).toBe('safe' satisfies RiskLevel)
  })

  it('classifies safe dev tool commands', () => {
    expect(classifyCommandRisk('npx tsc --noEmit')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('npx vitest run')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('npm test')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('node script.js')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('python3 main.py')).toBe('safe' satisfies RiskLevel)
  })

  it('classifies safe git subcommands', () => {
    expect(classifyCommandRisk('git status')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('git log')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('git diff')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('git branch')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('git remote -v')).toBe('safe' satisfies RiskLevel)
  })

  // ── Dangerous commands ─────────────────────────────────────────────

  it('classifies rm -rf as dangerous', () => {
    expect(classifyCommandRisk('rm -rf /tmp/foo')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('rm -r /tmp/foo')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('rm --recursive /tmp/foo')).toBe('dangerous' satisfies RiskLevel)
  })

  it('classifies rm with --no-preserve-root as dangerous', () => {
    expect(classifyCommandRisk('rm -rf --no-preserve-root /')).toBe('dangerous' satisfies RiskLevel)
  })

  it('classifies sudo and su as dangerous', () => {
    expect(classifyCommandRisk('sudo rm file')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('su -c "ls"')).toBe('dangerous' satisfies RiskLevel)
  })

  it('classifies destructive git commands as dangerous', () => {
    expect(classifyCommandRisk('git push --force main')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('git reset --hard')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('git clean -fd')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('git branch -D feature')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('git stash drop')).toBe('dangerous' satisfies RiskLevel)
  })

  it('classifies system shutdown commands as dangerous', () => {
    expect(classifyCommandRisk('shutdown -h now')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('reboot')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('halt')).toBe('dangerous' satisfies RiskLevel)
  })

  it('classifies SQL DROP/TRUNCATE as dangerous', () => {
    expect(classifyCommandRisk('DROP TABLE users')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('TRUNCATE TABLE logs')).toBe('dangerous' satisfies RiskLevel)
    expect(classifyCommandRisk('DROP DATABASE production')).toBe('dangerous' satisfies RiskLevel)
  })

  it('classifies DELETE FROM without WHERE as dangerous', () => {
    expect(classifyCommandRisk('DELETE FROM users')).toBe('dangerous' satisfies RiskLevel)
  })

  it('classifies fork bomb as dangerous', () => {
    expect(classifyCommandRisk(':(){ :|:& };:')).toBe('dangerous' satisfies RiskLevel)
  })

  // ── Needs approval ─────────────────────────────────────────────────

  it('classifies unknown commands as needs_approval', () => {
    expect(classifyCommandRisk('some-unknown-command arg1 arg2')).toBe(
      'needs_approval' satisfies RiskLevel,
    )
  })

  it('classifies commands with command substitution as needs_approval', () => {
    expect(classifyCommandRisk('echo $(ls)')).toBe('needs_approval' satisfies RiskLevel)
  })

  it('classifies commands with semicolons as needs_approval', () => {
    expect(classifyCommandRisk('ls; rm -f file')).toBe('needs_approval' satisfies RiskLevel)
  })

  it('classifies git checkout . as dangerous', () => {
    expect(classifyCommandRisk('git checkout .')).toBe('dangerous' satisfies RiskLevel)
  })

  // ── Edge cases ─────────────────────────────────────────────────────

  it('classifies empty command as needs_approval', () => {
    expect(classifyCommandRisk('')).toBe('needs_approval' satisfies RiskLevel)
    expect(classifyCommandRisk('   ')).toBe('needs_approval' satisfies RiskLevel)
  })

  it('handles multiline commands', () => {
    const cmd = 'echo hello\necho world'
    expect(classifyCommandRisk(cmd)).toBe('safe' satisfies RiskLevel)
  })

  it('handles multiline with one dangerous line', () => {
    const cmd = 'echo hello\nrm -rf /tmp\nls'
    expect(classifyCommandRisk(cmd)).toBe('dangerous' satisfies RiskLevel)
  })

  it('handles chained safe commands', () => {
    expect(classifyCommandRisk('ls -la && cat file.txt')).toBe('safe' satisfies RiskLevel)
  })

  it('handles environment variable assignments', () => {
    expect(classifyCommandRisk('DEBUG=true npm test')).toBe('safe' satisfies RiskLevel)
    expect(classifyCommandRisk('NODE_ENV=production ls')).toBe('safe' satisfies RiskLevel)
  })

  it('handles kubectl delete as dangerous', () => {
    expect(classifyCommandRisk('kubectl delete pod my-pod')).toBe('dangerous' satisfies RiskLevel)
  })

  it('handles terraform destroy as dangerous', () => {
    expect(classifyCommandRisk('terraform destroy')).toBe('dangerous' satisfies RiskLevel)
  })

  it('handles chmod 777 on root as dangerous', () => {
    expect(classifyCommandRisk('chmod -R 777 /etc')).toBe('dangerous' satisfies RiskLevel)
  })

  it('handles chown -R on root as dangerous', () => {
    expect(classifyCommandRisk('chown -R user /var')).toBe('dangerous' satisfies RiskLevel)
  })

  it('handles dd writing to /dev as dangerous', () => {
    expect(classifyCommandRisk('dd if=/dev/zero of=/dev/sda')).toBe('dangerous' satisfies RiskLevel)
  })

  it('handles redirection to /dev as dangerous', () => {
    expect(classifyCommandRisk('echo > /dev/sda')).toBe('dangerous' satisfies RiskLevel)
  })

  // ── Regular rm without -r is needs_approval ────────────────────────

  it('classifies regular rm (no -r flag) as needs_approval', () => {
    expect(classifyCommandRisk('rm file.txt')).toBe('needs_approval' satisfies RiskLevel)
  })
})
