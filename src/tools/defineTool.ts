/**
 * defineTool — Functional tool declarator for ovolv999 Agent Base.
 *
 * Allows developers to define standard agent tools concisely without boilerplates.
 *
 * Example:
 * ```ts
 * export const queryUserTool = defineTool({
 *   name: 'query_user',
 *   description: 'Query user profile by ID',
 *   properties: {
 *     userId: { type: 'string', description: 'User ID' }
 *   },
 *   required: ['userId'],
 *   execute: async ({ userId }) => {
 *     return `User: ${userId}`
 *   }
 * })
 * ```
 */

import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolCategory,
  RiskLevel,
  ToolDefinition,
  ToolMetadata,
  ToolConfirmationRequirement,
} from '../core/types.js'

export interface DefineToolOptions<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: string
  description: string
  category?: ToolCategory
  riskLevel?: RiskLevel
  concurrencySafe?: boolean
  longRunning?: boolean
  planModeAllowed?: boolean
  informationalAllowed?: boolean
  requiresConfirmation?: ToolConfirmationRequirement
  metadata?: ToolMetadata

  /** JSON Schema parameter properties definition. */
  properties?: Record<string, unknown>
  /** Required parameter keys. */
  required?: string[]

  /** Execution handler. Returns string or ToolResult. */
  execute: (input: TInput, context: ToolContext) => Promise<string | ToolResult>

  /** Optional input pre-validation hook. */
  validateInput?: (input: Record<string, unknown>) => { valid: boolean; reason?: string }
}

export function defineTool<TInput extends Record<string, unknown> = Record<string, unknown>>(
  options: DefineToolOptions<TInput>,
): Tool {
  const category: ToolCategory = options.category ?? 'readonly'
  const riskLevel: RiskLevel = options.riskLevel ?? 'safe'
  const concurrencySafe = options.concurrencySafe ?? (category === 'readonly')
  const planModeAllowed = options.planModeAllowed ?? true
  const informationalAllowed = options.informationalAllowed ?? (category === 'readonly')

  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: options.name,
      description: options.description,
      parameters: {
        type: 'object',
        properties: options.properties ?? {},
        required: options.required ?? [],
      },
    },
  }

  return {
    name: options.name,
    description: options.description,
    category,
    riskLevel,
    concurrencySafe,
    longRunning: options.longRunning ?? false,
    planModeAllowed,
    informationalAllowed,
    requiresConfirmation: options.requiresConfirmation,
    metadata: options.metadata,
    definition,

    async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {

      if (options.validateInput) {
        const check = options.validateInput(input)
        if (!check.valid) {
          return {
            content: `Error: invalid tool input (${check.reason ?? 'validation failed'})`,
            isError: true,
          }
        }
      }

      try {
        const res = await options.execute(input as TInput, context)
        if (typeof res === 'string') {
          return { content: res, isError: false }
        }
        return res
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: `Error executing ${options.name}: ${msg}`,
          isError: true,
        }
      }
    },
  }
}
