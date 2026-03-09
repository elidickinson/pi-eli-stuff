# Pi My Stuff

Extensions and skills for [pi](https://github.com/ferologics/pi), an AI coding agent.

## Sandbox

Runs pi tools inside [Gondolin](https://github.com/earendil-works/gondolin) micro-VMs on macOS. All pi tools (read, write, edit, bash) execute inside the VM with automatic path translation.

### Usage

```bash
pi-sandbox () {
  if [[ "$1" == "--shell" ]]; then
    shift
    GONDOLIN_GUEST_DIR=sandbox/guest-image \
      node --experimental-strip-types --no-warnings \
      sandbox/index.ts "${@:-.}"
    return
  fi
  GONDOLIN_GUEST_DIR=sandbox/guest-image pi -e sandbox/index.ts "$@"
}
```

Then from any project:
```bash
cd /path/to/project && pi-sandbox          # pi agent session
cd /path/to/project && pi-sandbox --shell   # interactive bash in VM
pi-sandbox --shell /path/to/project         # shell with explicit mount dir
```

Or add to `~/.config/pi/pi.json`:
```json
{
  "workspaces": {
    "/path/to/project": {
      "extensions": ["sandbox/index.ts"]
    }
  }
}
```

### How It Works

- Spawns VM on session start, mounts project at `/workspace`
- Paths auto-translated: `/Users/.../src/foo.ts` -> `/workspace/src/foo.ts`
- `host_bash` tool for host commands (requires approval)

### Guest Image

Alpine 3.23 (aarch64) with bash, python3, node, ripgrep, git, gh, uv, curl-impersonate.

```bash
cd sandbox && ./build.sh
```

## Extensions

| Extension | Description |
|-----------|-------------|
| `grep.ts` | File content search via ripgrep |
| `find.ts` | Find files by glob pattern |
| `ls.ts` | List directory contents |
| `ask-pi.ts` | Run pi as read-only subprocess |
| `ask-claude.ts` | Run Claude Code as subprocess |

## Skills

- **multi-review** — Parallel code review using Claude, DeepSeek, and Kimi. Invoke with `/skill:multi-review`.
