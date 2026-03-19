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

- Spawns VM on session start, mounts project at `/workspace` and `~/.config/pi-sandbox` at `/config`
- Paths auto-translated: `/Users/.../src/foo.ts` -> `/workspace/src/foo.ts`
- `host_bash` tool for host commands (requires approval)

### Guest Image

Alpine 3.23 (aarch64) with bash, python3, node, ripgrep, git, gh, uv, curl-impersonate, claude-code.

```bash
cd sandbox && ./build.sh
```

## Extensions

| Extension | Description |
|-----------|-------------|
| `grep.ts` | File content search via ripgrep |
| `find.ts` | Find files by glob pattern |
| `ask-pi.ts` | Run pi as read-only subprocess |
| `ask-claude.ts` | *(deprecated, use claude-acp)* Run Claude Code as subprocess |
| `claude-acp.ts` | Claude Code via ACP with persistent sessions |
| `claude-acpx.ts` | *(deprecated)* One-shot Claude Code tool via acpx CLI |
| `fetch.ts` | Fetch URLs as markdown, with optional proxy and JS rendering |
| `llm-perf/` | Passive LLM metrics tracking (TTFT, latency, throughput, cost) |
| `statusnote.ts` | `/status` command — persistent footer note |
| `slash-clear.ts` | `/clear` command (alias for `/new`) |
| `failover.ts` | Auto-rotate API keys on rate limit (config: `~/.pi/agent/failover.json`) |

## Skills

| Skill | Description |
|-------|-------------|
| `multi-review` | Parallel code review using Claude, DeepSeek, and Kimi |
| `br` | Browser automation CLI for web scraping and navigation |
| `deep-research` | Parallel web agent research using multiple search queries |

### Installation

Add to `~/.config/pi/pi.json`:

```json
{
  "skills": ["/Users/esd/projects/pi-my-stuff/skills"]
}
```

Then invoke with `/skill:<name>` (e.g., `/skill:br`, `/skill:deep-research`).
