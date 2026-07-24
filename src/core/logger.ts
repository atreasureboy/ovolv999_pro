/**
 * Logger — unified leveled logging for the agent base.
 *
 * Replaces the fragmented mix of console / renderer / eventLog for system-level
 * diagnostics. Three independent sinks, any of which may be omitted:
 *   - stderr stream (human-visible, never pollutes tool stdout)
 *   - EventLog (persistent audit trail)
 *   - debug buffer (captured for crash reports / tests)
 *
 * Design notes:
 *   - NEVER writes to stdout — tool output parsing and piped usage depend on a
 *     clean stdout. All human logs go to stderr.
 *   - Levels are filtered by LOG_LEVEL env (debug|info|warn|error), default info.
 *   - Best-effort: a logging failure must never break the engine.
 */

import type { EventLog } from './eventLog.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: '\x1b[2m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}
const RESET = '\x1b[0m'

function envLevel(): number {
  const raw = (process.env.OVOGO_LOG_LEVEL ?? 'info').toLowerCase()
  return LEVEL_ORDER[raw as LogLevel] ?? LEVEL_ORDER.info
}

export interface LoggerOptions {
  /** Component label shown in every line (e.g. "engine", "mcp"). */
  component?: string
  /** Persistent audit sink — best-effort. */
  eventLog?: EventLog
  /** Override the stderr writer (tests). Defaults to process.stderr. */
  sink?: (s: string) => void
  /** Override minimum level (tests). Defaults to OVOGO_LOG_LEVEL env. */
  minLevel?: LogLevel
}

export class Logger {
  private readonly component: string
  private readonly eventLog?: EventLog
  private readonly sink: (s: string) => void
  private readonly minLevel: number
  private readonly debugBuffer: string[] = []
  private readonly maxBuffer = 500

  constructor(opts: LoggerOptions = {}) {
    this.component = opts.component ?? 'agent'
    this.eventLog = opts.eventLog
    this.sink = opts.sink ?? ((s: string) => process.stderr.write(s))
    this.minLevel = opts.minLevel ? LEVEL_ORDER[opts.minLevel] : envLevel()
  }

  private emit(level: LogLevel, msg: string, detail?: Record<string, unknown>): void {
    const ts = new Date().toISOString()
    const line = `${ts} [${this.component}] ${level.toUpperCase()}: ${msg}`
    const styled = `${LEVEL_STYLE[level]}${line}${RESET}\n`

    // Debug buffer (ring) — captured for crash reports regardless of level
    this.debugBuffer.push(line)
    if (this.debugBuffer.length > this.maxBuffer) this.debugBuffer.shift()

    if (LEVEL_ORDER[level] < this.minLevel) return
    try {
      this.sink(styled)
    } catch {
      /* never break on log failure */
    }

    if (this.eventLog) {
      try {
        this.eventLog.append('log', this.component, { level, msg, ...detail })
      } catch {
        /* best-effort */
      }
    }
  }

  debug(msg: string, detail?: Record<string, unknown>): void {
    this.emit('debug', msg, detail)
  }
  info(msg: string, detail?: Record<string, unknown>): void {
    this.emit('info', msg, detail)
  }
  warn(msg: string, detail?: Record<string, unknown>): void {
    this.emit('warn', msg, detail)
  }
  error(msg: string, detail?: Record<string, unknown>): void {
    this.emit('error', msg, detail)
  }

  /** Recent debug lines (oldest→newest) for crash diagnostics. */
  captureRecent(): string[] {
    return [...this.debugBuffer]
  }
}

/** Process-wide singleton (lazily created) for code paths without DI access. */
let _root: Logger | null = null
export function rootLogger(): Logger {
  if (!_root) _root = new Logger({ component: 'root' })
  return _root
}
