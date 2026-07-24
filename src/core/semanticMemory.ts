/**
 * SemanticMemory — Cross-turn knowledge persistence with vector & hybrid index.
 *
 * Capabilities:
 * 1. Hybrid Retrieval Engine — Combines Tag index, Keyword matching, and Vector Cosine Similarity (TF-IDF / 3-gram embedding).
 * 2. Source Attribution & Conflict Resolution — user_stated(3) > agent_inferred(2) > tool_observed(1).
 * 3. Content Hash Deduplication — Auto-updates timestamp/confidence for matching hashes.
 *
 * Storage: ~/.ovogo/projects/{slug}/memory/semantic.jsonl
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'

export interface SemanticMemoryEntry {
  id: string
  content: string
  tags: string[]
  source: string // tool name or module that wrote this
  timestamp: string // ISO 8601
  confidence: number // 0–1, how confident we are this is correct
}

interface TagIndex {
  [tag: string]: Set<string>
}

function nextId(): string {
  return `sem_${randomUUID()}`
}

const SOURCE_PRIORITY: Record<string, number> = {
  user_stated: 3,
  agent_inferred: 2,
  consolidation: 2,
  tool_observed: 1,
}

function sourceRank(source: string): number {
  return SOURCE_PRIORITY[source] ?? 1
}

function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}

function extractTermVector(text: string): Map<string, number> {
  const vec = new Map<string, number>()
  const clean = text.toLowerCase().replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
  const words = clean.split(/\s+/).filter(Boolean)

  for (const w of words) {
    vec.set(w, (vec.get(w) ?? 0) + 1)
    if (w.length >= 3) {
      for (let i = 0; i <= w.length - 3; i++) {
        const gram = w.slice(i, i + 3)
        vec.set(gram, (vec.get(gram) ?? 0) + 0.5)
      }
    }
  }

  let normSq = 0
  for (const val of vec.values()) normSq += val * val
  const norm = Math.sqrt(normSq) || 1
  for (const [k, v] of vec.entries()) vec.set(k, v / norm)

  return vec
}

function cosineSimilarity(vecA: Map<string, number>, vecB: Map<string, number>): number {
  let dotProduct = 0
  const [smaller, larger] = vecA.size < vecB.size ? [vecA, vecB] : [vecB, vecA]

  for (const [term, weightA] of smaller.entries()) {
    const weightB = larger.get(term)
    if (weightB !== undefined) {
      dotProduct += weightA * weightB
    }
  }
  return dotProduct
}

export class SemanticMemory {
  private filePath: string
  private entries: Map<string, SemanticMemoryEntry> = new Map()
  private vectors: Map<string, Map<string, number>> = new Map()
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
          this.vectors.set(entry.id, extractTermVector(entry.content))
          for (const tag of entry.tags) {
            if (!this.tagIndex[tag]) this.tagIndex[tag] = new Set()
            this.tagIndex[tag].add(entry.id)
          }
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // file unreadable
    }
  }

  write(entry: Omit<SemanticMemoryEntry, 'id'>): SemanticMemoryEntry {
    this.ensureLoaded()

    const hash = contentHash(entry.content)

    for (const [id, existing] of this.entries) {
      if (contentHash(existing.content) === hash) {
        if (sourceRank(entry.source) < sourceRank(existing.source)) {
          return existing
        }
        const updated: SemanticMemoryEntry = {
          ...existing,
          confidence: Math.max(existing.confidence, entry.confidence),
          timestamp: new Date().toISOString(),
          source: entry.source,
        }
        this.entries.set(id, updated)
        this.vectors.set(id, extractTermVector(updated.content))
        this.persistAll()
        return updated
      }
    }

    const full: SemanticMemoryEntry = { ...entry, id: nextId() }
    this.entries.set(full.id, full)
    this.vectors.set(full.id, extractTermVector(full.content))

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

  readAll(): SemanticMemoryEntry[] {
    this.ensureLoaded()
    return Array.from(this.entries.values())
  }

  /**
   * Hybrid Vector & Keyword Search Engine
   * Filter by Tag & Keyword + Hybrid Cosine Vector Score.
   */
  search(options: {
    query?: string
    tags?: string[]
    keywords?: string[]
    limit?: number
  }): SemanticMemoryEntry[] {
    this.ensureLoaded()

    let candidates: SemanticMemoryEntry[]

    // 1. Tag filter
    if (options.tags && options.tags.length > 0) {
      const candidateIds = new Set<string>()
      for (const tag of options.tags) {
        const ids = this.tagIndex[tag]
        if (ids) {
          for (const id of ids) candidateIds.add(id)
        }
      }
      candidates = Array.from(candidateIds)
        .map((id) => this.entries.get(id))
        .filter((e): e is SemanticMemoryEntry => e !== undefined)
    } else {
      candidates = Array.from(this.entries.values())
    }

    // 2. Keyword strict filter (if keywords are specified, entry must contain at least one keyword)
    if (options.keywords && options.keywords.length > 0) {
      const lowerKeywords = options.keywords.map((k) => k.toLowerCase())
      candidates = candidates.filter((e) =>
        lowerKeywords.some((kw) => e.content.toLowerCase().includes(kw)),
      )
    }

    // 3. Score candidates using vector similarity & confidence
    const queryVec = options.query ? extractTermVector(options.query) : null

    const scored = candidates.map((entry) => {
      let score = entry.confidence * 0.3

      if (queryVec) {
        const entryVec = this.vectors.get(entry.id)
        if (entryVec) {
          const sim = cosineSimilarity(queryVec, entryVec)
          score += sim * 0.7
        }
      }

      return { entry, score }
    })

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.entry.timestamp.localeCompare(a.entry.timestamp)
    })

    const limit = options.limit ?? 20
    return scored.slice(0, limit).map((s) => s.entry)
  }
}
