import { describe, it, expect, vi } from 'vitest'
import { wrapMcpTool } from '../src/mcp/wrapper.js'
import type { McpClient, McpContentBlock } from '../src/mcp/client.js'

/** Minimal McpClient double — only serverName + callTool are used by the wrapper. */
function mockClient(serverName: string, callTool: (name: string, args: Record<string, unknown>) => Promise<McpContentBlock[]>): McpClient {
  return { serverName, callTool } as unknown as McpClient
}

describe('wrapMcpTool', () => {
  it('names tools as mcp__<server>__<tool>', () => {
    const client = mockClient('time', () => Promise.resolve([]))
    const tool = wrapMcpTool(client, { name: 'now', description: 'current time' })
    expect(tool.name).toBe('mcp__time__now')
    expect(tool.definition.function.name).toBe('mcp__time__now')
    expect(tool.definition.function.description).toContain('mcp:time')
  })

  it('passes the inputSchema through as parameters', () => {
    const client = mockClient('s', () => Promise.resolve([]))
    const tool = wrapMcpTool(client, {
      name: 't',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    })
    expect(tool.definition.function.parameters).toEqual({
      type: 'object', properties: { x: { type: 'string' } }, required: ['x'],
    })
  })

  it('execute calls the client and flattens text blocks', async () => {
    const callTool = vi.fn(() => Promise.resolve([
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ]))
    const client = mockClient('srv', callTool)
    const tool = wrapMcpTool(client, { name: 'do', description: 'd' })
    const res = await tool.execute({ x: 1 }, {} as never)
    expect(callTool).toHaveBeenCalledWith('do', { x: 1 })
    expect(res.isError).toBe(false)
    expect(res.content).toBe('line 1\nline 2')
  })

  it('execute returns an error result when the client throws', async () => {
    const client = mockClient('srv', () => Promise.reject(new Error('boom')))
    const tool = wrapMcpTool(client, { name: 'do' })
    const res = await tool.execute({}, {} as never)
    expect(res.isError).toBe(true)
    expect(res.content).toContain('boom')
  })

  it('execute reports an empty-content result explicitly', async () => {
    const client = mockClient('srv', () => Promise.resolve([]))
    const tool = wrapMcpTool(client, { name: 'do' })
    const res = await tool.execute({}, {} as never)
    expect(res.content).toContain('no content')
  })

  it('represents non-text blocks compactly', async () => {
    const client = mockClient('srv', () => Promise.resolve([
      { type: 'image', data: 'b64' },
      { type: 'text', text: 'caption' },
    ]))
    const tool = wrapMcpTool(client, { name: 'do' })
    const res = await tool.execute({}, {} as never)
    expect(res.content).toContain('[image block]')
    expect(res.content).toContain('caption')
  })

  it('defaults concurrencySafe to false (unknown side effects)', () => {
    const client = mockClient('s', () => Promise.resolve([]))
    const tool = wrapMcpTool(client, { name: 't' })
    expect(tool.concurrencySafe).toBe(false)
  })
})
