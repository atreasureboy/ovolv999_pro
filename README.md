# ovolv999 — Agent 基座

<div align="center">

**统一 Harness · 模块化能力 · 流式引擎 · 并发调度 · 配置驱动角色 · MCP 扩展 · 权限闸门**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-127%20passed-brightgreen)]()

> `ovolv999 "任何你需要它完成的任务"`

</div>

## 简介

ovolv999 是一个**纯 Agent 基座框架**，仿 Claude Code，核心设计参考 AgentOS 架构。

**所有 Agent 共享同一套运行时（Harness），通过启用/禁用模块获得差异化能力。** 不存在 `agent_type` 枚举——角色是 `AgentConfig`（identity + modules + tools）的组合配置。

- **统一 Harness** — 所有 Agent 走同一套 Boot Sequence，按模块配置差异化执行
- **模块化能力** — memory / critic / workspace / reflection 四个可组合模块
- **配置驱动角色** — 探索者、规划者、审查者 = 不同 AgentConfig 配置实例，零代码新增角色
- **MCP 客户端** — 通过 stdio JSON-RPC 连接任意 MCP server，其工具自动暴露为 `mcp__<server>__<tool>`
- **权限闸门** — `PermissionChecker`（auto/ask/deny 三态模式 + 规则 + 注入式 Approver），危险操作默认升级为人工确认
- **声明式配置** — `.ovogo/agent.json` 集中配置 model / modules / permission / mcpServers / verify / pricing，无需改源码
- **Session 恢复** — 每轮自动保存会话快照，`--resume <name|last>` 续接历史上下文
- **Token/Cost 可观测** — 流式 usage 聚合 + 单价配置 → 每轮 token 计数与 USD 估算
- **Memory 三原语** — `memory_write` / `memory_search` / `memory_recall`，Agent 主动操作长时记忆
- **来源归因 + 冲突解决** — `user_stated > agent_inferred > tool_observed` 优先级链
- **可配置验证闸门** — 子 agent 完成代码修改后自动跑 `verifyCommands`（默认 `tsc --noEmit`，可在 agent.json 改）
- **Session 整合** — REPL 退出时自动总结 episodic 经验写入 SemanticMemory（关闭学习闭环）
- **调用链追踪** — 子 agent spawn 深度追踪（max 5，基于 AsyncLocalStorage 并发安全），防递归 + 审计
- **Skill 懒加载** — Boot 时注入技能索引，LLM 按需通过 `load_skill` 加载
- **生命周期 Hooks** — 6 种：PreToolCall / PostToolCall / OnError / OnComplete / OnContextOverflow / UserPromptSubmit
- **并发调度** — 工具自声明 `concurrencySafe`，安全工具并行 (Promise.all)，状态工具串行，自动分区
- **流式引擎** — Streaming LLM API，tool_call 解析 → 分区调度 → 结果注入 → 循环；坏参数自愈（解析失败回灌 error tool_result）
- **上下文预算** — 统一百分比阈值 (70% warn / 85% compact)，**含系统提示词 token**，tool_call 对保护
- **统一 Logger** — 分级日志（stderr-only 不污染 LLM 上下文）+ EventLog 持久化 + debug 环形缓冲
- **API 重试** — SDK 指数退避 5 次重试 (429/5xx/ECONNRESET)，120s 超时
- **零领域绑定** — 核心是 Agent 基础设施，业务逻辑通过 Module + Tool + MCP 插件注入

