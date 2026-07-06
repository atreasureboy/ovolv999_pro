/**
 * Safe string coercion for tool inputs.
 *
 * Tool inputs arrive as `Record<string, unknown>` (parsed JSON).  Calling
 * `String(unknown)` risks "[object Object]" for object/array values.
 * This helper narrows to primitives first.
 */
export function str(v: unknown, def = ''): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return def
}
