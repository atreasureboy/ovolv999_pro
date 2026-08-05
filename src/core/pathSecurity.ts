/**
 * PathSecurity — 路径安全工具
 *
 * 纯函数，可测试，所有文件工具统一入口：
 * - containsPathTraversal: 检测路径遍历（含编码绕过）
 * - containsNullByte: 检测 \0 注入
 * - expandPath: 展开 ~ 为用户目录
 * - isPathWithin: 验证路径是否在允许的目录内
 */

import { homedir } from 'os'
import { join, resolve } from 'path'

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
  return resolved === base || resolved.startsWith(base + '\\') || resolved.startsWith(base + '/')
}