## 架构全景

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                        ovolv999 — 统一 Harness + 模块化 Agent 基座             ║
║              47 files · 9,100+ lines · tsc 0 · eslint 0 · 127 tests           ║
║               Runtime deps: openai · glob · zod (仅 3 个)                     ║
║               API retry: 5x exponential backoff · 120s timeout                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  ┌─ Declarative Config (.ovogo/agent.json) ──────────────────────────────┐   ║
║  │  model · maxIterations · maxContextTokens · modules · permission      │   ║
║  │  mcpServers · verifyCommands · pricing   (global ← project ← CLI)     │   ║
║  └────────────────────────────────────────────────────────────────────────┘   ║
║                                  │                                           ║
║  ┌─ AgentConfig ─────────────────▼───────────────────────────────────────┐   ║
║  │  identity(SOUL) + modules[] + tools[] + skills[] + limits             │   ║
║  │  ↓ preset (explore/plan/code-reviewer/general-purpose) 或 custom      │   ║
║  └───────────────────────────────────────────────────────────────────────┘   ║
║                                  │                                           ║
║  ┌───────────────────────────────▼───────────────────────────────────────┐   ║
║  │                    ExecutionEngine (统一 Harness)                       │   ║
║  │                                                                        │   ║
║  │  ┌─ Boot Sequence (7 steps) ───────────────────────────────────────┐  │   ║
║  │  │ 1. applyAgentToConfig  →  合并 agent 配置                         │  │   ║
║  │  │ 2. deriveEnabledModules → 自动推导或显式指定                      │  │   ║
║  │  │ 3. modules.boot()      → 并行启动，收集 prompt/tools/context      │  │   ║
║  │  │ 4. buildSystemPrompt   → 组装 identity + module sections          │  │   ║
║  │  │ 5. getToolDefinitions  → 白名单 + planMode 双重过滤               │  │   ║
║  │  │ 6. buildToolContext    → 基础 + module patches + toolNames        │  │   ║
║  │  │ 7. boot_context 轨迹   → EventLog 记录启动摘要                    │  │   ║
║  │  └──────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                        │   ║
║  │  ┌─ Engine Loop ────────────────────────────────────────────────────┐  │   ║
║  │  │  modules.onIteration()  ← CriticModule 每 N 轮纠错                │  │   ║
║  │  │  evaluateContextBudget() ← 统一百分比阈值 (70%/85%)               │  │   ║
║  │  │  callLLM() → streaming → consumeStream() → recordUsage()          │  │   ║
║  │  │  scheduleToolCalls() → 坏参数自愈 (parseError → error result)     │  │   ║
║  │  │  partitionToolCalls() → parallel(safe) / serial(stateful)         │  │   ║
║  │  │  executeToolCall() → PermissionChecker 闸门 → 白名单硬执行         │  │   ║
║  │  │  modules.onToolCall()  ← MemoryModule 写 episodic (成功+失败)     │  │   ║
║  │  │  hooks: PreToolCall / PostToolCall                                │  │   ║
║  │  └──────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                        │   ║
║  │  ┌─ Post-Run ───────────────────────────────────────────────────────┐  │   ║
║  │  │  modules.onComplete()  ← ReflectionModule LLM 知识提取            │  │   ║
║  │  │  saveConversation()    ← 每轮保存可恢复快照                        │  │   ║
║  │  │  hooks: OnComplete / OnError / OnContextOverflow                  │  │   ║
║  │  └──────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                        │   ║
║  │  Abort: softAbort(ESC) / hardAbort(Ctrl+C)                            │   ║
║  └────────────────────────────────────────────────────────────────────────┘   ║
║                                                                              ║
║  ┌─ Modules (4) ──────┐  ┌─ Tools ────────────────┐  ┌─ Memory ───────────┐  ║
║  │ memory             │  │ Bash / Read / Write    │  │ Semantic:          │  ║
║  │  ├ boot: 相关性检索│  │ Edit / Glob / Grep     │  │  关键词去重 +       │  ║
║  │  ├ tools: write/   │  │ TodoWrite / WebFetch   │  │  来源优先级冲突解决  │  ║
║  │  │   search/recall │  │ WebSearch / Agent      │  │ Episodic:          │  ║
║  │  └ onToolCall:     │  │ load_skill             │  │  成功+失败工具轨迹  │  ║
║  │     episodic 写入  │  │ TmuxSession            │  │ Boot: 相关性 top-10│  ║
║  │ critic             │  │ ────────────────────── │  │ Exit: session 整合  │  ║
║  │  └ onIteration:    │  │ MCP 动态工具           │  └────────────────────┘  ║
║  │     每 N 轮纠错    │  │ mcp__<server>__<tool>  │                          ║
║  │ workspace          │  └───────────────────────┘  ┌─ Communication ─────┐  ║
║  │  └ boot: sessionDir│                              │ Agent (invoke):     │  ║
║  │ reflection         │  ┌─ Permission Gate ─────┐   │  AgentConfig 驱动   │  ║
║  │  ├ dep: memory     │  │ auto/ask/deny 三态     │   │  AsyncLocalStorage  │  ║
║  │  └ onComplete:     │  │ + 规则 (rm -rf/sudo…) │   │  callDepth max 5   │  ║
║  │     LLM 知识提取   │  │ + 注入式 Approver      │   │  verify 闸门       │  ║
║  └────────────────────┘  └───────────────────────┘  └─────────────────────┘  ║
║                                                                              ║
║  ┌─ MCP Client (stdio JSON-RPC) ─────────────────────────────────────────┐   ║
║  │  spawn → initialize → tools/list → tools/call  (60s/req timeout)       │   ║
║  │  单 server 失败不影响其他 · wrapMcpTool 桥接为原生 Tool                 │   ║
║  └────────────────────────────────────────────────────────────────────────┘   ║
║                                                                              ║
║  输出: sessions/session_TIMESTAMP/ → 会话产物、EventLog、agent-logs           ║
║       conversation.json → --resume 可恢复的完整消息历史                       ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

