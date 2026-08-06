# Super Plan Phase 2 — 基座打磨 + 结构化接入

> **定位纠正**：ovolv999 不是"能做任务的引擎"，而是"任何智能体的出生点"。
> 以后你要把它做成逆向智能体、运维智能体、安全审计智能体——任何东西。
> 所以它需要两件事到极致：
>   ① **Harness 打磨到极致** — 每个接口完整、每个生命周期考虑周全、每个子系统深耕
>   ② **接入模板结构化** — 加工具/加模块/加 MCP/加能力包，照着 JSON 填就行

---

## Phase 1 复盘

### 做了什么
| 层次 | 内容 |
|------|------|
| 安全 | 路径注入防护、env 脱敏、命令风险三级分类、权限三态+规则引擎 |
| 架构 | WorkingState、CompletionContract、ResourceScheduler、ThinkingTagFilter、ExecutionProfile、ProgressMonitor 全部接入引擎 |
| Provider | 真正的 AnthropicAdapter（fetch + SSE→chunk 转换）、modelCapabilities 修正、动态适配器选择 |
| 工具 | StructuredToolResult（exitCode/stdout/stderr/linesChanged/bytesWritten） |
| 测试 | 15→23 文件，165→327 用例 |
| 文档 | CLAUDE.md、README 英文概述 |

### Phase 1 留下的缺口（Phase 2 要填的坑）

| 位置 | 问题 | 严重度 |
|------|------|--------|
| `engine.ts:78` | `CONCURRENCY_SAFE_TOOLS` 硬编码工具名列表 | 高—工具应该是自己声明安全的，不是引擎点名 |
| `toolExecutor.ts:158` | `tsc\|eslint\|vitest\|jest\|pytest\|cargo test\|go test` 硬编码 | 高—纯 coding 假设 |
| `toolPolicy.ts:5-11` | `PLAN_MODE_TOOLS` / `INFORMATIONAL_DISALLOWED_TOOLS` 硬编码 | 高—工具分类应该在工具定义里 |
| `riskClassifier.ts:18-43` | `DANGEROUS_PATTERNS` 编译时常量 | 中—应该是可加载的规则集 |
| `taskIntent.ts:89-94` | 关键词固定写死 | 中—分类策略不可替换 |
| `tools/index.ts:20` | `createTools()` 固定 14 个工具 | 高—应该是"基础空集 + profile 注入" |
| `module.ts` | 缺少 onError/onDispose/onStateSnapshot 生命周期 | 高—模块生命周期不完整 |
| `engine.ts:722` | onComplete 报错只记 log，没有任何恢复 | 中—模块出错后的引擎状态不确定 |
| `semanticMemory.ts` | 只能从自身经历学习，没有外部知识注入口 | 中 |
| `types.ts:102-117` | `Tool` 接口缺少分类字段（readOnly? level? category?） | 中 |

---

## 设计原则

```
一个新人想给基座加一个新工具（比如"反汇编二进制"）：
  现在的路径：读 Tool 接口 → 读 types.ts → 读现有工具代码参考 → 写代码 → 改 tools/index.ts → 不确定对不对
  应该的路径：复制模板文件 → 填结构化字段（name/description/parameters/category/riskLevel/concurrencySafe）→ 放目录 → 引擎自动发现

一个新人想加一个新模块（比如"逆向分析模块"）：
  现在的路径：读 module.ts → 读 ModuleRegistry → 读现有模块代码 → 实现 boot/onIteration... → 不确定生命周期
  应该的路径：复制模板 → 填 hook 回调 → 声明依赖 → 放目录 → 引擎自动加载
```

---

## Round 6: Harness 接口完全化 — 每个接口打磨到滴水不漏

### 6.1 Tool 接口标准化

**现状**：`Tool` 接口散落在字段和 convention 之间。`concurrencySafe` 和 `metadata.concurrencySafe` 重复。
`riskLevel` 不存在——全靠 `riskClassifier.ts` 硬编码猜测。

**改动**：

