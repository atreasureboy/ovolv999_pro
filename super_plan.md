# Super Plan — ovolv999 全面优化计划 (Phase 1: 大方向)

> **目标**: 将项目从"个人项目级别的 agent harness"提升为"成熟、生产可用的 agent 运行时框架"
> **策略**: 5 轮迭代，每轮聚焦一个维度，由粗到细、由架构到细节
> **核心原则**: 消除"表面接入"（wired but non-functional），深度集成所有子系统

---

## 审计发现汇总

### 🔴 临界 — 安全漏洞
| # | 问题 | 文件 | 严重度 |
|---|------|------|--------|
| S1 | FileReadTool 缺少路径安全校验（Write/Edit 有，Read 没有） | `src/tools/fileRead.ts` | 高 |
| S2 | start.sh `export "$(grep -v '^#' .env | xargs)"` 不安全 | `start.sh` | 中 |
| S3 | loadSkill 的权限校验在 `availableToolNames` 未设置时静默跳过 | `src/tools/loadSkill.ts:67` | 中 |

### 🟡 严重 — "表面接入"（Wired but Non-Functional）
| # | 问题 | 文件 | 严重度 |
|---|------|------|--------|
| D1 | **WorkingState** 完整实现但 ENGINE 从未更新它 — 纯死代码 | `src/core/engine.ts`, `src/core/workingState.ts` | 高 |
| D2 | **TaskIntent** 分类结果不驱动任何行为 — 分类完就丢弃 | `src/core/engine.ts`, `src/core/taskIntent.ts` | 高 |
| D3 | **CompletionContract** 定义了验收逻辑但从未在 loop 中检查 | `src/core/completionContract.ts` | 高 |
| D4 | **ResourceScheduler** 创建了但 claims 机制从未执行 | `src/core/resourceScheduler.ts` | 高 |
| D5 | **AnthropicAdapter** 纯占位符，回退到 OpenAI 模式 — 不是真正的 Anthropic 支持 | `src/core/providerAdapter.ts` | 高 |
| D6 | **ThinkingTagFilter** 创建了但从未用于过滤输出 | `src/core/thinkingTagFilter.ts` | 中 |
| D7 | **StructuredToolResult** 类型定义了但无工具返回结构化结果 | `src/core/structuredToolResult.ts` | 中 |
| D8 | **ExecutionProfile** 检测了但从不影响引擎行为 | `src/core/effort.ts` | 中 |
| D9 | **BackgroundTaskManager** 创建了但后台任务生命周期未集成 | `src/core/backgroundTaskManager.ts` | 中 |

### 🟠 中等 — 功能不完整
| # | 问题 | 文件 | 严重度 |
|---|------|------|--------|
| M1 | CriticModule 的 parseCriticOutput 只是透传原文，不解构 [问题]/[纠正] 格式 | `src/prompts/critic.ts:94` | 中 |
| M2 | modelCapabilities 多处不准确：llama→ollama 映射、promptCaching 默认值、reasoningTokens 过宽 | `src/core/modelCapabilities.ts` | 中 |
| M3 | SemanticMemory.write 去重是 O(n)，大量条目会变慢 | `src/core/semanticMemory.ts:144` | 中 |
| M4 | ReflectionModule consolidateSession 第 206 行缩进不一致 | `src/modules/reflection.ts:206` | 低 |
| M5 | 缺少 API 调用客户端侧速率限制 | `src/core/modelGateway.ts` | 中 |

### 🔵 低 — 测试覆盖缺失
| # | 缺失的测试文件 | 优先级 |
|---|---------------|--------|
| T1 | `riskClassifier.test.ts` | 高 |
| T2 | `agentToolFilter.test.ts` | 中 |
| T3 | `modelGateway.test.ts` | 中 |
| T4 | `envSafety.test.ts` | 中 |
| T5 | `taskIntent.test.ts` | 中 |
| T6 | `workingState.test.ts` | 中 |
| T7 | `completionContract.test.ts` | 低 |
| T8 | `effort.test.ts` | 低 |
| T9 | `hooks.test.ts` | 低 |

### ⚪ 文档
| # | 问题 | 优先级 |
|---|------|--------|
| D1 | 缺少 CLAUDE.md (AI 协作规范) | 高 |
| D2 | README 仅中文，缺少英文摘要 | 低 |
| D3 | 缺少架构图 / 数据流图 | 低 |

---

## Round 1: 安全加固 + 基础修复 🛡️