## 核心概念

### Module System — 模块化能力

所有 Agent 共享同一套 Harness，通过启用/禁用模块获得差异化能力：

```typescript
const agentConfig: AgentConfig = {
  identity: { systemPrompt: (cwd) => `你是运维员...` },
  modules: {
    memory: { enabled: true },      // 记忆检索 + memory_write/search/recall 工具
    critic: { enabled: true },      // 每 N 轮 LLM 纠错
    workspace: { enabled: true },   // sessionDir 产物目录
    reflection: { enabled: true },  // Run 结束后知识提取 → SemanticMemory
  },
  tools: ['Bash', 'Read', 'Grep'],
  maxIterations: 50,
}
```

| 模块 | 默认 | Boot 行为 | 循环行为 | 提供的工具 |
|------|:----:|----------|---------|-----------|
| `memory` | ✓ | 关键词相关性检索注入 top-10 | onToolCall 写 episodic | memory_write / memory_search / memory_recall |
| `workspace` | ✓ | 注入 sessionDir 到 ToolContext | — | — |
| `critic` | opt-in | — | onIteration 每 5 轮 LLM 纠错（额外 API 开销） | — |
| `reflection` | opt-in | — | onComplete LLM 知识提取（额外 API 开销） | — |

> **中立基座原则**：默认只启用无副作用的 `memory` + `workspace`。`critic` / `reflection` 是意见化的、每轮/每任务消耗额外 LLM 调用的行为，需显式开启。在 `.ovogo/agent.json` 中：`"modules": ["memory","critic","workspace","reflection"]`。

### AgentConfig — 配置驱动角色（无 agent_type）

4 个内置 preset + 无限自定义组合：

| 预设 | modules | tools | 场景 |
|------|---------|-------|------|
| `explore` | `{}` | Read/Glob/Grep/Web* (planMode) | 代码探索 |
| `plan` | `{}` | Read/Glob/Grep/Web* (planMode) | 实现规划 |
| `code-reviewer` | `{}` | Read/Glob/Grep (planMode) | 代码审查 |
| `general-purpose` | `{memory,workspace}` | 全工具（排除 Agent 防递归） | 通用子任务 |
| 自定义 | 任意组合 | 任意子集 | 零代码新增角色 |

