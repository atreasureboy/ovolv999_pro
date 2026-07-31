export type ResourceAccess = 'read' | 'write' | 'exclusive'

export interface ResourceClaim {
  type: string
  key: string
  access: ResourceAccess
}

export interface ResourceLease {
  claims: ReadonlyArray<ResourceClaim>
  release(): void
  readonly released: boolean
}

export class ResourceConflictError extends Error {
  constructor(
    public readonly conflicts: ReadonlyArray<{ claim: ResourceClaim; blockerKey: string }>,
    message?: string,
  ) {
    super(message ?? `resource conflict on ${conflicts.length} claim(s)`)
    this.name = 'ResourceConflictError'
  }
}

export class ResourceAcquireTimeoutError extends Error {
  constructor(
    public readonly claims: ReadonlyArray<ResourceClaim>,
    timeoutMs: number,
  ) {
    super(`resource acquire timed out after ${timeoutMs}ms`)
    this.name = 'ResourceAcquireTimeoutError'
  }
}

export function claimsConflict(
  existing: ResourceAccess,
  incoming: ResourceAccess,
): boolean {
  if (existing === 'exclusive' || incoming === 'exclusive') return true
  if (existing === 'write' || incoming === 'write') {
    return !(existing === 'read' && incoming === 'read')
  }
  return false
}

export function claimsConflictBetween(a: ResourceClaim[], b: ResourceClaim[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  for (const ca of a) {
    for (const cb of b) {
      if (ca.type === cb.type && ca.key === cb.key && claimsConflict(ca.access, cb.access)) {
        return true
      }
    }
  }
  return false
}

interface HeldClaim {
  claim: ResourceClaim
  acquiredAt: number
}

export interface AcquireOptions {
  timeoutMs?: number
  signal?: AbortSignal
  noWait?: boolean
}

export class ResourceScheduler {
  private readonly held = new Map<string, HeldClaim[]>()

  async acquire(
    claims: ResourceClaim[],
    opts: AcquireOptions = {},
  ): Promise<ResourceLease> {
    const timeoutMs = opts.timeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs

    while (true) {
      if (opts.signal?.aborted) {
        throw new ResourceConflictError([], 'acquire aborted')
      }

      const conflicts = this.findConflicts(claims)
      if (conflicts.length === 0) {
        return this.createLease(claims)
      }

      if (opts.noWait) {
        throw new ResourceConflictError(conflicts)
      }

      if (Date.now() >= deadline) {
        throw new ResourceAcquireTimeoutError(claims, timeoutMs)
      }

      await new Promise((r) => setTimeout(r, 50))
    }
  }

  private findConflicts(
    incoming: ResourceClaim[],
  ): Array<{ claim: ResourceClaim; blockerKey: string }> {
    const conflicts: Array<{ claim: ResourceClaim; blockerKey: string }> = []
    for (const claim of incoming) {
      const key = `${claim.type}:${claim.key}`
      const existing = this.held.get(key)
      if (existing) {
        for (const held of existing) {
          if (claimsConflict(held.claim.access, claim.access)) {
            conflicts.push({ claim, blockerKey: key })
          }
        }
      }
    }
    return conflicts
  }

  private createLease(claims: ResourceClaim[]): ResourceLease {
    const now = Date.now()
    for (const claim of claims) {
      const key = `${claim.type}:${claim.key}`
      if (!this.held.has(key)) {
        this.held.set(key, [])
      }
      this.held.get(key)!.push({ claim, acquiredAt: now })
    }

    let released = false
    const lease: ResourceLease = {
      claims,
      release: () => {
        if (released) return
        released = true
        for (const claim of claims) {
          const key = `${claim.type}:${claim.key}`
          const list = this.held.get(key)
          if (list) {
            const idx = list.findIndex((h) => h.acquiredAt === now && h.claim === claim)
            if (idx >= 0) list.splice(idx, 1)
            if (list.length === 0) this.held.delete(key)
          }
        }
      },
      get released() {
        return released
      },
    }
    return lease
  }

  releaseAll(): void {
    this.held.clear()
  }
}
