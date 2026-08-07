/**
 * BashTool — shell command execution with proper abort support
 *
 * Key change vs the previous promisified exec() approach:
 * We use exec() in callback form so we hold a reference to the ChildProcess.
 * When context.signal fires (Ctrl+C), we kill the entire process group
 * (SIGTERM → SIGKILL after 5 s)
 */

import { spawn } from 'child_process'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { BASH_DESCRIPTION } from '../prompts/tools.js'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { safeEnv } from '../core/envSafety.js'

const MAX_OUTPUT_LENGTH = 30_000
const DEFAULT_TIMEOUT_MS = 1_800_000
const MAX_TIMEOUT_MS = 14_400_000
const MIN_TIMEOUT_MS = 1_000

const SHELL =
  process.platform === 'win32'
    ? process.env.OVOGO_SHELL || process.env.ComSpec || 'cmd.exe'
    : process.env.OVOGO_SHELL || 'bash'

export interface BashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
  description?: string
  follow_mode?: boolean // Stream output to user's tmux pane for spectator view
}

function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output
  const half = Math.floor(maxLen / 2)
  const head = output.slice(0, half)
  const tail = output.slice(output.length - half)
  return `${head}\n\n[... ${output.length - maxLen} characters truncated ...]\n\n${tail}`
}

