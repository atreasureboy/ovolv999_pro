/**
 * FileWriteTool — write/create files
 * Reference: src/tools/FileWriteTool/
 */

import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { WRITE_FILE_DESCRIPTION } from '../prompts/tools.js'
import { atomicWrite } from '../core/atomicWrite.js'
import { containsPathTraversal, containsNullByte, isPathWithin } from '../core/pathSecurity.js'

export interface WriteFileInput {
  file_path: string
  content: string
}

export class FileWriteTool implements Tool {
  name = 'Write'
  description = 'Write or overwrite a file'
  category = 'mutation' as const
  riskLevel = 'safe' as const
  concurrencySafe = false
  planModeAllowed = false
  informationalAllowed = false

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Write',
      description: WRITE_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to write to',
          },
          content: {
            type: 'string',
            description: 'Content to write',
          },
        },
        required: ['file_path', 'content'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path, content } = input as unknown as WriteFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }
    if (typeof content !== 'string') {
      return { content: 'Error: content must be a string', isError: true }
    }
    if (containsNullByte(file_path)) {
      return { content: 'Error: file_path contains null byte', isError: true }
    }
    if (containsPathTraversal(file_path)) {
      return { content: 'Error: path traversal detected in file_path', isError: true }
    }
    if (!isPathWithin(file_path, context.cwd)) {
      return {
        content: `Error: file_path must be within the project directory (${context.cwd})`,
        isError: true,
      }
    }

    try {
      await mkdir(dirname(file_path), { recursive: true })
      await atomicWrite(file_path, content, { encoding: 'utf8' })

      const lines = content.split('\n').length
      return {
        content: `File written: ${file_path} (${lines} lines, ${content.length} bytes)`,
        isError: false,
        bytesWritten: content.length,
        linesChanged: lines,
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      return { content: `Error writing file: ${error.message}`, isError: true }
    }
  }
}
