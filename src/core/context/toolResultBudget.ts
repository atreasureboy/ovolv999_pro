const MAX_TOOL_RESULT_CHARS = 20_000
const MAX_AGGREGATE_CHARS = 80_000

export function truncateToolResult(content: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  if (content.length <= maxChars) return content
  const half = maxChars / 2
  return (
    content.slice(0, half) +
    `\n\n[... ${content.length - maxChars} chars truncated ...]\n\n` +
    content.slice(content.length - half)
  )
}

export function enforceAggregateBudget(results: string[]): string[] {
  let total = 0
  return results.map((r) => {
    const remaining = Math.max(2_000, MAX_AGGREGATE_CHARS - total)
    total += r.length
    if (r.length > remaining) {
      return truncateToolResult(r, remaining)
    }
    return r
  })
}
