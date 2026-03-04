# Pi My Stuff

Personal collection of extensions and skills for [pi](https://github.com/ferologics/pi), an AI coding agent.

> **Working note:** Use relative paths for file operations (e.g., `sandbox/index.ts`, `CLAUDE.md`). Avoid absolute paths like `/Users/esd/projects/pi-my-stuff/...`.

## Structure

```
pi-my-stuff/
├── extensions/      # pi extensions (grep, find, ls, ask-pi, ask-claude)
├── skills/          # pi skills (multi-review)
├── sandbox/         # Gondolin VM sandbox integration
├── pi-my-browser/   # Browser automation extension
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

### ls
List directory contents.

```typescript
ls({ path: "src" })
ls({ path: ".", depth: 2 })
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

## Browser Automation

### pi-my-browser
Browser automation extension for interacting with web pages.

## Skills

### multi-review
Multi-model code review using Claude, DeepSeek, and Kimi in parallel.

**Invoke with:** `/skill:multi-review`

## Sandbox

Runs pi tools inside [Gondolin](https://github.com/earendil-works/gondolin) micro-VMs on macOS.

### How it works

- Session start: Spawns VM with host directory mounted at `/workspace`
- All pi tools (read, write, edit, bash) run inside the VM
- Paths are translated between host and guest (e.g., `/Users/esd/project/src/foo.ts` → `/workspace/src/foo.ts`)
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
    "/Users/esd/projects/pi-my-stuff/extensions/grep.ts",
    "/Users/esd/projects/pi-my-stuff/extensions/find.ts",
    "/Users/esd/projects/pi-my-stuff/extensions/ls.ts",
    "/Users/esd/projects/pi-my-stuff/extensions/ask-pi.ts",
    "/Users/esd/projects/pi-my-stuff/extensions/ask-claude.ts"
  ],
  "workspaces": {
    "/Users/esd/projects/my-project": {
      "extensions": [
        "/Users/esd/projects/pi-my-stuff/sandbox/index.ts"
      ]
    }
  }
}
```

## Reference

- **pi monorepo**: `vendor/pi-mono` — source, docs, examples
  - Extension docs: `vendor/pi-mono/packages/coding-agent/README.md`
  - TUI API: `vendor/pi-mono/packages/coding-agent/docs/tui.md`
- **pi-skills**: `vendor/pi-skills` — example skills
