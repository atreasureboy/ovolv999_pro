/**
 * Test fixtures — helpers for downstream consumers building & testing tools.
 *
 * Building a tool against this base means implementing `Tool` and calling
 * `execute(input, context)`. These helpers fabricate a `ToolContext` (and a few
 * related objects) without spinning up an engine, so tool unit-tests stay tiny.
 *
 * Example:
 *   import { createMockToolContext } from 'ovolv999/testing'
 *   const ctx = createMockToolContext({ cwd: '/tmp/proj' })
 *   const res = await myTool.execute({ path: 'a' }, ctx)
 *   expect(res.isError).toBe(false)
 */

import type { ToolContext, ToolResult } from '../core/types.js'

export {
  createMockClient,
  textResponse,
  toolCallResponse,
  errorResponse,
  type ScriptedResponse,
  type MockUsage,
} from './mockClient.js'

export interface MockToolContextOverrides extends Partial<ToolContext> {
  /** Captures the most recent progress update (for tools that report progress). */
  progressSink?: (p: number) => void
}

/**
 * Fabricate a ToolContext suitable for tool unit-tests.
 * Every field has a safe no-op default; override only what your tool reads.
 */
export function createMockToolContext(
  overrides: MockToolContextOverrides = {},
): ToolContext {
  const signal = overrides.signal ?? new AbortController().signal
  return {
    cwd: overrides.cwd ?? process.cwd(),
    permissionMode: overrides.permissionMode ?? 'auto',
    signal,
    updateProgress: overrides.updateProgress ?? (() => {}),
    apiConfig: overrides.apiConfig ?? { apiKey: 'test-key', baseURL: undefined, model: 'test-model' },
    sessionDir: overrides.sessionDir,
    eventLog: overrides.eventLog,
    semanticMemory: overrides.semanticMemory,
    episodicMemory: overrides.episodicMemory,
    availableToolNames: overrides.availableToolNames,
  }
}

/** A minimal successful tool result, for asserting against tool output. */
export function okResult(content: string): ToolResult {
  return { content, isError: false }
}

/** A minimal error tool result. */
export function errResult(content: string): ToolResult {
  return { content, isError: true }
}
