# Pi My Stuff

Personal collection of extensions and skills for [pi](https://github.com/ferologics/pi), an AI coding agent.

> **Working note:** Use relative paths for file operations (e.g., `sandbox/index.ts`, `CLAUDE.md`). Avoid absolute paths like `~/projects/pi-my-stuff/...`.

## API Reference — ALWAYS Check Before Using

**Do NOT guess pi API method names, property names, or event shapes.** Look them up first:

1. `vendor/pi-mono/packages/coding-agent/src/core/extensions/types.ts` — canonical type definitions for `ExtensionContext`, `ExtensionAPI`, events, etc.
2. `vendor/pi-mono/packages/coding-agent/docs/extensions.md` — official extension docs
3. `docs/extension-cookbook.md` — local patterns and examples

Example: `ExtensionContext` has `ctx.model` (a property), NOT `ctx.getModel()` (which is on a different internal interface). Getting this wrong causes runtime errors.

## Structure

```
pi-my-stuff/
├── extensions/      # pi extensions (grep, find, ask-pi, ask-claude, claude-acp, claude-acpx, fetch, statusnote, llm-perf, slash-clear)
├── skills/          # pi skills (multi-review, br, deep-research)
├── sandbox/         # Gondolin VM sandbox integration
├── pi-my-browser/   # Browser automation extension
├── claude-agent-sdk-pi/ # Claude Agent SDK provider (routes LLM calls through Claude Code)
├── pi-subagents/    # Subagent orchestration library
├── pi-plan/         # Planning agent
├── docs/            # Additional documentation
└── vendor/          # vendored pi resources (pi-mono, pi-skills, gondolin)
```

## Extensions

### grep
Search file contents using ripgrep.

```typescript
grep({ pattern: "TODO", glob: "*.ts", ignoreCase: true })
grep({ pattern: "function.*foo", literal: false, context: 2 })
```

### find
Find files by glob pattern.

```typescript
find({ pattern: "**/*.test.ts" })
find({ pattern: "src/**/*.json" })
```

### ask-pi
Run pi as subprocess with read-only tools. Useful for delegating to other models (deepseek, kimi, etc.).

```typescript
AskPi({ prompt: "Review this code...", model: "deepseek/deepseek-v3.2" })
```

### ask-claude
Spawn Claude Code as subprocess.

```typescript
AskClaude({ prompt: "Analyze this architecture...", model: "sonnet" })
```

### claude-acp
Interactive Claude Code mode via ACP. Forwards all user messages to Claude Code and streams responses back into pi's TUI with markdown rendering, tool call tracking, and plan display.

```bash
/claude:on    # Connect (resumes previous session)
/claude:off   # Disconnect (preserves session)
/claude:clear # Disconnect and start fresh
/claude:btw   # Quick one-shot question (display only, no context)
/pi <msg>     # Send a message to Pi's LLM while connected
```

### claude-acpx
One-shot Claude Code tool via `acpx` CLI. Sends a prompt and returns the result. Supports named sessions for multi-turn conversations.

### fetch
Fetch web pages and download files. Supports proxy auth via `~/.pi/agent/fetch.json`.

## Browser Automation

### pi-my-browser
Browser automation extension for interacting with web pages.

## Skills

### multi-review
Multi-model code review using Claude, DeepSeek, and Kimi in parallel.

**Invoke with:** `/skill:multi-review`

### br
Browser automation skill.

**Invoke with:** `/skill:br`

### deep-research
Parallel web agent research using multiple search queries.

**Invoke with:** `/skill:deep-research`

## Docs

- `extension-cookbook.md` — Practical patterns for building extensions (tools, TUI, events, subprocesses)
- `skill-authoring.md` — How to write SKILL.md files
- `host-bash-tool.md` — Sandbox host escape hatch (`host_bash` tool) usage and approval flow
- `pi-gondolin-landscape.md` — Research into pi-gondolin integrations
- `pi-subagents-dev-notes.md` — Development notes for pi-subagents (tool registration gotchas)
- `pi-tool-call-ux.md` — How to customize tool call display in the pi TUI
- `extension-settings.md` — How to handle user-configurable settings in extensions

## Sandbox

Runs pi tools inside [Gondolin](https://github.com/earendil-works/gondolin) micro-VMs on macOS.

### How it works

- Session start: Spawns VM with host directory mounted at `/workspace`
- All pi tools (read, write, edit, bash) run inside the VM
- Paths are translated between host and guest (e.g., `~/project/src/foo.ts` → `/workspace/src/foo.ts`)
- `host_bash` tool provides escape hatch for commands that must run on the host (requires approval)

### Usage

```bash
pi -e /path/to/pi-my-stuff/sandbox/index.ts
```

Or add to `~/.config/pi/pi.json` as a workspace extension.

### Environment

API keys and env vars are forwarded to the VM automatically:
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.
- `GONDOLIN_ENV_FOO=bar` → `FOO=bar` in guest

### Building the guest image

```bash
cd sandbox && ./build.sh
```

Creates minimal Linux image with: bash, node, python3, curl, ripgrep, git

## Development

### Adding an extension

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "MyTool",
    description: "Does something cool",
    parameters: Type.Object({ /* schema */ }),
    async execute(id, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: "result" }], details: {} };
    },
  });
}
```

### Adding a skill

1. Create `skills/your-skill/SKILL.md`
2. Add frontmatter and documentation

```markdown
---
name: your-skill
description: One-line description
---

# Skill Name

Explanation of how it works...
```

## Configuration

`~/.config/pi/pi.json`:

```json
{
  "extensions": [
    "~/projects/pi-my-stuff/extensions/grep.ts",
    "~/projects/pi-my-stuff/extensions/find.ts",
    "~/projects/pi-my-stuff/extensions/ask-pi.ts",
    "~/projects/pi-my-stuff/extensions/ask-claude.ts",
    "~/projects/pi-my-stuff/extensions/statusnote.ts"
  ],
  "workspaces": {
    "~/projects/my-project": {
      "extensions": [
        "~/projects/pi-my-stuff/sandbox/index.ts"
      ]
    }
  }
}
```

### StatusNote Extension

Track what you're working on with a custom status displayed in the footer.

```bash
/status "Refactoring auth module"  # Set status
/status clear                      # Clear status
```

Status persists across session forks and resumes - the status text is stored in the session and restored when you fork or resume.

### LLM Perf

Passively tracks LLM responsiveness metrics (TTFT, latency, throughput, cost) per model/provider. Data stored in `~/.pi/agent/llm-perf.db` (SQLite, WAL mode).

```bash
/llm-perf              # Last 24h, all models
/llm-perf week         # Last 7 days
/llm-perf week sonnet  # Last 7 days, models matching "sonnet"
/llm-perf purge 30d    # Delete entries older than 30 days
```

Debug logging: `LLM_PERF_DEBUG=1`

## Reference

- **pi monorepo**: `vendor/pi-mono` — source, docs, examples
  - Extension docs: `vendor/pi-mono/packages/coding-agent/README.md`
  - TUI API: `vendor/pi-mono/packages/coding-agent/docs/tui.md`
- **pi-skills**: `vendor/pi-skills` — example skills
