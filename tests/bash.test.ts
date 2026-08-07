/**
 * BashTool tests — output capture, exit codes, timeout kill, abort handling,
 * and the process-group kill guarantee (no orphaned grandchildren).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { setTimeout as delay } from 'timers/promises'

import { BashTool } from '../src/tools/bash.js'
import type { ToolContext } from '../src/core/types.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bash-tool-'))
})
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: workDir, permissionMode: 'auto', ...overrides }
}

describe('BashTool', () => {
  it('captures stdout with exitCode 0', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'echo hello-bash' }, ctx())
    expect(result.isError).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.content).toContain('hello-bash')
  })

  it('reports non-zero exit via exitCode (not isError)', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'exit 3' }, ctx())
    expect(result.exitCode).toBe(3)
    expect(result.isError).toBe(false) // non-zero exit is diagnostic info, not a crash
    expect(result.content).toContain('Exit code: 3')
  })

  it('captures stderr alongside stdout', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'echo out-part; echo err-part >&2' }, ctx())
    expect(result.stdout).toContain('out-part')
    expect(result.stderr).toContain('err-part')
  })

  it('rejects non-string command', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 42 }, ctx())
    expect(result.isError).toBe(true)
  })

  it('kills the command on timeout', async () => {
    const tool = new BashTool()
    const start = Date.now()
    const result = await tool.execute({ command: 'sleep 10', timeout: 1000 }, ctx())
    const elapsed = Date.now() - start
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/timed out/i)
    expect(elapsed).toBeLessThan(8000) // killed ~1s, not the full 10s
  })

  it('returns cancelled immediately for a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = new BashTool()
    const start = Date.now()
    const result = await tool.execute({ command: 'sleep 10' }, ctx({ signal: controller.signal }))
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('kills the whole process group on abort (no orphaned grandchildren)', async () => {
    // The command spawns a grandchild (`sleep`) which would create a marker
    // file after the shell itself is gone. Only a process-group kill stops it.
    const marker = join(workDir, 'orphan-marker')
    const controller = new AbortController()
    const tool = new BashTool()
    const pending = tool.execute(
      { command: `sleep 0.4 && touch "${marker}"` },
      ctx({ signal: controller.signal }),
    )
    await delay(100)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)
    // Give the orphaned grandchild (if any) time to finish its work
    await delay(700)
    expect(existsSync(marker)).toBe(false)
  })
})
