/**
 * SessionStore — save / restore conversation state for crash recovery and
 * long-running task continuation.
 *
 * Why this exists: the base only persisted an append-only audit log (events) and
 * output artifacts (session dir). The conversation itself was lost on exit, so a
 * crash or a deliberate restart meant starting over. This writes a resumable
 * snapshot of the OpenAIMessage history alongside the existing session dir.
 *
 * Format: <sessionDir>/conversation.json — { version, savedAt, model, messages[] }
 * Listing: scans <cwd>/sessions/<session>/conversation.json and returns metadata.
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { OpenAIMessage } from './types.js'

export interface ConversationSnapshot {
  version: 1
  savedAt: string
  model?: string
  messages: OpenAIMessage[]
}

/** Persist the current conversation to the session dir (atomic-ish, best-effort). */
export function saveConversation(
  sessionDir: string,
  messages: OpenAIMessage[],
  model?: string,
): void {
  if (!sessionDir) return
  const snapshot: ConversationSnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    model,
    messages,
  }
  try {
    writeFileSync(join(sessionDir, 'conversation.json'), JSON.stringify(snapshot, null, 2), 'utf8')
  } catch {
    // best-effort: never break the turn on snapshot failure
  }
}

/** Load a conversation snapshot. Returns null if absent / corrupt. */
export function loadConversation(sessionDir: string): ConversationSnapshot | null {
  if (!sessionDir) return null
  const filePath = join(sessionDir, 'conversation.json')
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ConversationSnapshot
    if (!parsed || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}

export interface SessionEntry {
  /** Absolute path to the session directory. */
  dir: string
  /** Directory name (e.g. session_20240101_120000). */
  name: string
  savedAt: string
  messageCount: number
  model?: string
}

/**
 * Enumerate resumable sessions under <cwd>/sessions, newest first.
 * Only sessions containing a conversation.json are listed.
 */
export function listSessions(cwd: string): SessionEntry[] {
  const sessionsRoot = join(cwd, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  let entries: string[]
  try {
    entries = readdirSync(sessionsRoot)
  } catch {
    return []
  }
  const found: SessionEntry[] = []
  for (const name of entries) {
    const dir = join(sessionsRoot, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const snap = loadConversation(dir)
    if (!snap) continue
    found.push({
      dir,
      name,
      savedAt: snap.savedAt,
      messageCount: snap.messages.length,
      model: snap.model,
    })
  }
  // newest savedAt first
  found.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
  return found
}

/** Resolve a `--resume` argument ("last" or a session name/dir) to a session dir. */
export function resolveSessionArg(cwd: string, arg: string): string | null {
  if (arg === 'last') {
    const sessions = listSessions(cwd)
    return sessions[0]?.dir ?? null
  }
  // Direct path
  if (existsSync(join(arg, 'conversation.json'))) return arg
  // Session name under cwd/sessions
  const candidate = join(cwd, 'sessions', arg)
  if (existsSync(join(candidate, 'conversation.json'))) return candidate
  return null
}