```typescript
interface Tool {
  // ── 身份 ──
  name: string                    // 唯一标识
  description: string             // 一句话描述
  definition: ToolDefinition      // OpenAI function schema

  // ── 分类（引擎据此自动决策，不再需要 CONCURRENCY_SAFE_TOOLS 常量） ──
  category: 'readonly' | 'mutation' | 'system' | 'external' | 'delegation'
  riskLevel: RiskLevel            // 'safe' | 'needs_approval' | 'dangerous'
  concurrencySafe: boolean        // 引擎并发分区依据
  longRunning?: boolean           // 是否可能超时

  // ── 声明（引擎据此自动过滤，不再需要 PLAN_MODE_TOOLS 常量） ──
  planModeAllowed: boolean        // plan mode 下是否可用
  requiresConfirmation?: string[] // 什么条件下需要确认（如 "outside_cwd"）

  // ── 执行 ──
  execute(input, context): Promise<ToolResult>

  // ── 可选钩子 ──
  isConcurrencySafe?(input): boolean          // 每个 input 级别的并发判断
  validateInput?(input): ValidationResult     // 输入预校验（在 execute 之前）
  postProcess?(result): ToolResult            // 结果后处理
}
```

**模板文件**：`src/tools/_template.ts`

```typescript
// 复制此文件，改名，填下面这些字段即可接入引擎
import type { Tool, ToolContext, ToolResult } from '../core/types.js'

export class MyTool implements Tool {
  // ── 填这里 ──
  name = 'MyTool'
  description = '这个工具做什么'
  category = 'readonly'          // readonly | mutation | system | external | delegation
  riskLevel = 'safe'              // safe | needs_approval | dangerous
  concurrencySafe = true
  longRunning = false
  planModeAllowed = true

  definition = {
    type: 'function' as const,
    function: {
      name: 'MyTool',
      description: '这个工具做什么',
      parameters: {
        type: 'object' as const,
        properties: {
          // 你的参数在这里
        },
        required: [],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // 你的逻辑在这里
    return { content: 'done', isError: false }
  }
}
```

### 6.2 Module 生命周期完整化

**现状**：`AgentModule` 只有 4 个 hook（boot / onIteration / onToolCall / onComplete）。
没有错误处理、资源清理、状态序列化。

**改动**：扩展 `AgentModule` 接口：

```typescript
interface AgentModule {
  readonly name: string
  readonly dependencies?: string[]

  // ── 出生 ──
  boot(ctx: ModuleBootContext): ModuleBootResult | Promise<ModuleBootResult>

  // ── 运行 ──
  onIteration?(ctx: ModuleIterationContext): void | ModuleIterationResult | Promise<...>
  onToolCall?(toolName, input, result, turnNumber): void
  onBeforeToolCall?(toolName, input): ToolCallAdvice | void  // NEW: 工具执行前介入
  onDelegation?(childConfig: AgentConfig): AgentConfig | void // NEW: 子 agent 配置介入

  // ── 异常 ──
  onError?(error: EngineError, ctx: ModuleErrorContext): ErrorRecoveryAction  // NEW

  // ── 死亡 ──
  onComplete?(ctx: ModuleRunContext): void | Promise<void>
  onDispose?(): void | Promise<void>  // NEW: 清理资源

  // ── 持久化 ──
  onStateSnapshot?(): Record<string, unknown>   // NEW: 参与引擎快照
  onStateRestore?(state: Record<string, unknown>): void  // NEW: 从快照恢复

  // ── 自描述 ──
  describe?(): ModuleDescription   // NEW: 模块自述（CLI 可展示）
}
```

**模板文件**：`src/modules/_template.ts`

### 6.3 引擎子系统的"接口收尾"

**每一个子系统都要有完整接口，能独立测试，能独立替换**：

