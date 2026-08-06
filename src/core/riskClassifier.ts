/**
 * Risk Classifier — Shell 命令三级风险分类
 *
 * 风险级别：
 * - safe: 安全命令（ls, cat, git status 等）
 * - needs_approval: 需要审批的命令（未知命令、有副作用的命令）
 * - dangerous: 危险命令（rm -rf, sudo, DROP TABLE 等）
 *
 * 分类逻辑：
 * 1. 先检查危险模式（正则匹配）
 * 2. 检查安全前缀白名单
 * 3. Git 子命令细粒度分类
 * 4. 命令替换检测（$(), 反引号, ;）
 */

export type RiskLevel = 'safe' | 'needs_approval' | 'dangerous'

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\b(?=.*(?:\s-[a-zA-Z]*r[a-zA-Z]*\b|\s--recursive\b))/,
  /\brm\s+.*--no-preserve-root/,
  /\brm\s+(-rf|-fr)\s+\//, // rm -rf / (absolute root destruction)
  /\bdd\s+.*of=\/dev\//,
  /\bmkfs\./,
  />\s*\/dev\/(sd|nvme|hd|vd)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\binit\s+[06]\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /(?:^|[;&|]+|`|\$\()\s*(sudo|su)\b/,
  /\bchmod\s+(-R\s+)?[0-7]*7[0-7]*\s+\//,
  /\bchmod\s+(-R\s+)?[0-7]*7[0-7]*\s+\S/, // chmod 777 on any path (not just root)
  /\bchown\s+-R\s+.*\s+\//,
  /\bchown\s+\S+:\S+\s+\//,
  /\bmkswap\b/,
  /\bmkfs\b/, // broader mkfs match (mkfs.ext4, mkfs.btrfs, etc.)
  /\bparted\b/,
  /\bfdisk\b/,
  /\bdd\s+if=/,
  /\b:(){ :|:& };:/, // fork bomb
  /\bcrontab\s+-/,
  /\bhistory\s+-c\b/,
  /\bgit\s+push\s+.*--force.*\b(main|master)\b/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+(-[a-zA-Z]*[fd])/,
  /\bgit\s+checkout\s+\./,
  /\bgit\s+restore\s+\./,
  /\bgit\s+stash\s+(drop|clear)\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+commit\s+--amend/,
  /\bgit\s+.*--no-verify/,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,
  /\bDELETE\s+FROM\b(?=.*[^;]*$)(?!.*\bWHERE\b)/i,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+destroy\b/,
]

const SAFE_PREFIXES: Set<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'fd',
  'pwd',
  'whoami',
  'echo',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'date',
  'uname',
  'hostname',
  'env',
  'printenv',
  'id',
  'which',
  'type',
  'readlink',
  'basename',
  'dirname',
  'realpath',
  'test',
  'true',
  'false',
  'tree',
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'python',
  'python3',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'cargo',
  'go',
  'rustc',
  'git',
])

const SAFE_GIT_SUBCOMMANDS: Set<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'tag',
  'remote',
  'describe',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'shortlog',
  'blame',
  'stash',
  'config',
])

function extractFirstWord(segment: string): string {
  const stripped = segment.trim()
  if (!stripped) return ''
  return stripped.split(/\s+/)[0] ?? ''
}

function classifySegment(segment: string): RiskLevel {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(segment)) return 'dangerous'
  }

  const firstWord = extractFirstWord(segment)
  if (!firstWord) return 'needs_approval'

  if (SAFE_PREFIXES.has(firstWord)) {
    if (firstWord === 'git') return classifyGit(segment)
    if (/\$\(|`|;\s|&&|\|\||-exec\b/.test(segment)) {
      return 'needs_approval'
    }
    return 'safe'
  }

  return 'needs_approval'
}

function classifyGit(segment: string): RiskLevel {
  const tokens = segment.split(/\s+/)
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('-')) {
      return SAFE_GIT_SUBCOMMANDS.has(token) ? 'safe' : 'needs_approval'
    }
  }
  return 'safe'
}

export function classifyCommandRisk(command: string): RiskLevel {
  if (!command.trim()) return 'needs_approval'

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return 'dangerous'
  }

  const lines = command.trim().split('\n')
  let worst: RiskLevel = 'safe'

  for (const line of lines) {
    const segments = line.split(/\s*(?:\|\||&&|;|\||&)\s*/)
    for (const segment of segments) {
      const trimmed = segment.trim()
      if (!trimmed) continue
      const cleaned = trimmed.replace(/^[A-Z_][A-Z0-9_]*=\S+\s+/, '')
      const level = classifySegment(cleaned)
      if (level === 'dangerous') return 'dangerous'
      if (level === 'needs_approval') worst = 'needs_approval'
    }
  }

  return worst
}
