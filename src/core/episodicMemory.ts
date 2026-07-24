/**
 * EpisodicMemory — action trajectory persistence
 *
 * Records "what I did, what happened, was it successful" for each tool call
 * and agent action. Lets the agent review its recent history of attempts
 * without re-reading the full conversation.
 *
 * Storage: ~/.ovogo/projects/{slug}/memory/episodes.jsonl
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface EpisodicMemoryEntry {
  id: string
  turn: number
  toolName: string
  inputSummary: string // truncated input
  resultSummary: string // truncated result
  outcome: 'success' | 'failure' | 'partial'
  duration?: number // ms
  timestamp: string // ISO 8601
}

function nextId(): string {
  return `epi_${randomUUID()}`
}

// Hard cap on retained episodes. The file grows by one line per tool call, so
// without a bound it becomes unbounded over long sessions and every read (which
// loads the whole file then slices) turns O(n). When the file exceeds the cap we
// trim the oldest entries in place — keeping the freshest trajectory.
const MAX_EPISODES = 2000

export class EpisodicMemory {
  private filePath: string

  constructor(projectDir: string) {
    const memDir = join(projectDir, 'memory')
    try {
      mkdirSync(memDir, { recursive: true })
    } catch {
      /* best-effort */
    }
    this.filePath = join(memDir, 'episodes.jsonl')
  }

  /** Append a new episode entry */
  write(entry: Omit<EpisodicMemoryEntry, 'id'>): EpisodicMemoryEntry {
    const full: EpisodicMemoryEntry = { ...entry, id: nextId() }
    try {
      appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8')
    } catch {
      /* best-effort */
    }
    return full
  }

  /** Read the most recent N episodes */
  recent(limit = 20): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.slice(-limit)
  }

  /** Read all entries, trimming oldest when the file exceeds MAX_EPISODES */
  readAll(): EpisodicMemoryEntry[] {
    if (!existsSync(this.filePath)) return []
    try {
      const lines = readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean)
      // Lazy rotation: if the file outgrew the cap, rewrite it keeping the
      // newest MAX_EPISODES entries so subsequent reads stay cheap.
      let kept = lines
      if (lines.length > MAX_EPISODES) {
        kept = lines.slice(-MAX_EPISODES)
        try {
          writeFileSync(this.filePath, kept.join('\n') + '\n', 'utf8')
        } catch {
          /* best-effort rotation; in-memory slice still correct */
        }
      }
      return kept
        .map((l) => {
          try {
            return JSON.parse(l) as EpisodicMemoryEntry
          } catch {
            return null
          }
        })
        .filter((e): e is EpisodicMemoryEntry => e !== null)
    } catch {
      return []
    }
  }

  /** Search episodes by tool name */
  findByTool(toolName: string, limit = 10): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.filter((e) => e.toolName === toolName).slice(-limit)
  }
}
