/**
 * Module Template — 复制此文件，改名，填下面字段即可接入引擎
 *
 * 使用方法:
 *   1. cp src/modules/_template.ts src/modules/myModule.ts
 *   2. 填 name / boot / 需要用的 hook 回调
 *   3. 在 src/core/moduleRegistry.ts 注册工厂函数
 *   4. 引擎启动时自动加载
 */

import type {
  AgentModule,
  ModuleBootContext,
  ModuleBootResult,
  ModuleIterationContext,
  ModuleIterationResult,
  ModuleRunContext,
  ToolCallAdvice,
  ModuleErrorContext,
  ErrorRecoveryAction,
  ModuleDescription,
  EngineError,
} from '../core/module.js'
import type { ToolResult } from '../core/types.js'
import type { AgentConfig } from '../core/agentPresets.js'

export class TemplateModule implements AgentModule {
  // ── 填这里 ──
  readonly name = 'my-module'
  readonly dependencies?: string[] = [] // 如果有依赖 ['memory'] 等

  // ── Birth: 注入提示词、工具、上下文 ──
  // eslint-disable-next-line @typescript-eslint/require-await
  async boot(_ctx: ModuleBootContext): Promise<ModuleBootResult> {
    return {
      systemPromptSections: ['## My Module\nModule-specific instructions here...'],
      tools: [], // 如果模块提供工具，在这里返回
      toolContextPatch: {}, // 如果需要修改 ToolContext
    }
  }

  // ── Run: 每个迭代 ──
  async onIteration(_ctx: ModuleIterationContext): Promise<ModuleIterationResult | void> {
    // 每轮迭代开始时的逻辑
    // return { injectMessage: '...' } // 如果需要注入消息
  }

  // ── Run: 工具调用前介入 ──
  onBeforeToolCall(_toolName: string, _input: Record<string, unknown>): ToolCallAdvice | void {
    // 可以 veto 或修改工具调用
    // return { action: 'deny', reason: 'Not allowed for this module' }
  }

  // ── Run: 每次工具调用后 ──
  onToolCall(
    _toolName: string,
    _input: Record<string, unknown>,
    _result: ToolResult,
    _turnNumber: number,
  ): void {
    // 记录、分析、反应
  }

  // ── Run: 子 agent 配置修改 ──
  onDelegation(_childConfig: AgentConfig): AgentConfig | void {
    // 修改子 agent 的配置
    // return { ...childConfig, maxIterations: 50 }
  }

  // ── Error: 出错时 ──
  onError(_error: EngineError, _ctx: ModuleErrorContext): ErrorRecoveryAction | void {
    // 返回恢复建议
    return { action: 'continue' } // continue | skip_turn | abort
  }

  // ── Death: 任务完成 ──
  async onComplete(_ctx: ModuleRunContext): Promise<void> {
    // 任务完成后的逻辑
  }

  // ── Death: 清理资源 ──
  async onDispose(): Promise<void> {
    // 关闭连接、释放资源
  }

  // ── Persistence: 状态快照 ──
  onStateSnapshot(): Record<string, unknown> | null {
    return {
      /* 你的模块状态 */
    }
  }

  onStateRestore(_state: Record<string, unknown>): void {
    // 从快照恢复
  }

  // ── Self-description ──
  describe(): ModuleDescription {
    return {
      name: this.name,
      capabilities: ['...'],
      version: '1.0.0',
      dependencies: this.dependencies,
      tools: [],
    }
  }
}