| 子系统 | 现状 | 完善点 |
|--------|------|--------|
| `ToolRegistry` | ✅ 完整 | — |
| `ToolPolicy` | ⚠️ plan mode + informational 硬编码 | 改为从 Tool 的字段动态决策（见 6.1） |
| `ToolExecutor` | ⚠️ 验证检测硬编码 | 改为 `verificationDetector` 策略注入 |
| `ToolScheduler` | ✅ 完整 | 增加调度超时保护 |
| `ContextManager` | ⚠️ 压缩 threshold 不可配 | 增加 compressThreshold 配置项 |
| `ProgressMonitor` | ⚠️ stall threshold 不可配 | 增加可配置 threshold |
| `ResourceScheduler` | ✅ 完整 | — |
| `ModelGateway` | ✅ 完整 | — |
| `ProviderAdapter` | ✅ 完整 | — |
| `BackgroundTaskManager` | ⚠️ 只创建，生命周期未完全接入引擎 | 接入 dispose 链（详见 6.4） |
| `WorkingState` | ✅ 完整 | — |
| `CompletionContract` | ✅ 完整 | — |
| `ThinkingTagFilter` | ✅ 完整 | 通用化为 OutputFilter 接口（见 7.2） |

### 6.4 引擎 dispose 链完整性

**现状**：`engine.dispose()` 清理了 `backgroundTaskManager`、`resourceScheduler`、`eventEmitter`、`sharedState`。
但没有清理 `modules`（onDispose）、`thinkingFilter`、`providerAdapter`、子 session 残留文件。

**改动**：
```typescript
dispose(): void {
  // 1. 先通知模块（让它们有机会 flush、关闭连接）
  for (const m of this.modules) {
    try { m.onDispose?.() } catch { /* best-effort */ }
  }
  // 2. 中止所有后台任务
  this.backgroundTaskManager.dispose()
  // 3. 释放所有资源锁
  this.resourceScheduler.releaseAll()
  // 4. 清理引擎内部状态
  if (this.currentTurnAbortController) {
    this.currentTurnAbortController.abort()
  }
  this.eventEmitter.clear()
  this.sharedState.clear()
  this.thinkingFilter.finish()
}
```

### 6.5 引擎状态快照（可恢复性）

**现状**：sessionStore 只存消息历史。WorkingState、模块状态、迭代计数丢失。

**改动**：
```typescript
interface EngineSnapshot {
  version: 1
  timestamp: string
  messages: OpenAIMessage[]
  workingState: WorkingState
  iterations: number
  turnNumber: number
  moduleStates: Record<string, Record<string, unknown>>  // 各模块通过 onStateSnapshot 提供
  taskIntent: TaskIntent
  costSnapshot: { totalInputTokens: number; totalOutputTokens: number; apiCalls: number }
}
```
- 每个 turn 结束自动快照
- `--resume` 恢复时完整恢复状态，不只是消息历史

---

## Round 7: 结构化接入 — 加什么都按模板来

### 7.1 ToolProfile：工具的结构化声明

**核心理念**：工具的所有元信息都在工具定义里声明，引擎不再需要"外部常量"来分类工具。

每个工具自带完整 profile：
```typescript
// ToolProfile — 工具给自己的"身份证"，引擎据此自动决策
interface ToolProfile {
  category: 'readonly' | 'mutation' | 'system' | 'external' | 'delegation'
  riskLevel: RiskLevel
  concurrencySafe: boolean
  longRunning: boolean
  planModeAllowed: boolean
  informationalAllowed: boolean       // informational 任务能否用
  requiresConfirmation?: {            // 什么条件需要确认
    kind: 'always' | 'outside_cwd' | 'pattern'
    pattern?: RegExp
  }
  claims?: ResourceClaim[]            // 资源声明（输入→资源列表）
}

// 引擎利用 ToolProfile 自动决策：
// - plan mode → 过滤 planModeAllowed=false 的工具
// - informational → 过滤 informationalAllowed=false 的工具
// - 并发分区 → 依据 concurrencySafe 和 claims
// - 权限确认 → 依据 riskLevel 和 requiresConfirmation
```

**效果**：删除 `CONCURRENCY_SAFE_TOOLS`、`PLAN_MODE_TOOLS`、`INFORMATIONAL_DISALLOWED_TOOLS` 三个硬编码常量。

### 7.2 工具注册自动化

**现状**：加新工具必须编辑 `src/tools/index.ts` 的 `createTools()` 函数。

