/**
 * SessionStore — versioned conversation snapshots for crash recovery and
 * long-running task continuation.
 *
 * Schema evolution:
 *   v1: basic { version, savedAt, model, messages[] }
 *   v2: envelope with updatedAt + lastOutcome summary
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { isPathWithin } from './pathSecurity.js'
import type { OpenAIMessage } from './types.js'

export const CURRENT_SESSION_VERSION = 2
export const MIN_SUPPORTED_VERSION = 1
export const CURRENT_SESSION_SCHEMA = 'ovogo.session.v2'
export const V1_SESSION_SCHEMA = 'ovogo.session.v1'

export interface OutcomeSummary {
  status: string
  changedFiles: string[]
  verification: { executed: boolean; passed: boolean }
  blockers: string[]
  requiredNextActions: string[]
  lastModel?: string
  durationMs?: number
}

export interface SessionEnvelope {
  version: number
  schema: string
  updatedAt: string
  messages: OpenAIMessage[]
  lastOutcome?: OutcomeSummary
}

export class UnknownSessionVersionError extends Error {
  readonly version: number
  readonly minSupported: number
  readonly maxSupported: number
  constructor(sessionDir: string, version: number, minSupported: number, maxSupported: number) {
    super(
      `Session at ${sessionDir} uses version ${version}, ` +
      `but this build supports versions ${minSupported}..${maxSupported}.`,
    )
    this.name = 'UnknownSessionVersionError'
    this.version = version
    this.minSupported = minSupported
    this.maxSupported = maxSupported
  }
}

export class CorruptSessionError extends Error {
  constructor(
    readonly sessionDir: string,
    readonly kind: string,
    cause: unknown,
  ) {
    super((cause as Error)?.message ?? String(cause))
    this.name = 'CorruptSessionError'
  }
}

export interface ConversationSnapshot {
  version: number
  schema: string
  savedAt: string
  updatedAt: string
  model?: string
  messages: OpenAIMessage[]
  lastOutcome?: OutcomeSummary
}

function migrateV1(raw: Record<string, unknown>): ConversationSnapshot {
  return {
    version: CURRENT_SESSION_VERSION,
    schema: CURRENT_SESSION_SCHEMA,
    savedAt: (raw.savedAt as string) ?? new Date().toISOString(),
    updatedAt: (raw.savedAt as string) ?? new Date().toISOString(),
    model: raw.model as string | undefined,
    messages: (raw.messages as OpenAIMessage[]) ?? [],
  }
}

export function saveConversation(
  sessionDir: string,
  messages: OpenAIMessage[],
  model?: string,
  outcome?: OutcomeSummary,
): void {
  if (!sessionDir) return
  const now = new Date().toISOString()
  const envelope: ConversationSnapshot = {
    version: CURRENT_SESSION_VERSION,
    schema: CURRENT_SESSION_SCHEMA,
    savedAt: now,
    updatedAt: now,
    model,
    messages,
    lastOutcome: outcome,
  }
  try {
    writeFileSync(join(sessionDir, 'conversation.json'), JSON.stringify(envelope, null, 2), 'utf8')
  } catch {
    /* best-effort */
  }
}

export function loadConversation(sessionDir: string): ConversationSnapshot | null {
  if (!sessionDir) return null
  const filePath = join(sessionDir, 'conversation.json')
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    if (!raw || !Array.isArray(raw.messages)) return null

    const version = typeof raw.version === 'number' ? raw.version : 1

    if (version < MIN_SUPPORTED_VERSION || version > CURRENT_SESSION_VERSION) {
      throw new UnknownSessionVersionError(sessionDir, version, MIN_SUPPORTED_VERSION, CURRENT_SESSION_VERSION)
    }

    if (version === 1) {
      return migrateV1(raw)
    }

    if (typeof raw.updatedAt !== 'string') {
      raw.updatedAt = raw.savedAt ?? new Date().toISOString()
    }

    return raw as unknown as ConversationSnapshot
  } catch (err: unknown) {
    if (err instanceof UnknownSessionVersionError) throw err
    return null
  }
}

export interface SessionEntry {
  dir: string
  name: string
  savedAt: string
  updatedAt: string
  messageCount: number
  model?: string
  lastOutcome?: OutcomeSummary
}

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
      updatedAt: snap.updatedAt,
      messageCount: snap.messages.length,
      model: snap.model,
      lastOutcome: snap.lastOutcome,
    })
  }
  found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return found
}

export function resolveSessionArg(cwd: string, arg: string): string | null {
  if (arg === 'last') {
    const sessions = listSessions(cwd)
    return sessions[0]?.dir ?? null
  }
  if (existsSync(join(arg, 'conversation.json'))) return arg
  const candidate = join(cwd, 'sessions', arg)
  const resolved = resolve(candidate)
  if (!isPathWithin(resolved, join(cwd, 'sessions'))) return null
  if (existsSync(join(resolved, 'conversation.json'))) return resolved
  return null
}
