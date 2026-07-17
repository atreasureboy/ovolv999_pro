/**
 * Scripted mock OpenAI client for engine integration tests.
 *
 * The real SDK client returns a stream of ChatCompletionChunk objects from
 * `chat.completions.create()`. This mock lets a test script a sequence of
 * responses (text / tool-calls / thrown error) — one per `create()` call — so
 * the full engine loop (LLM → parse → permission gate → tool exec → loop) can
 * be exercised without network access or API spend.
 *
 * Usage:
 *   const client = createMockClient([
 *     textResponse('hello'),                       // 1st LLM call
 *     toolCallResponse('Echo', { msg: 'hi' }),     // 2nd: emit a tool call
 *     textResponse('done'),                        // 3rd: final reply
 *   ])
 *   const engine = new ExecutionEngine({ ..., client }, new Renderer())
 */

import type OpenAI from 'openai'

export interface MockUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** One scripted LLM response. */
export type ScriptedResponse =
  | { kind: 'text'; content: string; usage?: MockUsage }
  | {
      kind: 'tool_calls'
      calls: { id: string; name: string; arguments: string }[]
      usage?: MockUsage
    }
  | { kind: 'error'; error: Error }

/** A text reply that ends the turn (finish_reason: stop, no tool calls). */
export function textResponse(content: string, usage?: MockUsage): ScriptedResponse {
  return { kind: 'text', content, usage }
}

/** One or more tool-call requests. Arguments is a JSON string (as the API sends). */
export function toolCallResponse(
  calls: { name: string; arguments: Record<string, unknown>; id?: string }[],
  usage?: MockUsage,
): ScriptedResponse {
  return {
    kind: 'tool_calls',
    calls: calls.map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.name,
      arguments: JSON.stringify(c.arguments),
    })),
    usage,
  }
}

/** A response that throws (simulates an API/auth/network failure). */
export function errorResponse(error: Error): ScriptedResponse {
  return { kind: 'error', error }
}

/** Build the chunk stream for a scripted response. */
function buildChunks(res: ScriptedResponse): Record<string, unknown>[] {
  if (res.kind === 'text') {
    return [
      { choices: [{ delta: { content: res.content }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: res.usage ?? null },
    ]
  }
  if (res.kind === 'tool_calls') {
    return [
      {
        choices: [
          {
            delta: {
              tool_calls: res.calls.map((c, index) => ({
                index,
                id: c.id,
                function: { name: c.name, arguments: c.arguments },
              })),
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: res.usage ?? null },
    ]
  }
  return []
}

/**
 * Create a mock OpenAI client that replays `scripts` in order, one per
 * `chat.completions.create()` call. Throws if the engine makes more calls than
 * scripted (surfaces unexpected loops in a test).
 */
export function createMockClient(scripts: ScriptedResponse[]): OpenAI {
  let callIndex = 0
  // Returns a Promise of a chunk stream for the next scripted response.
  const create = (): Promise<AsyncIterable<Record<string, unknown>>> => {
    const script = scripts[callIndex++]
    if (!script) {
      return Promise.reject(
        new Error(
          `mock client: create() called ${callIndex} times but only ${scripts.length} response(s) scripted`,
        ),
      )
    }
    if (script.kind === 'error') return Promise.reject(script.error)
    const chunks = buildChunks(script)
    // A sync generator is `for await`-compatible at runtime; cast satisfies the
    // AsyncIterable type the engine expects.
    function* gen(): Generator<Record<string, unknown>> {
      for (const c of chunks) yield c
    }
    return Promise.resolve(gen() as unknown as AsyncIterable<Record<string, unknown>>)
  }
  // Structurally compatible with the slice of OpenAI the engine uses.
  return { chat: { completions: { create } } } as unknown as OpenAI
}
