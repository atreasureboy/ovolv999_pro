import type { ToolResult, TurnResult } from '../types.js'

export type RunEvent =
  | { type: 'RUN_STARTED'; userMessage: string }
  | { type: 'BOOT_COMPLETED'; moduleCount: number; toolCount: number }
  | { type: 'ITERATION_STARTED'; iteration: number }
  | { type: 'MODEL_REQUESTED'; model: string }
  | {
      type: 'MODEL_COMPLETED'
      assistantText: string
      finishReason: string | null
      toolCallCount: number
    }
  | { type: 'MODEL_FAILED'; error: string }
  | { type: 'TOOL_BATCH_STARTED'; count: number; parallel: boolean }
  | { type: 'TOOL_STARTED'; callId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'TOOL_COMPLETED'; callId: string; toolName: string; result: ToolResult }
  | { type: 'CONTEXT_COMPACTED'; strategy: string; tokensBefore: number; tokensAfter: number }
  | { type: 'PLAN_MODE_ENTERED' }
  | { type: 'PLAN_MODE_EXITED' }
  | { type: 'ABORT_REQUESTED'; kind: 'soft' | 'hard'; reason: string }
  | { type: 'MAX_ITERATIONS_REACHED'; maxIterations: number }
  | { type: 'STALL_DETECTED'; kind: string; reason: string; action: string }
  | { type: 'RUN_COMPLETED'; result: TurnResult }
  | { type: 'RUN_FAILED'; error: string; output: string }
  | { type: 'MODEL_CHANGED'; from: string; to: string }
  | { type: 'PROGRESS_RECORDED'; kind: 'progress' | 'stall' | 'replan' }

export type RunEventType = RunEvent['type']

export type RunEventHandler<E extends RunEvent = RunEvent> = (event: E) => void

type HandlerMap = {
  [T in RunEventType]: Array<(event: Extract<RunEvent, { type: T }>) => void>
}

export class RunEventEmitter {
  private readonly handlers: Partial<HandlerMap> = {}

  on<T extends RunEventType>(
    type: T,
    handler: (event: Extract<RunEvent, { type: T }>) => void,
  ): () => void {
    if (!this.handlers[type]) {
      this.handlers[type] = [] as HandlerMap[T]
    }
    ;(this.handlers[type] as Array<(event: Extract<RunEvent, { type: T }>) => void>).push(handler)
    return () => this.off(type, handler)
  }

  off<T extends RunEventType>(
    type: T,
    handler: (event: Extract<RunEvent, { type: T }>) => void,
  ): void {
    const list = this.handlers[type]
    if (!list) return
    const idx = (list as Array<(event: unknown) => void>).indexOf(
      handler as (event: unknown) => void,
    )
    if (idx >= 0) list.splice(idx, 1)
  }

  emit(event: RunEvent): void {
    const list = this.handlers[event.type] as Array<(event: RunEvent) => void> | undefined
    if (!list) return
    for (const handler of list) {
      try {
        handler(event)
      } catch {
        /* subscriber failures must never break the runtime loop */
      }
    }
  }

  clear(): void {
    for (const key of Object.keys(this.handlers)) {
      delete (this.handlers as Record<string, unknown>)[key]
    }
  }
}
