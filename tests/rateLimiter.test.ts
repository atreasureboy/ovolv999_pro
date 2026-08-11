import { describe, it, expect } from 'vitest'
import { RateLimiter } from '../src/core/rateLimiter.js'

describe('RateLimiter', () => {
  it('acquires immediately when tokens available', async () => {
    const rl = new RateLimiter({ maxTokens: 5, refillRate: 1 })
    await rl.acquire(3)
    expect(rl.waiters).toBe(0)
  })

  it('resolves a queued waiter once the bucket refills (no deadlock)', async () => {
    // Regression: acquire() queued a waiter but nothing ever called drain()
    // again, so the Promise hung forever. This test fails (times out) if the
    // deadlock returns.
    const rl = new RateLimiter({ maxTokens: 2, refillRate: 100 })
    await rl.acquire(2) // bucket now empty

    let resolved = false
    const p = rl.acquire(1).then(() => {
      resolved = true
    })
    expect(rl.waiters).toBe(1)

    await new Promise((r) => setTimeout(r, 80))
    await p
    expect(resolved).toBe(true)
    expect(rl.waiters).toBe(0)
  })

  it('resolves multiple queued waiters in order as tokens refill', async () => {
    const rl = new RateLimiter({ maxTokens: 1, refillRate: 200 })
    await rl.acquire(1) // empty

    const order: number[] = []
    const p1 = rl.acquire(1).then(() => order.push(1))
    const p2 = rl.acquire(1).then(() => order.push(2))

    await Promise.race([p1, p2, new Promise((r) => setTimeout(r, 200))])
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })

  it('reset() clears waiters and cancels the drain timer', async () => {
    const rl = new RateLimiter({ maxTokens: 1, refillRate: 1 })
    await rl.acquire(1)
    const p = rl.acquire(1) // queued
    expect(rl.waiters).toBe(1)
    rl.reset()
    await p
    expect(rl.waiters).toBe(0)
    expect(rl.availableTokens).toBe(1)
  })
})
