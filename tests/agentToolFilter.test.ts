import { describe, it, expect } from 'vitest'
import { filterToolsForSubAgent, SUB_AGENT_DISALLOWED_TOOLS } from '../src/core/agentToolFilter.js'

describe('filterToolsForSubAgent', () => {
  const ALL_TOOLS = [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'Bash',
    'Agent',
    'EnterPlanMode',
    'ExitPlanMode',
    'WebFetch',
    'mcp__myServer',
    'mcp__otherServer',
  ]

  it('removes globally disallowed tools', () => {
    const result = filterToolsForSubAgent(ALL_TOOLS, undefined, undefined)
    expect(result).not.toContain('Agent')
    expect(result).not.toContain('EnterPlanMode')
    expect(result).not.toContain('ExitPlanMode')
  })

  it('filters to allowlist when provided', () => {
    const result = filterToolsForSubAgent(ALL_TOOLS, ['Read', 'Glob', 'Bash'], undefined)
    expect(result).toContain('Read')
    expect(result).toContain('Glob')
    expect(result).toContain('Bash')
    expect(result).not.toContain('Write')
    expect(result).not.toContain('Edit')
    // Globally disallowed tools are still removed even if in allowlist
    expect(result).not.toContain('Agent')
  })

  it('always allows mcp__ tools in allowlist mode', () => {
    const result = filterToolsForSubAgent(ALL_TOOLS, ['Read'], undefined)
    expect(result).toContain('Read')
    expect(result).toContain('mcp__myServer')
    expect(result).toContain('mcp__otherServer')
    expect(result).not.toContain('Write')
  })

  it('applies denylist after global disallowed and allowlist', () => {
    const result = filterToolsForSubAgent(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'], undefined, [
      'Bash',
      'WebFetch',
    ])
    expect(result).toContain('Read')
    expect(result).toContain('Glob')
    expect(result).toContain('Grep')
    expect(result).not.toContain('Bash')
    expect(result).not.toContain('WebFetch')
  })

  it('applies allowlist then denylist', () => {
    const result = filterToolsForSubAgent(ALL_TOOLS, ['Read', 'Bash'], ['Bash'])
    expect(result).toContain('Read')
    expect(result).not.toContain('Bash')
  })

  it('handles empty tool list', () => {
    const result = filterToolsForSubAgent([], undefined, undefined)
    expect(result).toEqual([])
  })

  it('handles undefined allowlist and denylist', () => {
    const result = filterToolsForSubAgent(['Read', 'Write'], undefined, undefined)
    expect(result).toEqual(['Read', 'Write'])
  })

  it('SUB_AGENT_DISALLOWED_TOOLS contains expected entries', () => {
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Agent')).toBe(true)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('EnterPlanMode')).toBe(true)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('ExitPlanMode')).toBe(true)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Read')).toBe(false)
  })
})
