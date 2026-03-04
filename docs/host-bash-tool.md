# `host_bash` — Sandbox Host Escape Hatch

Registered by the sandbox extension (`sandbox/index.ts`), `host_bash` lets the LLM request command execution on the host machine outside the Gondolin VM. Every call requires explicit user approval via a confirm dialog.

## Usage

```typescript
host_bash({
  command: "brew install jq",
  reason: "jq is not available in the sandbox VM",
  timeout: 60  // optional, default 30s
})
```

The user sees a confirm dialog showing the command and reason, and can approve or deny.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | yes | Bash command to run on the host |
| `reason` | string | yes | One sentence explaining why host access is needed |
| `timeout` | number | no | Timeout in seconds (default: 30) |

## Behavior

- **Approved** — runs the command on the host and returns stdout/stderr to the LLM
- **Denied** — returns `"User denied host execution."` (non-error, LLM can adapt)
- **Non-interactive** — automatically denied with an explanation (fail-closed)
