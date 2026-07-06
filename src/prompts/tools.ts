/**
 * Tool descriptions
 */

export const BASH_DESCRIPTION = `Executes a bash command and returns its output (stdout + stderr combined).

The working directory persists between calls via absolute paths. Shell state (variables, aliases) does NOT persist.

IMPORTANT: Avoid using this for file operations when dedicated tools exist:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo > or cat <<EOF)

Reserve Bash for: shell commands, build tools, test runners, git, scripts, system operations.

## Timeout Strategy

Default timeout: **1800 seconds (30 min)**. Max: **14400 seconds (4 hours)**.

Always set an explicit timeout for long-running commands based on expected duration:
- Quick commands (ls, git status): default is fine
- Build / compile: timeout=300000
- Test suites: timeout=600000
- Long-running tasks (full builds, large migrations): timeout=3600000+

## Background Pattern for Long-Running Commands

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

## Parallel Execution

To run multiple commands simultaneously, call Bash multiple times with run_in_background=true in the SAME response.
All background jobs start simultaneously. Check results later by reading their output files.

Example: Run build + lint + test all at once:
- Call 1: build → /tmp/build.log (background)
- Call 2: lint → /tmp/lint.log (background)
- Call 3: test → /tmp/test.log (background)
Then in next turn: read all three output files.

## Interactive Processes — CRITICAL WARNING

NEVER run interactive processes that wait for user input in a foreground Bash call.
These will block until timeout (30 min) and produce no useful output:

BLOCKED patterns:
- python3 / irb / node REPL (blocks on stdin)
- CLI tools that show a "> " or "$ " prompt and wait for keystrokes
- nc / ncat without -l in a piped shell

CORRECT pattern — use TmuxSession for ALL interactive processes:
  TmuxSession({ action: "new", session: "py", command: "python3 -i" })
  TmuxSession({ action: "wait_for", session: "py", pattern: ">>>", timeout: 10000 })
  TmuxSession({ action: "send", session: "py", text: "print('hello')" })
  TmuxSession({ action: "capture", session: "py", lines: 10 })

## Other Instructions
- Always quote paths with spaces: "path with spaces/file.txt"
- Use absolute paths to avoid cwd confusion
- For dependent sequential commands, chain with && in one call`

export const READ_FILE_DESCRIPTION = `Reads a file from the filesystem and returns its contents with line numbers.

Usage:
- Provide an absolute file path
- Optionally specify offset (start line) and limit (number of lines) for large files
- Returns content in cat -n format: "line_number\\tcontent"
- Can read text files, code files, JSON, YAML, etc.`

export const WRITE_FILE_DESCRIPTION = `Writes content to a file, creating it if it doesn't exist or overwriting if it does.

IMPORTANT: For existing files, prefer Edit (precise string replacement) over Write (full overwrite).
Only use Write for:
- Creating new files
- Complete rewrites where the entire content changes

Always read the file first before overwriting to avoid losing content.`

export const EDIT_FILE_DESCRIPTION = `Performs exact string replacement in a file.

Usage:
- Provide the file path, the exact string to find (old_string), and the replacement (new_string)
- The old_string must match EXACTLY including whitespace and indentation
- If old_string appears multiple times, use more context to make it unique
- Use replace_all=true to replace all occurrences

This is the preferred way to modify existing files — it's precise and shows exactly what changed.`

export const GLOB_DESCRIPTION = `Finds files matching a glob pattern, sorted by modification time (newest first).

Examples:
- "**/*.ts" — all TypeScript files recursively
- "src/**/*.{js,ts}" — JS/TS files under src/
- "*.json" — JSON files in current directory

Returns a list of matching absolute file paths.`

export const GREP_DESCRIPTION = `Searches file contents using regex patterns (powered by ripgrep).

Parameters:
- pattern: regex pattern to search for
- path: directory or file to search (defaults to cwd)
- glob: file pattern filter (e.g. "*.ts")
- output_mode: "files_with_matches" (default) | "content" | "count"
- context: lines before/after each match (when output_mode="content")
- case_insensitive: true/false

Examples:
- Find files containing "useEffect": pattern="useEffect", glob="*.tsx"
- Show matching lines: pattern="TODO", output_mode="content"
- Count matches: pattern="console.log", output_mode="count"`
