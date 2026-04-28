/**
 * SemanticMemory — cross-turn knowledge persistence with incremental index.
 *
 * Improvements over the previous version:
 * 1. In-memory index — entries are tracked as they're written; disk reads are
 *    lazy (only on first query or after explicit reload).
 * 2. Deduplication — entries with the same content hash are not duplicated;
 *    newer entries update the confidence/timestamp of existing ones.
 * 3. Tag index — a Map<tag, Set<entryId>> for O(1) tag lookups without
 *    scanning all entries.
 *
 * Storage: ~/.ovogo/projects/{slug}/memory/semantic.jsonl
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

export interface SemanticMemoryEntry {
  id: string
  content: string
  tags: string[]
  source: string // tool name or module that wrote this
  timestamp: string // ISO 8601
  confidence: number // 0–1, how confident we are this is correct
}

interface TagIndex {
  [tag: string]: Set<string> // tag → set of entry IDs
}

let _memCounter = 0
function nextId(): string {
  _memCounter++
  return `sem_${Date.now()}_${_memCounter}`
}

function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}

export class SemanticMemory {
  private filePath: string
  private entries: Map<string, SemanticMemoryEntry> = new Map()
  private tagIndex: TagIndex = {}
  private loaded = false

  constructor(projectDir: string) {
    const memDir = join(projectDir, 'memory')
    try {
      mkdirSync(memDir, { recursive: true })
    } catch {
      /* best-effort */
    }
    this.filePath = join(memDir, 'semantic.jsonl')
  }

  /** Lazy-load from disk on first access */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true

    if (!existsSync(this.filePath)) return

    try {
      const lines = readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SemanticMemoryEntry
          this.entries.set(entry.id, entry)
          for (const tag of entry.tags) {
            if (!this.tagIndex[tag]) this.tagIndex[tag] = new Set()
            this.tagIndex[tag].add(entry.id)
          }
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // file unreadable — start fresh
    }
  }

  /** Append a new memory entry. Deduplicates by content hash. */
  write(entry: Omit<SemanticMemoryEntry, 'id'>): SemanticMemoryEntry {
    this.ensureLoaded()

    const hash = contentHash(entry.content)

    // Check for duplicate content
    for (const [id, existing] of this.entries) {
      if (contentHash(existing.content) === hash && existing.tags.includes(entry.tags[0] ?? '')) {
        // Update existing entry instead of duplicating
        const updated: SemanticMemoryEntry = {
          ...existing,
          confidence: Math.max(existing.confidence, entry.confidence),
          timestamp: new Date().toISOString(),
          source: entry.source,
        }
        this.entries.set(id, updated)
        // Rewrite the entire file (infrequent enough for JSONL)
        this.persistAll()
        return updated
      }
    }

    const full: SemanticMemoryEntry = { ...entry, id: nextId() }
    this.entries.set(full.id, full)

    // Update tag index
    for (const tag of full.tags) {
      if (!this.tagIndex[tag]) this.tagIndex[tag] = new Set()
      this.tagIndex[tag].add(full.id)
    }

    try {
      appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8')
    } catch {
      /* best-effort */
    }
    return full
  }

  /** Persist all entries to disk (rewrite entire file for consistency) */
  private persistAll(): void {
    try {
      const lines = Array.from(this.entries.values())
        .map((e) => JSON.stringify(e))
        .join('\n')
      writeFileSync(this.filePath, lines + '\n', 'utf8')
    } catch {
      /* best-effort */
    }
  }

  /** Read all entries from the in-memory index */
  readAll(): SemanticMemoryEntry[] {
    this.ensureLoaded()
    return Array.from(this.entries.values())
  }

  /** Search by tags and/or keywords in content */
  search(options: {
    tags?: string[]
    keywords?: string[]
    limit?: number
  }): SemanticMemoryEntry[] {
    this.ensureLoaded()
    let results: SemanticMemoryEntry[]

    // Fast path: use tag index
    if (options.tags && options.tags.length > 0) {
      const candidateIds = new Set<string>()
      for (const tag of options.tags) {
        const ids = this.tagIndex[tag]
        if (ids) {
          for (const id of ids) candidateIds.add(id)
        }
      }
      results = Array.from(candidateIds)
        .map((id) => this.entries.get(id))
        .filter((e): e is SemanticMemoryEntry => e !== undefined)
    } else {
      results = Array.from(this.entries.values())
    }

    // Keyword filter (still needs full scan)
    if (options.keywords && options.keywords.length > 0) {
      const lowerKeywords = options.keywords.map((k) => k.toLowerCase())
      results = results.filter((e) =>
        lowerKeywords.some((kw) => e.content.toLowerCase().includes(kw)),
      )
    }

    // Sort by confidence descending, then by timestamp descending
    results.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.timestamp.localeCompare(a.timestamp)
    })

    const limit = options.limit ?? 20
    return results.slice(0, limit)
  }

  /** Get entries relevant to a specific target/host */
  searchByTarget(target: string, limit = 15): SemanticMemoryEntry[] {
    return this.search({
      keywords: [target],
      limit,
    })
  }

  /** Count total entries */
  count(): number {
    this.ensureLoaded()
    return this.entries.size
  }

  /** Force reload from disk (e.g. if another process wrote to the file) */
  reload(): void {
    this.loaded = false
    this.entries.clear()
    this.tagIndex = {}
    this.ensureLoaded()
  }

  /** Clear all entries (in-memory only; does not delete the file) */
  clear(): void {
    this.entries.clear()
    this.tagIndex = {}
  }
}