**改动**：引擎扫描 `src/tools/` 目录，自动发现实现 `Tool` 接口的类。

```typescript
// 每个工具文件 export default 或具名 export 的 Tool 实例
// 引擎启动时自动：
//   1. 扫描 src/tools/ （或配置的 toolsDir）
//   2. import 每个文件
//   3. 收集所有 implements Tool 的对象
//   4. 注册到 ToolRegistry
```

**配置文件驱动**：
```jsonc
// .ovogo/tools.json — 声明要加载哪些工具
{
  "tools": [
    "Bash",           // 内置核心
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Glob",
    "Grep",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Agent",
    "Task",
    "TmuxSession",
    "loadSkill"
  ],
  "extraToolDirs": [    // 扫描额外目录中的工具
    "./custom-tools/"   // 每个文件 export 一个 Tool 实例
  ]
}
```

### 7.3 Module 接入模板化

**模板文件**：`src/modules/_template.ts`

```typescript
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'

export class TemplateModule implements AgentModule {
  // ── 填这里 ──
  readonly name = 'my-module'
  readonly dependencies?: string[] = ['memory']  // 如果有依赖

  // ── Boot: 注入提示词、工具、上下文 ──
  async boot(ctx: ModuleBootContext): Promise<ModuleBootResult> {
    return {
      systemPromptSections: ['## 我的模块知识\n...'],
      tools: [],                    // 如果模块提供工具
      toolContextPatch: {},         // 如果需要修改 ToolContext
    }
  }

  // ── 每个迭代 ──
  async onIteration(ctx) {
    // 如果需要，返回 { injectMessage: '...' }
  }

  // ── 每次工具调用后 ──
  onToolCall(toolName, input, result, turnNumber) {
    // 记录、分析、反应
  }

  // ── 出错时 ──
  onError(error, ctx) {
    return { action: 'continue' }   // continue | skip_turn | abort
  }

  // ── 任务完成 ──
  async onComplete(ctx) {}

  // ── 清理 ──
  async onDispose() {}

  // ── 状态快照（可选） ──
  onStateSnapshot() {
    return { /* 你的模块状态 */ }
  }
  onStateRestore(state) {}

  // ── 自描述（可选） ──
  describe() {
    return { name: this.name, capabilities: ['...'], version: '1.0.0' }
  }
}
```

### 7.4 MCP 接入的结构化声明

```jsonc
// .ovogo/mcp.json — MCP server 声明
{
  "servers": [
    {
      "id": "github",
      "description": "GitHub API access",
      "transport": "stdio",          // stdio | sse | streamable-http
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },  // 变量引用
      "autoReconnect": true,
      "reconnectDelayMs": 5000,
      "timeoutMs": 60000,
      "toolPrefix": "mcp__github",   // 生成 mcp__github__<tool> 的工具名
      "concurrencySafe": false,      // 默认所有工具都是串行的
      "enabled": true
    }
  ]
}
```

### 7.5 Provider 配置结构化

```jsonc
// .ovogo/providers.json
{
  "provider": "auto",               // auto = 根据 model 名自动检测
  "providers": {
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "baseURL": "https://api.openai.com/v1"
    },
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "baseURL": "https://api.anthropic.com"
    }
  },
  "modelCapabilities": {            // 覆盖/扩展内置 model capabilities
    "my-custom-model": {
      "provider": "openai",
      "contextWindow": 200000,
      "reasoningTokens": true
    }
  }
}
```

---

## Round 8: 接入协议统一化 — 一个接口接入一切

### 8.1 Capability Manifest：统一的能力声明格式

**核心理念**：一个 JSON/YAML 文件声明一套完整能力包（工具 + 模块 + MCP + 知识 + 提示词），引擎加载这个文件就获得所有能力。

