/**
 * FileMultiEditTool — atomic multi-chunk exact string replacement in a single file
 * Allows non-contiguous block edits in one tool call to minimize token roundtrips.
 */

import { readFile, writeFile } from 'fs/promises'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export interface ReplacementChunk {
  old_string: string
  new_string: string
  start_line?: number
  end_line?: number
  replace_all?: boolean
}

export interface MultiEditFileInput {
  file_path: string
  chunks: ReplacementChunk[]
}

export class FileMultiEditTool implements Tool {
  name = 'MultiEdit'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'MultiEdit',
      description:
        'Perform multiple non-contiguous exact string replacements in a single file atomically.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to edit',
          },
          chunks: {
            type: 'array',
            description: 'Array of replacement chunks',
            items: {
              type: 'object',
              properties: {
                old_string: {
                  type: 'string',
                  description: 'Exact string to find and replace',
                },
                new_string: {
                  type: 'string',
                  description: 'Replacement content',
                },
                start_line: {
                  type: 'number',
                  description: 'Optional 1-indexed start line to limit search scope',
                },
                end_line: {
                  type: 'number',
                  description: 'Optional 1-indexed end line to limit search scope',
                },
                replace_all: {
                  type: 'boolean',
                  description: 'Replace all occurrences in scope (default: false)',
                },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['file_path', 'chunks'],
      },
    },
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const { file_path, chunks } = input as unknown as MultiEditFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { content: 'Error: chunks array must be a non-empty array', isError: true }
    }

    try {
      let content = await readFile(file_path, 'utf8')
      const lines = content.split('\n')
      let editCount = 0

      // Apply chunks sequentially from top to bottom
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const { old_string, new_string, start_line, end_line, replace_all } = chunk

        if (typeof old_string !== 'string' || typeof new_string !== 'string') {
          return {
            content: `Error in chunk [${i + 1}]: old_string and new_string must be strings`,
            isError: true,
          }
        }
        if (old_string === new_string) {
          continue // no-op for identical replacement
        }

        if (start_line !== undefined || end_line !== undefined) {
          // Scope replacement to line range
          const startIdx = Math.max(0, (start_line ?? 1) - 1)
          const endIdx = Math.min(lines.length, end_line ?? lines.length)
          const targetSlice = lines.slice(startIdx, endIdx).join('\n')

          if (!targetSlice.includes(old_string)) {
            return {
              content: `Error in chunk [${i + 1}]: old_string not found within lines ${startIdx + 1}-${endIdx}`,
              isError: true,
            }
          }

          const occurrences = countOccurrences(targetSlice, old_string)
          if (!replace_all && occurrences > 1) {
            return {
              content: `Error in chunk [${i + 1}]: old_string appears ${occurrences} times within specified line range. Make old_string more specific or set replace_all=true.`,
              isError: true,
            }
          }

          const updatedSlice = replace_all
            ? targetSlice.split(old_string).join(new_string)
            : targetSlice.replace(old_string, new_string)

          // Re-assemble content
          const before = lines.slice(0, startIdx).join('\n')
          const after = lines.slice(endIdx).join('\n')
          content = (before ? before + '\n' : '') + updatedSlice + (after ? '\n' + after : '')
          editCount += replace_all ? occurrences : 1
        } else {
          // Full file replacement
          if (!content.includes(old_string)) {
            return {
              content: `Error in chunk [${i + 1}]: old_string not found in ${file_path}`,
              isError: true,
            }
          }

          const occurrences = countOccurrences(content, old_string)
          if (!replace_all && occurrences > 1) {
            return {
              content: `Error in chunk [${i + 1}]: old_string appears ${occurrences} times in ${file_path}. Make old_string unique or set replace_all=true.`,
              isError: true,
            }
          }

          content = replace_all
            ? content.split(old_string).join(new_string)
            : content.replace(old_string, new_string)

          editCount += replace_all ? occurrences : 1
        }
      }

      await writeFile(file_path, content, 'utf8')

      return {
        content: `Successfully applied ${chunks.length} edit chunks (${editCount} replacements) to ${file_path}`,
        isError: false,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error editing file ${file_path}: ${msg}`, isError: true }
    }
  }
}

function countOccurrences(str: string, substr: string): number {
  if (!substr) return 0
  let count = 0
  let pos = 0
  while ((pos = str.indexOf(substr, pos)) !== -1) {
    count++
    pos += substr.length
  }
  return count
}
