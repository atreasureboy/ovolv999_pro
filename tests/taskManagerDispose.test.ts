import { describe, it, expect } from 'vitest'
import { AsyncTaskManager } from '../src/core/taskManager.js'

describe('AsyncTaskManager dispose', () => {
  it('dispose() terminates running tasks', async () => {
    const manager = new AsyncTaskManager()
    // Start a long-running task.
    const info = manager.startTask('sleep 30', process.cwd())
    expect(info.status).toBe('running')

    // Give it a moment to actually spawn.
    await new Promise((r) => setTimeout(r, 100))
    const before = manager.getTaskStatus(info.id).info
    expect(before?.status).toBe('running')

    manager.dispose()

    const after = manager.getTaskStatus(info.id).info
    expect(after?.status).toBe('killed')
  })

  it('killTask marks a running task as killed', async () => {
    const manager = new AsyncTaskManager()
    const info = manager.startTask('sleep 30', process.cwd())
    await new Promise((r) => setTimeout(r, 100))

    const res = manager.killTask(info.id)
    expect(res.success).toBe(true)

    const status = manager.getTaskStatus(info.id).info
    expect(status?.status).toBe('killed')
  })

  it('killTask on a finished task is a no-op success', async () => {
    const manager = new AsyncTaskManager()
    const info = manager.startTask('echo done', process.cwd())
    // Wait for completion.
    const deadline = Date.now() + 5000
    let status = manager.getTaskStatus(info.id).info
    while (status?.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      status = manager.getTaskStatus(info.id).info
    }
    expect(status?.status).toBe('completed')

    const res = manager.killTask(info.id)
    expect(res.success).toBe(true)
    expect(res.message).toContain('already finished')
  })
})
