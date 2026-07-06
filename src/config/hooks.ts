/**
 * HookRunner — executes configured shell hooks around tool calls
 *
 * Implements IHookRunner from core/types so the engine stays decoupled
 * from the config layer.
 *
 * All hooks are best-effort: failures are silently ignored so they never
 * interrupt the agent loop.
 */

import { execSync } from 'child_process'
import type { HooksConfig, HookEntry } from './settings.js'
import type { IHookRunner, TurnResult } from '../core/types.js'

function matchesHook(entry: HookEntry, toolName: string): boolean {
  if (!entry.matcher) return true
  const patterns = entry.matcher.split(',').map((s) => s.trim())
  return patterns.some((p) => {
    if (p === '*') return true
    if (p.endsWith('*')) return toolName.startsWith(p.slice(0, -1))
    return toolName === p
  })
}

function runCommand(command: string, env: Record<string, string>): void {
  try {
    execSync(command, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10_000,
      stdio: 'ignore',
    })
  } catch {
    // best-effort — hook failures never crash the engine
  }
}

export class HookRunner implements IHookRunner {
  constructor(private hooks: HooksConfig) {}

  runPreToolCall(toolName: string, input: Record<string, unknown>): void {
    for (const entry of this.hooks.PreToolCall ?? []) {
      if (matchesHook(entry, toolName)) {
        runCommand(entry.command, {
          OVOGO_TOOL_NAME: toolName,
          OVOGO_TOOL_INPUT: JSON.stringify(input).slice(0, 4096),
        })
      }
    }
  }

  runPostToolCall(toolName: string, result: string, isError: boolean): void {
    for (const entry of this.hooks.PostToolCall ?? []) {
      if (matchesHook(entry, toolName)) {
        runCommand(entry.command, {
          OVOGO_TOOL_NAME: toolName,
          OVOGO_TOOL_RESULT: result.slice(0, 4096),
          OVOGO_TOOL_IS_ERROR: String(isError),
        })
      }
    }
  }

  runUserPromptSubmit(prompt: string): void {
    for (const entry of this.hooks.UserPromptSubmit ?? []) {
      runCommand(entry.command, {
        OVOGO_PROMPT: prompt.slice(0, 4096),
      })
    }
  }

  runOnError(error: Error, context: { turnNumber: number; lastToolName?: string }): void {
    for (const entry of this.hooks.OnError ?? []) {
      runCommand(entry.command, {
        OVOGO_ERROR_MESSAGE: error.message.slice(0, 4096),
        OVOGO_TURN_NUMBER: String(context.turnNumber),
        OVOGO_LAST_TOOL: context.lastToolName ?? '',
      })
    }
  }

  runOnComplete(result: TurnResult): void {
    for (const entry of this.hooks.OnComplete ?? []) {
      runCommand(entry.command, {
        OVOGO_RUN_REASON: result.reason,
        OVOGO_RUN_OUTPUT: result.output.slice(0, 4096),
      })
    }
  }

  runOnContextOverflow(tokensBefore: number, tokensAfter: number): void {
    for (const entry of this.hooks.OnContextOverflow ?? []) {
      runCommand(entry.command, {
        OVOGO_TOKENS_BEFORE: String(tokensBefore),
        OVOGO_TOKENS_AFTER: String(tokensAfter),
      })
    }
  }
}

/** A no-op runner used when no hooks are configured */
export class NoopHookRunner implements IHookRunner {
  runPreToolCall(): void {}
  runPostToolCall(): void {}
  runUserPromptSubmit(): void {}
  runOnError(): void {}
  runOnComplete(): void {}
  runOnContextOverflow(): void {}
}
