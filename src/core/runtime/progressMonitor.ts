export interface ProgressSnapshot {
  iteration: number
  changedFiles: string[]
  repeatedToolCalls: number
  repeatedErrors: number
  minutesSinceLastMeaningfulProgress: number
}

export type StallVerdict =
  | { kind: 'progressing' }
  | { kind: 'soft-stall'; reason: string; action: 'summarize-and-replan' }
  | { kind: 'hard-stall'; reason: string; action: 'escalate-critic' }
  | { kind: 'repeated-failure'; reason: string; action: 'root-cause-subtask' }

export interface StallThresholds {
  softStallMinutes: number
  hardStallMinutes: number
  repeatedErrorLimit: number
  repeatedToolCallLimit: number
}

export const DEFAULT_THRESHOLDS: StallThresholds = {
  softStallMinutes: 10,
  hardStallMinutes: 25,
  repeatedErrorLimit: 3,
  repeatedToolCallLimit: 3,
}

interface ToolCallKey {
  tool: string
  inputFingerprint: string
}

function fingerprint(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input).slice(0, 500)
  } catch {
    return '[unserializable]'
  }
}

export class ProgressMonitor {
  private readonly changedFiles = new Set<string>()
  private iteration = 0
  private lastToolCall: ToolCallKey | null = null
  private repeatedToolCalls = 0
  private consecutiveErrors = 0
  private lastErrorFingerprint: string | null = null
  private lastMeaningfulProgressAt = Date.now()
  private readonly thresholds: StallThresholds

  constructor(thresholds?: Partial<StallThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  }

  tick(): void {
    this.iteration++
  }

  markProgress(): void {
    this.lastMeaningfulProgressAt = Date.now()
  }

  recordToolCall(
    tool: string,
    input: Record<string, unknown>,
    result: { isError: boolean; content: string },
  ): void {
    const fp = fingerprint(input)
    const key: ToolCallKey = { tool, inputFingerprint: fp }

    if (this.lastToolCall && this.lastToolCall.tool === tool && this.lastToolCall.inputFingerprint === fp) {
      this.repeatedToolCalls++
    } else {
      this.repeatedToolCalls = 0
    }
    this.lastToolCall = key

    if (result.isError) {
      const errFp = result.content.slice(0, 200)
      if (this.lastErrorFingerprint === errFp) {
        this.consecutiveErrors++
      } else {
        this.consecutiveErrors = 1
        this.lastErrorFingerprint = errFp
      }
    } else {
      this.consecutiveErrors = 0
      this.lastErrorFingerprint = null
      this.markProgress()
    }
  }

  recordFileChange(path: string): void {
    if (!this.changedFiles.has(path)) {
      this.changedFiles.add(path)
      this.markProgress()
    }
  }

  snapshot(): ProgressSnapshot {
    const minutesSince = (Date.now() - this.lastMeaningfulProgressAt) / 60_000
    return {
      iteration: this.iteration,
      changedFiles: [...this.changedFiles],
      repeatedToolCalls: this.repeatedToolCalls,
      repeatedErrors: this.consecutiveErrors,
      minutesSinceLastMeaningfulProgress: minutesSince,
    }
  }

  detectStall(): StallVerdict {
    const minutesSince = (Date.now() - this.lastMeaningfulProgressAt) / 60_000

    if (this.consecutiveErrors >= this.thresholds.repeatedErrorLimit) {
      return {
        kind: 'repeated-failure',
        reason: `${this.consecutiveErrors} consecutive identical errors`,
        action: 'root-cause-subtask',
      }
    }

    if (minutesSince >= this.thresholds.hardStallMinutes) {
      return {
        kind: 'hard-stall',
        reason: `No meaningful progress for ${minutesSince.toFixed(1)} minutes`,
        action: 'escalate-critic',
      }
    }

    if (minutesSince >= this.thresholds.softStallMinutes) {
      return {
        kind: 'soft-stall',
        reason: `No meaningful progress for ${minutesSince.toFixed(1)} minutes`,
        action: 'summarize-and-replan',
      }
    }

    return { kind: 'progressing' }
  }

  reset(): void {
    this.changedFiles.clear()
    this.iteration = 0
    this.lastToolCall = null
    this.repeatedToolCalls = 0
    this.consecutiveErrors = 0
    this.lastErrorFingerprint = null
    this.lastMeaningfulProgressAt = Date.now()
  }
}
