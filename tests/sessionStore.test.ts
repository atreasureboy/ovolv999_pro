import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  saveConversation,
  loadConversation,
  listSessions,
  resolveSessionArg,
} from '../src/core/sessionStore.js'
import type { OpenAIMessage } from '../src/core/types.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sess-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const msgs: OpenAIMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
]

describe('saveConversation / loadConversation', () => {
  it('round-trips a message history', () => {
    const dir = join(workDir, 'session_1')
    mkdirSync(dir, { recursive: true })
    saveConversation(dir, msgs, 'gpt-4o')
    const snap = loadConversation(dir)
    expect(snap).not.toBeNull()
    expect(snap!.messages).toHaveLength(2)
    expect(snap!.messages[0].content).toBe('hello')
    expect(snap!.model).toBe('gpt-4o')
    expect(snap!.version).toBe(2)
  })

  it('returns null when no snapshot exists', () => {
    expect(loadConversation(join(workDir, 'nope'))).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    const dir = join(workDir, 'session_bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'conversation.json'), '{ not json', 'utf8')
    expect(loadConversation(dir)).toBeNull()
  })

  it('no-op save when sessionDir empty (does not throw)', () => {
    expect(() => saveConversation('', msgs)).not.toThrow()
  })
})

describe('listSessions', () => {
  it('lists sessions newest-first, skipping dirs without snapshots', () => {
    const sessionsRoot = join(workDir, 'sessions')
    const older = join(sessionsRoot, 'session_1')
    const newer = join(sessionsRoot, 'session_2')
    const empty = join(sessionsRoot, 'session_3')
    mkdirSync(older, { recursive: true })
    mkdirSync(newer, { recursive: true })
    mkdirSync(empty, { recursive: true })
    saveConversation(older, msgs)
    // newer has a later savedAt
    saveConversation(newer, [{ role: 'user', content: 'x' }])
    const list = listSessions(workDir)
    expect(list).toHaveLength(2)
    expect(list[0].dir).toBe(newer)
    expect(list.map((s) => s.name)).toEqual(['session_2', 'session_1'])
  })

  it('returns [] when no sessions dir exists', () => {
    expect(listSessions(workDir)).toEqual([])
  })
})

describe('resolveSessionArg', () => {
  it('resolves "last" to the newest session', () => {
    const sessionsRoot = join(workDir, 'sessions')
    const s1 = join(sessionsRoot, 'session_1')
    const s2 = join(sessionsRoot, 'session_2')
    mkdirSync(s1, { recursive: true })
    mkdirSync(s2, { recursive: true })
    saveConversation(s1, msgs)
    saveConversation(s2, msgs)
    expect(resolveSessionArg(workDir, 'last')).toBe(s2)
  })

  it('resolves a session name under cwd/sessions', () => {
    const dir = join(workDir, 'sessions', 'myname')
    mkdirSync(dir, { recursive: true })
    saveConversation(dir, msgs)
    expect(resolveSessionArg(workDir, 'myname')).toBe(dir)
  })

  it('resolves a direct directory path', () => {
    const dir = join(workDir, 'direct')
    mkdirSync(dir, { recursive: true })
    saveConversation(dir, msgs)
    expect(resolveSessionArg(workDir, dir)).toBe(dir)
  })

  it('returns null for an unknown name', () => {
    expect(resolveSessionArg(workDir, 'does-not-exist')).toBeNull()
  })
})
