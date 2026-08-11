import { describe, it, expect } from 'vitest'
import { atomicWriteSync } from '../src/core/atomicWrite.js'
import {
  readFileSync,
  statSync,
  unlinkSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmdirSync,
} from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

describe('atomicWriteSync', () => {
  function tmpFile(name: string): string {
    return join(
      tmpdir(),
      `ovogo-aw-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    )
  }

  it('writes content atomically and preserves it on success', () => {
    const f = tmpFile('basic')
    atomicWriteSync(f, 'hello world')
    expect(readFileSync(f, 'utf8')).toBe('hello world')
    unlinkSync(f)
  })

  it('leaves no stray temp file behind after a successful write', () => {
    const f = tmpFile('notemp')
    atomicWriteSync(f, 'data')
    // No leftover temp files for this target name.
    expect(existsSync(`${f}.tmp`)).toBe(false)
    unlinkSync(f)
  })

  it('cleans up the temp file when rename throws', () => {
    // Targeting a non-empty directory makes rename throw EISDIR/ENOTEMPTY. The
    // temp file written next to it (in the same parent dir) must be unlinked.
    const tempRoot = tmpFile('cleanup-root')
    atomicWriteSync(tempRoot, 'seed') // valid writable parent + exists
    const targetDir = join(dirname(tempRoot), 'ovogo-targetdir-' + Date.now())
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'occupant'), 'x') // make it non-empty
    // atomicWriteSync writes temp into dirname(targetDir) (the shared tmpdir),
    // then renames onto targetDir (a non-empty dir) which throws.
    const parentDir = dirname(targetDir)

    expect(() => atomicWriteSync(targetDir, 'payload')).toThrow()

    // No leftover .tmp.* file for this run remains in the parent directory.
    const leftover = readdirSync(parentDir).filter(
      (n) => n.includes('.tmp.') && n.includes(`.${process.pid}.`),
    )
    expect(leftover.length).toBe(0)

    // cleanup
    unlinkSync(join(targetDir, 'occupant'))
    rmdirSync(targetDir)
    unlinkSync(tempRoot)
  })

  it('preserves existing file mode on overwrite', () => {
    const f = tmpFile('mode')
    atomicWriteSync(f, 'first')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('fs').chmodSync(f, 0o600)
    atomicWriteSync(f, 'second')
    expect(readFileSync(f, 'utf8')).toBe('second')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    unlinkSync(f)
  })
})