### 目标
修复所有安全漏洞和基础缺陷，确保核心路径安全可靠。

### 任务清单

#### 1.1 FileReadTool 安全加固 (S1)
- **文件**: `src/tools/fileRead.ts`
- **改动**: 加入 `containsPathTraversal`、`containsNullByte`、`isPathWithin` 检查（对齐 FileWrite/FileEdit）
- **验证**: 现有 pathSecurity 测试必须通过，新增 FileRead 安全测试

#### 1.2 start.sh 安全修复 (S2)
- **文件**: `start.sh`
- **改动**: 替换 `export "$(grep -v '^#' .env | xargs)"` 为安全的逐行加载方式
  ```bash
  set -a
  [ -f .env ] && . ./.env
  set +a
  ```
- **验证**: 手动测试 start.sh 行为一致

#### 1.3 loadSkill 权限校验强化 (S3)
- **文件**: `src/tools/loadSkill.ts`
- **改动**: 当 `context.availableToolNames` 为 undefined 时，发出警告而非静默跳过
- **验证**: 新增测试用例覆盖 availableToolNames=undefined 场景

#### 1.4 setup.bat 移除（可选）
- **文件**: `setup.bat`
- **原因**: Windows 批处理文件与项目 Linux/macOS 定位不一致
- **验证**: 确认不影响 npm 发布

### 预期成果
- 零已知安全漏洞
- 文件操作工具安全一致性
- Shell 脚本安全基线

---

## Round 2: 架构补全 — 把"表面接入"变成"实际接入" 🏗️

### 目标
将已定义但未集成的子系统真正接入引擎主循环，让它们产生实际效果。

### 任务清单

#### 2.1 接入 WorkingState 更新 (D1)
- **文件**: `src/core/engine.ts`, `src/core/toolRuntime/toolExecutor.ts`
- **改动**:
  - 在 ToolExecutor 中，执行文件工具后调用 `recordFileRead()` / `recordFileChange()`
  - 在引擎 loop 中，将 WorkingState 序列化注入到 context budget 计算
  - 工具返回结果时附带 WorkingState delta
- **关键**: 这使 Agent 的上下文压缩能保留结构化任务状态

#### 2.2 TaskIntent 驱动工具过滤 (D2)
- **文件**: `src/core/engine.ts`, `src/core/toolPolicy.ts`
- **改动**:
  - `informational` 任务自动禁用写工具（Write/Edit/Bash）
  - `analysis` 任务保持 read-only
  - `mutation` 任务正常启用全部工具
  - ToolPolicy 读取 TaskIntent.kind 做过滤决策
- **验证**: 集成测试验证不同 TaskKind 的工具暴露

#### 2.3 接入 CompletionContract (D3)
- **文件**: `src/core/engine.ts`, `src/core/completionContract.ts`
- **改动**:
  - 引擎 loop 结束后调用 CompletionContract 验证
  - runTurn 的 TurnResult 增加 completionStatus 字段
  - 如果验证不通过，注入提示让 Agent 继续修复
- **验证**: 集成测试验证 completion check 逻辑

#### 2.4 接入 ResourceScheduler (D4)
- **文件**: `src/core/toolRuntime/toolScheduler.ts`, `src/core/resourceScheduler.ts`
- **改动**:
  - ToolScheduler 执行工具前检查 resource claims
  - 冲突时排队延迟执行
  - 工具完成后释放 claims
- **验证**: 测试 resource claim 冲突场景

#### 2.5 接入 ThinkingTagFilter (D6)
- **文件**: `src/core/engine.ts`, `src/core/thinkingTagFilter.ts`
- **改动**:
  - 流式输出经过 ThinkingTagFilter 处理后再渲染
  - 过滤 `<｜end▁of▁thinking｜>` / `thinking` 等 XML 标记
- **验证**: 确认非标记文本不受影响

#### 2.6 接入 ExecutionProfile (D8)
- **文件**: `src/core/engine.ts`, `src/core/effort.ts`
- **改动**:
  - 根据 ExecutionProfile 自动调整 iteration 频率检查
  - 高 effort profile → 更宽松的 stall 检测
  - 低 effort profile → 更激进的 early termination
- **验证**: 测试不同 profile 下的引擎行为差异

### 预期成果
- WorkingState 在引擎中实际流动和更新
- TaskIntent 真正影响工具可用性
- CompletionContract 在 loop 结束后检查验收
- ResourceScheduler 阻止冲突操作
- ThinkingTagFilter 改善输出质量
- ExecutionProfile 影响引擎调度

