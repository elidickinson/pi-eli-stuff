---
name: acpx-claude
description: Delegate work to Claude via acpx (Agent Client Protocol) with full tool access. Use when you need Claude to read/write files, run commands, or do actual coding work.
---

# acpx with Claude

## Agent Execution Strategy

### Direct vs Background

Default to running acpx directly (foreground) via bash. Only use background subagents when:
- You have independent parallel tasks
- You need to continue working while Claude runs
- Results can be collected asynchronously

**Direct (foreground):** Most cases. Wait for completion before proceeding.

**Background:** Use the `Agent` tool with `run_in_background: true` for parallel work. The agent should run acpx commands and report completion.

### Session Naming

**Always use named sessions (`-s <name>`)** for task isolation and clarity.

```bash
# Task 1: Analyze auth module
acpx claude -s analyze-auth "analyze auth module"

# Task 2: Refactor based on findings (new session, fresh state)
acpx claude -s refactor-auth "refactor auth module"
```

**Session name guidelines:**
- Use descriptive, task-based names: `analyze-auth`, `refactor-db`, `review-security`
- Start a new named session for each distinct task (don't reuse)
- For parallel work, use descriptive suffixes: `security-api`, `security-db`

**Note on context between sessions:**
- Named sessions are isolated — a new session starts with no memory of previous sessions
- To pass context between sessions, explicitly include it in the prompt or save/output results to files
- Use the same session name if you need to iterate within a single task

### Parallel Sessions

**Good candidates for parallelization:**
- Independent file analysis (different modules, different directories)
- Separate review tasks (security review, style review, performance review)
- Documentation for different components
- Test execution for independent test suites

**Bad candidates:**
- Tasks that depend on shared state
- Sequential steps in a single workflow
- Tasks that need coordination between them

**Fan-out/fan-in pattern:**
```bash
# Fan-out: start parallel sessions
acpx claude sessions new --name review-security
acpx claude sessions new --name review-performance
acpx claude sessions new --name docs-api

# Send tasks to each (can be background subagents)
acpx claude -s review-security "analyze auth module for security issues"
acpx claude -s review-performance "profile query performance"
acpx claude -s docs-api "document the API endpoints"

# Fan-in: collect results when all complete
# Check status or use subagent completion notifications
acpx claude sessions show review-security
acpx claude sessions show review-performance
acpx claude sessions show docs-api
# Then summarize/synthesize findings
```

### Fire-and-Forget

Use `--no-wait` when:
- Submitting queued follow-up prompts
- You don't need to wait for completion immediately
- Results will be collected later

Don't use `--no-wait` when:
- You need the result before proceeding
- Task completion is required for next steps

```bash
# Good: queue analysis while you do other work
acpx claude -s tests "run full test suite"
acpx claude -s tests --no-wait "summarize test results when done"
# ... continue with other tasks ...

# Bad: need test results before proceeding
acpx claude -s tests --no-wait "run tests"  # Don't do this
acpx claude -s tests "analyze results"      # This might run before tests finish
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
acpx claude sessions close <name>
acpx claude sessions new --name <name>

# Timeout? Increase limit
acpx claude -s <name> --timeout 300 "your prompt"

# Stuck process? Cancel and restart
acpx claude -s <name> cancel
acpx claude status -s <name>  # Confirm stopped
acpx claude -s <name> "your prompt"
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
acpx claude -s analyze "analyze the codebase, write findings to /tmp/analysis.txt"
acpx claude -s plan "propose a refactoring plan based on /tmp/analysis.txt"
acpx claude -s implement "implement the changes from the plan"

# Parallel workstreams
acpx claude -s backend "fix API bug"
acpx claude -s frontend "update UI"
acpx claude -s docs "write changelog"

# One-shot fire-and-forget (no session, no history)
acpx claude exec "what does this function do?"

# Queue follow-up within same task
acpx claude -s tests "run tests"
acpx claude -s tests --no-wait "summarize test results when done"

# Debug investigation
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
