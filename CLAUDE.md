# CLAUDE.md — AI 协作规范

> ovolv999 (ovogogogo) — TypeScript 自主 Agent 基座/运行时框架

## 项目身份

ovolv999 是一个**纯 Agent 基座框架**，仿 Claude Code。所有 Agent 共享同一套 Harness（ExecutionEngine），通过模块组合获得差异化能力。不存在 `agent_type` 枚举 — 角色是 `AgentConfig`（identity + modules + tools）的组合。

**领域中立**：核心是 Agent 基础设施，默认不含 coding 假设。文件工具（Read/Write/Edit/Glob/Grep）虽已注册，但系统提示词、身份、职责准则都是领域无关的。

## 架构概览

```
┌─ CLI/boot ──────────────────────────────────────────┐
│  bin/ovogogogo.ts  →  .ovogo/agent.json  →  Engine  │
└─────────────────────────────────────────────────────┘
                         │
┌─ ExecutionEngine ───────────────────────────────────┐
│  Boot (7 steps) → Loop (think→act→observe)          │
│                                                      │
│  ToolScheduler  →  partitionToolCalls  →  batch     │
│  ToolExecutor   →  permission gate  →  execute      │
│  ModelGateway   →  ProviderAdapter  →  stream       │
│  ContextManager →  budget + compaction              │
│                                                      │
│  Subsystems:                                         │
│  ├── WorkingState      (structured task state)       │
│  ├── CompletionContract (completion verification)    │
│  ├── ThinkingTagFilter (streaming think-tag strip)   │
│  ├── ProgressMonitor   (stall detection)             │
│  ├── ResourceScheduler (tool claim conflict check)   │
│  └── BackgroundTaskManager (async task lifecycle)    │
└─────────────────────────────────────────────────────┘
                         │
┌─ Modules ───────────────────────────────────────────┐
│  memory · critic · workspace · reflection            │
│  AgentModule: boot / onIteration / onToolCall /      │
│               onComplete / onDelegation              │
└─────────────────────────────────────────────────────┘
                         │
┌─ Tools ─────────────────────────────────────────────┐
│  Bash · Read · Write · Edit · MultiEdit · Glob ·     │
│  Grep · WebFetch · WebSearch · Agent · Task · Todo    │
│  loadSkill · TmuxSession · mcp__<server>__<tool>    │
└─────────────────────────────────────────────────────┘
```

## 代码风格约定

- **语言**: TypeScript 5.7, ESM (`"type": "module"`)
- **分号**: 无分号（no semi）
- **引号**: 单引号 (`'`)
- **类型**: strict mode，优先 `interface` 而非 `type`（对象形状），优先 `type` 用于联合/映射类型
- **导入**: 文件扩展名必需 — `import { X } from './foo.js'`（不是 `'./foo'`）
- **错误处理**: 工具用 `{ content, isError }`，引擎用 try/catch
- **JSDoc**: 关键路径注释 `/** ... */`，解释 WHY 而非 WHAT
- **命名**: 
  - 文件: camelCase（`engine.ts`, `thinkingTagFilter.ts`）
  - 类/接口: PascalCase（`ToolExecutor`, `AgentModule`）
  - 函数/变量: camelCase（`recordFileRead`）
  - 常量: SCREAMING_SNAKE（`MAX_OUTPUT_LENGTH`）
- **不可变性**: WorkingState 函数返回新对象，不修改原对象

## 关键设计决策

### 为什么不用 enum？
字符串联合类型（`type ExecutionProfile = 'fast' | 'standard' | 'deep' | 'autonomous'`）而非 enum。原因：enum 需要运行时值，增加 bundle 体积；字符串联合类型与 JSON 配置天然兼容。

### 为什么模块组合优于类型枚举？
不存在 `agent_type` 枚举。角色通过 `AgentConfig`（identity + modules[] + tools[]）组合。这避免了类型爆炸 — 新增角色无需修改核心类型。

### 为什么 ToolResult 是结构化可扩展的？
`ToolResult` 有必填的 `content` + `isError`，以及可选的 `exitCode`/`stdout`/`stderr`/`linesChanged`/`bytesWritten`/`retryable`。向后兼容的同时为工具提供丰富元数据，无需改变引擎。

