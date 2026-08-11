import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { safeEnv } from './envSafety.js'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface TaskInfo {
  id: string
  command: string
  description: string
  status: TaskStatus
  exitCode: number | null
  pid: number | null
  startTime: number
  endTime: number | null
  durationMs: number | null
  outputLength: number
}

export interface TaskDetail extends TaskInfo {
  output: string
}

interface InternalTask {
  info: TaskInfo
  process: ChildProcess | null
  output: string
  outputFile: string | null
  stopped: boolean
}

const MAX_OUTPUT_BUFFER = 200_000
const MAX_OUTPUT_RETURN = 30_000
const DEFAULT_SIGKILL_GRACE_MS = 3000

function getShellInvocation(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: ['/c', command] }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: ['-lc', command] }
}

export class BackgroundTaskManager {
  private tasks = new Map<string, InternalTask>()
  private sequence = 0
  private sessionDir?: string

  constructor(sessionDir?: string) {
    this.sessionDir = sessionDir
    if (sessionDir) {
      try {
        mkdirSync(sessionDir, { recursive: true })
      } catch {
        /* best-effort */
      }
    }
  }

  createTask(command: string, description = ''): string {
    const id = `bg_${randomUUID().slice(0, 8)}`
    const seq = ++this.sequence

    let outputFile: string | null = null
    if (this.sessionDir) {
      outputFile = join(this.sessionDir, `task_${seq}_${id}.log`)
      try {
        writeFileSync(outputFile, '', 'utf8')
      } catch {
        outputFile = null
      }
    }

    const info: TaskInfo = {
      id,
      command,
      description: description || command.slice(0, 80),
      status: 'running',
      exitCode: null,
      pid: null,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      outputLength: 0,
    }

    const { shell, args } = getShellInvocation(command)
    const proc = spawn(shell, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeEnv(),
    })

    const task: InternalTask = {
      info,
      process: proc,
      output: '',
      outputFile,
      stopped: false,
    }

    info.pid = proc.pid ?? null
    this.tasks.set(id, task)

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      task.output += text
      task.info.outputLength = task.output.length

      if (task.output.length > MAX_OUTPUT_BUFFER) {
        task.output = task.output.slice(-MAX_OUTPUT_BUFFER)
      }

      if (task.outputFile) {
        try {
          appendFileSync(task.outputFile, text, 'utf8')
        } catch {
          /* best-effort */
        }
      }
    }

    proc.stdout?.on('data', handleOutput)
    proc.stderr?.on('data', handleOutput)

    proc.on('close', (code) => {
      task.info.exitCode = code
      task.info.status = task.stopped ? 'stopped' : code === 0 ? 'completed' : 'failed'
      task.info.endTime = Date.now()
      task.info.durationMs = task.info.endTime - task.info.startTime
      task.process = null
    })

    proc.on('error', () => {
      task.info.status = 'failed'
      task.info.endTime = Date.now()
      task.info.durationMs = task.info.endTime - task.info.startTime
      task.process = null
    })

    return id
  }

  getTask(id: string): TaskDetail | null {
    const task = this.tasks.get(id)
    if (!task) return null
    return {
      ...task.info,
      output: task.output.slice(-MAX_OUTPUT_RETURN),
    }
  }

  listTasks(): TaskInfo[] {
    return [...this.tasks.values()].map((t) => ({ ...t.info }))
  }

  stopTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || !task.process) return false

    task.stopped = true
    const pid = task.process.pid
    if (pid === undefined) return false

    try {
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
            stdio: 'ignore',
            timeout: 2000,
          })
        } catch {
          /* already gone */
        }
      } else {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          /* group gone */
        }
        setTimeout(() => {
          try {
            // Kill the whole process group, not just the direct child —
            // proc.kill('SIGKILL') only reaps the shell and orphans grandchildren.
            process.kill(-pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }, DEFAULT_SIGKILL_GRACE_MS)
      }
    } catch {
      return false
    }

    return true
  }

  async waitForTask(id: string, timeoutMs = 60_000): Promise<TaskDetail | null> {
    const task = this.tasks.get(id)
    if (!task) return null

    const deadline = Date.now() + timeoutMs
    while (task.process && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }

    return this.getTask(id)
  }

  dispose(): void {
    for (const [id] of this.tasks) {
      this.stopTask(id)
    }
    this.tasks.clear()
  }
}
