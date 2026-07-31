import type { Tool, ToolDefinition } from '../types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return [...this.tools.values()]
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getDefinitions(tools?: Tool[]): ToolDefinition[] {
    const source = tools ?? this.getAll()
    return source.map((t) => t.definition)
  }

  clear(): void {
    this.tools.clear()
  }
}
