import { describe, it, expect } from 'vitest'
import { AsyncTaskManager } from '../src/core/taskManager.js'
import { TaskTool } from '../src/tools/task.js'

describe('AsyncTaskManager & TaskTool', () => {
  const manager = AsyncTaskManager.getInstance()
  const tool = new TaskTool()

  it('spawns a background task and monitors output', async () => {
    const taskInfo = manager.startTask('echo "hello world" && sleep 0.1', process.cwd())
    expect(taskInfo.id).toBeDefined()
    expect(taskInfo.status).toBe('running')

    // Wait for task to finish
    await new Promise((resolve) => setTimeout(resolve, 300))

    const status = manager.getTaskStatus(taskInfo.id)
    expect(status.info?.status).toBe('completed')
    expect(status.logs?.join(' ')).toContain('hello world')
  })

  it('executes Task tool actions', async () => {
    const startRes = await tool.execute(
      { action: 'start', command: 'echo "test task tool"' },
      { cwd: process.cwd(), permissionMode: 'auto' },
    )
    expect(startRes.isError).toBe(false)
    expect(startRes.content).toContain('Task started')

    const listRes = await tool.execute(
      { action: 'list' },
      { cwd: process.cwd(), permissionMode: 'auto' },
    )
    expect(listRes.isError).toBe(false)
    expect(listRes.content).toContain('Background Tasks')
  })
})