---

## Round 3: 深度集成 — 修复伪接入 🧩

### 目标
将"有代码但实际不工作"的组件修复为真正可用的功能。

### 任务清单

#### 3.1 AnthropicAdapter 真正支持 Anthropic API (D5)
- **文件**: `src/core/providerAdapter.ts`, 新增 `src/core/anthropicFormat.ts`
- **改动**:
  - 使用 `fetch()` 直接调用 Anthropic Messages API（不依赖 `@anthropic-ai/sdk`）
  - 实现 Anthropic SSE 流 → OpenAI ChatCompletionChunk 格式转换
  - 处理 Anthropic 的 system prompt（顶层字段）、tool schema（`input_schema`）、thinking blocks
  - 如果不想维护完整实现，则：
    - 移除 AnthropicAdapter class
    - `createProviderAdapter` 中对 `anthropic` 返回 OpenAICompatibleAdapter + 警告日志
    - 利用 `/v1/messages` → OpenAI `/v1/chat/completions` 的兼容代理
- **验证**: 集成测试使用 mock 的 Anthropic SSE 响应

#### 3.2 CriticModule 结构化输出解析 (M1)
- **文件**: `src/prompts/critic.ts`
- **改动**:
  - `parseCriticOutput()` 真正解析 `[问题] ... [纠正] ...` 格式
  - 返回结构化 `Array<{problem: string, correction: string}>`
  - 无结构化输出时回退到 raw 模式
- **验证**: 单元测试覆盖多种 critic 输出格式

#### 3.3 ProviderAdapter 统一 Provider 检测
- **文件**: `src/core/modelGateway.ts`, `src/core/providerAdapter.ts`
- **改动**:
  - ModelGateway 调用前先通过 `detectProvider(model)` 确定 provider
  - 动态选择正确的 adapter
  - 修复 `streamUsageSupported` 的各种 provider 默认值错误
- **验证**: 测试不同 model 名称的 provider 检测

#### 3.4 modelCapabilities 修正 (M2)
- **文件**: `src/core/modelCapabilities.ts`
- **改动**:
  - `llama` → `openrouter`（不一定是 ollama）
  - `mistral/mixtral` → `openrouter`（不一定是 mistral API）
  - 修正 promptCaching: openai 默认 false（需显式 opt-in）
  - 修正 reasoningTokens: 仅 o1/o3/o4/deepseek-r1
  - 增加 known models map 用于精确匹配
- **验证**: 单元测试覆盖所有 provider + 常见 model

#### 3.5 StructuredToolResult 实际使用 (D7)
- **文件**: `src/tools/*.ts`
- **改动**:
  - BashTool 返回结构化结果（exitCode, stdout, stderr）
  - FileWrite/Edit 返回结构化结果（bytesWritten, linesChanged）
  - 引擎保持向后兼容（`ToolResult.content` 仍可用）
- **验证**: 测试结构化结果格式

#### 3.6 SemanticMemory 性能优化 (M3)
- **文件**: `src/core/semanticMemory.ts`
- **改动**: 增加 contentHash → id 的 Map 索引，避免 O(n) 扫描
- **验证**: 性能测试确认大数据集下 write 速度

### 预期成果
- AnthropicAdapter 真正工作（或明确声明不支持并干净降级）
- Critic 输出被结构化解析
- Provider 检测准确
- 工具返回结构化结果
- SemanticMemory 去重性能优化

---

## Round 4: 测试覆盖 + 质量门 🧪

### 目标
将测试覆盖率从当前的 ~60% 提升到 ~85%，新增 8+ 测试文件。

### 任务清单

#### 4.1 新增测试文件 (T1-T9)

| 测试文件 | 测试对象 | 核心用例 |
|----------|----------|----------|
| `tests/riskClassifier.test.ts` | `riskClassifier.ts` | 安全命令/危险命令/Git 子命令/复合命令/环境变量赋值 |
| `tests/agentToolFilter.test.ts` | `agentToolFilter.ts` | 全局禁止列表/allowlist/denylist/MCP 工具豁免 |
| `tests/modelGateway.test.ts` | `modelGateway.ts` | 流消费/usage 跟踪/上下文溢出重试/provider 降级 |
| `tests/envSafety.test.ts` | `envSafety.ts` | 敏感 env 过滤/自定义 env 注入 |
| `tests/taskIntent.test.ts` | `taskIntent.ts` | 中英关键词匹配/plan mode/默认分类 |
| `tests/workingState.test.ts` | `workingState.ts` | 增删改查/序列化/压缩不变量检查 |
| `tests/completionContract.test.ts` | `completionContract.ts` | 完成状态判定/证据/阻塞项 |
| `tests/effort.test.ts` | `effort.ts` | Profile 检测/配置影响 |

