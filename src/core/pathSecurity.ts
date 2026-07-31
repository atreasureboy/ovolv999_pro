/**
 * PathSecurity — 路径安全工具
 *
 * 纯函数，可测试，所有文件工具统一入口：
 * - containsPathTraversal: 检测 .. 路径遍历
 * - containsNullByte: 检测 \0 注入
 * - expandPath: 展开 ~ 为用户目录
 */

import { homedir } from 'os'
import { join } from 'path'

export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
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
