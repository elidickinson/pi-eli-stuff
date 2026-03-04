# Pi My Stuff

Extensions and skills for [pi](https://github.com/ferologics/pi), an AI coding agent.

## Setup

Add to `~/.config/pi/pi.json`:

```json
{
  "extensions": ["extensions/grep.ts", "extensions/find.ts", "extensions/ls.ts"],
  "workspaces": {
    "/path/to/project": {
      "extensions": ["sandbox/index.ts"]
    }
  }
}
```

Or load directly:
```bash
pi -e sandbox/index.ts
```

## Extensions

| File | Description |
|------|-------------|
| `grep.ts` | File content search via ripgrep |
| `find.ts` | Find files by glob pattern |
| `ls.ts` | List directory contents |
| `ask-pi.ts` | Run pi as read-only subprocess |
| `ask-claude.ts` | Run Claude Code as subprocess |

## Sandbox

Runs pi tools inside [Gondolin](https://github.com/earendil-works/gondolin) micro-VMs on macOS.

### Quick Start

Add to shell:
```bash
pi-sandbox () {
  GONDOLIN_GUEST_DIR=sandbox/guest-image pi -e sandbox/index.ts "$@"
}
```

Run from any project:
```bash
cd /path/to/project
pi-sandbox
```

### How It Works

- Spawns VM on session start, mounts project at `/workspace`
- All pi tools (read, write, edit, bash) run inside VM
- Paths auto-translated: `/Users/.../src/foo.ts` → `/workspace/src/foo.ts`
- `host_bash` tool for host commands (requires approval)

### Guest Image

Alpine 3.23 (aarch64) with `bash`, `python3`, `node`, `ripgrep`, `git`, `gh`, `uv`.

Build:
```bash
cd sandbox && ./build.sh
```

Creates `sandbox/guest-image/` for reuse via `GONDOLIN_GUEST_DIR`.

## Skills

### multi-review

Parallel code review using Claude, DeepSeek, and Kimi. Validate findings, auto-fix confirmed bugs.

Invoke with `/skill:multi-review`.

## Development

- `vendor/pi-mono/` — pi source code and docs
- `vendor/pi-skills/` — example skills
- `CLAUDE.md` — detailed documentation
