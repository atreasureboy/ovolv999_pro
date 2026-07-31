export interface ActiveToolCall {
  callId: string
  toolName: string
  startedAt: number
}

export class SharedRuntimeState {
  private activeToolCalls = new Map<string, ActiveToolCall>()
  private iteration = 0
  private planMode = false

  get currentIteration(): number {
    return this.iteration
  }

  setIteration(n: number): void {
    this.iteration = n
  }

  get isPlanMode(): boolean {
    return this.planMode
  }

  setPlanMode(v: boolean): void {
    this.planMode = v
  }

  addActiveToolCall(call: ActiveToolCall): void {
    this.activeToolCalls.set(call.callId, call)
  }

  removeActiveToolCall(callId: string): void {
    this.activeToolCalls.delete(callId)
  }

  getActiveToolCalls(): ReadonlyMap<string, ActiveToolCall> {
    return this.activeToolCalls
  }

  clear(): void {
    this.activeToolCalls.clear()
    this.iteration = 0
    this.planMode = false
  }
}
