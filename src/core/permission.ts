/**
 * Permission Gate — approval/deny rules for tool execution.
 *
 * Why this exists: `permissionMode` was a declared-but-unimplemented enum. Tools
 * that touch the real system (Bash, Write, Edit) need a security boundary so a
 * base consumer can decide what runs unattended vs. what must be approved.
 *
 * Model:
 *   - A rule set is consulted in order; first match wins.
 *   - Each rule targets a tool (+ optional pattern over an input "fingerprint").
 *   - Rule action ∈ allow | deny | ask. `ask` defers to an injected approver.
 *   - A coarse mode governs the default action when no rule matches:
 *       auto — allow by default (autonomous), unless a rule says ask/deny
 *       ask  — prompt by default, unless a rule says allow/deny
 *       deny — block by default, unless a rule explicitly allows
 *
 * The approver is injected (DI) so the checker stays UI-agnostic: the CLI wires
 * a yes/no readline prompt; tests/CI wire an auto-resolver; sub-agents inherit
 * the parent's approver or fall back to a safe deny.
 *
 * Fingerprinting: rather than exposing raw input JSON to patterns (fragile), we
 * derive a human-readable fingerprint per tool — e.g. the Bash command string,
 * or the file path for Write/Edit. Patterns are matched as substring tests,
 * which is robust and easy to author.
 */

import type { ToolContext } from './types.js'
import { str } from './strings.js'

export type PermissionMode = 'auto' | 'ask' | 'deny'
export type PermissionAction = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  /** Tool name to match. Omit / "*" matches every tool. */
  tool?: string
  /**
   * Substring matched against the tool's fingerprint (the Bash command, or the
   * file path for Write/Edit, etc.). Omit to match any input for this tool.
   */
  pattern?: string
  action: PermissionAction
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

/**
 * A sensible default deny-ish rule set: operations that are commonly destructive
 * or hard to reverse are escalated to `ask` even in autonomous mode. Consumers
 * extend/override this in their config.
 */
export const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  // Filesystem destruction
  { tool: 'Bash', pattern: 'rm -rf', action: 'ask' },
  { tool: 'Bash', pattern: 'rm -fr', action: 'ask' },
  { tool: 'Bash', pattern: 'mkfs', action: 'ask' },
  { tool: 'Bash', pattern: 'dd if=', action: 'ask' },
  { tool: 'Bash', pattern: ' > /dev/sd', action: 'ask' },
  // Privilege escalation
  { tool: 'Bash', pattern: 'sudo ', action: 'ask' },
  { tool: 'Bash', pattern: 'chmod 777', action: 'ask' },
  { tool: 'Bash', pattern: 'chown ', action: 'ask' },
  // Remote code execution / piping to shell
  { tool: 'Bash', pattern: 'curl ', action: 'ask' },
  { tool: 'Bash', pattern: 'wget ', action: 'ask' },
  // Force-push / history rewrite
  { tool: 'Bash', pattern: 'git push --force', action: 'ask' },
  { tool: 'Bash', pattern: 'git push -f', action: 'ask' },
  { tool: 'Bash', pattern: 'git commit --amend', action: 'ask' },
]

/**
 * Derive a short, human-readable fingerprint of a tool invocation for pattern
 * matching and approval prompts.
 */
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
      // Best-effort: flatten values
      return Object.values(input)
        .map((v) => str(v))
        .join(' ')
        .slice(0, 200)
  }
}

export class PermissionChecker {
  private readonly mode: PermissionMode
  private readonly rules: PermissionRule[]
  private readonly approver?: Approver

  constructor(mode: PermissionMode, rules: PermissionRule[] = [], approver?: Approver) {
    this.mode = mode
    // Consumer rules take priority over defaults; defaults fill the gaps.
    this.rules = [...rules, ...DEFAULT_PERMISSION_RULES]
    this.approver = approver
  }

  /** Decide whether a tool call may proceed. Never throws. */
  async check(input: PermissionCheckInput): Promise<PermissionDecision> {
    const fp = fingerprint(input.tool, input.input)

    const matched = this.matchRule(input.tool, fp)
    const action = this.resolveAction(matched?.action)

    if (action === 'allow') {
      return { allowed: true, reason: 'allowed' }
    }
    if (action === 'deny') {
      return { allowed: false, reason: `denied by ${matched ? 'rule' : 'mode'} (${this.mode})` }
    }

    // action === 'ask'
    if (!this.approver) {
      // No approver wired (headless / sub-agent): fail safe → deny.
      return { allowed: false, reason: 'approval required but no approver available' }
    }
    let approved: boolean
    try {
      approved = await this.approver({ tool: input.tool, fingerprint: fp, matchedRule: matched })
    } catch {
      approved = false
    }
    return approved
      ? { allowed: true, reason: 'approved by user' }
      : { allowed: false, reason: 'denied by user' }
  }

  private matchRule(tool: string, fp: string): PermissionRule | undefined {
    return this.rules.find((r) => {
      if (r.tool && r.tool !== '*' && r.tool !== tool) return false
      if (r.pattern && !fp.includes(r.pattern)) return false
      return true
    })
  }

  private resolveAction(ruleAction?: PermissionAction): PermissionAction {
    if (ruleAction) return ruleAction
    switch (this.mode) {
      case 'deny':
        return 'deny'
      case 'ask':
        return 'ask'
      case 'auto':
      default:
        return 'allow'
    }
  }
}

/**
 * Build a default PermissionChecker from a ToolContext's permissionMode.
 * Useful when a tool wants to self-gate without a full engine-configured checker.
 */
export function checkerFromContext(
  ctx: ToolContext,
  rules?: PermissionRule[],
  approver?: Approver,
): PermissionChecker {
  return new PermissionChecker(ctx.permissionMode, rules, approver)
}
