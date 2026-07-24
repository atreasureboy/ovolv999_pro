/**
 * SecretSanitizer — Redacts API keys, secret tokens, private keys, and credentials.
 *
 * Ensures multi-tenant isolation and security compliance by preventing secret leakage into
 * log files, persistent session stores, or LLM contexts.
 */

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'OpenAI/Anthropic API Key',
    regex: /(?:sk-[a-zA-Z0-9_-]{20,})|(?:sk-ant-api03-[a-zA-Z0-9_-]{20,})/g,
  },
  { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/g },
  {
    name: 'AWS Secret Access Key',
    regex: /(?:aws_secret_access_key\s*=\s*)([A-Za-z0-9/+=]{40})/gi,
  },
  { name: 'GitHub Personal Access Token', regex: /gh[pousr]_[a-zA-Z0-9]{36}/g },
  { name: 'Slack Token', regex: /xox[baprs]-[a-zA-Z0-9_-]{10,}/g },
  { name: 'JWT Token', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g },
  {
    name: 'Database Connection Credentials',
    regex: /(?:postgres|postgresql|mongodb|mongodb\+srv|mysql|redis):\/\/[^:]+:([^@]+)@/gi,
  },
  { name: 'Bearer Token', regex: /Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi },
  {
    name: 'Generic Password Parameter',
    regex: /(?:"?password"?|"?secret"?|"?token"?)\s*:\s*"([^"]{6,})"/gi,
  },
  {
    name: 'Private Key Header',
    regex:
      /-----BEGIN\s+(?:RSA|EC|OPENSSH|PRIVATE)\s+KEY-----[\s\S]*?-----END\s+(?:RSA|EC|OPENSSH|PRIVATE)\s+KEY-----/gi,
  },
]

export class SecretSanitizer {
  /** Redact sensitive credentials from text */
  static redact(text: string): string {
    if (!text || typeof text !== 'string') return text
    let sanitized = text

    for (const { regex } of SECRET_PATTERNS) {
      sanitized = sanitized.replace(regex, '[REDACTED_SECRET]')
    }

    return sanitized
  }

  /** Redact sensitive credentials from deep objects */
  static redactObject<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj
    if (typeof obj === 'string') return SecretSanitizer.redact(obj) as unknown as T
    if (typeof obj !== 'object') return obj

    if (Array.isArray(obj)) {
      return (obj as unknown[]).map((item: unknown) =>
        SecretSanitizer.redactObject(item),
      ) as unknown as T
    }

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (/password|secret|token|apiKey|private_key|key/i.test(key) && typeof value === 'string') {
        result[key] = '[REDACTED_SECRET]'
      } else {
        result[key] = SecretSanitizer.redactObject(value)
      }
    }
    return result as T
  }
}
