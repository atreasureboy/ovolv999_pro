/**
 * WorkspaceModule — session directory for artifacts.
 *
 * Provides sessionDir to ToolContext so tools can write outputs
 * (generated files, logs, reports) to an isolated per-session directory.
 */

import type { AgentModule, ModuleBootContext, ModuleBootResult, ModuleDescription } from '../core/module.js'

export class WorkspaceModule implements AgentModule {
  readonly name = 'workspace'

  constructor(private sessionDir?: string) {}

  boot(ctx: ModuleBootContext): ModuleBootResult {
    const sessionDir = this.sessionDir ?? ctx.sessionDir
    return {
      toolContextPatch: sessionDir ? { sessionDir } : {},
    }
  }

  describe(): ModuleDescription {
    return {
      name: this.name,
      capabilities: ['session-workspace', 'artifact-storage'],
      version: '1.0.0',
    }
  }
}
