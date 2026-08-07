/**
 * WebFetchTool — SSRF guard on cloud metadata endpoints.
 */
import { describe, it, expect } from 'vitest'
import { WebFetchTool } from '../src/tools/webFetch.js'
import type { ToolContext } from '../src/core/types.js'

const ctx: ToolContext = { cwd: process.cwd(), permissionMode: 'auto' }

describe('WebFetchTool SSRF guard', () => {
  it('blocks the link-local cloud metadata IP', async () => {
    const tool = new WebFetchTool()
    const result = await tool.execute(
      { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/blocked|metadata/i)
  })

  it('blocks metadata.google.internal', async () => {
    const tool = new WebFetchTool()
    const result = await tool.execute(
      { url: 'http://metadata.google.internal/computeMetadata/v1/' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/blocked|metadata/i)
  })

  it('rejects non-http schemes', async () => {
    const tool = new WebFetchTool()
    const result = await tool.execute({ url: 'file:///etc/passwd' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('rejects a missing url', async () => {
    const tool = new WebFetchTool()
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
  })
})
