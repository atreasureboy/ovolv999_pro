/**
 * Tool Template — 复制此文件，改名，填下面字段即可接入引擎
 *
 * 使用方法:
 *   1. cp src/tools/_template.ts src/tools/myTool.ts
 *   2. 填 name / description / category / riskLevel / planModeAllowed 等字段
 *   3. 实现 execute() 逻辑
 *   4. 引擎自动发现并注册（无需手动编辑 tools/index.ts）
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export class MyTool implements Tool {
  // ── 身份 ──
  name = 'MyTool'
  description = '这个工具做什么 — 一句话描述'

  // ── 分类（引擎据此自动决策过滤、并发分区、权限等） ──
  category: Tool['category'] = 'readonly'    // readonly | mutation | system | external | delegation
  riskLevel: Tool['riskLevel'] = 'safe'       // safe | needs_approval | dangerous
  concurrencySafe = true                       // 能否与其他 safe 工具并行执行
  longRunning = false                          // 是否可能超时

  // ── 声明（引擎据此自动过滤，无需外部常量） ──
  planModeAllowed = true                       // plan mode 下是否可用
  informationalAllowed = true                  // informational 任务能否使用

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'MyTool',
      description: '这个工具做什么',
      parameters: {
        type: 'object',
        properties: {
          // ── 你的参数在这里 ──
          // example_param: {
          //   type: 'string',
          //   description: '示例参数',
          // },
        },
        required: [],
      },
    },
  }

  // ── 执行逻辑 ──
  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    // 你的逻辑在这里
    return { content: 'done', isError: false }
  }

  // ── 可选钩子 ──
  // isConcurrencySafe?(input: Record<string, unknown>): boolean — 每个 input 级别的并发判断
  // validateInput?(input: Record<string, unknown>): ToolValidationResult — 输入预校验
  // postProcess?(result: ToolResult): ToolResult — 结果后处理
}
