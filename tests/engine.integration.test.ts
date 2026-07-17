/**
 * Engine integration tests — exercise the full Think→Act→Observe loop with a
 * scripted mock OpenAI client (no network). These cover paths the pure-function
 * unit tests can't reach: the permission gate inside executeToolCall, token-usage
 * recording from the stream, malformed-tool-arg self-heal, and the run() error
 * path that previously swallowed its message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { ExecutionEngine } from '../src/core/engine.js'
import { EventLog } from '../src/core/eventLog.js'
import { Renderer } from '../src/ui/renderer.js'
import { PermissionChecker } from '../src/core/permission.js'
import type { Tool, EngineConfig } from '../src/core/types.js'
import {
  createMockClient,
  textResponse,
  toolCallResponse,
  errorResponse,
  type ScriptedResponse,
} from '../src/testing/index.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'eng-it-'))
})
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** A tool that records every execute() call so tests can assert on it. */
function makeRecordingTool(name = 'Recorder'): { tool: Tool; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  const tool: Tool = {
    name,
    concurrencySafe: true,
    definition: {
      type: 'function',
      function: {
        name,
        description: 'test recorder',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      },
    },
    execute(input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
      calls.push(input)
      return Promise.resolve({ content: `ok:${name}`, isError: false })
    },
  }
  return { tool, calls }
}

/** Wire a minimal engine around a scripted mock client. */
function makeEngine(
  scripts: ScriptedResponse[],
  opts: {
    extraTools?: Tool[]
    permissionChecker?: PermissionChecker
    maxIterations?: number
  } = {},
): { engine: ExecutionEngine; eventLog: EventLog } {
  const eventLog = new EventLog(workDir)
  const config: EngineConfig = {
    model: 'test-model',
    apiKey: 'test-key',
    maxIterations: opts.maxIterations ?? 5,
    cwd: workDir,
    permissionMode: 'auto',
    enabledModules: [], // keep the loop lightweight; modules have their own tests
    sessionDir: workDir,
    eventLog,
    extraTools: opts.extraTools,
    client: createMockClient(scripts),
    permissionChecker: opts.permissionChecker,
  }
  const engine = new ExecutionEngine(config, new Renderer())
  return { engine, eventLog }
}

