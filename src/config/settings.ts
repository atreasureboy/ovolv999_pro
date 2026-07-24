/**
 * Settings loader — reads .ovogo/settings.json from project and global dirs
 *
 * Config resolution order (later entries win):
 *   ~/.ovogo/settings.json   (global user defaults)
 *   .ovogo/settings.json     (project-specific, relative to cwd)
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PreToolCall": [
 *       { "matcher": "Bash", "command": "echo \"Running: $OVOGO_TOOL_INPUT\"" }
 *     ],
 *     "PostToolCall": [
 *       { "matcher": "Write,Edit", "command": "npx prettier --write \"$OVOGO_TOOL_NAME\" 2>/dev/null || true" }
 *     ],
 *     "UserPromptSubmit": [
 *       { "command": "logger -t ovogogogo \"prompt: $OVOGO_PROMPT\"" }
 *     ]
 *   }
 * }
 *
 * Hook env vars:
 *   PreToolCall:       OVOGO_TOOL_NAME, OVOGO_TOOL_INPUT (JSON)
 *   PostToolCall:      OVOGO_TOOL_NAME, OVOGO_TOOL_RESULT, OVOGO_TOOL_IS_ERROR
 *   UserPromptSubmit:  OVOGO_PROMPT
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'

export interface HookEntry {
  /** Comma-separated tool names to match, or "*" / omit for all. Supports trailing "*" wildcard. */
  matcher?: string
  /** Shell command to execute. Runs with tool env vars set. */
  command: string
}

export interface HooksConfig {
  PreToolCall?: HookEntry[]
  PostToolCall?: HookEntry[]
  UserPromptSubmit?: HookEntry[]
  OnError?: HookEntry[]
  OnComplete?: HookEntry[]
  OnContextOverflow?: HookEntry[]
}

/**
 * 结构化任务上下文 — 注入系统提示词，为 agent 提供任务背景。
 * 配置在 .ovogo/settings.json 的 "taskContext" 字段。
 * 领域无关：phase/scope 均为自由字符串，不绑定任何特定业务语义。
 */
export interface TaskContext {
  /** 任务名称 */
  name?: string
  /** 当前任务阶段（自由字符串，如 "调研"、"实现"、"测试"）*/
  phase?: string
  /** 工作范围（目录、仓库、服务名等工作目标）*/
  scope?: string[]
  /** 额外备注（约束、特殊要求等）*/
  notes?: string
}

export interface OvogoSettings {
  hooks?: HooksConfig
  taskContext?: TaskContext
}

function tryParse(path: string): OvogoSettings {
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    return JSON.parse(raw) as OvogoSettings
  } catch (err) {
    process.stderr.write(
      `[settings] warning: ${path} has invalid JSON (${(err as Error).message}); ignoring this file\n`,
    )
    return {}
  }
}

function mergeSettings(a: OvogoSettings, b: OvogoSettings): OvogoSettings {
  const mergedTaskContext = b.taskContext
    ? {
        ...(a.taskContext ?? {}),
        ...b.taskContext,
        scope: b.taskContext.scope ?? a.taskContext?.scope,
      }
    : a.taskContext

  return {
    hooks: {
      PreToolCall: [...(a.hooks?.PreToolCall ?? []), ...(b.hooks?.PreToolCall ?? [])],
      PostToolCall: [...(a.hooks?.PostToolCall ?? []), ...(b.hooks?.PostToolCall ?? [])],
      UserPromptSubmit: [
        ...(a.hooks?.UserPromptSubmit ?? []),
        ...(b.hooks?.UserPromptSubmit ?? []),
      ],
      OnError: [...(a.hooks?.OnError ?? []), ...(b.hooks?.OnError ?? [])],
      OnComplete: [...(a.hooks?.OnComplete ?? []), ...(b.hooks?.OnComplete ?? [])],
      OnContextOverflow: [
        ...(a.hooks?.OnContextOverflow ?? []),
        ...(b.hooks?.OnContextOverflow ?? []),
      ],
    },
    taskContext: mergedTaskContext,
  }
}

export function loadSettings(cwd: string): OvogoSettings {
  const globalPath = join(homedir(), '.ovogo', 'settings.json')
  const projectPath = resolve(cwd, '.ovogo', 'settings.json')

  let settings: OvogoSettings = {}
  if (existsSync(globalPath)) settings = mergeSettings(settings, tryParse(globalPath))
  if (existsSync(projectPath)) settings = mergeSettings(settings, tryParse(projectPath))
  return settings
}
