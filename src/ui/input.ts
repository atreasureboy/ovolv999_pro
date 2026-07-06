/**
 * Interactive input handler — raw readline with history support
 *
 * Provides ovogogogo-style input:
 * - ❯ prompt glyph
 * - Arrow key history navigation
 * - Ctrl+C to cancel / Ctrl+D to exit
 * - Multi-line paste support
 */

import { createInterface, type Interface } from 'readline'

export interface InputResult {
  text: string
  eof: boolean
}

export class InputHandler {
  private rl: Interface
  private history: string[] = []

  constructor() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdout.isTTY,
      historySize: 100,
    })

    // Prevent readline from closing on Ctrl+C (SIGINT).
    // Without this handler readline emits 'close', which kills the REPL.
    // Our SIGINT handler in the main entry point handles Ctrl+C instead.
    this.rl.on('SIGINT', () => {})
  }

  async readLine(promptText: string): Promise<InputResult> {
    return new Promise((resolve) => {
      // Handle Ctrl+D (EOF)
      this.rl.once('close', () => {
        resolve({ text: '', eof: true })
      })

      this.rl.question(promptText, (answer) => {
        if (answer.trim()) {
          this.history.unshift(answer)
        }
        resolve({ text: answer, eof: false })
      })
    })
  }

  close(): void {
    this.rl.close()
  }
}

/**
 * Read a single line from stdin (for pipe/non-TTY usage)
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = () => {
      if (timer) clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8').trim())
    }
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', done)
    process.stdin.on('error', done)
    timer = setTimeout(done, 10_000) // 10s generous timeout for slow pipes
  })
}
