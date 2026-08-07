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
import { PermissionChecker, type Approver } from '../src/core/permission.js'
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
    description: `Test recorder tool: ${name}`,
    category: 'readonly' as const,
    riskLevel: 'safe' as const,
    concurrencySafe: true,
    planModeAllowed: true,
    informationalAllowed: true,
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
    maxContextTokens?: number
    pricing?: { inputPer1M?: number; outputPer1M?: number }
    maxCostUsd?: number
    systemPrompt?: string
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
    maxContextTokens: opts.maxContextTokens,
    pricing: opts.pricing,
    maxCostUsd: opts.maxCostUsd,
    systemPrompt: opts.systemPrompt,
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
    const errors = eventLog.readAll().filter((e) => e.type === 'error')
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
    const { engine } = makeEngine(
      [
        toolCallResponse([{ name: 'Recorder', arguments: { input: 'a' } }]),
        textResponse('done', { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }),
      ],
      { extraTools: [rec.tool] },
    )
    await engine.runTurn('run it', [])
    expect(engine.getTokenUsage().totalTokens).toBe(60) // usage absent on the tool-call leg
  })
})

describe('ExecutionEngine runTurn — tool loop', () => {
  it('executes a requested tool then stops on a text reply', async () => {
    const rec = makeRecordingTool()
    const { engine } = makeEngine(
      [
        toolCallResponse([{ name: 'Recorder', arguments: { input: 'hello' } }]),
        textResponse('all done'),
      ],
      { extraTools: [rec.tool] },
    )
    const { result, newHistory } = await engine.runTurn('use the tool', [])
    expect(rec.calls).toEqual([{ input: 'hello' }])
    expect(result.reason).toBe('stop_sequence')
    // history: user, assistant(tool_call), tool(result), assistant(text)
    const roles = newHistory.map((m) => m.role)
    expect(roles).toContain('tool')
  })
})

describe('ExecutionEngine runTurn — cost budget', () => {
  it('stops with budget_exceeded before the next LLM call once cost >= maxCostUsd', async () => {
    const rec = makeRecordingTool()
    // Pricing $1000/1M tokens → the first (1000-token) call costs $1.00.
    // maxCostUsd 0.50 → the check before the 2nd call trips.
    const { engine } = makeEngine(
      [
        toolCallResponse([{ name: 'Recorder', arguments: { input: 'x' } }], {
          prompt_tokens: 1000,
          completion_tokens: 0,
          total_tokens: 1000,
        }),
        textResponse('should never be consumed'),
      ],
      {
        extraTools: [rec.tool],
        pricing: { inputPer1M: 1000, outputPer1M: 1000 },
        maxCostUsd: 0.5,
      },
    )
    const { result } = await engine.runTurn('run it', [])
    expect(result.reason).toBe('budget_exceeded')
    expect(rec.calls).toHaveLength(1) // first iteration ran before the budget tripped
    expect(engine.getTokenUsage().costUsd).toBeGreaterThanOrEqual(0.5)
  })

  it('runs normally when maxCostUsd is not configured', async () => {
    const { engine } = makeEngine([textResponse('hi')], {
      pricing: { inputPer1M: 1000, outputPer1M: 1000 },
    })
    const { result } = await engine.runTurn('go', [])
    expect(result.reason).toBe('stop_sequence')
  })
})

describe('ExecutionEngine runTurn — max iterations exit', () => {
  it('reports max_iterations with the accumulated output (sentinel path)', async () => {
    // Every call emits a tool call → loop never decides → maxIterations exhausts.
    const rec = makeRecordingTool()
    const { engine } = makeEngine(
      [
        toolCallResponse([{ name: 'Recorder', arguments: { input: '1' } }]),
        toolCallResponse([{ name: 'Recorder', arguments: { input: '2' } }]),
      ],
      { extraTools: [rec.tool], maxIterations: 2 },
    )
    const { result } = await engine.runTurn('loop', [])
    expect(result.reason).toBe('max_iterations')
  })
})

describe('ExecutionEngine runTurn — Bash permission gate', () => {
  it('ask-mode: consults the approver for shell commands', async () => {
    const seen: string[] = []
    const approver: Approver = (req) => {
      seen.push(`${req.tool}:${req.fingerprint}`)
      return Promise.resolve(true)
    }
    const checker = new PermissionChecker('ask', [], approver)
    const { engine } = makeEngine(
      [
        toolCallResponse([{ name: 'Bash', arguments: { command: 'echo permission-probe' } }]),
        textResponse('done'),
      ],
      // systemPrompt carries the mutation keyword so the engine's TaskIntent
      // (classified at construction) allows Bash — otherwise an informational
      // intent policy-blocks the shell before the permission gate is reached.
      { permissionChecker: checker, systemPrompt: 'create the output file as requested' },
    )
    const { newHistory } = await engine.runTurn('create the output by running the command', [])
    expect(seen.some((s) => s.startsWith('Bash:'))).toBe(true) // gate was consulted
    const toolMsg = newHistory.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('permission-probe') // approved → executed
  })

  it('auto-mode: user deny rules still apply to Bash commands', async () => {
    const checker = new PermissionChecker('auto', [
      { tool: 'Bash', pattern: 'echo blocked-probe', action: 'deny' },
    ])
    const { engine } = makeEngine(
      [
        toolCallResponse([{ name: 'Bash', arguments: { command: 'echo blocked-probe' } }]),
        textResponse('done'),
      ],
      { permissionChecker: checker, systemPrompt: 'create the output file as requested' },
    )
    const { newHistory } = await engine.runTurn('create the output by running the command', [])
    const toolMsg = newHistory.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('Permission denied')
    expect(String(toolMsg?.content)).not.toContain('blocked-probe]')
  })
})

