/**
 * EnvSafety — 环境变量安全过滤
 *
 * 过滤敏感凭证（API key / token / secret / password）避免泄露给子进程。
 */

const SENSITIVE_ENV_RE = /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i

export function safeEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_ENV_RE.test(k)) continue
    env[k] = v
  }
  if (extra) {
    Object.assign(env, extra)
  }
  return env
}