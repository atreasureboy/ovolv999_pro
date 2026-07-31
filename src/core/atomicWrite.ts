/**
 * AtomicWrite — 原子文件写入
 *
 * 写临时文件 → fsync → rename
 * - 保留原文件权限（mode）
 * - 符号链接穿透（write-through）
 * - 崩溃安全
 */

import { rename, unlink, stat, mkdir, lstat, realpath, open } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

export interface AtomicWriteOptions {
  encoding?: BufferEncoding
}

let _tmpCounter = 0

export async function atomicWrite(
  target: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const encoding = opts.encoding ?? 'utf8'

  let realTarget = target
  let isSymlink = false
  try {
    const lst = await lstat(target)
    if (lst.isSymbolicLink()) isSymlink = true
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  if (isSymlink) {
    try {
      realTarget = await realpath(target)
    } catch (err: unknown) {
      throw new Error(
        `atomicWrite: target ${target} is a broken symlink ` +
          `(cannot resolve: ${(err as Error).message}); ` +
          `fix the link before writing`,
        { cause: err },
      )
    }

    try {
      const rs = await stat(realTarget)
      if (rs.isDirectory()) {
        throw new Error(
          `atomicWrite: target ${target} is a symlink to a directory ` +
            `(${realTarget}); refusing to write through`,
        )
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new Error(
          `atomicWrite: target ${target} is a broken symlink ` +
            `(points to ${realTarget} which does not exist); ` +
            `fix the link before writing`,
          { cause: err },
        )
      }
      throw err
    }
  }

  await mkdir(dirname(realTarget), { recursive: true })

  let existingMode: number | undefined
  try {
    const s = await stat(realTarget)
    existingMode = s.mode
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const counter = (_tmpCounter = (_tmpCounter + 1) | 0)
  const tmpPath = `${realTarget}.tmp.${process.pid}.${Date.now()}.${counter}.${randomBytes(6).toString('hex')}`

  let fh: FileHandle | null = null
  try {
    fh = await open(tmpPath, 'w')
    await fh.writeFile(content, encoding)
    if (existingMode !== undefined) {
      await fh.chmod(existingMode)
    }
    await fh.sync()
    await fh.close()
    fh = null
    await rename(tmpPath, realTarget)
  } catch (err) {
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* fd may already be invalid */
      }
    }
    try {
      await unlink(tmpPath)
    } catch {
      /* original error is more informative */
    }
    throw err
  }
}

export async function statSafely(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(filePath)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
