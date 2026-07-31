/**
 * Effort System — 推理深度控制
 *
 * EffortLevel: 控制 thinkingTokens、searchResults、verificationDepth
 * ExecutionProfile: 控制模块集、迭代上限、输出预算、隐藏工具
 */

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'maximum'

export interface EffortConfig {
  level: EffortLevel
  thinkingTokens: number
  maxSearchResults: number
  verificationDepth: 'none' | 'quick' | 'thorough'
  explanationDetail: 'minimal' | 'normal' | 'detailed'
}

export const EFFORT_PRESETS: Record<EffortLevel, EffortConfig> = {
  minimal: {
    level: 'minimal',
    thinkingTokens: 0,
    maxSearchResults: 3,
    verificationDepth: 'none',
    explanationDetail: 'minimal',
  },
  low: {
    level: 'low',
    thinkingTokens: 500,
    maxSearchResults: 5,
    verificationDepth: 'none',
    explanationDetail: 'minimal',
  },
  medium: {
    level: 'medium',
    thinkingTokens: 2000,
    maxSearchResults: 10,
    verificationDepth: 'quick',
    explanationDetail: 'normal',
  },
  high: {
    level: 'high',
    thinkingTokens: 5000,
    maxSearchResults: 20,
    verificationDepth: 'thorough',
    explanationDetail: 'detailed',
  },
  maximum: {
    level: 'maximum',
    thinkingTokens: 10000,
    maxSearchResults: 50,
    verificationDepth: 'thorough',
    explanationDetail: 'detailed',
  },
}

let currentEffort: EffortLevel = 'medium'

export function getCurrentEffort(): EffortLevel {
  return currentEffort
}

export function setEffort(level: EffortLevel): EffortConfig {
  currentEffort = level
  return getEffortConfig(level)
}

export function getEffortConfig(level?: EffortLevel): EffortConfig {
  return EFFORT_PRESETS[level ?? currentEffort]
}

export function cycleEffort(): EffortLevel {
  const levels: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'maximum']
  const idx = levels.indexOf(currentEffort)
  const next = levels[(idx + 1) % levels.length]
  currentEffort = next
  return next
}

export type ExecutionProfile = 'fast' | 'standard' | 'deep' | 'autonomous'

export interface ExecutionProfileSpec {
  modules: string[]
  maxIterations?: number
  maxOutputTokens?: number
  excludedTools?: string[]
  description: string
}

export const EXECUTION_PROFILES: Record<ExecutionProfile, ExecutionProfileSpec> = {
  fast: {
    modules: ['memory', 'workspace'],
    maxIterations: 30,
    excludedTools: ['Agent'],
    description: 'Lightweight turn: no Critic, no Reflection, no sub-agents.',
  },
  standard: {
    modules: ['memory', 'workspace'],
    description: 'Default: standard module set.',
  },
  deep: {
    modules: ['memory', 'critic', 'workspace', 'reflection'],
    maxIterations: 300,
    maxOutputTokens: 32000,
    description: 'Complex tasks: raised iteration and output budgets.',
  },
  autonomous: {
    modules: ['memory', 'critic', 'workspace', 'reflection'],
    description: 'Background loop autonomy.',
  },
}

export function isExecutionProfile(value: string): value is ExecutionProfile {
  return value === 'fast' || value === 'standard' || value === 'deep' || value === 'autonomous'
}

export function detectExecutionProfile(taskPrompt: string): ExecutionProfile {
  const prompt = taskPrompt.toLowerCase().trim()
  if (!prompt) return 'fast'

  const isComplex = /(architect|refactor|migrat|redesign|multi-file|cross-module|rewrite)/.test(prompt)
  if (isComplex) return 'deep'

  const isQuestion = /^(what|how|why|explain|tell|where|is|can|show|list|find|search|grep|status|health)\b/.test(prompt)
  const isEditAction = /(fix|edit|add|write|modify|create|delete|update|replace|implement|build|remove)/.test(prompt)

  if (isQuestion && !isEditAction) return 'fast'
  if (prompt.length < 30 && !isEditAction) return 'fast'

  return 'standard'
}
