/**
 * AsyncTaskManager — Background process management and process scheduling for long-running operations.
 *
 * Allows agents to spawn asynchronous background tasks, inspect their log streams,
 * send stdin inputs, and manage life cycles without blocking the main engine turn loop.
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'

export interface TaskInfo {
  id: string
  command: string
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode: number | null
  startTime: string
  endTime?: string
  logTail: string[]
}

export class AsyncTaskManager {
  private tasks: Map<string, { process: ChildProcess; info: TaskInfo; logs: string[] }> = new Map()
  private static instance: AsyncTaskManager

  public static getInstance(): AsyncTaskManager {
    if (!AsyncTaskManager.instance) {
      AsyncTaskManager.instance = new AsyncTaskManager()
    }
    return AsyncTaskManager.instance
  }

  /** Spawn a new background task */
  startTask(command: string, cwd: string): TaskInfo {
    const id = `task_${randomUUID().slice(0, 8)}`
    const shell = process.env.OVOGO_SHELL || 'bash'

    const proc = spawn(shell, ['-c', command], {
      cwd,
      env: { ...process.env },
      detached: false,
    })

    const info: TaskInfo = {
      id,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      startTime: new Date().toISOString(),
      logTail: [],
    }

    const logs: string[] = []
    const appendLog = (data: Buffer | string) => {
      const text = data.toString('utf8')
      const lines = text.split('\n')
      for (const line of lines) {
        if (!line && lines.length > 1) continue
        logs.push(line)
        if (logs.length > 500) logs.shift() // keep last 500 lines
      }
      info.logTail = logs.slice(-20)
    }

    proc.stdout?.on('data', appendLog)
    proc.stderr?.on('data', appendLog)

    proc.on('close', (code) => {
      info.exitCode = code
      info.status = code === 0 ? 'completed' : 'failed'
      info.endTime = new Date().toISOString()
    })

    proc.on('error', (err) => {
      appendLog(`Process error: ${err.message}`)
      info.status = 'failed'
      info.endTime = new Date().toISOString()
    })

    this.tasks.set(id, { process: proc, info, logs })
    return info
  }

  /** List all active and recent background tasks */
  listTasks(): TaskInfo[] {
    return Array.from(this.tasks.values()).map((t) => t.info)
  }

  /** Get task status and recent log output */
  getTaskStatus(id: string, logLines = 30): { info?: TaskInfo; logs?: string[]; error?: string } {
    const task = this.tasks.get(id)
    if (!task) {
      return { error: `Task '${id}' not found` }
    }
    return {
      info: task.info,
      logs: task.logs.slice(-logLines),
    }
  }

  /** Send stdin text to a running background task */
  sendInput(id: string, input: string): { success: boolean; message: string } {
    const task = this.tasks.get(id)
    if (!task) return { success: false, message: `Task '${id}' not found` }
    if (task.info.status !== 'running') {
      return {
        success: false,
        message: `Task '${id}' is not running (status: ${task.info.status})`,
      }
    }
    try {
      task.process.stdin?.write(input.endsWith('\n') ? input : input + '\n')
      return { success: true, message: `Input sent to task '${id}'` }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, message: `Failed to send input: ${msg}` }
    }
  }

  /** Terminate a running background task */
  killTask(id: string): { success: boolean; message: string } {
    const task = this.tasks.get(id)
    if (!task) return { success: false, message: `Task '${id}' not found` }
    if (task.info.status !== 'running') {
      return { success: true, message: `Task '${id}' was already finished` }
    }

    try {
      task.process.kill('SIGTERM')
      task.info.status = 'killed'
      task.info.endTime = new Date().toISOString()
      return { success: true, message: `Task '${id}' terminated` }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, message: `Failed to kill task: ${msg}` }
    }
  }
}