describe('ExecutionEngine runTurn — error path', () => {
  it('surfaces the failure message on TurnResult.error (not just reason:"error")', async () => {
    const { engine } = makeEngine([errorResponse(new Error('401 Invalid API key'))])
    const { result } = await engine.runTurn('do something', [])
    expect(result.reason).toBe('error')
    expect(result.error).toBe('401 Invalid API key')
  })

  it('writes an "error" event to the EventLog with the message', async () => {
    const { engine, eventLog } = makeEngine([errorResponse(new Error('boom'))])
    await engine.runTurn('go', [])
    const errors = eventLog.readAll().filter(e => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(String(errors[0].detail.error)).toContain('boom')
  })
})

describe('ExecutionEngine runTurn — token usage', () => {
  it('records usage from the trailing stream chunk', async () => {
    const { engine } = makeEngine([
      textResponse('hello', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    ])
    await engine.runTurn('hi', [])
    const u = engine.getTokenUsage()
    expect(u.promptTokens).toBe(100)
    expect(u.completionTokens).toBe(20)
    expect(u.totalTokens).toBe(120)
    expect(u.calls).toBe(1)
  })

  it('accumulates usage across multiple LLM calls in one turn', async () => {
    const rec = makeRecordingTool()
    const { engine } = makeEngine([
      toolCallResponse([{ name: 'Recorder', arguments: { input: 'a' } }]),
      textResponse('done', { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }),
    ], { extraTools: [rec.tool] })
    await engine.runTurn('run it', [])
    expect(engine.getTokenUsage().totalTokens).toBe(60) // usage absent on the tool-call leg
  })
})

describe('ExecutionEngine runTurn — tool loop', () => {
  it('executes a requested tool then stops on a text reply', async () => {
    const rec = makeRecordingTool()
    const { engine } = makeEngine([
      toolCallResponse([{ name: 'Recorder', arguments: { input: 'hello' } }]),
      textResponse('all done'),
    ], { extraTools: [rec.tool] })
    const { result, newHistory } = await engine.runTurn('use the tool', [])
    expect(rec.calls).toEqual([{ input: 'hello' }])
    expect(result.reason).toBe('stop_sequence')
    // history: user, assistant(tool_call), tool(result), assistant(text)
    const roles = newHistory.map(m => m.role)
    expect(roles).toContain('tool')
  })
})

describe('ExecutionEngine runTurn — permission gate', () => {
  it('blocks a denied tool and feeds back an error tool_result without executing', async () => {
    const rec = makeRecordingTool()
    const deny = new PermissionChecker('auto', [{ tool: 'Recorder', action: 'deny' }])
    const { engine } = makeEngine([
      toolCallResponse([{ name: 'Recorder', arguments: { input: 'x' } }]),
      textResponse('okay'),
    ], { extraTools: [rec.tool], permissionChecker: deny })
    const { newHistory } = await engine.runTurn('try the tool', [])
    expect(rec.calls).toHaveLength(0) // never executed
    const toolMsg = newHistory.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(String(toolMsg!.content)).toContain('Permission denied')
  })
})

describe('ExecutionEngine runTurn — bad-args self-heal', () => {
  it('rejects malformed tool arguments instead of executing with {}', async () => {
    const rec = makeRecordingTool()
    // A raw scripted response whose arguments string is invalid JSON.
    const malformed: ScriptedResponse = {
      kind: 'tool_calls',
      calls: [{ id: 'call_0', name: 'Recorder', arguments: '{ not valid json' }],
    }
    const { engine } = makeEngine([malformed, textResponse('recovered')], {
      extraTools: [rec.tool],
    })
    const { newHistory } = await engine.runTurn('call it badly', [])
    expect(rec.calls).toHaveLength(0) // never executed with garbage
    const toolMsg = newHistory.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(String(toolMsg!.content).toLowerCase()).toMatch(/error|invalid|parse/)
  })
})

describe('ExecutionEngine runTurn — concurrency actually executes in parallel', () => {
  /** A tool that stays "active" for a few ms so we can detect execution overlap. */
  function makeOverlapTool(name: string, tracker: { active: number; max: number }): Tool {
    return {
      name,
      concurrencySafe: true,
      definition: {
        type: 'function',
        function: {
          name,
          description: 'slow tool',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute(): Promise<{ content: string; isError: boolean }> {
        tracker.active++
        if (tracker.active > tracker.max) tracker.max = tracker.active
        return new Promise(resolve =>
          setTimeout(() => {
            tracker.active--
            resolve({ content: `ok:${name}`, isError: false })
          }, 20),
        )
      },
    }
  }

  it('runs two concurrencySafe tools concurrently (overlap observed)', async () => {
    const tracker = { active: 0, max: 0 }
    const { engine } = makeEngine(
      [
        toolCallResponse([
          { name: 'A', arguments: {} },
          { name: 'B', arguments: {} },
        ]),
        textResponse('done'),
      ],
      { extraTools: [makeOverlapTool('A', tracker), makeOverlapTool('B', tracker)] },
    )
    await engine.runTurn('run both', [])
    expect(tracker.max).toBeGreaterThanOrEqual(2) // they overlapped
  })

  it('runs two stateful (non-safe) tools serially (no overlap)', async () => {
    const tracker = { active: 0, max: 0 }
    const mk = (name: string): Tool => {
      const t = makeOverlapTool(name, tracker)
      t.concurrencySafe = false // opt out → forced serial
      return t
    }
    const { engine } = makeEngine(
      [
        toolCallResponse([
          { name: 'A', arguments: {} },
          { name: 'B', arguments: {} },
        ]),
        textResponse('done'),
      ],
      { extraTools: [mk('A'), mk('B')] },
    )
    await engine.runTurn('run both serially', [])
    expect(tracker.max).toBe(1) // never overlapped
  })
})
