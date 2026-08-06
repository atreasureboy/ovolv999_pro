/**
 * Structured ToolResult — 结构化工具结果
 *
 * 替代 {content, isError} 的简单形状，携带更丰富的信息：
 * - status: 明确的成功/失败/取消/超时状态
 * - exitCode: 进程退出码
 * - stdout/stderr: 分离的输出流
 * - diagnostics: 结构化诊断信息（lint errors, test failures）
 * - retryable: 是否可重试
 *
 * 向后兼容：旧工具仍返回 {content, isError}，ToolExecutor 通过 toLegacy() 标准化
 */

export type ToolResultStatus = 'success' | 'failed' | 'cancelled' | 'timed_out'

export interface Diagnostic {
  source: string
  severity: 'error' | 'warning' | 'info'
  message: string
  file?: string
  line?: number
  column?: number
  code?: string
}

export interface StructuredToolResult {
  status: ToolResultStatus
  summary: string
  exitCode?: number
  stdout?: string
  stderr?: string
  diagnostics?: Diagnostic[]
  retryable?: boolean
  content?: string
}

export interface LegacyToolResult {
  content: string
  isError: boolean
}

export type AnyToolResult = StructuredToolResult | LegacyToolResult

export function isStructuredResult(r: AnyToolResult): r is StructuredToolResult {
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof (r as StructuredToolResult).status === 'string' &&
    typeof (r as StructuredToolResult).summary === 'string'
  )
}

export function toStructured(r: AnyToolResult): StructuredToolResult {
  if (isStructuredResult(r)) return r
  return {
    status: r.isError ? 'failed' : 'success',
    summary: r.content,
    content: r.content,
  }
}

export function toLegacy(r: AnyToolResult): LegacyToolResult {
  if (!isStructuredResult(r)) return r
  const isError = r.status !== 'success'
  const content = pickLegacyContent(r)
  return { content, isError }
}

function pickLegacyContent(r: StructuredToolResult): string {
  if (r.content !== undefined && r.content !== '') return r.content
  const parts: string[] = []
  if (r.stdout) parts.push(r.stdout)
  if (r.stderr) parts.push(r.stderr)
  if (parts.length > 0) {
    const code = r.exitCode !== undefined ? `Exit code: ${r.exitCode}\n` : ''
    return code + parts.join('\n--- stderr ---\n')
  }
  return r.summary
}

export function ok(fields: {
  summary: string
  stdout?: string
  stderr?: string
  exitCode?: number
  diagnostics?: Diagnostic[]
  content?: string
}): StructuredToolResult {
  return { status: 'success', retryable: false, ...fields }
}

export function failed(fields: {
  summary: string
  stdout?: string
  stderr?: string
  exitCode?: number
  diagnostics?: Diagnostic[]
  retryable?: boolean
  content?: string
}): StructuredToolResult {
  return {
    status: 'failed',
    exitCode: 1,
    retryable: false,
    ...fields,
  }
}

export function cancelled(summary: string, content?: string): StructuredToolResult {
  return { status: 'cancelled', summary, content, retryable: false }
}

export function timedOut(
  summary: string,
  opts: { stdout?: string; stderr?: string } = {},
): StructuredToolResult {
  return {
    status: 'timed_out',
    summary,
    stdout: opts.stdout,
    stderr: opts.stderr,
    retryable: true,
  }
}

export const DEFAULT_LARGE_OUTPUT_BYTES = 8 * 1024

export function routeLargeOutput(
  output: string,
  artifactId: string,
  threshold: number = DEFAULT_LARGE_OUTPUT_BYTES,
): {
  artifact: { id: string; kind: string; contentType: string; sizeBytes: number }
  preview: string
} | null {
  if (output.length <= threshold) return null
  const head = output.slice(0, threshold >> 1)
  const tail = output.slice(-(threshold >> 1))
  const preview = `${head}\n... [${output.length - threshold} bytes truncated; see artifact ${artifactId}] ...\n${tail}`
  return {
    artifact: {
      id: artifactId,
      kind: 'log',
      contentType: 'text/plain',
      sizeBytes: output.length,
    },
    preview,
  }
}
