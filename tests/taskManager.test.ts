import { describe, it, expect } from 'vitest'
import { AsyncTaskManager } from '../src/core/taskManager.js'
import { TaskTool } from '../src/tools/task.js'

describe('AsyncTaskManager & TaskTool', () => {
  const manager = new AsyncTaskManager()
  const tool = new TaskTool()

  it('spawns a background task and monitors output', async () => {
    const taskInfo = manager.startTask('echo "hello world"', process.cwd())
    expect(taskInfo.id).toBeDefined()
    expect(taskInfo.status).toBe('running')

    const deadline = Date.now() + 5000
    let status = manager.getTaskStatus(taskInfo.id)
    while (status.info?.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      status = manager.getTaskStatus(taskInfo.id)
    }

    expect(status.info?.status).toBe('completed')
    expect(status.logs?.join(' ')).toContain('hello world')
  })

  it('executes Task tool actions', async () => {
    const startRes = await tool.execute(
      { action: 'start', command: 'echo "test task tool"' },
      { cwd: process.cwd(), permissionMode: 'auto', asyncTaskManager: manager },
    )
    expect(startRes.isError).toBe(false)
    expect(startRes.content).toContain('Task started')

    const listRes = await tool.execute(
      { action: 'list' },
      { cwd: process.cwd(), permissionMode: 'auto', asyncTaskManager: manager },
    )
    expect(listRes.isError).toBe(false)
    expect(listRes.content).toContain('Background Tasks')
  })
})
