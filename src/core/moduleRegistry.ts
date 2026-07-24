/**
 * ModuleRegistry — manages module factories and resolves enabled modules.
 *
 * Usage:
 *   const registry = new ModuleRegistry()
 *   registry.register('memory', (ctx) => new MemoryModule(ctx.config.semanticMemory!, ...))
 *   const modules = registry.resolve(['memory', 'critic'], moduleCtx)
 */

import type { AgentModule, ModuleFactory, ModuleContext } from './module.js'

export class ModuleRegistry {
  private factories = new Map<string, ModuleFactory>()

  /** Register a module factory by name */
  register(name: string, factory: ModuleFactory): void {
    this.factories.set(name, factory)
  }

  /** Check if a module is registered */
  has(name: string): boolean {
    return this.factories.has(name)
  }

  /**
   * Resolve a list of enabled module names into instantiated modules.
   * Dependencies are resolved automatically (depth-first, deduplicated).
   *
   * Failure modes (previously silent — now surfaced):
   *   - A dependency cycle raises an Error immediately. A cycle is a programming
   *     bug that would otherwise produce a silently truncated module list.
   *   - An unknown/unregistered name logs a warning and is skipped, so a typo in
   *     config degrades gracefully instead of vanishing without a trace.
   */
  resolve(enabledNames: string[], ctx: ModuleContext): AgentModule[] {
    const resolved: AgentModule[] = []
    const seen = new Set<string>()
    const inProgress = new Set<string>() // cycle detection

    const resolveOne = (name: string, chain: string[]): void => {
      if (seen.has(name)) return
      if (inProgress.has(name)) {
        const cyclePath = [...chain, name].join(' → ')
        throw new Error(`ModuleRegistry: dependency cycle detected (${cyclePath})`)
      }
      const factory = this.factories.get(name)
      if (!factory) {
        // Surface the typo instead of silently dropping it. eventLog is the
        // project's audit channel; best-effort (skips when no session is active).
        ctx.config.eventLog?.append('module_error', 'ModuleRegistry', {
          unknown_module: name,
          note: 'not registered, skipping',
        })
        return
      }

      inProgress.add(name)
      const module = factory(ctx)

      // Resolve dependencies first
      for (const dep of module.dependencies ?? []) {
        resolveOne(dep, [...chain, name])
      }

      inProgress.delete(name)
      seen.add(name)
      resolved.push(module)
    }

    for (const name of enabledNames) {
      resolveOne(name, [])
    }

    return resolved
  }
}

/** Global default registry — populated at startup by bin/ovogogogo.ts */
export const globalModuleRegistry = new ModuleRegistry()