```jsonc
// .ovogo/capabilities/reverse-engineering.manifest.json
{
  "name": "reverse-engineering",
  "version": "1.0.0",
  "description": "二进制逆向分析能力包",
  "provides": {
    "tools": [
      {
        "name": "Disassemble",
        "category": "system",
        "riskLevel": "safe",
        "concurrencySafe": true,
        "planModeAllowed": true,
        "definition": {
          "type": "function",
          "function": {
            "name": "Disassemble",
            "description": "反汇编二进制文件",
            "parameters": {
              "type": "object",
              "properties": {
                "file_path": { "type": "string", "description": "二进制文件路径" },
                "arch": { "type": "string", "enum": ["x86", "x64", "arm", "arm64"] }
              },
              "required": ["file_path"]
            }
          }
        }
        // execute 逻辑通过 "runtime" 字段指定：
        // "runtime": "bash" → 用 Bash 执行指定命令
        // "runtime": "module" → 用关联模块处理
      }
    ],
    "modules": ["binary-analysis"],
    "mcpServers": [],
    "skills": [
      { "name": "reverse-engineering-workflow", "description": "逆向分析标准流程" }
    ],
    "systemPromptSections": ["## Binary Analysis\n你可以使用 Disassemble 工具..."],
    "knowledge": ["./knowledge/x86-opcodes.jsonl"]
  },
  "requires": {
    "tools": ["Bash", "Read"],
    "modules": ["workspace"]
  }
}
```

**引擎在 Boot 时**：
1. 扫描 `.ovogo/capabilities/` 目录
2. 加载 manifest → 注册工具 → 启用模块 → 加载知识
3. 检查 requires → 缺失的自动提示

### 8.2 Tool Runtime：让简单工具不需要写代码

**核心理念**：80% 的工具就是"执行一个命令/调一个 API"。不应该需要写一个完整的 `Tool` 类。

```typescript
// 三种 Tool Runtime：

// 1. BashRuntime — 工具 = 执行一个命令
{
  name: 'Nmap',
  runtime: 'bash',
  bashTemplate: 'nmap ${flags} ${target}',  // 模板变量
  definition: { /* parameter schema */ }
}

// 2. HTTPRuntime — 工具 = 调一个 API
{
  name: 'VirusTotal',
  runtime: 'http',
  request: {
    method: 'POST',
    url: 'https://www.virustotal.com/api/v3/files/${file_hash}',
    headers: { 'x-apikey': '${VIRUSTOTAL_API_KEY}' }
  }
}

// 3. CodeRuntime — 工具 = 自定义 TypeScript
{
  name: 'Disassemble',
  runtime: 'code',
  executeFile: './tools/disassemble-impl.ts'  // export async function execute(input, ctx)
}
```

所有这些都通过同一个 `Tool` 接口暴露给引擎——引擎不需要知道 runtime 类型。

### 8.3 事件系统的结构化

**现状**：`RunEventEmitter` 有固定事件类型。外部系统无法订阅自定义事件。

**改动**：
```typescript
// 引擎事件总线变成通用 pub/sub
interface EngineEventBus {
  // 引擎核心事件
  on(event: 'RUN_STARTED', handler): void
  on(event: 'ITERATION_STARTED', handler): void
  on(event: 'TOOL_COMPLETED', handler): void
  on(event: 'RUN_COMPLETED', handler): void

  // 自定义事件通道（模块/MCP/外部系统可以订阅）
  emit(topic: string, payload: unknown): void
  subscribe(topic: string, handler): () => void    // 返回 unsubscribe 函数
}

// 用法示例：
engine.events.subscribe('tool:Disassemble:completed', (result) => {
  // 外部系统监听反汇编结果
})
```

---

## Round 9: 引擎循环内部的精细化

### 9.1 工具执行的细粒度控制

**现状**：ToolExecutor 执行工具 → 结果回灌。缺少超时、重试、降级、超限保护。

**改动**：
- 每个工具可声明 `timeoutMs`（默认 2 分钟，长时工具可声明更长）
- 工具返回 `retryable: true` 时引擎自动重试一次
- 同一工具连续失败 3 次 → 引擎注入"该工具反复失败"提示给 LLM
- 工具输出超 `maxOutputChars` 时自动截断 + 写入 artifact

### 9.2 上下文预算的精细化

**现状**：固定 70%/85% 阈值。不能按任务类型调整。

