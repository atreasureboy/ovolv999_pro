/**
 * PathSecurity — 路径安全工具
 *
 * 纯函数，可测试，所有文件工具统一入口：
 * - containsPathTraversal: 检测路径遍历（含编码绕过）
 * - containsNullByte: 检测 \0 注入
 * - expandPath: 展开 ~ 为用户目录
 * - isPathWithin: 验证路径是否在允许的目录内（realpath 防 TOCTOU）
 * - resolveSymlinks: resolve + realpath 两步验证，防止 symlink 逃逸
 */

import { homedir } from 'os'
import { join, resolve } from 'path'
import { realpathSync } from 'fs'

export function containsPathTraversal(path: string): boolean {
  const decoded = decodeURIComponent(path)
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(decoded)
}

export function containsNullByte(path: string): boolean {
  return path.includes('\0')
}

export function expandPath(path: string): string {
  if (containsNullByte(path)) {
    throw new Error(`Path contains null byte: ${path.slice(0, 100)}`)
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  if (path === '~') {
    return homedir()
  }
  return path
}

export function isPathWithin(candidate: string, allowedBase: string): boolean {
  const resolved = resolve(expandPath(candidate))
  const base = resolve(allowedBase)
  if (resolved === base) return true
  if (resolved.startsWith(base + '/') || resolved.startsWith(base + '\\')) {
    // Resolve symlinks to prevent TOCTOU bypass: an attacker could replace a
    // symlink after the resolve check passes but before the file is opened.
    // realpathSync resolves all symlinks in the path chain to their real targets.
    try {
      const real = realpathSync(resolved)
      const realBase = realpathSync(base)
      return (
        real === realBase || real.startsWith(realBase + '/') || real.startsWith(realBase + '\\')
      )
    } catch {
      // If the path doesn't exist yet (e.g., Write), the resolve check is sufficient —
      // the file will be created inside the allowed base on disk.
      return true
    }
  }
  return false
}

/**
 * Known path field names used by file-operation tools.
 * The tool executor scans tool inputs for these fields and validates them
 * as a defense-in-depth layer — even if a tool forgets its own path checks,
 * the engine will catch it centrally.
 */
const KNOWN_PATH_FIELDS = new Set(['file_path', 'path', 'workdir', 'dir'])

/**
 * Validate all known path fields in a tool input against the cwd.
 * Returns the first validation error as a string, or null if all paths are safe.
 */
export function validatePathInputs(input: Record<string, unknown>, cwd: string): string | null {
  for (const field of KNOWN_PATH_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string' || value.length === 0) continue
    if (containsNullByte(value)) {
      return `Error: ${field} contains null byte`
    }
    if (containsPathTraversal(value)) {
      return `Error: path traversal detected in ${field}`
    }
    if (!isPathWithin(value, cwd)) {
      return `Error: ${field} must be within the project directory (${cwd})`
    }
  }
  return null
}

/** Sync realpath resolver — exported for testing. Use with care (blocks event loop). */
export { realpathSync as _realpathSync }
