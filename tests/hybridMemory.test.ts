import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { rm } from 'fs/promises'

describe('Hybrid Vector & Tag SemanticMemory', () => {
  const projectDir = join(tmpdir(), `hybrid-mem-test-${Date.now()}`)
  let memory: SemanticMemory

  beforeEach(() => {
    memory = new SemanticMemory(projectDir)
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('ranks memories by hybrid vector and keyword relevance', () => {
    memory.write({
      content: 'TypeScript execution engine uses streaming OpenAI API',
      tags: ['engine', 'ts'],
      source: 'user_stated',
      timestamp: new Date().toISOString(),
      confidence: 1.0,
    })

    memory.write({
      content: 'Python scripts process dataset files in parallel',
      tags: ['python', 'data'],
      source: 'tool_observed',
      timestamp: new Date().toISOString(),
      confidence: 0.8,
    })

    const results = memory.search({ query: 'TypeScript streaming engine' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('TypeScript execution engine')
  })
})