**改动**：
```typescript
// ContextBudget — 可配置
interface ContextBudgetConfig {
  warnPercent: number       // 默认 70
  compactPercent: number    // 默认 85
  minReserveTokens: number  // 默认 4096（至少留这么多给输出）
  strategies: ('snip' | 'summarize' | 'drop-oldest')[]  // 压缩策略优先级
}
```
- 深度任务（deep profile）自动提高 compactPercent 到 90%
- 快速任务（fast profile）降低到 75%，更激进的压缩

### 9.3 CompletionContract 的领域适配

**现状**：`evaluateCompletion` 的默认验证要求是 coding 的（typecheck/lint）。

**改动**：
- `CompletionInput` 增加 `domainProfile` 字段
- 不同 domain 的默认验证标准不同：
  - coding: typecheck, lint, test
  - devops: 健康检查, 日志验证
  - generic: 无默认验证
- 用户可以通过 `AgentConfig.expectedVerification` 覆盖

### 9.4 错误处理的精细化

**现状**：引擎的 try/catch 分散在多处，恢复策略不一致。

**改动**：统一错误分类 + 恢复策略：

```typescript
type EngineErrorClass = 'recoverable' | 'degradable' | 'fatal'

interface ClassifiedError {
  class: EngineErrorClass
  source: 'llm' | 'tool' | 'module' | 'internal'
  originalError: Error
  recoverySuggestion: string
  retryable: boolean
}

// 引擎单点错误处理：
//   recoverable → 自动重试 1 次
//   degradable → 跳过当前操作，继续执行
//   fatal → 中止 run，返回错误
```

---

## Round 10: 边界情况覆盖 + 压测基础

### 10.1 并发安全全面审计

- 多工具并行时共享 WorkingState 的安全性（当前 `recordFileRead` 等函数是纯的）
- 子 agent 并发时的 sessionDir 隔离
- 多个 MCP server 同时调用的资源竞争

### 10.2 大文件/大输出处理

- 工具输出 > 1MB → 自动路由到 artifact 文件，只返回摘要
- context 中消息数量 > 500 条 → 触发强制压缩
- semantic memory 条目 > 10,000 → 触发归档

### 10.3 异常场景测试

- LLM API 返回非标准 chunk
- 工具执行超时
- MCP server 中途断连
- 磁盘满（Write 工具失败）
- 子 agent 深度达到上限
- 用户连续 ESC 打断

### 10.4 性能基准

- 空引擎启动时间 < 200ms
- 单次工具调用开销 < 5ms（不含工具自身逻辑）
- 1000 次迭代内存增长 < 50MB
- semanticMemory.write() O(1) 确认（已在 Phase 1 实现）

---

## 实施顺序

```
R6 Harness 接口完善 ──→ R7 结构化接入 ──→ R8 接入协议统一 ──→ R9 引擎循环精细化 ──→ R10 边界覆盖
     10 天                   8 天                 7 天                 6 天                 5 天
```

每轮质量门：
```
tsc --noEmit: 0 errors
vitest run:  全部通过
每轮新增 ≥ 25 测试
核心模块覆盖率 > 85%
```

---

## 成功后基座的形态

一个新人想把这个基座做成**逆向智能体**：

```
1. 复制 src/tools/_template.ts → src/tools/disassemble.ts
   填 name/description/parameters/category/riskLevel/concurrencySafe
   写 execute 逻辑

2. 复制 src/modules/_template.ts → src/modules/binaryAnalysis.ts
   填 boot (注入提示词) / onToolCall (记录分析结果)

3. 创建 .ovogo/capabilities/reverse-engineering.manifest.json
   声明: 工具列表、模块列表、依赖关系、提示词片段、知识文件

4. 引擎启动 → 自动扫描 → 发现 manifest → 注册工具/模块 → 就绪

5. 用户: "分析这个 .so 文件" → 引擎有 Disassemble 工具 → 逆向模块
   提供知识 → Critic 根据逆向特定的失败模式检查 → CompletionContract
   根据逆向特定的验收标准验证
```

**这就是基座该有的样子** — 不是"一个会写代码的 AI"，而是**任何智能体的出生点**。
