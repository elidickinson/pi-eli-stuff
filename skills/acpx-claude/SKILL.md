---
name: acpx-claude
description: Delegate work to Claude via acpx (Agent Client Protocol) with full tool access. Use when directed to talk to Claude or to delegate tasks to a fresh Claude context.
---

# acpx with Claude

acpx is a headless CLI client for the Agent Client Protocol. It gives Claude a fresh context with full tool access (read, write, edit, bash) in an isolated session.

## Turn Efficiency

Combine session creation with first prompt to save a tool call:
```bash
acpx claude sessions new --name task-name && acpx claude -s task-name "prompt"
```

Chain sequential acpx calls with `&&` for a single bash call:
```bash
acpx claude -s analyze "analyze codebase, write to /tmp/analysis.txt" && \
acpx claude -s plan "propose refactoring based on /tmp/analysis.txt"
```

## Sessions

**Always use named sessions (`-s <name>`)** for task isolation. Sessions must be created before use.

```bash
acpx claude sessions new --name <name>   # Create named session
acpx claude sessions ensure              # Get existing or create (idempotent)
acpx claude sessions list                # List all sessions
acpx claude sessions show <name>         # Show session metadata
acpx claude sessions history <name> --limit 20  # Recent turns
acpx claude status -s <name>             # Check if running/idle
acpx claude cancel -s <name>             # Cancel running prompt
acpx claude sessions close <name>        # Close session (keeps history)
```

Use `sessions ensure` when you want to reuse an existing session if available.

### Multi-turn conversations

Same session name continues the conversation:
```bash
acpx claude -s analyze-auth "analyze auth module"
acpx claude -s analyze-auth "now focus on the token refresh logic"
```

New session name starts fresh:
```bash
acpx claude -s refactor-auth "refactor auth module"
```

## Prompting

```bash
acpx claude -s <name> "prompt"           # Named session (default)
acpx claude -s <name> --file <path>      # Prompt from file
acpx claude -s <name> --file - "extra"   # stdin + args
```

### exec (one-shot)

Stateless, no session, no history. Useful for quick questions that don't need context or follow-up. Does not support `-s` or `--timeout`.

```bash
acpx claude exec "what does this function do?"
```

### Options

```bash
--no-wait          # Queue prompt, return immediately (see Background below)
--timeout <seconds># Max wait for prompt completion
--ttl <seconds>    # How long session process stays alive after idle (default 300, 0=never)
--verbose          # Debug logging
```

### Permissions

Permission flags go on `acpx` (before `claude`) and control what Claude can do without prompting. Default is `--approve-reads`.

```bash
--approve-all      # Auto-approve everything (read + write + bash + fetch)
--approve-reads    # Auto-approve file reads and file/grep searches (default). Writes, bash, web search/fetch denied.
--deny-all         # Deny all tool requests (Claude can only think/respond)
```

```bash
acpx --approve-all claude -s task "fix the bug"
acpx --approve-reads claude exec "what does this function do?"
```

For tasks that modify files or run commands, use `--approve-all`.

## Parallel Work

**Use pi subagents for parallelism.** Spawn multiple `Agent` tool calls with `run_in_background: true`, each running acpx in its own session. The subagent extension handles concurrency, result collection, and notifications — don't reimplement that with shell backgrounding.

### Background (async without subagents)

For simple fire-and-forget follow-ups within a session, use `--no-wait`:
```bash
acpx claude -s tests "run tests"
acpx claude -s tests --no-wait "summarize test results when done"
```

The prompt is queued and executes in order. Check status or send a follow-up later:
```bash
acpx claude status -s tests
acpx claude -s tests "what were the results?"
```

## Error Handling

```bash
# Session failed? Close and retry
acpx claude sessions close <name> && acpx claude sessions new --name <name>

# Timeout? Increase limit
acpx claude -s <name> --timeout 300 "your prompt"

# Stuck? Cancel and restart
acpx claude -s <name> cancel && acpx claude -s <name> "your prompt"
```

## Passing Context Between Sessions

Sessions are isolated. To chain results across sessions, write to files:
```bash
acpx claude -s analyze "analyze codebase, write findings to /tmp/analysis.txt" && \
acpx claude -s implement "implement changes based on /tmp/analysis.txt"
```

Or capture output:
```bash
result=$(acpx claude -s summarize "summarize findings")
echo "$result" > /tmp/summary.txt
```