export class BashTool implements Tool {
  name = 'Bash'
  description = 'Execute shell commands'
  category = 'mutation' as const
  riskLevel = 'needs_approval' as const
  concurrencySafe = true
  planModeAllowed = false
  informationalAllowed = false

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Bash',
      description: BASH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description: `Timeout in MILLISECONDS. Default: ${DEFAULT_TIMEOUT_MS} (30 min). Max: ${MAX_TIMEOUT_MS} (4 h). Values below ${MIN_TIMEOUT_MS} are treated as unit mistakes and clamped to the default. For long-running commands, prefer run_in_background:true instead of raising timeout.`,
          },
          run_in_background: {
            type: 'boolean',
            description: 'Run command in background and return immediately',
          },
          description: {
            type: 'string',
            description: 'Brief description of what this command does (shown to user)',
          },
          follow_mode: {
            type: 'boolean',
            description:
              'If true, stream output to a tmux pane for real-time user viewing (spectator mode). The LLM still receives the full output after completion.',
          },
        },
        required: ['command'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { command, timeout, run_in_background, follow_mode } = input as unknown as BashInput

    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required and must be a string', isError: true }
    }

    const timeoutMs = Math.min(
      typeof timeout === 'number' && timeout >= MIN_TIMEOUT_MS ? timeout : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    // ── Background mode (fire-and-forget with auto log redirect) ─────────────
    if (run_in_background) {
      // Auto-redirect stdout/stderr to a session-scoped log file so output
      // is never lost even if the caller forgets to add `> file 2>&1`.
      const bgLogDir = context.sessionDir
        ? join(context.sessionDir, '.bg_logs')
        : join(context.cwd, '.bg_logs')
      try {
        mkdirSync(bgLogDir, { recursive: true })
      } catch {
        /* best-effort */
      }

      const ts = Date.now()
      const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
      const logFile = join(bgLogDir, `${ts}_${safeCmd}.log`)

      // Append redirect if the caller didn't already redirect
      const alreadyRedirected =
        command.includes('>') || command.includes('2>&1') || command.includes('/dev/null')
      const actualCommand = alreadyRedirected ? command : `${command} >> "${logFile}" 2>&1`

      const child = spawn(SHELL, ['-c', actualCommand], {
        detached: true,
        stdio: 'ignore',
        cwd: context.cwd,
        env: safeEnv(),
      })
      child.unref()

      const redirectInfo = alreadyRedirected ? '' : `\n输出自动重定向到: ${logFile}`
      return {
        content: `Command started in background (PID: ${child.pid})${redirectInfo}`,
        isError: false,
      }
    }

    // ── Foreground mode with abort support ──────────────────────
    // Use exec() callback form so we can kill the child on abort.
    // Kill by process group approach.
    return new Promise<ToolResult>((resolve) => {
      let settled = false

      // ── follow_mode: set up tmux spectator pane ───────────────
      let actualCommand = command
      let followCleanup: (() => void) | null = null
      let followModeHint = ''
      if (follow_mode) {
        const followLogDir = context.sessionDir
          ? join(context.sessionDir, '.bg_logs')
          : join(context.cwd, '.bg_logs')
        try {
          mkdirSync(followLogDir, { recursive: true })
        } catch {
          /* best-effort */
        }
        const ts = Date.now()
        const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
        const followLogFile = join(followLogDir, `${ts}_${safeCmd}_follow.log`)

        // Wrap command: tee duplicates output so the LLM captures it AND the follow log gets it.
        // pipefail preserves the command's exit code through the pipeline.
        actualCommand = `set -o pipefail; { ${command}; } 2>&1 | tee -a "${followLogFile}"`

        // Launch a tmux session with tail -f for user viewing
        const tmuxSessionName = `ovogo-follow-${ts}`
        let paneJoined = false
        // spawn() emits 'error' asynchronously when the binary is missing —
        // without a listener that crashes the process, so every fire-and-forget
        // tmux spawn gets a noop error handler.
        const tmuxSpawn = (args: string[], detached = false) => {
          const p = spawn('tmux', args, {
            cwd: context.cwd,
            ...(detached ? { detached: true } : {}),
          })
          p.on('error', () => undefined)
          return p
        }
        try {
          tmuxSpawn(['new-session', '-d', '-s', tmuxSessionName, '-x', '200', '-y', '50'], true)
          tmuxSpawn([
            'send-keys',
            '-t',
            tmuxSessionName,
            `tail -n +1 -f "${followLogFile}"`,
            'Enter',
          ])
          // Try to join the follow pane into the user's current tmux window
          try {
            const currentTmux = process.env.TMUX_PANE
              ? process.env.TMUX?.split(',')[0]?.replace(/^\//, '')
              : null
            if (currentTmux) {
              tmuxSpawn([
                'join-pane',
                '-t',
                `${currentTmux}`,
                '-s',
                `${tmuxSessionName}`,
                '-l',
                '15',
              ])
              paneJoined = true
            }
          } catch {
            /* best-effort: user can manually attach */
          }

          followModeHint = paneJoined
            ? '[观战面板已嵌入当前 tmux 窗口底部]'
            : `[观战面板: tmux attach -t ${tmuxSessionName}]`

          followCleanup = () => {
            try {
              tmuxSpawn(['kill-session', '-t', tmuxSessionName], true)
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* tmux not available, degrade gracefully */
        }
      }

      // spawn (not exec): on POSIX we detach into a new process group so
      // abort/timeout can signal the WHOLE tree via kill(-pid). With exec the
      // child shared our group — kill(-pid) threw ESRCH and only the shell
      // died, leaving grandchildren (npm/node/build workers) orphaned.
      const isWin = process.platform === 'win32'
      const child = spawn(
        SHELL,
        isWin ? ['/d', '/s', '/c', actualCommand] : ['-c', actualCommand],
        {
          cwd: context.cwd,
          env: { ...safeEnv(), TERM: 'dumb' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !isWin,
        },
      )

      const MAX_STREAM_CHARS = 50 * 1024 * 1024
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (text: string) => {
        if (stdout.length < MAX_STREAM_CHARS)
          stdout += text.slice(0, MAX_STREAM_CHARS - stdout.length)
      })
      child.stderr?.on('data', (text: string) => {
        if (stderr.length < MAX_STREAM_CHARS)
          stderr += text.slice(0, MAX_STREAM_CHARS - stderr.length)
      })

      const killTree = (signal: NodeJS.Signals) => {
        if (isWin) {
          try {
            child.kill(signal)
          } catch {
            /* already gone */
          }
          return
        }
        const pid = child.pid
        if (pid === undefined) return
        try {
          process.kill(-pid, signal)
        } catch {
          try {
            child.kill(signal)
          } catch {
            /* already gone */
          }
        }
      }
      const escalateToSigkill = () => {
        const t = setTimeout(() => killTree('SIGKILL'), 5_000)
        if (typeof t.unref === 'function') t.unref()
      }

      let timedOut = false
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        killTree('SIGTERM')
        escalateToSigkill()
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timeoutTimer)
        if (context.signal) context.signal.removeEventListener('abort', onAbort)
        if (followCleanup) followCleanup()
      }

      child.on('error', (err) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ content: `Failed to start command: ${err.message}`, isError: true })
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        cleanup()

        if (context.signal?.aborted) {
          resolve({ content: 'Command cancelled.', isError: true })
          return
        }
        if (timedOut) {
          resolve({ content: `Command timed out after ${timeoutMs / 1000}s`, isError: true })
          return
        }

        const prefix = follow_mode
          ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n`
          : ''
        if (code === 0) {
          const combined = [stdout, stderr].filter(Boolean).join('\n').trimEnd()
          resolve({
            content: truncateOutput(prefix + combined, MAX_OUTPUT_LENGTH) || '(no output)',
            isError: false,
            exitCode: 0,
            stdout,
            stderr,
          })
          return
        }

        // Non-zero exit — provide stdout+stderr so the LLM can diagnose
        const exitCode = code ?? 1
        const out = [stdout, stderr].filter(Boolean).join('\n').trimEnd()
        resolve({
          content: truncateOutput(
            prefix + `Exit code: ${exitCode}\n${out}`,
            MAX_OUTPUT_LENGTH,
          ).trimEnd(),
          isError: false, // non-zero exit is not necessarily fatal
          exitCode,
          stdout,
          stderr,
        })
      })

      // ── Abort handler — kill entire process group ────────────
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        killTree('SIGTERM')
        escalateToSigkill()
        resolve({ content: 'Command cancelled.', isError: true })
      }

      if (context.signal) {
        if (context.signal.aborted) {
          onAbort()
        } else {
          context.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })
  }
}