### 声明式配置 — `.ovogo/agent.json`

无需改源码即可配置 model、模块、权限、MCP、验证闸门、定价。**解析顺序**（后者覆盖前者，深合并）：

```
1. 内置默认
2. ~/.ovogo/agent.json      (用户全局)
3. .ovogo/agent.json        (项目级)
4. CLI flags / env          (bin 应用)
```

```jsonc
// .ovogo/agent.json — 所有字段可选，省略 = 保持默认
{
  "model": "claude-sonnet-4-5",
  "maxIterations": 30,
  "maxContextTokens": 200000,            // 或交给 model→tokens 映射自动推断
  "modules": ["memory", "critic", "workspace"],
  "permission": {
    "mode": "ask",                       // auto | ask | deny
    "rules": [
      { "tool": "Bash", "pattern": "rm -rf", "action": "ask" },
      { "tool": "Write", "pattern": ".env", "action": "deny" }
    ]
  },
  "mcpServers": {
    "time": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
  },
  "verifyCommands": ["npm run typecheck", "npm test"],
  "pricing": { "inputPer1M": 3, "outputPer1M": 15 }
}
```

model→上下文窗口映射内置常见模型（gpt-4o / claude-sonnet-4-x / deepseek 等）；未知模型回退 128k。

**Schema 校验**：配置经 zod schema 校验（类型 + 枚举）。结构错误（如 `permission.mode:"asky"`、`maxIterations:"三十"`）会让该文件被整体拒绝并在 stderr 打印精确路径；未知顶层键（如把 `model` 拼成 `models`）会告警但保留有效字段。配置错误不再被静默吞掉。

### 权限闸门 — Permission Gate

工具执行前的安全边界。三态模式 + 规则集 + 注入式 Approver：

```
模式 (default action when no rule matches):
  auto — 默认放行（自主模式），除非规则要求 ask/deny
  ask  — 默认询问，除非规则 allow/deny
  deny — 默认拒绝，除非规则显式 allow

规则 (first match wins):
  { tool?: "Bash", pattern?: "rm -rf", action: "allow" | "deny" | "ask" }
  pattern = 工具指纹的子串匹配（Bash→命令串, Write/Edit→文件路径…）

Approver (DI 注入，UI 无关):
  CLI  → 交互式 y/n/always 提示（session 级 alwaysAllow 集合）
  测试 → 自动解析器
  无头/子 agent → fail-safe deny
```

内置默认规则将常见危险操作（`rm -rf` / `sudo` / `git push --force` / `curl | sh` / `chmod 777` 等）升级为 `ask`，即使在 `auto` 模式也会拦截确认。

### MCP 接入 — 动态工具扩展