#### 4.2 补充现有测试
- `tests/engine.test.ts`: 增加 WorkingState 更新路径测试
- `tests/permission.test.ts`: 增加 plan/deny/ask/bubble 模式的综合分析测试
- `tests/mcp.test.ts`: 增加工具转换/schema 处理测试

#### 4.3 集成测试扩充
- `tests/engine.integration.test.ts`:
  - TaskIntent 驱动工具过滤
  - CompletionContract 验证
  - ResourceScheduler 冲突
  - WorkingState 流经完整 turn

### 预期成果
- 165 → 220+ 测试
- 核心模块覆盖率 >85%
- CI 就绪（零失败、零跳过）

---

## Round 5: 文档 + 开发者体验 📝

### 目标
让新开发者能快速理解架构并贡献代码。

### 任务清单

#### 5.1 创建 CLAUDE.md (D1)
- **文件**: `CLAUDE.md`
- **内容**:
  - 项目架构概览（Harness + Module + Tool 三层）
  - 代码风格约定（no semi, single quotes, strict TS）
  - 测试规范（vitest, 命名约定, mock 模式）
  - 关键设计决策记录（为什么不用 enum、为什么模块组合优于类型枚举）
  - 常见开发流程（加新工具、加新模块、加新 provider）
  - 安全注意事项（路径校验、权限模式、密钥脱敏）

#### 5.2 README 增强 (D2)
- **文件**: `README.md`
- **改动**:
  - 顶部添加英文 Architecture Overview（3-5 段）
  - 添加 ASCII 架构图或 Mermaid 图
  - 明确标注哪些是 production-ready、哪些是 experimental

#### 5.3 代码注释补全
- **文件**: `src/core/engine.ts`, `src/core/modelGateway.ts`, `src/core/module.ts`
- **改动**: 在关键路径增加行内注释，解释 WHY 而非 WHAT

#### 5.4 修复已知小问题
- `src/modules/reflection.ts:206`: 修正缩进
- `src/core/providerAdapter.ts`: 标记 AnthropicAdapter 为 `@deprecated` 或补全实现
- `src/core/modelCapabilities.ts`: 标注已知限制

#### 5.5 .env.example 增强
- **文件**: `.env.example`
- **改动**: 增加更多可选配置项说明、注释每个变量的用途和默认值

### 预期成果
- 新开发者 5 分钟看懂架构
- 所有关键路径有注释
- 文档中英双语覆盖

---

## 实施顺序与依赖

```
Round 1 (安全) → Round 2 (架构补全) → Round 3 (深度集成) → Round 4 (测试) → Round 5 (文档)
     ↓                    ↓                    ↓                   ↓
  立即开始          依赖 R1 安全基线     依赖 R2 接口稳定     依赖 R3 实现稳定
```

每轮完成后：
1. `npm run lint` — 零错误
2. `npm test` — 全部通过
3. `npm run build` — 编译成功
4. Git commit + meaningful message

---

## 成功标准

| 指标 | 当前 | 目标 (R5 后) |
|------|------|-------------|
| 测试数量 | 165 | 220+ |
| 测试通过率 | 100% | 100% |
| ESLint 错误 | 0 | 0 |
| 安全漏洞 | 3 已知 | 0 |
| 死代码子系统 | 9 (表面接入) | ≤2 |
| 文档语言 | 仅中文 | 中英双语 |
| CLAUDE.md | 无 | 完整 |
| Provider 支持 | OpenAI only (Anthropic 占位) | OpenAI + Anthropic (或明确标注) |
| 代码行数 | ~15,918 | ~17,000-18,000 |

---

## 第二次审计范围 (Phase 1 完成后)

在 5 轮完成后，执行第二次全面审计，重点关注：
1. **残留的"表面接入"** — 是否还有子系统接入但无效果？
2. **新增的回归问题** — Round 2-3 的深度接入是否引入了新 bug？
3. **测试覆盖率真实性** — 测试是否真正验证行为而非仅覆盖行数？
4. **性能回归** — 新接入的子系统是否影响了引擎性能？
5. **API 兼容性** — 改动是否破坏了现有 API 约定？
