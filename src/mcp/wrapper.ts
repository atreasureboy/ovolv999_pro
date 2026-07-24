/**
 * MCP tool wrapper + loader — bridges MCP tool descriptors into the base's
 * native `Tool` interface so the engine schedules them like built-ins.
 *
 * Naming: an MCP tool `foo` from server `time` becomes `mcp__time__foo`. This
 * prefix avoids collisions with built-in tools and makes the source obvious in
 * logs / approval prompts.
 *
 * `loadMcpServers` connects all declared servers at startup and returns the
 * combined Tool[] plus a `close()` for graceful shutdown. A server that fails to
 * connect is logged and skipped — one bad server never breaks the whole agent.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import type { Logger } from '../core/logger.js'
import {
  McpClient,
  type McpToolDescriptor,
  type McpContentBlock,
  type McpServerLaunchConfig,
} from './client.js'

/** Convert an MCP JSON Schema into the base's ToolDefinition.parameters. */
function schemaToParameters(
  inputSchema?: Record<string, unknown>,
): ToolDefinition['function']['parameters'] {
  // MCP inputSchema is already a JSON Schema object; pass through, defaulting to
  // an empty object schema for tools that take no arguments.
  if (inputSchema && typeof inputSchema === 'object') {
    return inputSchema as ToolDefinition['function']['parameters']
  }
  return { type: 'object', properties: {} }
}

/** Flatten MCP content blocks (text + others) into a single tool-result string. */
function blocksToText(blocks: McpContentBlock[]): string {
  return blocks
    .map((b) => {
      if (typeof b.text === 'string') return b.text
      // Non-text blocks (image/resource): represent compactly so the model knows.
      return `[${b.type} block]`
    })
    .join('\n')
    .trim()
}

/** Wrap a single MCP tool descriptor as a native Tool. */
export function wrapMcpTool(client: McpClient, descriptor: McpToolDescriptor): Tool {
  const callName = `mcp__${client.serverName}__${descriptor.name}`
  return {
    name: callName,
    // MCP tools are treated as concurrency-unsafe by default: their side effects
    // are unknown, so serialise them. Consumers whose MCP tools are read-only
    // can flip this per-tool in a follow-up.
    concurrencySafe: false,
    definition: {
      type: 'function',
      function: {
        name: callName,
        description: descriptor.description
          ? `[mcp:${client.serverName}] ${descriptor.description}`
          : `[mcp:${client.serverName}] ${descriptor.name}`,
        parameters: schemaToParameters(descriptor.inputSchema),
      },
    },
    async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        const blocks = await client.callTool(descriptor.name, input)
        const text = blocksToText(blocks)
        return {
          content: text || `[${callName} returned no content]`,
          isError: false,
        }
      } catch (err) {
        return {
          content: `[${callName}] invocation failed: ${(err as Error).message}`,
          isError: true,
        }
      }
    },
  }
}

export interface McpLoadResult {
  tools: Tool[]
  /** Gracefully shut down all connected servers. */
  close: () => Promise<void>
  /** Human-readable connection summary (for the startup banner). */
  summary: string[]
}

/**
 * Connect to all declared MCP servers and return their tools as native Tools.
 * Never throws on a single-server failure — logs and skips so the agent stays up.
 */
export async function loadMcpServers(
  servers: Record<string, McpServerLaunchConfig>,
  logger: Logger,
): Promise<McpLoadResult> {
  const clients: McpClient[] = []
  const tools: Tool[] = []
  const summary: string[] = []

  for (const [name, launch] of Object.entries(servers)) {
    const client = new McpClient(name, launch, logger)
    try {
      await client.connect()
      const descriptors = await client.listTools()
      for (const desc of descriptors) {
        tools.push(wrapMcpTool(client, desc))
      }
      clients.push(client)
      summary.push(`mcp:${name} — ${descriptors.length} tools`)
      logger.info(`MCP server "${name}" contributed ${descriptors.length} tool(s)`)
    } catch (err) {
      logger.warn(`MCP server "${name}" failed to connect, skipping`, {
        error: (err as Error).message,
      })
      summary.push(`mcp:${name} — FAILED (${(err as Error).message})`)
      try {
        await client.close()
      } catch {
        /* already failing */
      }
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)))
    },
    summary,
  }
}
