# Pi My Stuff

Extensions and skills for [pi](https://github.com/ferologics/pi), an AI coding agent.

## Usage

Add to `~/.config/pi/pi.json`:

```json
{
  "extensions": [
    "/path/to/pi-my-stuff/extensions/*.ts"
  ],
  "workspaces": {
    "/path/to/your/project": {
      "extensions": [
        "/path/to/pi-my-stuff/sandbox/index.ts"
      ]
    }
  }
}
```

Or load from any directory:
```bash
pi -e /path/to/pi-my-stuff/sandbox/index.ts
```

---

## Extensions

| File | Description |
|------|-------------|
| `grep.ts` | File content search via ripgrep |
| `ask-pi.ts` | Run pi as a read-only subprocess (in sandbox) |
| `ask-claude.ts` | Run Claude Code as subprocess (on host) |
| `slash-clear.ts` | `/clear` slash command as alias for `/new`|

---

## Sandbox

Runs pi tools inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM for isolated execution on macOS.

### Quick Start

Add this to your shell:

```bash
pi-sandbox () {
  GONDOLIN_GUEST_DIR=/Users/esd/projects/pi-my-stuff/sandbox/guest-image \
  pi -e /Users/esd/projects/pi-my-stuff/sandbox/index.ts "$@"
}
```

Then run from any project:
```bash
cd /path/to/your/project
pi-sandbox
```

### How It Works

1. Starts a lightweight Linux VM on session start
2. Mounts your project directory at `/workspace`
3. Intercepts all pi tools (read, write, edit, bash)
4. Paths are auto-translated: host path → guest path
5. Commands run in the VM with limited filesystem access

### Guest Image

Alpine 3.23 (aarch64) with:
- `bash`, `python3`, `node`
- `ripgrep`, `git`, `gh` (github-cli)
- `uv` (python package manager)

### Building the Image

```bash
cd sandbox
./build.sh
```

Creates `sandbox/guest-image/` with a pre-built VM image. Point `GONDOLIN_GUEST_DIR` to it to reuse across sessions.

### Path Security

All paths are validated to prevent escaping the workspace:
- Absolute host paths resolved relative to project root
- `../` blocked at boundaries
- Already-converted guest paths normalized

### Host Access

Use `host_bash` tool for commands that must run on macOS (package managers, system tools). Requires explicit user approval each time.

### Environment

API keys are automatically forwarded from the host. Additional env vars can be injected via `GONDOLIN_ENV_FOO=bar`.

---

## Skills

### Multi-Review

Parallel code review using Claude, DeepSeek, and Kimi. Each model catches different issues, findings are validated, and confirmed bugs are auto-fixed.

Invoke with `/skill:multi-review` or automatically after major changes.

---

## Development

See `vendor/pi-mono/` for pi source code and `vendor/pi-skills/` for example skills.
