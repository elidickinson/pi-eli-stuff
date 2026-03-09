---
name: acpx-claude
description: Delegate work to Claude via acpx (Agent Client Protocol) with full tool access. Use when directed to talk to Claude or if you get stuck and need help from a smarter model.
---

# acpx with Claude

## Turn Efficiency

Combine commands to reduce tool calls:

- **Chain sequential tasks** with `&&`: `cmd1 && cmd2 && cmd3`
- **Parallel independent tasks** with subshells and `&`: `{ cmd1 } & { cmd2 } &`
- **Group related commands** with `{ }`: `{ cmd1; cmd2; cmd3 }`
- **Skip unnecessary confirmation steps** (e.g., after cancel, proceed directly)

Named sessions must be created before use with `-s <name>`. Combine creation and first prompt:
```bash
acpx claude sessions new --name task-name && acpx claude -s task-name "prompt"
```

## Agent Execution Strategy

### Direct vs Background

Default to running acpx directly (foreground) via bash. Only use background subagents when directed to do so or:
- You have independent parallel tasks
- You need to continue working while Claude runs
- Results can be collected asynchronously

**Direct (foreground):** Simple cases. Wait for completion before proceeding.

**Background:** Use the `Agent` tool with `run_in_background: true` for parallel work. The agent should run acpx commands and report completion.

### Session Naming

**Always use named sessions (`-s <name>`)** for task isolation and clarity.

```bash
# Task: Analyze auth module
acpx claude -s analyze-auth "analyze auth module"

# Task: Re-review
acpx claude -s analyze-auth "Update analysis based on the provided information"

# Task: Refactor based on findings (new name; fresh state; assumes we don't want old context)
acpx claude -s refactor-auth "refactor auth module"
```

### Parallel Sessions

**Fan-out/fan-in pattern:**
```bash
# Fan-out: start parallel sessions and send tasks (combined for efficiency)
{
  acpx claude sessions new --name review-security && \
  acpx claude -s review-security "analyze auth module for security issues"
} &

{
  acpx claude sessions new --name review-performance && \
  acpx claude -s review-performance "profile query performance"
} &

{
  acpx claude sessions new --name docs-api && \
  acpx claude -s docs-api "document the API endpoints"
} &

# Fan-in: collect results when all complete
{
  acpx claude status -s review-security
  acpx claude status -s review-performance
  acpx claude status -s docs-api
}
# Then summarize/synthesize findings
```

### Collecting Results

For parallel or background work:

```bash
# Check if a session is still running
acpx claude status -s <name>

# Get recent turns from a session
acpx claude sessions history <name> --limit 5

# Ask a session for a summary
acpx claude -s <name> "summarize your findings in 3 bullets"
```

### Error Handling

```bash
# Session failed? Close and retry
acpx claude sessions close <name> && acpx claude sessions new --name <name>

# Timeout? Increase limit
acpx claude -s <name> --timeout 300 "your prompt"

# Stuck process? Cancel and restart (no confirmation needed)
acpx claude -s <name> cancel && acpx claude -s <name> "your prompt"
```

## Commands

### Sessions

```bash
acpx claude sessions new --name <name>   # Create named session (default)
acpx claude sessions new                 # Create default session (unnamed)
acpx claude sessions ensure              # Get existing or create (idempotent)
acpx claude sessions list                # List all sessions
acpx claude sessions show <name>         # Show session metadata
acpx claude sessions history <name> --limit 20  # Recent turns
acpx claude status                       # Default session status
acpx claude status -s <name>             # Named session status
acpx claude cancel                       # Cancel default session
acpx claude cancel -s <name>             # Cancel named session
acpx claude sessions close <name>        # Close session (keep history)
```

Create named sessions with `sessions new --name <name>` before using `-s <name>`. Use `sessions ensure` when you want to reuse existing session if available (idempotent).

### Prompt

```bash
# Named session (default, use for all tasks)
acpx claude -s <task-name> "prompt"

# One-shot (fire-and-forget, no session, -s flag not supported)
acpx claude exec "prompt"

# From file
acpx claude -s <task-name> --file <path>
acpx claude -s <task-name> --file - "extra args"        # stdin + args
```

### Options

```bash
--no-wait          # Queue prompt and return immediately
--ttl <seconds>    # Queue owner idle timeout (default 300, 0=never)
--timeout <seconds># Max wait time for prompt completion (not available in exec mode)
--verbose          # Debug logging
```

`--ttl`: How long the session process stays alive after finishing (for queued follow-ups). `--timeout`: Max time to wait for a single prompt to complete.

## Common Patterns

```bash
# Sequential tasks (new named session per task, pass context via file)
# Chain with && for single bash call when order matters
acpx claude -s analyze "analyze the codebase, write findings to /tmp/analysis.txt" && \
acpx claude -s plan "propose a refactoring plan based on /tmp/analysis.txt" && \
acpx claude -s implement "implement the changes from the plan"

# Parallel workstreams (subshells with & for parallel execution)
{
  acpx claude sessions new --name backend && acpx claude -s backend "fix API bug"
} &

{
  acpx claude sessions new --name frontend && acpx claude -s frontend "update UI"
} &

{
  acpx claude sessions new --name docs && acpx claude -s docs "write changelog"
} &

# One-shot fire-and-forget (no session, no history)
acpx claude exec "what does this function do?"

# Queue follow-up within same task
acpx claude -s tests "run tests"
acpx claude -s tests --no-wait "summarize test results when done"

# Debug investigation
acpx claude sessions new --name debug-issue && \
acpx claude -s debug-issue "investigate failure"

# Capture output for downstream use
result=$(acpx claude -s summarize "summarize findings")
echo "$result" > /tmp/summary.txt
```

## When to Use vs AskClaude

| Need | Use |
|------|-----|
| Read/write files, run commands | acpx claude |
| Persistent conversation | acpx claude |
| Parallel independent tasks | acpx claude (named sessions) |
| Simple text-only answer | AskClaude tool |
| Quick one-liner | AskClaude tool |
