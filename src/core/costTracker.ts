import type { PricingConfig } from '../config/agentConfig.js'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  costUSD: number
  apiCalls: number
}

export function calculateUSDCost(pricing: PricingConfig | undefined, usage: TokenUsage): number {
  if (!pricing) return 0
  return (
    (usage.inputTokens / 1_000_000) * (pricing.inputPer1M ?? 0) +
    (usage.outputTokens / 1_000_000) * (pricing.outputPer1M ?? 0)
  )
}

export function formatCost(cost: number, maxDecimalPlaces = 4): string {
  return `$${cost > 0.5 ? Math.round(cost * 100) / 100 : cost.toFixed(maxDecimalPlaces)}`
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  return `${m}m ${rs}s`
}

export class CostTracker {
  private totalCostUSD = 0
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalAPICalls = 0
  private totalAPIDurationMs = 0
  private readonly modelUsage = new Map<string, ModelUsage>()
  private _hasUnknownPricing = false

  addUsage(model: string, usage: TokenUsage, pricing?: PricingConfig, durationMs?: number): void {
    const cost = calculateUSDCost(pricing, usage)
    if (!pricing) {
      this._hasUnknownPricing = true
    }

    this.totalCostUSD += cost
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    this.totalAPICalls++
    if (durationMs) this.totalAPIDurationMs += durationMs

    const existing = this.modelUsage.get(model)
    if (existing) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.costUSD += cost
      existing.apiCalls++
    } else {
      this.modelUsage.set(model, {
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: cost,
        apiCalls: 1,
      })
    }
  }

  get hasUnknownPricing(): boolean {
    return this._hasUnknownPricing
  }

  getTotalCostUSD(): number {
    return this.totalCostUSD
  }

  getTotalInputTokens(): number {
    return this.totalInputTokens
  }

  getTotalOutputTokens(): number {
    return this.totalOutputTokens
  }

  getTotalAPICalls(): number {
    return this.totalAPICalls
  }

  getModelUsage(): ReadonlyMap<string, ModelUsage> {
    return this.modelUsage
  }

  formatSummary(): string {
    const lines: string[] = []
    lines.push(
      `Total: ${formatNumber(this.totalInputTokens)} in / ${formatNumber(this.totalOutputTokens)} out / ${formatCost(this.totalCostUSD)} (${this.totalAPICalls} calls)`,
    )
    if (this.totalAPIDurationMs > 0) {
      lines.push(`API time: ${formatDuration(this.totalAPIDurationMs)}`)
    }
    if (this.modelUsage.size > 1) {
      lines.push('Per model:')
      for (const [, mu] of this.modelUsage) {
        lines.push(
          `  ${mu.model}: ${formatNumber(mu.inputTokens)} in / ${formatNumber(mu.outputTokens)} out / ${formatCost(mu.costUSD)} (${mu.apiCalls} calls)`,
        )
      }
    }
    if (this._hasUnknownPricing) {
      lines.push('(cost under-reported: no pricing configured for some models)')
    }
    return lines.join('\n')
  }

  reset(): void {
    this.totalCostUSD = 0
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalAPICalls = 0
    this.totalAPIDurationMs = 0
    this.modelUsage.clear()
    this._hasUnknownPricing = false
  }
}
