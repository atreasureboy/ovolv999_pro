/**
 * Permission System — 7-mode cycling + rule engine
 *
 * Modes:
 *   default          — ask for dangerous, allow safe
 *   acceptEdits      — auto-approve file edits, still gate Bash
 *   plan             — read-only (no writes/edits/bash)
 *   auto             — auto-approve everything except dangerous
 *   bypassPermissions — approve everything (even dangerous)
 *   dontAsk          — same as bypass, but suppresses all prompts
 *   bubble           — sandbox mode
 *
 * Permission Rules:
 *   "Bash(npm *)"    → allow all npm commands
 *   "Bash(git *)"    → allow all git commands
 *   "Read(src/**)"   → allow reading from src/
 *   "Edit(*.ts)"     → allow editing TypeScript files
 *
 * Shift+Tab cycling:
 *   default → acceptEdits → plan → auto → bypassPermissions → default
 */

import { str } from './strings.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'bubble'
  | 'ask'
  | 'deny'

export type PermissionProfile = 'safe' | 'standard' | 'autonomous'

const PROFILE_MODES: Record<PermissionProfile, PermissionMode> = {
  safe: 'default',
  standard: 'acceptEdits',
  autonomous: 'auto',
}

export function resolvePermissionMode(
  profile?: PermissionProfile,
  legacyMode?: PermissionMode,
): PermissionMode {
  if (profile) return PROFILE_MODES[profile]
  return legacyMode ?? PROFILE_MODES.standard
}

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  tool?: string
  pattern?: string
  action: PermissionBehavior
}

export interface PermissionCheckInput {
  tool: string
  input: Record<string, unknown>
}

export interface PermissionRequest {
  tool: string
  fingerprint: string
  matchedRule?: PermissionRule
}

export type Approver = (req: PermissionRequest) => Promise<boolean>

export interface PermissionConfig {
  mode: PermissionMode
  rules: PermissionRule[]
}

export interface PermissionDecision {
  allowed: boolean
  reason: string
}

// ── Mode Cycling (Shift+Tab) ────────────────────────────────────────────────

const CYCLE_ORDER: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'bubble',
  'ask',
  'deny',
]

export function getNextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = CYCLE_ORDER.indexOf(current)
  if (idx === -1) return 'default'
  return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length]
}

export function isValidPermissionMode(value: string): value is PermissionMode {
  return CYCLE_ORDER.includes(value as PermissionMode)
}

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'Default'
    case 'acceptEdits':
      return 'Accept Edits'
    case 'plan':
      return 'Plan Mode'
    case 'auto':
      return 'Auto'
    case 'bypassPermissions':
      return 'Bypass'
    case 'dontAsk':
      return "Don't Ask"
    case 'bubble':
      return 'Bubble (Sandbox)'
    case 'ask':
      return 'Ask'
    case 'deny':
      return 'Deny'
  }
}

export function permissionModeSymbol(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return ''
    case 'acceptEdits':
      return '>>'
    case 'plan':
      return '||'
    case 'auto':
      return '>>>'
    case 'bypassPermissions':
      return '>>>>'
    case 'dontAsk':
      return '?!'
    case 'bubble':
      return '[][]'
    case 'ask':
      return '>'
    case 'deny':
      return 'X'
  }
}

export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'Ask for dangerous commands, allow safe ones'
    case 'acceptEdits':
      return 'Auto-approve file edits, still gate shell commands'
    case 'plan':
      return 'Read-only analysis (no writes/edits/bash)'
    case 'auto':
      return 'Auto-approve everything except dangerous commands'
    case 'bypassPermissions':
      return 'Approve everything (use with caution)'
    case 'dontAsk':
      return 'No prompts: trust the model + hooks only'
    case 'bubble':
      return 'Shell commands run in OS-level sandbox'
    case 'ask':
      return 'Ask for all tool calls'
    case 'deny':
      return 'Deny all tool calls'
  }
}

export function isSandboxMode(mode: PermissionMode): boolean {
  return mode === 'bubble'
}

export function isBypassMode(mode: PermissionMode): boolean {
  return mode === 'bypassPermissions' || mode === 'dontAsk'
}

// ── Mode → behavior resolution ──────────────────────────────────────────────

export function getModeBehavior(
  mode: PermissionMode,
  toolName: string,
  isDangerous: boolean,
): PermissionBehavior {
  // Legacy aliases
  if (mode === 'ask') return 'ask'
  if (mode === 'deny') return 'deny'

  if (mode === 'bypassPermissions' || mode === 'dontAsk') return 'allow'

  if (mode === 'plan') {
    const readOnly = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']
    return readOnly.includes(toolName) ? 'allow' : 'deny'
  }

  if (mode === 'auto') {
    return isDangerous ? 'ask' : 'allow'
  }

  if (mode === 'acceptEdits') {
    const editTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep']
    if (editTools.includes(toolName)) return 'allow'
    // Documented contract: "auto-approve file edits, still gate shell commands"
    if (toolName === 'Bash') return 'ask'
    return isDangerous ? 'ask' : 'allow'
  }

  if (isDangerous) return 'ask'
  return 'allow'
}

