/**
 * TaskTool — Manage background asynchronous processes
 *
 * Actions:
 *   start      — launch a command in the background
 *   list       — list all tasks
 *   status     — view logs and state of a task
 *   send_input — send text/stdin to a running task
 *   kill       — terminate a task
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { AsyncTaskManager } from '../core/taskManager.js'

export interface TaskInput {
  action: 'start' | 'list' | 'status' | 'send_input' | 'kill'
  command?: string
  task_id?: string
  input?: string
  log_lines?: number
}

export class TaskTool implements Tool {
  name = 'Task'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Task',
      description:
        'Manage asynchronous background tasks (start long-running commands, check status/logs, send stdin, kill).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'list', 'status', 'send_input', 'kill'],
            description: 'Task action to perform',
          },
          command: {
            type: 'string',
            description: 'Shell command line to execute (required for action="start")',
          },
          task_id: {
            type: 'string',
            description: 'Task ID (required for status, send_input, kill)',
          },
          input: {
            type: 'string',
            description: 'Input text for stdin (required for action="send_input")',
          },
          log_lines: {
            type: 'number',
            description: 'Number of recent log lines to retrieve (for action="status", default 30)',
          },
        },
        required: ['action'],
      },
    },
  }

  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const manager = AsyncTaskManager.getInstance()
    const args = input as unknown as TaskInput

    let result: ToolResult
    switch (args.action) {
      case 'start': {
        if (!args.command || typeof args.command !== 'string') {
          result = {
            content: 'Error: command string is required for action="start"',
            isError: true,
          }
          break
        }
        const info = manager.startTask(args.command, context.cwd)
        result = {
          content: `Task started.\nID: ${info.id}\nCommand: ${info.command}\nStatus: ${info.status}\nUse Task({ action: "status", task_id: "${info.id}" }) to check progress.`,
          isError: false,
        }
        break
      }

      case 'list': {
        const tasks = manager.listTasks()
        if (tasks.length === 0) {
          result = { content: 'No background tasks running or completed.', isError: false }
          break
        }
        const summary = tasks
          .map(
            (t) =>
              `- [${t.id}] status=${t.status} exitCode=${t.exitCode ?? 'N/A'} cmd="${t.command}"`,
          )
          .join('\n')
        result = { content: `Background Tasks (${tasks.length}):\n${summary}`, isError: false }
        break
      }

      case 'status': {
        if (!args.task_id) {
          result = { content: 'Error: task_id is required for action="status"', isError: true }
          break
        }
        const res = manager.getTaskStatus(args.task_id, args.log_lines ?? 30)
        if (res.error) {
          result = { content: res.error, isError: true }
          break
        }

        const logContent = (res.logs ?? []).join('\n')
        result = {
          content: `Task ${res.info?.id} [${res.info?.status}]\nCommand: ${res.info?.command}\nExit Code: ${res.info?.exitCode ?? 'running'}\n\nRecent Logs (${res.logs?.length} lines):\n${logContent || '(no output yet)'}`,
          isError: false,
        }
        break
      }

      case 'send_input': {
        if (!args.task_id || args.input === undefined) {
          result = {
            content: 'Error: task_id and input string are required for send_input',
            isError: true,
          }
          break
        }
        const res = manager.sendInput(args.task_id, args.input)
        result = { content: res.message, isError: !res.success }
        break
      }

      case 'kill': {
        if (!args.task_id) {
          result = { content: 'Error: task_id is required for action="kill"', isError: true }
          break
        }
        const res = manager.killTask(args.task_id)
        result = { content: res.message, isError: !res.success }
        break
      }

      default:
        result = { content: `Error: unknown action '${String(args.action)}'`, isError: true }
        break
    }
    return Promise.resolve(result)
  }
}
