/**
 * Tool Descriptions — 工具描述
 *
 * 借鉴 Fable5 的工具描述风格，每个工具包含：
 * - 基本描述
 * - 适用场景 (When to Use)
 * - 不适用场景 (When NOT to Use)
 * - 关键工具包含示例 (Examples)
 */

// ── Bash ──────────────────────────────────────────────────────────

export const BASH_DESCRIPTION = `Executes a bash command and returns its output (stdout + stderr combined).

The working directory persists between calls via absolute paths. Shell state (variables, aliases) does NOT persist.

### When to Use Bash

Bash is the right tool for:
- Shell commands (build tools, compilers, test runners, git, npm/yarn/pip)
- System operations (process management, environment inspection, network checks)
- Running scripts and tools that have no dedicated agent tool

### When NOT to Use Bash — Use Dedicated Tools Instead

These file operations should use dedicated tools, not Bash:
- File search → Glob (not find or ls)
- Content search → Grep (not grep or rg — Grep uses ripgrep with .gitignore awareness)
- Read files → Read (not cat/head/tail)
- Edit files → Edit (not sed/awk)
- Write files → Write (not echo > or cat <<EOF)
- Multi-edit files → MultiEdit (not chained sed calls)

These interactive processes should use TmuxSession, not Bash:
- Python/Node/Ruby REPL (blocks on stdin → timeout)
- CLI tools showing "> / # / $" prompts waiting for input
- Database clients (mysql, psql) in interactive mode
- nc/ncat without -l in a piped shell

### Timeout Strategy

The timeout parameter is ALWAYS in milliseconds. Default: 1800000 (30 min). Max: 14400000 (4 h).

Do NOT pass small numbers like 300 or 1800 — those mean 0.3s / 1.8s and will kill your command instantly. If unsure, OMIT the timeout field and let the default (30 min) apply.

When you do set an explicit timeout, use milliseconds:
- Build / compile: timeout=300000 (5 min)
- Test suites: timeout=600000 (10 min)
- Long-running tasks: timeout=3600000+ (1 h+)

### Background Pattern for Long-Running Commands

For commands expected to run >5 minutes, ALWAYS use background mode to avoid blocking:

\`\`\`
# Step 1: Launch in background, redirect output to file
run_in_background=true
command: "npm run build > /tmp/build.log 2>&1"

# Step 2 (later): Check progress or read results
command: "tail -50 /tmp/build.log"

# Or wait for completion and read
command: "wait && cat /tmp/build.log"
\`\`\`

### Parallel Execution

To run multiple independent commands simultaneously, call Bash multiple times with run_in_background=true in the SAME response. All background jobs start simultaneously.

Example: Run build + lint + test all at once:
- Call 1: build → /tmp/build.log (background)
- Call 2: lint → /tmp/lint.log (background)
- Call 3: test → /tmp/test.log (background)
Then in next turn: read all three output files and report results.

### Path and Shell Conventions
- Always quote paths with spaces: "path with spaces/file.txt"
- Use absolute paths to avoid cwd confusion
- For dependent sequential commands, chain with && in one call
- Avoid cd — prefer absolute paths or the --directory flag of the tool`

// ── File Tools ────────────────────────────────────────────────────

export const READ_FILE_DESCRIPTION = `Reads a file from the filesystem and returns its contents with line numbers.

### When to Use
- Inspecting any file's content (code, config, data, logs)
- Understanding existing implementation before editing
- Verifying the result of a file operation
- Large files: use offset and limit for partial reads

### When NOT to Use
- Don't use Bash (cat/head/tail) — Read formats output with line numbers, handles pagination
- Don't use Read to search — use Grep to find files containing patterns, then Read only the relevant files
- Don't read the same file repeatedly — cache what you need

Output is in cat -n format: "line_number\\tcontent"`

export const WRITE_FILE_DESCRIPTION = `Writes content to a file, creating it if it doesn't exist or fully overwriting if it does.

### When to Use
- Creating new files
- Complete rewrites where the entire content changes
- Generating output or reports

### When NOT to Use
- Small edits to existing files → use Edit (precise string replacement)
- Multiple edits to the same file → use MultiEdit (single-commit atomic)
- Append-only → use Bash (>> append) if no dedicated append tool exists

Always read the file first before overwriting to avoid losing content. After writing, verify with Read.`

export const EDIT_FILE_DESCRIPTION = `Performs exact string replacement in a file — the preferred way to modify existing files.

### When to Use
- Changing a single function / class / section
- Fixing a bug at a specific location
- Any targeted modification where the old text is known exactly

### When NOT to Use
- Multiple non-contiguous edits in the same file → use MultiEdit
- Creating a new file → use Write
- The old_string appears multiple times → add more context to make it unique
- The change spans most of the file → use Write for a clean overwrite

### How It Works
- Provide old_string (exact match, including whitespace/indentation) and new_string
- If old_string appears multiple times and you want all replaced → use replace_all=true
- The edit is atomic: either the exact match is found and replaced, or nothing changes
- After editing, verify the result with Read or Grep`

export const GLOB_DESCRIPTION = `Finds files matching a glob pattern, sorted by modification time (newest first).

### When to Use
- Finding all files of a specific type: "**/*.ts", "src/**/*.{js,ts}"
- Locating configuration files: "**/package.json"
- Discovering project structure: "src/**/*"

### When NOT to Use
- Content search → use Grep (you need to find text inside files, not filenames)
- Directory listing → Glob returns files only (nodir: true)
- Recursive listing with live updates → Glob is a snapshot, not a watch

### Examples
- "**/*.test.ts" → all test files
- "src/modules/*.ts" → module files in src/modules/
- "*.json" → JSON files in working directory

Hidden files (dotfiles) are excluded. node_modules, .git, and dist directories are ignored.`

export const GREP_DESCRIPTION = `Searches file contents using regex patterns (powered by ripgrep).

### When to Use
- Finding where a function/class/variable is used: pattern="useEffect", glob="*.tsx"
- Locating TODO/FIXME markers: pattern="TODO|FIXME"
- Checking for patterns across the codebase: pattern="import.*from.*deprecated"
- Counting occurrences: output_mode="count"

### When NOT to Use
- Finding filenames by pattern → use Glob
- Reading entire file contents → use Read (use Grep first to find the file, then Read it)
- Simple string matching (not regex) → Grep is regex; escape special chars as needed

### Output Modes
- "files_with_matches" (default) — just the file paths
- "content" — matching lines with line numbers
- "count" — match count per file

### Examples
- Find all files importing a module: pattern="from 'lodash'", glob="*.ts"
- Show matching lines with context: pattern="handleError", output_mode="content", context=3
- Count console.log usage: pattern="console\\.log", output_mode="count"

Results are capped at 500 lines to avoid flooding context.`