### 为什么 ProviderAdapter 统一为 OpenAI chunk 格式？
所有 provider（OpenAI、Anthropic）标准化为 OpenAI `ChatCompletionChunk` 流。这使 ModelGateway 可以切换适配器而流消费代码无需更改。

### 为什么 ThinkingTagFilter 是流式的？
`ThinkingTagFilter.push(chunk)` 返回无 think 标签的可见文本，跨 chunk 边界处理。不缓存完整响应 — 专为流式渲染设计。

## 开发流程

### 添加新工具
1. 在 `src/tools/` 创建文件，实现 `Tool` 接口
2. 在 `src/tools/index.ts` 的 `createTools()` 中注册
3. 在 `src/core/types.ts` 的 `ToolResult` 中添加结构化字段（如有需要）
4. 在 `tests/` 添加测试
5. 如涉及路径，始终通过 `src/core/pathSecurity.ts` 校验

### 添加新模块
1. 在 `src/modules/` 创建文件，实现 `AgentModule` 接口
2. 在 `src/core/moduleRegistry.ts` 注册工厂函数
3. 如模块提供工具，在 `boot()` 中返回 `{ tools: [...] }`
4. 声明依赖（`dependencies` 字段），解析器检测循环依赖

### 添加新 provider
1. 在 `src/core/providerAdapter.ts` 实现 `ProviderAdapter` 接口
2. 在 `createProviderAdapter()` switch 中添加分支
3. 在 `src/core/modelCapabilities.ts` 添加 provider 默认值
4. 实现 SSE → OpenAI chunk 流转换

### 添加新测试
- 单元测试: `tests/<module>.test.ts`，vitest，纯函数
- 集成测试: `tests/engine.integration.test.ts`，mock OpenAI client
- 运行: `npx vitest run`（CI）/ `npx vitest`（watch）

## 安全注意事项

### 路径安全（必读）
**始终**在文件操作工具中使用 `src/core/pathSecurity.ts`：
- `containsPathTraversal(path)` — 检测 `..` / symlink tricks
- `containsNullByte(path)` — 检测空字节注入
- `isPathWithin(path, cwd)` — 确保在工作目录内

Read/Write/Edit/MultiEdit 工具必须验证所有三个检查。

### 权限模式
- `auto`: 默认放行，危险命令（rm -rf、sudo 等）自动升级为 ask
- `ask`: 默认询问用户
- `deny`: 默认拒绝，仅在规则显式允许时执行

### 密钥脱敏
- `src/core/envSafety.ts` 的 `safeEnv()` 生成子进程环境变量时过滤 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GITHUB_TOKEN`、`AWS_*`、`SECRET`、`TOKEN`、`PASSWORD`、`CREDENTIAL`
- 永远不会将原始 API key 暴露给 LLM

### 工具安全
- BashTool 使用 `classifyCommandRisk()` 进行三级风险分类（safe/needs_approval/dangerous）
- AgentToolFilter 防止子 agent 递归（全局禁用 Agent/EnterPlanMode/ExitPlanMode）
- 所有工具在执行前经过 PermissionChecker 闸门

## 构建 & 测试命令

```bash
# 类型检查（等价 npm run typecheck）
npx tsc --noEmit

# 所有测试
npx vitest run

# 单个测试文件
npx vitest run tests/riskClassifier.test.ts

# Lint（等价 npm run lint）
npx eslint src/ bin/ tests/

# 格式化检查 / 写入
npm run format:check
npm run format

# 运行引擎
npx tsx bin/ovogogogo.ts
```

## 测试统计

- 测试文件: 23
- 测试用例: 342
- 覆盖率目标: >85% 核心模块

## 项目健康基线

```
tsc --noEmit:  0 errors
vitest run:    342 passed · 0 failed · 23 files
eslint:         0 errors · 0 warnings
prettier:       0 violations (src/ bin/ tests/)
runtime deps:   3 (openai · glob · zod)
```
