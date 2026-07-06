/**
 * Memory system — bridges SemanticMemory persistence to the system prompt.
 *
 * SemanticMemory writes to ~/.ovogo/projects/{slug}/memory/semantic.jsonl.
 * This module reads that file at startup and formats entries for injection
 * into the system prompt, so the agent can recall cross-turn knowledge.
 */

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface SemanticEntry {
  id: string
  content: string
  tags: string[]
  source: string
  timestamp: string
  confidence: number
}

/** Compute the project slug the same way bin/ovogogogo.ts does */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32)
}

/** Get the memory directory for a given cwd (matches SemanticMemory's path) */
export function getMemoryDir(cwd: string): string {
  const slug = projectSlug(cwd)
  const dir = join(homedir(), '.ovogo', 'projects', slug, 'memory')
  try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  return dir
}

/** Read all semantic memory entries from disk */
function readSemanticEntries(memoryDir: string): SemanticEntry[] {
  const filePath = join(memoryDir, 'semantic.jsonl')
  if (!existsSync(filePath)) return []
  try {
    const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
    return lines
      .map((l) => {
        try { return JSON.parse(l) as SemanticEntry } catch { return null }
      })
      .filter((e): e is SemanticEntry => e !== null)
  } catch {
    return []
  }
}

/** Build the memory section for the system prompt */
export function buildMemorySystemSection(memoryDir: string): string {
  const entries = readSemanticEntries(memoryDir)
  if (entries.length === 0) return ''

  // Sort by confidence descending, take top entries
  entries.sort((a, b) => b.confidence - a.confidence)
  const top = entries.slice(0, 20)

  const lines = top.map((e) => {
    const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''
    return `- ${e.content}${tags}`
  })

  return `## Memory — Cross-Turn Knowledge\n\nThe following knowledge entries were saved from previous sessions. Use them as context, but verify if uncertain.\n\n${lines.join('\n')}`
}

/** Get memory stats for display */
export function getMemoryStats(memoryDir: string): { hasIndex: boolean; entryCount: number } {
  const entries = readSemanticEntries(memoryDir)
  return { hasIndex: entries.length > 0, entryCount: entries.length }
}
