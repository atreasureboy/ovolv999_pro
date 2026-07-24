/**
 * MCP client — stdio JSON-RPC 2.0 client for Model Context Protocol servers.
 *
 * Why this exists: MCP is the standard way to extend an agent with external
 * tools without writing them into the base. This connects to any stdio MCP
 * server, performs the initialize handshake, lists tools, and invokes them —
 * wrapping each as a first-class `Tool` so the engine treats them uniformly.
 *
 * Transport: newline-delimited JSON-RPC over the server process's stdin/stdout.
 * (stderr is surfaced to the logger, never parsed as protocol.)
 *
 * Lifecycle:
 *   const c = new McpClient('time', { command, args, env }, logger)
 *   await c.connect()                 // initialize + initialized notification
 *   const tools = await c.listTools() // tools/list
 *   const result = await c.callTool('get_time', {})  // tools/call
 *   await c.close()                   // kill + cleanup
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { Logger } from '../core/logger.js'

/** MCP tool descriptor as returned by tools/list. */
export interface McpToolDescriptor {
  name: string
  description?: string
  /** JSON Schema for the tool's arguments. */
  inputSchema?: Record<string, unknown>
}

/** One content block of a tools/call result. */
export interface McpContentBlock {
  type: string
  text?: string
  // Other block types (image, resource) are passed through verbatim.
  [k: string]: unknown
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const PROTOCOL_VERSION = '2024-11-05'

export interface McpServerLaunchConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export class McpClient {
  readonly serverName: string
  private readonly launch: McpServerLaunchConfig
  private readonly logger: Logger
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<
    string | number,
    {
      resolve: (r: unknown) => void
      reject: (e: Error) => void
    }
  >()
  private serverInfo: { name?: string; version?: string } | null = null
  private closed = false

  constructor(serverName: string, launch: McpServerLaunchConfig, logger: Logger) {
    this.serverName = serverName
    this.launch = launch
    this.logger = logger
  }

  /** Spawn the server and complete the initialize handshake. */
  async connect(): Promise<void> {
    if (this.proc) return
    const { command, args = [], env, cwd } = this.launch
    this.logger.info(`connecting MCP server "${this.serverName}": ${command} ${args.join(' ')}`)
    try {
      this.proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(env ?? {}) },
        cwd: cwd ?? process.cwd(),
      })
    } catch (err) {
      throw new Error(
        `Failed to spawn MCP server "${this.serverName}": ${(err as Error).message}`,
        { cause: err },
      )
    }

    this.proc.on('error', (err) => {
      this.logger.error(`MCP "${this.serverName}" process error`, { error: err.message })
      // Reject all pending on a hard process error
      for (const [, p] of this.pending) p.reject(new Error(`MCP server error: ${err.message}`))
      this.pending.clear()
    })
    this.proc.on('exit', (code, signal) => {
      this.logger.debug(`MCP "${this.serverName}" exited`, { code, signal: String(signal) })
      if (!this.closed) {
        for (const [, p] of this.pending) {
          p.reject(new Error(`MCP server "${this.serverName}" exited (code=${code})`))
        }
        this.pending.clear()
      }
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => {
      // Surface server diagnostics without treating them as protocol.
      this.logger.debug(`MCP "${this.serverName}" stderr: ${chunk.trim()}`)
    })

    // initialize handshake
    const initResult = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ovolv999-agent-base', version: '0.1.0' },
    })) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } }
    this.serverInfo = initResult?.serverInfo ?? {}
    // Notify initialized (no response expected)
    this.notify('notifications/initialized', {})
    this.logger.info(
      `MCP "${this.serverName}" ready` +
        (this.serverInfo.name
          ? ` (${this.serverInfo.name}${this.serverInfo.version ? '@' + this.serverInfo.version : ''})`
          : ''),
    )
  }

  /** List tools exposed by the server. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDescriptor[] }
    return result?.tools ?? []
  }

  /** Invoke a tool by name with the given arguments. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpContentBlock[]> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: McpContentBlock[]
    }
    return result?.content ?? []
  }

  /** Stop the server process. Safe to call multiple times. */
  async close(): Promise<void> {
    this.closed = true
    if (!this.proc) return
    try {
      this.proc.stdin.end()
    } catch {
      /* best-effort */
    }
    const proc = this.proc
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already dead */
        }
        resolve()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.proc = null
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error(`MCP "${this.serverName}" not connected`))
    const id = this.nextId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(msg)
      // Safety timeout so a hung server can't stall the agent forever.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP "${this.serverName}" request "${method}" timed out`))
        }
      }, 60_000)
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(msg: JsonRpcRequest | { jsonrpc: '2.0'; method: string; params: unknown }): void {
    if (!this.proc) return
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      this.logger.error(`MCP "${this.serverName}" write failed`, { error: (err as Error).message })
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      this.handleMessage(line)
    }
  }

  private handleMessage(line: string): void {
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(line) as JsonRpcResponse
    } catch {
      this.logger.debug(`MCP "${this.serverName}" non-JSON line: ${line.slice(0, 200)}`)
      return
    }
    if (msg.id === undefined || msg.id === null) return // server notification — ignored for now
    const waiter = this.pending.get(msg.id)
    if (!waiter) return
    this.pending.delete(msg.id)
    if (msg.error) {
      waiter.reject(new Error(`MCP "${this.serverName}": ${msg.error.message}`))
    } else {
      waiter.resolve(msg.result)
    }
  }
}