describe('ExecutionEngine runTurn — permission gate', () => {
  it('blocks a denied tool and feeds back an error tool_result without executing', async () => {
    const rec = makeRecordingTool()
    const deny = new PermissionChecker('auto', [{ tool: 'Recorder', action: 'deny' }])
    const { engine } = makeEngine(
      [toolCallResponse([{ name: 'Recorder', arguments: { input: 'x' } }]), textResponse('okay')],
      { extraTools: [rec.tool], permissionChecker: deny },
    )
    const { newHistory } = await engine.runTurn('try the tool', [])
    expect(rec.calls).toHaveLength(0) // never executed
    const toolMsg = newHistory.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(String(toolMsg!.content)).toContain('Permission denied')
  })

  it('ask-mode: invokes the injected approver and runs the tool when approved', async () => {
    const rec = makeRecordingTool()
    const seen: string[] = []
    const approver: Approver = (req) => {
      seen.push(`${req.tool}:${req.fingerprint}`)
      return Promise.resolve(true)
    }
    const checker = new PermissionChecker('ask', [], approver) // no rules → default ask
    const { engine } = makeEngine(
      [toolCallResponse([{ name: 'Recorder', arguments: { input: 'z' } }]), textResponse('ok')],
      { extraTools: [rec.tool], permissionChecker: checker },
    )
    await engine.runTurn('use it', [])
    expect(seen).toHaveLength(1) // approver was consulted
    expect(seen[0]).toContain('Recorder')
    expect(rec.calls).toEqual([{ input: 'z' }]) // tool actually ran
  })

  it('ask-mode: blocks the tool when the approver returns false', async () => {
    const rec = makeRecordingTool()
    const approver: Approver = () => Promise.resolve(false)
    const checker = new PermissionChecker('ask', [], approver)
    const { engine } = makeEngine(
      [toolCallResponse([{ name: 'Recorder', arguments: { input: 'z' } }]), textResponse('ok')],
      { extraTools: [rec.tool], permissionChecker: checker },
    )
    const { newHistory } = await engine.runTurn('use it', [])
    expect(rec.calls).toHaveLength(0) // approver said no → never ran
    const toolMsg = newHistory.find((m) => m.role === 'tool')
    expect(String(toolMsg!.content)).toContain('denied by user')
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
    const toolMsg = newHistory.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(String(toolMsg!.content).toLowerCase()).toMatch(/error|invalid|parse/)
  })
})

describe('ExecutionEngine runTurn — concurrency actually executes in parallel', () => {
  /** A tool that stays "active" for a few ms so we can detect execution overlap. */
  function makeOverlapTool(name: string, tracker: { active: number; max: number }): Tool {
    return {
      name,
      description: `Slow tool: ${name}`,
      category: 'readonly' as const,
      riskLevel: 'safe' as const,
      concurrencySafe: true,
      planModeAllowed: true,
      informationalAllowed: true,
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
        return new Promise((resolve) =>
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

describe('ExecutionEngine runTurn — context compaction', () => {
  it('summarizes old messages when context pressure exceeds the compact threshold', async () => {
    // Pre-fill a long history so the engine has enough messages to compact
    // (aggressive strategy keeps 4 recent; needs >= 8 total to proceed).
    const longHistory: { role: 'user' | 'assistant'; content: string }[] = []
    for (let i = 0; i < 10; i++) {
      longHistory.push({
        role: 'user',
        content: `earlier task number ${i} with plenty of detail `.repeat(4),
      })
      longHistory.push({
        role: 'assistant',
        content: `acknowledged task ${i} and did substantial work on it`.repeat(4),
      })
    }
    const preCount = longHistory.length + 1 // +1 for the new user message

    // scripts[0] = compaction summarization (non-streaming); scripts[1] = final reply (streaming)
    const { engine, eventLog } = makeEngine(
      [
        textResponse(
          '<summary>The user worked through ten earlier tasks; all completed.</summary>',
        ),
        textResponse('all done'),
      ],
      { maxContextTokens: 100 }, // tiny window → pressure forces aggressive compaction
    )
    const { result, newHistory } = await engine.runTurn('next step', longHistory)

    // A compaction event was recorded with the strategy + token reduction.
    const compactions = eventLog.readAll().filter((e) => e.type === 'context_compact')
    expect(compactions.length).toBeGreaterThan(0)

    // The compacted history carries the summary marker and is smaller than before.
    const hasSummary = newHistory.some(
      (m) => typeof m.content === 'string' && m.content.includes('CONVERSATION SUMMARY'),
    )
    expect(hasSummary).toBe(true)
    expect(newHistory.length).toBeLessThan(preCount)
    expect(result.reason).toBe('stop_sequence')
  })
})
