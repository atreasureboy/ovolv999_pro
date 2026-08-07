/**
 * RateLimiter — token-bucket API call throttling.
 *
 * Prevents the agent from hammering the provider and getting 429'd. Every
 * LLM call consumes one token; tokens refill at a configurable rate.
 *
 * Usage:
 *   const limiter = new RateLimiter({ maxTokens: 10, refillRate: 2 })
 *   await limiter.acquire()  // blocks until a token is available
 */

export interface RateLimiterOptions {
  /** Maximum tokens the bucket can hold (burst capacity). */
  maxTokens?: number
  /** Tokens added per second. */
  refillRate?: number
}

export class RateLimiter {
  private currentTokens: number
  private readonly maxTokens: number
  private readonly refillRate: number
  private lastRefillMs: number
  private readonly waitQueue: Array<{
    resolve: () => void
    tokens: number
  }> = []

  constructor(opts: RateLimiterOptions = {}) {
    this.maxTokens = opts.maxTokens ?? 10
    this.refillRate = opts.refillRate ?? 2
    this.currentTokens = this.maxTokens
    this.lastRefillMs = Date.now()
  }

  /** Refill tokens based on elapsed time since the last refill. */
  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefillMs) / 1000
    const added = elapsed * this.refillRate
    if (added > 0) {
      this.currentTokens = Math.min(this.currentTokens + added, this.maxTokens)
      this.lastRefillMs = now
    }
  }

  /** Wake up waiters that can now be satisfied. */
  private drain(): void {
    this.refill()
    while (this.waitQueue.length > 0 && this.currentTokens >= this.waitQueue[0].tokens) {
      this.currentTokens -= this.waitQueue[0].tokens
      this.waitQueue.shift()!.resolve()
    }
  }

  /**
   * Acquire `tokens` tokens. Resolves immediately if enough are available;
   * otherwise queues the caller and resolves when the bucket refills.
   */
  acquire(tokens = 1): Promise<void> {
    this.refill()
    if (this.currentTokens >= tokens && this.waitQueue.length === 0) {
      this.currentTokens -= tokens
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waitQueue.push({ resolve, tokens })
    })
  }

  /** Instantaneous token count (for observability). */
  get availableTokens(): number {
    this.refill()
    return this.currentTokens
  }

  /** Release tokens back to the bucket (e.g. after a cancelled call). */
  release(tokens = 1): void {
    this.currentTokens = Math.min(this.currentTokens + tokens, this.maxTokens)
    this.drain()
  }

  /** Number of callers currently waiting. */
  get waiters(): number {
    return this.waitQueue.length
  }

  /** Reset the bucket to full capacity. */
  reset(): void {
    this.currentTokens = this.maxTokens
    this.lastRefillMs = Date.now()
    while (this.waitQueue.length) {
      this.waitQueue.shift()!.resolve()
    }
  }
}