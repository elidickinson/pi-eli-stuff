# /claudemode Implementation Plan

Pi extension that spawns Claude Code as an ACP agent subprocess, intercepts user input, forwards it to Claude Code via `connection.prompt()`, and streams responses back into pi's TUI.

## Architecture

```
User types in pi
       │
       ▼
  pi "input" event handler (when active)
       │
       ▼
  connection.prompt({ sessionId, prompt: [{ type: "text", text }] })
       │
       ├── sessionUpdate callbacks stream back:
       │     • agent_message_chunk → update displayed response
       │     • agent_thought_chunk → render thinking indicator
       │     • tool_call / tool_call_update → render tool activity
       │     • plan → render plan tasks
       │     • current_mode_update → track plan mode
       │
       ├── requestPermission → auto-approve (for now)
       │
       ├── readTextFile / writeTextFile → delegate to real filesystem
       │
       ├── createTerminal / waitForTerminalExit → delegate to real shell
       │
       └── prompt() resolves with stopReason
```

## Dependencies

- `@agentclientprotocol/sdk` — `ClientSideConnection`, `ndJsonStream`, schema types
- `node:child_process` — spawn Claude Code agent process

## Implementation Steps

### Step 1: Scaffold & State

- Single file: `extensions/claudemode.ts`
- State: `active`, `connection`, `sessionId`, `agentProcess`, accumulated stream state
- Persist `active` via `pi.appendEntry()` for fork/resume awareness
- Restore on session events (but don't auto-reconnect — user must `/claudemode` again)

### Step 2: `/claudemode` Command

- `/claudemode` — toggle on/off
- `/claudemode disconnect` — explicit disconnect

On activate:
1. Spawn: `spawn("claude", ["--agent"], { stdio: pipe })`
2. Stream: `ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout))`
3. `new ClientSideConnection(toClient, stream)`
4. `connection.initialize()` with fs + terminal capabilities
5. `connection.newSession({ cwd: process.cwd(), mcpServers: [] })`
6. Footer status: `ctx.ui.setStatus("claudemode", "Claude Code ●")`

On deactivate:
1. Kill agent process
2. Clear status + state

### Step 3: Input Interception

`pi.on("input", ...)` — when active:
- Return `{ action: "handled" }` to consume input
- Display user message in pi via `pi.sendMessage()`
- Call `connection.prompt()` — this blocks until the turn completes
- During the turn, `sessionUpdate` callbacks fire and update the TUI

### Step 4: Client Callbacks

**`sessionUpdate(params)`** — switch on `params.update.sessionUpdate`:
- `agent_message_chunk` — accumulate text, send/update custom message
- `agent_thought_chunk` — accumulate thinking, show indicator
- `tool_call` / `tool_call_update` — track by toolCallId, render tool name/args/status/output
- `plan` — render plan with task list
- `usage_update` — track tokens
- `current_mode_update` — update footer (plan mode indicator)

**`requestPermission(params)`** — auto-approve:
```typescript
const allow = params.options.find(o => o.kind === "allow_once");
return { outcome: { outcome: "selected", optionId: allow.optionId } };
```

**`readTextFile(params)`** — read from real filesystem, return content

**`writeTextFile(params)`** — write to real filesystem

**`createTerminal(params)`** — spawn shell, return terminalId

**`terminalOutput(params)`** — read terminal output

**`waitForTerminalExit(params)`** — wait for process exit, return code

**`killTerminal(params)`** — kill terminal process

**`releaseTerminal(params)`** — cleanup terminal

### Step 5: Message Renderers

Register renderers for custom message types:
- `claudemode-response` — Claude's text (accent styling, streamed)
- `claudemode-tool` — tool calls (collapsed: name+status, expanded: args+output)
- `claudemode-thinking` — thinking content (dimmed)
- `claudemode-plan` — plan with task list
- `claudemode-status` — connection state changes

### Step 6: Plan Mode & Questions

- `current_mode_update` tells us when Claude enters/exits plan mode
- `plan` updates contain task list with statuses — render in TUI
- Questions: Claude asks in text → user reads in pi → types answer → input handler sends as next prompt turn. No special handling needed.
- Multi-choice from `requestPermission`: use auto-approve for now, later could use `ctx.ui.select()`

### Step 7: Footer Status

- `Claude Code ●` (green) — connected, idle
- `Claude Code ◉` — prompt in progress
- `Claude Code [plan]` — plan mode active
- Nothing — disconnected

## Deferred

- Permission approval UI (auto-approve for now)
- Exposing pi's custom tools via MCP
- Sandbox routing for file/terminal operations
- Session persistence across pi restarts
- Image/file attachment forwarding
