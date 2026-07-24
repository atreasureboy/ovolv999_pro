import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileMultiEditTool } from '../src/tools/fileMultiEdit.js'
import { writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('FileMultiEditTool', () => {
  const testDir = join(tmpdir(), `multiedit-test-${Date.now()}`)
  const testFile = join(testDir, 'sample.txt')
  const tool = new FileMultiEditTool()

  beforeEach(async () => {
    const { mkdir } = await import('fs/promises')
    await mkdir(testDir, { recursive: true })
    const initialContent = [
      'line 1: alpha',
      'line 2: beta',
      'line 3: gamma',
      'line 4: delta',
      'line 5: epsilon',
    ].join('\n')
    await writeFile(testFile, initialContent, 'utf8')
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('applies multiple non-contiguous edits atomically', async () => {
    const res = await tool.execute(
      {
        file_path: testFile,
        chunks: [
          { old_string: 'alpha', new_string: 'ALPHA' },
          { old_string: 'gamma', new_string: 'GAMMA' },
        ],
      },
      { cwd: testDir, permissionMode: 'auto' },
    )

    expect(res.isError).toBe(false)
    const content = await readFile(testFile, 'utf8')
    expect(content).toContain('line 1: ALPHA')
    expect(content).toContain('line 3: GAMMA')
    expect(content).toContain('line 2: beta')
  })

  it('handles scoped line ranges correctly', async () => {
    const res = await tool.execute(
      {
        file_path: testFile,
        chunks: [
          {
            old_string: 'delta',
            new_string: 'DELTA',
            start_line: 3,
            end_line: 5,
          },
        ],
      },
      { cwd: testDir, permissionMode: 'auto' },
    )

    expect(res.isError).toBe(false)
    const content = await readFile(testFile, 'utf8')
    expect(content).toContain('line 4: DELTA')
  })

  it('fails cleanly when old_string is missing', async () => {
    const res = await tool.execute(
      {
        file_path: testFile,
        chunks: [{ old_string: 'nonexistent', new_string: 'foo' }],
      },
      { cwd: testDir, permissionMode: 'auto' },
    )

    expect(res.isError).toBe(true)
    expect(res.content).toContain('old_string not found')
  })
})
