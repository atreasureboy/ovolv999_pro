/**
 * EnvSafety — 环境变量安全过滤
 *
 * 过滤敏感凭证避免泄露给子进程。
 *
 * 策略：
 *   - 后缀匹配：最常见模式是 PROVIDER_API_KEY / SERVICE_TOKEN / APP_SECRET
 *   - 精确黑名单：已知的敏感变量名（包括大小写变体）
 *   - 避免前缀匹配：太容易误杀（TOKEN_EXPIRY 不是 secret）
 */

const SENSITIVE_SUFFIX_RE = /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/i

// Exact-match blacklist for well-known secrets not caught by suffix patterns.
// Case-insensitive: normalise to uppercase before lookup.
const SENSITIVE_EXACT = new Set(
  [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'DOCKER_AUTH',
  ].map((s) => s.toUpperCase()),
)

export function safeEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_EXACT.has(k.toUpperCase())) continue
    if (SENSITIVE_SUFFIX_RE.test(k)) continue
    env[k] = v
  }
  if (extra) {
    Object.assign(env, extra)
  }
  return env
}
