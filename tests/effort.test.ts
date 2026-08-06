import { describe, it, expect, afterAll } from 'vitest'
import {
  EFFORT_PRESETS,
  getEffortConfig,
  setEffort,
  getCurrentEffort,
  cycleEffort,
  isExecutionProfile,
  detectExecutionProfile,
  type EffortLevel,
} from '../src/core/effort.js'

describe('Effort presets', () => {
  it('has all five levels', () => {
    const levels: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'maximum']
    for (const level of levels) {
      expect(EFFORT_PRESETS[level]).toBeDefined()
      expect(EFFORT_PRESETS[level].level).toBe(level)
    }
  })

  it('minimal has zero thinking tokens', () => {
    expect(EFFORT_PRESETS.minimal.thinkingTokens).toBe(0)
    expect(EFFORT_PRESETS.minimal.verificationDepth).toBe('none')
  })

  it('maximum has the highest values', () => {
    const max = EFFORT_PRESETS.maximum
    const high = EFFORT_PRESETS.high
    expect(max.thinkingTokens).toBeGreaterThan(high.thinkingTokens)
    expect(max.maxSearchResults).toBeGreaterThan(high.maxSearchResults)
  })

  it('levels have monotonically increasing thinkingTokens', () => {
    const levels: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'maximum']
    for (let i = 1; i < levels.length; i++) {
      expect(EFFORT_PRESETS[levels[i]].thinkingTokens).toBeGreaterThanOrEqual(
        EFFORT_PRESETS[levels[i - 1]].thinkingTokens,
      )
    }
  })
})

describe('getEffortConfig', () => {
  it('returns config for specified level', () => {
    const config = getEffortConfig('low')
    expect(config.level).toBe('low')
    expect(config.thinkingTokens).toBe(500)
  })

  it('returns config for current level when no arg', () => {
    setEffort('high')
    const config = getEffortConfig()
    expect(config.level).toBe('high')
  })
})

describe('setEffort / getCurrentEffort', () => {
  it('updates current effort', () => {
    setEffort('minimal')
    expect(getCurrentEffort()).toBe('minimal')

    setEffort('maximum')
    expect(getCurrentEffort()).toBe('maximum')
  })

  it('returns the full config after setEffort', () => {
    const config = setEffort('low')
    expect(config.level).toBe('low')
    expect(config.thinkingTokens).toBe(500)
  })

  // Reset to default after tests
  afterAll(() => {
    setEffort('medium')
  })
})

describe('cycleEffort', () => {
  it('cycles through all levels', () => {
    setEffort('minimal')
    expect(cycleEffort()).toBe('low')
    expect(cycleEffort()).toBe('medium')
    expect(cycleEffort()).toBe('high')
    expect(cycleEffort()).toBe('maximum')
    expect(cycleEffort()).toBe('minimal')
  })

  afterAll(() => {
    setEffort('medium')
  })
})

describe('isExecutionProfile', () => {
  it('recognizes valid profiles', () => {
    expect(isExecutionProfile('fast')).toBe(true)
    expect(isExecutionProfile('standard')).toBe(true)
    expect(isExecutionProfile('deep')).toBe(true)
    expect(isExecutionProfile('autonomous')).toBe(true)
  })

  it('rejects invalid profiles', () => {
    expect(isExecutionProfile('medium')).toBe(false)
    expect(isExecutionProfile('')).toBe(false)
    expect(isExecutionProfile('unknown')).toBe(false)
  })
})

describe('detectExecutionProfile', () => {
  it('returns fast for empty prompt', () => {
    expect(detectExecutionProfile('')).toBe('fast')
  })

  it('returns fast for simple questions', () => {
    expect(detectExecutionProfile('what is the weather')).toBe('fast')
    expect(detectExecutionProfile('how do I use this')).toBe('fast')
    expect(detectExecutionProfile('list all files')).toBe('fast')
  })

  it('returns standard for edits', () => {
    expect(detectExecutionProfile('fix the login bug')).toBe('standard')
    expect(detectExecutionProfile('add a new endpoint')).toBe('standard')
    expect(detectExecutionProfile('edit the config file')).toBe('standard')
  })

  it('returns deep for complex tasks', () => {
    expect(detectExecutionProfile('refactor the authentication module')).toBe('deep')
    expect(detectExecutionProfile('redesign the database schema')).toBe('deep')
    expect(detectExecutionProfile('migrate to TypeScript 5')).toBe('deep')
  })

  it('returns standard for short mutation commands', () => {
    expect(detectExecutionProfile('fix bug')).toBe('standard')
  })
})
