import { describe, it, expect } from 'vitest'
import {
  containsPathTraversal,
  containsNullByte,
  expandPath,
  isPathWithin,
  validatePathInputs,
} from '../src/core/pathSecurity.js'
import { homedir } from 'os'
import { join } from 'path'

describe('containsPathTraversal', () => {
  it('detects .. traversal', () => {
    expect(containsPathTraversal('../etc/passwd')).toBe(true)
    expect(containsPathTraversal('foo/../../bar')).toBe(true)
    expect(containsPathTraversal('..\\Windows\\System32')).toBe(true)
  })

  it('detects URL-encoded traversal', () => {
    expect(containsPathTraversal('%2e%2e%2fetc%2fpasswd')).toBe(true)
  })

  it('allows safe paths', () => {
    expect(containsPathTraversal('src/file.ts')).toBe(false)
    expect(containsPathTraversal('foo.bar.baz')).toBe(false)
  })
})

describe('containsNullByte', () => {
  it('detects null byte', () => {
    expect(containsNullByte('foo\0bar')).toBe(true)
  })

  it('allows normal strings', () => {
    expect(containsNullByte('normal path')).toBe(false)
  })
})

describe('expandPath', () => {
  it('expands ~/ to home directory', () => {
    expect(expandPath('~/')).toBe(homedir())
    expect(expandPath('~/projects')).toBe(join(homedir(), 'projects'))
  })

  it('expands ~ to home directory', () => {
    expect(expandPath('~')).toBe(homedir())
  })

  it('returns other paths unchanged', () => {
    expect(expandPath('/absolute/path')).toBe('/absolute/path')
  })

  it('throws on null byte', () => {
    expect(() => expandPath('~/bad\0path')).toThrow('null byte')
  })
})

describe('isPathWithin', () => {
  it('allows paths within base directory', () => {
    expect(isPathWithin(join(homedir(), 'projects', 'file.ts'), join(homedir(), 'projects'))).toBe(
      true,
    )
  })

  it('rejects paths outside base directory', () => {
    expect(isPathWithin('/etc/passwd', join(homedir(), 'projects'))).toBe(false)
  })

  it('rejects traversal paths', () => {
    expect(
      isPathWithin(join(homedir(), 'projects', '..', '..', 'etc'), join(homedir(), 'projects')),
    ).toBe(false)
  })
})

describe('validatePathInputs', () => {
  const cwd = process.cwd()

  it('returns null when all known path fields are safe', () => {
    expect(validatePathInputs({ file_path: join(cwd, 'src', 'file.ts') }, cwd)).toBeNull()
    expect(validatePathInputs({ path: 'src', dir: join(cwd, 'tmp') }, cwd)).toBeNull()
  })

  it('ignores empty and non-string fields', () => {
    expect(validatePathInputs({ file_path: '' }, cwd)).toBeNull()
    expect(validatePathInputs({ path: 42, workdir: null }, cwd)).toBeNull()
  })

  it('ignores unknown fields', () => {
    expect(validatePathInputs({ command: 'ls', url: '/etc/passwd' }, cwd)).toBeNull()
  })

  it('rejects null bytes in any known field', () => {
    expect(validatePathInputs({ file_path: join(cwd, 'bad\0path') }, cwd)).toMatch(/null byte/)
  })

  it('rejects traversal in any known field', () => {
    expect(validatePathInputs({ path: '../../etc' }, cwd)).toMatch(/traversal/)
    expect(validatePathInputs({ workdir: `${cwd}/foo/../../..` }, cwd)).toMatch(/traversal/)
  })

  it('rejects normalized paths that escape cwd', () => {
    expect(validatePathInputs({ workdir: join(cwd, '..', '..') }, cwd)).toMatch(
      /within the project directory/,
    )
  })

  it('rejects absolute paths outside cwd', () => {
    expect(validatePathInputs({ file_path: '/etc/passwd' }, cwd)).toMatch(
      /within the project directory/,
    )
  })
})
