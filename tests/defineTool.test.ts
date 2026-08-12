import { describe, it, expect } from 'vitest'
import { defineTool } from '../src/tools/defineTool.js'

describe('defineTool functional declarator', () => {
  it('creates a standard Tool object with defaults', async () => {
    const tool = defineTool({
      name: 'hello_tool',
      description: 'Says hello',
      properties: { name: { type: 'string' } },
      required: ['name'],
      execute: async ({ name }) => `Hello, ${name}!`,
    })

    expect(tool.name).toBe('hello_tool')
    expect(tool.category).toBe('readonly')
    expect(tool.riskLevel).toBe('safe')
    expect(tool.concurrencySafe).toBe(true)

    const res = await tool.execute({ name: 'World' }, {} as any)
    expect(res.content).toBe('Hello, World!')
    expect(res.isError).toBe(false)
  })

  it('handles input validation correctly', async () => {
    const tool = defineTool({
      name: 'strict_tool',
      description: 'Requires valid id',
      validateInput: (input) => {
        if (!input.id) return { valid: false, reason: 'missing id' }
        return { valid: true }
      },
      execute: async ({ id }) => `ID: ${id}`,
    })

    const invalidRes = await tool.execute({}, {} as any)
    expect(invalidRes.isError).toBe(true)
    expect(invalidRes.content).toContain('missing id')

    const validRes = await tool.execute({ id: '123' }, {} as any)
    expect(validRes.isError).toBe(false)
    expect(validRes.content).toBe('ID: 123')
  })
})