通过 stdio JSON-RPC 连接任意 [MCP server](https://modelcontextprotocol.io)，其工具自动暴露给 Agent：

```
启动时:
  loadMcpServers(config.mcpServers)
    ├─ server A: spawn → initialize → tools/list  ✓
    ├─ server B: 连接失败 → 记 log，跳过（不影响其他）  ✗
    └─ 包装: wrapMcpTool → mcp__<server>__<tool> 原生 Tool

调用时:
  Agent 调 mcp__time__get_current_time
    → wrapper → client.tools/call (60s 超时) → 结果回灌
```

MCP 工具默认 `concurrencySafe: false`（未知副作用，保守串行）。`--no-mcp` 可跳过连接。

### Session 恢复

每轮对话后自动保存 `conversation.json` 完整消息历史，可随时续接：

```bash
ovogogogo --sessions              # 列出可恢复会话
ovogogogo --resume last           # 续接最近一次
ovogogogo --resume my-task        # 按名称续接
```

### Token / Cost 可观测

流式响应启用 `stream_options.include_usage`，引擎聚合每轮 token 用量并按 `pricing` 配置估算 USD：

```
[usage] prompt: 12,430 · completion: 820 · total: 13,250 · ~$0.0412 · calls: 3
```

### Memory System — 来源归因 + 冲突解决 + 整合闭环

```
写入 (memory_write):
  source: user_stated(3) > agent_inferred(2) > tool_observed(1)
  → 同内容冲突: 低优先级不能覆盖高优先级

Boot 时检索:
  userMessage → extractKeywords → scoreRelevance → top-10 注入

Session 整合 (REPL 退出):
  episodic 全量 → LLM 总结 → 高置信度知识 → SemanticMemory (source: consolidation)

跨 Session:
  下次 Boot → 相关性检索 → 自动注入
```

### Verification Gate — 可配置验证闸门

```typescript
// 主 agent 派子 agent 实现代码后自动验证
Agent({
  description: "实现登录功能",
  prompt: "...",
  subagent_type: "general-purpose",
  verify: true   // ← 完成后跑 verifyCommands（默认 tsc --noEmit，可在 agent.json 改）
})
// 结果包含:
// [验证闸门] ✓ typecheck — passed
// 或
// [验证闸门] ✗ typecheck — FAILED + 错误详情
```

`verifyCommands` 在 `.ovogo/agent.json` 中配置（如 `["npm run typecheck", "npm test"]`），不再硬编码 `tsc`。

### Agent Communication — 调用链追踪（并发安全）

```
主 agent (depth=0, AsyncLocalStorage)
  └─ spawn general-purpose (depth=1)
       └─ EventLog: invoke_sent {call_depth: 1}
       └─ 子 agent 执行...
       └─ EventLog: invoke_completed {call_depth: 1, duration_ms, output_preview}

调用深度 max 5 → 超限拒绝 (防递归)
基于 AsyncLocalStorage → 并发子 agent 链各自独立计数，互不干扰
```

## 并发分区调度

工具自声明 `concurrencySafe`（Read/Glob/Grep/Web* 等无副作用工具 = true，Bash/Write/Edit = false）。引擎动态构建安全集合后分区：

```
tool_calls [A, B, C, D, E, F]
     │
     ├─ partitionToolCalls(safeNames)
     │
     ├─ Batch 1 (并行): [A=Read, B=Glob, C=WebSearch]   ← concurrencySafe
     │     → Promise.all([A, B, C]) → 同时执行
     │
     ├─ Batch 2 (串行): [D=Write]                        ← 有状态/副作用
     │     → 等 Batch 1 完成 → 执行 D
     │
     └─ Batch 3 (并行): [E=Bash*, F=Agent]               ← E 自声明 safe 则并行
           → Promise.all([E, F]) → 同时执行
```

## 工具模型

引擎在 Boot 时装配工具集：11 个内置核心工具（`createTools()`：Bash / Read / Write / Edit / Glob / Grep / Todo / WebFetch / WebSearch / Agent / load_skill）+ 模块提供的工具（memory 的 3 个原语）+ MCP 动态工具（`mcp__<server>__<tool>`）+ `extraTools` 注入。

| 类别 | 说明 |
|------|------|
| 核心工具 | 无外部依赖，任何环境可用 |
| `TmuxSession` | **环境相关**：管理本地交互式进程（Python REPL / Node REPL / 交互式 CLI），需要宿主安装 `tmux`。未安装时优雅降级（返回 error 工具结果，不崩溃），基座本身不依赖它 |
| MCP 工具 | 外部 stdio 进程，按 `.ovogo/agent.json` 的 `mcpServers` 声明动态接入 |

工具通过 `concurrencySafe` 自声明并行安全性（Read/Glob/Grep/Web* 等只读工具 = `true`，Bash/Write/Edit = `false`），引擎据此动态分区调度。

## 如何扩展

### 方式 1: 编写自定义 Tool

```typescript
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export class MyCustomTool implements Tool {
  name = 'MyCustom'
  concurrencySafe = true   // ← 声明无副作用则可并行调度（可选，默认 false）
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'MyCustom',
      description: '...',
      parameters: { type: 'object', properties: { /* ... */ }, required: ['input'] },
    },
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return { content: 'done', isError: false }
  }
}
```

注册到 `src/tools/index.ts` 或通过 `EngineConfig.extraTools` 注入。

### 方式 2: 编写自定义 Module

```typescript
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'

export class MyModule implements AgentModule {
  readonly name = 'my-module'
  readonly dependencies = ['memory']

  boot(ctx: ModuleBootContext): ModuleBootResult {
    return {
      systemPromptSections: ['## Custom Knowledge\n...'],
      tools: [myCustomTool],
    }
  }

  onToolCall(toolName: string, input: Record<string, unknown>, result: { content: string; isError: boolean }): void {
    // 每次工具调用后的副作用
  }
}
```

注册: `globalModuleRegistry.register('my-module', (ctx) => new MyModule())`。依赖解析会检测循环依赖（抛错并显示 `x → y → x` 路径）。

### 方式 3: 自定义 Agent 角色

```typescript
const config: AgentConfig = {
  identity: {
    systemPrompt: (cwd: string) => `Working directory: ${cwd}\n\n你是审计员...`,
  },
  modules: { memory: { enabled: true }, workspace: { enabled: true } },
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  maxIterations: 50,
}

// 通过 Agent 工具的 agent_config 参数使用
Agent({ description: '审计认证模块', prompt: '...', agent_config: config })
```

### 方式 4: 添加自定义 Skill

在 `.ovogo/skills/` 下创建 Markdown 文件:

```markdown
---
name: deploy
description: 部署到生产环境
tools: Bash, Read
---
检查 staging 环境，确认测试通过后部署到生产...
```

LLM 可通过 `load_skill("deploy")` 按需加载。

### 方式 5: 接入 MCP Server

在 `.ovogo/agent.json` 声明即可，无需写代码：

```jsonc
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }
  }
}
```

启动后这些 server 的工具自动以 `mcp__github__*` / `mcp__fs__*` 暴露给 Agent。

## 快速开始

### 安装

```bash
git clone https://github.com/atreasureboy/ovolv999.git
cd ovolv999
pnpm install
```

### 配置

```bash
export OPENAI_API_KEY="your-key"
# export OPENAI_BASE_URL="https://your-proxy.com/v1"
# export OVOGO_MODEL="claude-sonnet-4-5"
```

可选创建 `.ovogo/agent.json` 进行项目级配置（见上文「声明式配置」）。

### 使用

```bash
# 交互模式 — REPL
npx tsx bin/ovogogogo.ts

# 单任务模式
npx tsx bin/ovogogogo.ts "修复 src/core 的类型错误"

# 指定模型和工作目录
npx tsx bin/ovogogogo.ts -m claude-sonnet-4-5 --cwd /my/project

# 权限模式（危险操作需确认）
npx tsx bin/ovogogogo.ts -p ask "重构认证模块"

# 恢复上次会话
npx tsx bin/ovogogogo.ts --resume last

# 列出可恢复会话
npx tsx bin/ovogogogo.ts --sessions

# 跳过 MCP 连接
npx tsx bin/ovogogogo.ts --no-mcp "快速问答"
```

#### CLI 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-m, --model <model>` | LLM 模型 (env: `OVOGO_MODEL`) | `gpt-4o` |
| `--max-iter <n>` | Think-Act-Observe 最大循环 (env: `OVOGO_MAX_ITER`) | `200` |
| `--cwd <path>` | 工作目录 (env: `OVOGO_CWD`) | 当前目录 |
| `-p, --permission <m>` | 权限模式 `auto \| ask \| deny` | `auto` |
| `--resume <name\|last>` | 恢复已保存的会话（`--sessions` 列出） | — |
| `--sessions` | 列出可恢复会话后退出 | — |
| `--no-mcp` | 跳过 MCP server 连接 | — |
| `-v, --version` | 打印版本 | — |
| `-h, --help` | 显示帮助 | — |

## 项目结构

```
ovolv999/
├── bin/
│   └── ovogogogo.ts             # CLI + REPL + agent.json 加载 + MCP/权限/会话装配
├── src/
│   ├── core/                           # 引擎核心 (13 files)
│   │   ├── engine.ts                   # 统一 Harness — Boot + Loop + 权限闸门 + usage
│   │   ├── types.ts                    # EngineConfig / AgentConfig / Tool / TokenUsage
│   │   ├── module.ts                   # AgentModule 接口 (4 生命周期钩子)
│   │   ├── moduleRegistry.ts           # 工厂注册 + 依赖解析 + 环检测(抛错)
│   │   ├── agentPresets.ts             # 4 preset + resolveAgentConfig
│   │   ├── permission.ts               # PermissionChecker + 规则 + Approver DI
│   │   ├── sessionStore.ts             # 会话快照保存/恢复/列表
│   │   ├── logger.ts                   # 统一分级 Logger (stderr + EventLog + ring)
│   │   ├── compact.ts                  # 上下文压缩 + strategy + tool_call 对保护
│   │   ├── semanticMemory.ts           # 语义记忆 + 来源优先级 + hash 去重
│   │   ├── episodicMemory.ts           # 过程记忆 (成功+失败轨迹 + 轮转上限)
│   │   ├── eventLog.ts                 # 不可变审计流
│   │   └── strings.ts                  # str() 安全转换 helper
│   ├── modules/                        # 内置能力模块 (4 files)
│   │   ├── memory.ts                   # 相关性检索 + 3 memory tools + episodic 写入
│   │   ├── critic.ts                   # 每 N 轮 LLM 纠错
│   │   ├── workspace.ts                # sessionDir 注入
│   │   └── reflection.ts               # per-turn 知识提取 + session-level 整合
│   ├── tools/                          # 工具层 (13 files)
│   │   ├── agent.ts                    # AgentConfig 驱动 + 验证闸门 + AsyncLocalStorage 深度
│   │   ├── loadSkill.ts                # 技能懒加载 + 权限检查
│   │   ├── bash.ts                     # 跨平台 shell + 后台模式 + timeout ms clamp
│   │   └── ...                         # Read/Write/Edit/Glob/Grep/Todo/Web/Tmux
│   ├── mcp/                            # MCP 客户端 (2 files)
│   │   ├── client.ts                   # stdio JSON-RPC (initialize/tools/call, 60s)
│   │   └── wrapper.ts                  # wrapMcpTool + loadMcpServers (容错)
│   ├── prompts/                        # 提示词 (3 files)
│   │   ├── system.ts                   # 系统提示词组装 + skill 索引注入
│   │   ├── tools.ts                    # 工具描述常量
│   │   └── critic.ts                   # Critic 纠错提示词
│   ├── config/                         # 配置 (4 files)
│   │   ├── agentConfig.ts              # .ovogo/agent.json 加载 + model→tokens 映射
│   │   ├── hooks.ts                    # 6 种 Hook + HookRunner + NoopHookRunner
│   │   ├── settings.ts                 # JSON 解析 + TaskContext
│   │   └── ovogomd.ts                  # OVOGO.md 多级加载
│   ├── ui/                             # 终端 UI (3 files)
│   │   ├── renderer.ts                 # 流式输出 + 工具卡片 + usage + spinner
│   │   ├── input.ts                    # readline + stdin pipe
│   │   └── tmuxLayout.ts               # 子 agent tmux 窗口管理
│   ├── testing/                        # 测试夹具
│   │   └── index.ts                    # createMockToolContext / okResult / errResult
│   ├── skills/                         # 技能系统
│   │   └── loader.ts                   # frontmatter 解析 + formatSkillIndex
│   └── memory/                         # 记忆桥接
│       └── index.ts                    # SemanticMemory → 系统提示词注入 + projectSlug
├── tests/                              # 111 tests · 9 files
│   ├── engine.test.ts                  # partitionToolCalls + compact + critic
│   ├── presets.test.ts                 # AgentConfig + preset 解析 + applyAgent
│   ├── modules.test.ts                 # SemanticMemory + EpisodicMemory + ModuleRegistry
│   ├── compact.test.ts                 # token 估算 + 策略 + 消息结构
│   ├── permission.test.ts              # PermissionChecker + 规则 + 指纹 (14)
│   ├── sessionStore.test.ts            # 保存/恢复/列表/resolveSessionArg (10)
│   ├── agentConfig.test.ts             # 加载/合并/model→tokens (7)
│   ├── mcp.test.ts                     # wrapMcpTool + loadMcpServers (7)
│   └── testing.test.ts                 # 测试夹具 (4)
└── package.json                        # 3 runtime deps: openai / glob / zod
```

## AgentOS 概念对照

| AgentOS 概念 | ovolv999 实现 |
|---|---|
| 统一 Harness（无 agent_type） | `ExecutionEngine` + `AgentConfig` + 4 preset |
| 模块组合驱动 | `ModuleRegistry` + memory/critic/workspace/reflection |
| Boot Sequence | 7 步：identity → modules → boot → prompt → tools → context → trajectory |
| 声明式配置 | `.ovogo/agent.json` — model/modules/permission/mcp/verify/pricing |
| MCP 工具扩展 | stdio JSON-RPC client → `mcp__<server>__<tool>` 原生 Tool |
| 权限闸门 | `PermissionChecker`（auto/ask/deny + 规则 + Approver DI） |
| 会话恢复 | `conversation.json` 快照 + `--resume` |
| Token/Cost 可观测 | `stream_options.include_usage` + pricing → 每轮聚合 |
| 来源归因 + 冲突解决 | `user_stated(3) > agent_inferred(2) > tool_observed(1)` |
| Memory Tool 三原语 | `memory_write` / `memory_search` / `memory_recall` |
| Boot 时相关性检索 | `extractKeywords` + `scoreRelevance` → top-10 |
| Memory 整合 | `consolidateSession` — REPL 退出时 LLM 总结 |
| Skill 懒加载 | `load_skill` + `formatSkillIndex` + 权限检查 |
| 验证闸门 (No Tuple No Merge) | `verify:true` → `verifyCommands`（可配置，默认 tsc） |
| 调用链追踪 + 循环检测 | AsyncLocalStorage depth max 5 + EventLog（并发安全） |
| 生命周期 Hooks | 6 种 Hook 类型 |
| Trajectory 捕获 | `boot_context` + `invoke_sent/completed` + EventLog |
| Context 压缩 + 策略 | 统一 70%/85% + **含系统提示词 token** + tool_call 对保护 + strategy |
| 并发分区 | 工具自声明 `concurrencySafe` → 引擎动态安全集合 |
| API 重试 | SDK maxRetries=5 指数退避 (429/5xx/ECONNRESET) + 120s timeout |
| Module-driven Tools | MemoryModule 通过 `boot().tools` 提供 3 个工具 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript 5.7 (ESM) |
| 运行时 | Node.js ≥ 20 |
| LLM API | OpenAI SDK (兼容 Claude 等端点) |
| 工具扩展 | MCP (Model Context Protocol) stdio |
| 测试 | Vitest（111 tests）+ 内置夹具 (`src/testing`) |
| Lint | ESLint (typescript-eslint recommendedTypeChecked) |
| 依赖 | openai · glob · zod (仅 3 个 runtime deps) |

## 许可

MIT License