// ── Rule Engine ─────────────────────────────────────────────────────────────

export function matchRule(ruleContent: string, command: string): boolean {
  if (ruleContent.endsWith(':*')) {
    const prefix = ruleContent.slice(0, -2)
    return command.startsWith(prefix)
  }

  if (ruleContent.includes('*')) {
    const regexStr = ruleContent.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    let finalRegex = regexStr
    const unescapedStarCount = (ruleContent.match(/\*/g) || []).length
    if (finalRegex.endsWith(' .*') && unescapedStarCount === 1) {
      finalRegex = finalRegex.slice(0, -3) + '( .*)?'
    }
    try {
      return new RegExp('^' + finalRegex + '$', 's').test(command)
    } catch {
      return false
    }
  }

  return command === ruleContent
}

// ── Fingerprinting ──────────────────────────────────────────────────────────

export function fingerprint(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
      return str(input.command)
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Read':
      return str(
        input.file_path ??
          input.path ??
          input.file ??
          input.filename ??
          input.target_file ??
          input.target,
      )
    case 'Glob':
      return str(input.pattern)
    case 'Grep':
      return str(input.pattern)
    case 'Agent':
      return str(input.description)
    default:
      return Object.values(input)
        .map((v) => str(v))
        .join(' ')
        .slice(0, 200)
  }
}

// ── Default Rules ───────────────────────────────────────────────────────────

export const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  { tool: 'Bash', pattern: 'rm -rf', action: 'ask' },
  { tool: 'Bash', pattern: 'rm -fr', action: 'ask' },
  { tool: 'Bash', pattern: 'mkfs', action: 'ask' },
  { tool: 'Bash', pattern: 'dd if=', action: 'ask' },
  { tool: 'Bash', pattern: ' > /dev/sd', action: 'ask' },
  { tool: 'Bash', pattern: 'sudo ', action: 'ask' },
  { tool: 'Bash', pattern: 'chmod 777', action: 'ask' },
  { tool: 'Bash', pattern: 'chown ', action: 'ask' },
  { tool: 'Bash', pattern: 'curl ', action: 'ask' },
  { tool: 'Bash', pattern: 'wget ', action: 'ask' },
  { tool: 'Bash', pattern: 'git push --force', action: 'ask' },
  { tool: 'Bash', pattern: 'git push -f', action: 'ask' },
  { tool: 'Bash', pattern: 'git commit --amend', action: 'ask' },
]

// ── PermissionChecker ───────────────────────────────────────────────────────

export class PermissionChecker {
  private mode: PermissionMode
  private readonly rules: PermissionRule[]
  private readonly approver?: Approver

  constructor(mode: PermissionMode, rules: PermissionRule[] = [], approver?: Approver) {
    this.mode = mode
    this.rules = [...rules, ...DEFAULT_PERMISSION_RULES]
    this.approver = approver
  }

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  cycleMode(): PermissionMode {
    this.mode = getNextPermissionMode(this.mode)
    return this.mode
  }

  formatMode(): string {
    return permissionModeLabel(this.mode)
  }

  private matchRule(tool: string, fp: string): PermissionRule | undefined {
    for (const rule of this.rules) {
      if (rule.tool && rule.tool !== '*' && rule.tool !== tool) continue
      if (rule.pattern) {
        if (matchRule(rule.pattern, fp)) return rule
      } else {
        return rule
      }
    }
    return undefined
  }

  async check(input: PermissionCheckInput): Promise<PermissionDecision> {
    const fp = fingerprint(input.tool, input.input)
    const matched = this.matchRule(input.tool, fp)
    const isDangerous = input.tool === 'Bash' && this.isDangerousCommand(str(input.input.command))

    const action = matched?.action ?? getModeBehavior(this.mode, input.tool, isDangerous)

    if (action === 'allow') {
      return { allowed: true, reason: 'allowed' }
    }
    if (action === 'deny') {
      return { allowed: false, reason: `denied by ${matched ? 'rule' : 'mode'} (${this.mode})` }
    }

    if (this.approver) {
      try {
        const approved = await this.approver({
          tool: input.tool,
          fingerprint: fp,
          matchedRule: matched,
        })
        return { allowed: approved, reason: approved ? 'approved by user' : 'denied by user' }
      } catch {
        return { allowed: false, reason: 'denied_by_approver_error' }
      }
    }

    return { allowed: false, reason: 'requires_approval (no approver wired)' }
  }

  private isDangerousCommand(cmd: string): boolean {
    const dangerous = [
      'rm -rf',
      'rm -fr',
      'sudo ',
      'chmod 777',
      'git push --force',
      'git push -f',
      'mkfs',
      'dd if=',
      '> /dev/sd',
      'chown ',
      'curl ',
      'wget ',
      'git commit --amend',
    ]
    const normalized = cmd.replace(/\s+/g, ' ').trim()
    return dangerous.some((d) => normalized.includes(d))
  }
}
