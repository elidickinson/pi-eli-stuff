# Pi My Stuff

Personal collection of extensions and skills for [pi](https://github.com/ferologics/pi), an AI coding agent.

## Project Structure

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

### Grep (`extensions/grep.ts`)
Registers the **grep** tool which searches file contents using ripgrep (rg).

```typescript
// Usage from within pi
grep({ pattern: "TODO", glob: "*.ts", ignoreCase: true })
grep({ pattern: "function.*foo", literal: false, context: 2 })
```

### Find (`extensions/find.ts`)
Registers the **find** tool for finding files by glob pattern.

```typescript
// Usage from within pi
find({ pattern: "**/*.test.ts" })
find({ pattern: "src/**/*.json" })
```

### Ls (`extensions/ls.ts`)
Registers the **ls** tool for listing directory contents.

```typescript
// Usage from within pi
ls({ path: "src" })
ls({ path: ".", depth: 2 })
```

### AskPi (`extensions/ask-pi.ts`)
Runs pi as a subprocess with read-only tools (no edit/write/bash). Useful for:
- Multi-agent workflows where one agent should be read-only
- Delegating tasks to other models (deepseek, kimi, etc.)

```typescript
// Usage from within pi
AskPi({ prompt: "Review this code...", model: "deepseek/deepseek-v3.2" })
```

### AskClaude (`extensions/ask-claude.ts`)
Spawns Claude Code as a subprocess. Allows delegation to Claude models from within pi.

```typescript
// Usage from within pi
AskClaude({ prompt: "Analyze this architecture...", model: "sonnet" })
```

## Browser Automation

### pi-my-browser (`pi-my-browser/`)
Browser automation extension. Allows pi to interact with web pages through a browser interface.

## Skills

### Multi-Review (`skills/multi-review/SKILL.md`)
Multi-model code review using Claude, DeepSeek, and Kimi in parallel. Each model catches different issues, then findings are validated and synthesized.

**Invoke with:** `/skill:multi-review`

**Process:**
1. Runs 3 parallel reviews (Claude, DeepSeek, Kimi)
2. Validates each finding against actual code
3. Categorizes by severity (Major/Minor/Style)
4. Auto-fixes confirmed bugs
5. Asks user about judgment-call issues

## Sandbox (`sandbox/index.ts`)

Integrates [Gondolin](https://github.com/earendil-works/gondolin) micro-VMs with pi for isolated execution. Gondolin provides lightweight Linux VMs via Apple's Virtualization Framework on macOS.

### How It Works

1. **On session start**: Spawns a Gondolin VM with host directory mounted at `/workspace`
2. **Tool interception**: All pi tools (read, write, edit, bash) are overridden
3. **Path translation**: Host paths are translated to guest paths
   - Host: `/Users/esd/projects/my-project/src/foo.ts`
   - Guest: `/workspace/src/foo.ts`
4. **Isolated execution**: Bash commands run in the VM with limited filesystem access

### Usage

```bash
# Run pi with sandbox from your project directory
pi -e /path/to/pi-my-stuff/sandbox/index.ts

# Or add to ~/.config/pi/pi.json as a workspace extension
```

### Path Security

The `toGuestPath()` function ensures:
- Absolute host paths are resolved relative to `localCwd`
- Paths cannot escape the workspace via `../`
- Already-converted guest paths are normalized before use

### Building the Guest Image

```bash
cd sandbox
./build.sh
```

This creates a minimal Linux guest image with: bash, node, python3, curl, ripgrep, git

## Development

### Adding a New Extension

1. Create a new file in `extensions/`
2. Export a default function taking `ExtensionAPI`
3. Register tools/hooks as needed
4. Test with `pi -e ./extensions/your-extension.ts`

Example:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "MyTool",
    label: "My Tool",
    description: "Does something cool",
    parameters: Type.Object({ /* schema */ }),
    async execute(id, params, signal, onUpdate, ctx) {
      // Implementation
      return { content: [{ type: "text", text: "result" }], details: {} };
    },
  });
}
```

### Adding a New Skill

1. Create directory `skills/your-skill/`
2. Add `SKILL.md` with skill metadata (frontmatter) and documentation
3. Skill is automatically discovered by pi

Example frontmatter:
```markdown
---
name: your-skill
description: One-line description of what this skill does
---

# Skill Name

Detailed explanation of how the skill works...
```

## Useful Reference Materials

- **pi monorepo**: `./vendor/pi-mono` - Source code, documentation, and examples
  - Extension docs: `vendor/pi-mono/packages/coding-agent/README.md`
  - TUI API: `vendor/pi-mono/packages/coding-agent/docs/tui.md`
  - SDK integration: `vendor/pi-mono/packages/coding-agent/docs/sdk.md`
- **pi-skills**: `./vendor/pi-skills` - Example skills from https://github.com/ferologics/pi-skills

## Configuration

Extensions can be configured globally or per-workspace in `~/.config/pi/pi.json`:

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
