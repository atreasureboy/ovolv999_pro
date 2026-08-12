/**
 * TaskIntent — 任务意图分类
 *
 * 在 run 开始时捕获结构化用户意图。
 * 用于：
 * - ModelRouter 路由决策
 * - CompletionContract 完成判断
 * - 工具过滤（informational 任务禁用写工具）
 */

export type TaskKind = 'informational' | 'analysis' | 'mutation'

export interface AcceptanceCriterion {
  id?: string
  description: string
  satisfied?: boolean
}

export interface VerificationRequirement {
  kind: 'test' | 'typecheck' | 'lint' | 'build' | 'command' | 'review' | 'manual'
  description: string
  satisfied?: boolean
}

export interface TaskIntent {
  kind: TaskKind
  /** 用户明确请求的结果 */
  requestedOutcomes: string[]
  /** 验收标准 */
  explicitAcceptanceCriteria: AcceptanceCriterion[]
  /** 是否需要工作区变更 */
  requiresWorkspaceChange: boolean
  /** 期望的验证 */
  expectedVerification: VerificationRequirement[]
  /** 分类置信度 (0..1) */
  confidence: number
  /** 分类来源 */
  source: 'static-rule' | 'keyword' | 'user-stated' | 'plan-mode'
  /** 原始用户消息 */
  userMessage: string
}

export type CustomIntentClassifier = (userMessage: string) => TaskIntent | null
const customClassifiers: CustomIntentClassifier[] = []

export function registerIntentClassifier(classifier: CustomIntentClassifier): () => void {
  customClassifiers.push(classifier)
  return () => {
    const idx = customClassifiers.indexOf(classifier)
    if (idx >= 0) customClassifiers.splice(idx, 1)
  }
}

/**
 * 静态规则分类器
 */
export function classifyTaskIntent(
  userMessage: string,
  options: {
    planMode?: boolean
    explicitKind?: TaskKind
    explicitAcceptanceCriteria?: AcceptanceCriterion[]
    expectedVerification?: VerificationRequirement[]
  } = {},
): TaskIntent {
  // Check custom registered classifiers first
  for (const custom of customClassifiers) {
    const res = custom(userMessage)
    if (res) return res
  }

  const text = userMessage.toLowerCase()

  const explicit = options.explicitKind
  const planMode = options.planMode ?? false
  const explicitCriteria = options.explicitAcceptanceCriteria ?? []

  // 最高优先级：用户明确指定的类型
  if (explicit) {
    return {
      kind: explicit,
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: explicit === 'mutation',
      expectedVerification: options.expectedVerification ?? [],
      confidence: 0.95,
      source: 'user-stated',
      userMessage,
    }
  }

  // Plan 模式始终是 analysis
  if (planMode) {
    return {
      kind: 'analysis',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: false,
      expectedVerification: options.expectedVerification ?? [],
      confidence: 0.9,
      source: 'plan-mode',
      userMessage,
    }
  }

  // 关键词匹配
  const mutationKeywords =
    /\b(fix|implement|refactor|rewrite|write|add|remove|delete|rename|edit|modify|patch|change|update|build|create|install|configure)\b|(修复|修改|实现|增加|新增|删除|重构|迁移|替换|优化)/
  const analysisKeywords =
    /\b(audit|analyze|review|design|architect|investigate|examine|explore|inspect|evaluate|assess|describe|explain|plan|verify|validate|check|test|diagnose|troubleshoot)\b|(审计|分析|检查|评估|设计|研究|解释|验证|测试|诊断|排查)/
  const informationalKeywords =
    /\b(what|why|how|when|where|who|explain|summarize|describe|tell me|show|list|find|locate|search|hello|hi)\b|(解释|说明|回答|总结|翻译|查询|是什么|怎么做|为什么)/

  if (mutationKeywords.test(text)) {
    return {
      kind: 'mutation',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: true,
      expectedVerification: options.expectedVerification ?? defaultVerificationForMutation(),
      confidence: 0.6,
      source: 'keyword',
      userMessage,
    }
  }

  if (analysisKeywords.test(text)) {
    return {
      kind: 'analysis',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: false,
      expectedVerification: options.expectedVerification ?? [],
      confidence: 0.6,
      source: 'keyword',
      userMessage,
    }
  }

  if (informationalKeywords.test(text)) {
    return {
      kind: 'informational',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: false,
      expectedVerification: [],
      confidence: 0.6,
      source: 'keyword',
      userMessage,
    }
  }

  // 默认：informational
  return {
    kind: 'informational',
    requestedOutcomes: extractOutcomes(userMessage),
    explicitAcceptanceCriteria: explicitCriteria,
    requiresWorkspaceChange: false,
    expectedVerification: options.expectedVerification ?? [],
    confidence: 0.3,
    source: 'static-rule',
    userMessage,
  }
}

function extractOutcomes(message: string): string[] {
  return message
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5 && s.length < 200)
    .slice(0, 5)
}

function defaultVerificationForMutation(): VerificationRequirement[] {
  return [
    { kind: 'typecheck', description: 'Project type-check passes after edits.' },
    { kind: 'lint', description: 'Lint passes after edits.' },
  ]
}
