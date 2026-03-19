# Capture/Replay Extension for Pi

Capture the complete state of a conversation (session + repo state) for replay with different models/providers/settings.

## Features

- **Capture**: Save current session and repository state as a tarball
- **Replay**: Restore captured state in a new empty directory
- **Safety**: Replay only works in empty directories to prevent file clobbering
- **Portable**: Captures stored in `.pi-captures/` directory (gitignored by default)

## Commands

### `/capture [name]`

Capture the current session and repository state.

```bash
/capture                              # Auto-generated name
/capture auth-bug-repro               # Custom name
```

**What gets captured:**
- Current Pi session file (message history)
- All files in current directory
- **Excludes**: `.git/`, `.pi-captures/`, and anything in `.gitignore`

**Stored as**: `.pi-captures/<id>.tar.gz`

### `/list-captures`

List all captures with preview information.

```bash
/list-captures
```

**Shows:**
- Capture ID and name
- Creation date
- Message count
- File count and size
- Model used
- First user message

### `/replay <capture-id> [--session-only]`

Replay a capture to a new empty directory.

```bash
/replay capt-abc123                   # Full replay (session + repo)
/replay capt-abc123 --session-only    # Session replay only
```

**Full replay:**
- Prompts for target directory
- Directory must be empty or new
- Extracts tarball to target directory
- Launches pi with `--session <session-file>`

**Session-only replay:**
- Copies only the session file to target directory
- Useful for quick testing without repo changes

### `/delete-capture <capture-id>`

Delete a capture.

```bash
/delete-capture capt-abc123
```

## Storage Structure

```
.pi-captures/
├── index.json                          # Registry of all captures
├── capt-abc123.tar.gz                  # Tarball: project state + session
├── capt-abc123.jsonl                   # Session file (copied from ~/.pi/agent/sessions/)
├── capt-def456.tar.gz
└── capt-def456.jsonl
```

## Safety Features

1. **Empty directory requirement**: Replay only works in empty or non-existent directories
2. **No clobbering**: Protected against overwriting existing files
3. **Explicit confirmation**: Delete operations require confirmation in interactive mode
4. **Size warnings**: Warns if capture is >100MB

## Use Cases

### A/B Testing Models

```bash
# Capture interesting conversation
pi
> /capture refactor-attempt-1

# Replay with different model
mkdir ~/test-replay
pi -e ./capture-replay
> /replay refactor-attempt-1
> Enter path: ~/test-replay
# Now in the captured state, switch models
/model claude-opus-4
> continue refactoring
```

### Benchmarking

```bash
# Capture tricky problem
pi
> /capture tricky-bug XYZ

# Later, test across multiple models
for model in claude-sonnet-4 gpt-4o deepseek-v3; do
  mkdir ~/test-$model
  cd ~/test-$model
  pi -e ./capture-replay
  /replay tricky-bug XYZ
  /model $model
  > solve this bug
done
```

### Debugging Model Differences

```bash
# Capture state before model switch
> /capture before-switch

# Switch model and continue
/model claude-opus-4
> complete the work

# Compare behavior
/replay before-switch --session-only
> # Try with original model
```

## Implementation Notes

### Tarball Contents

Each capture tarball contains:
- `*.ts`, `*.js`, etc. - Project source files (respecting `.gitignore`)
- `.pi-session.jsonl` - Copied session file
- `.pi-capture-meta.json` - Capture metadata

**Excluded by default:**
- `.git/` directory
- `.pi-captures/` directory
- `.gitignore` patterns
- `node_modules/`, `.env`, `*.pyc`, `dist/`, `build/`, `.DS_Store`

### Session Restoration

On replay, the session file is available in two locations:
1. Inside project directory: `project/.pi-session.jsonl`
2. At root: `.pi-session.jsonl` (for convenience)

Run pi with:
```bash
pi --session .pi-session.jsonl
```

## Limitations

- **Tarball size**: Large projects may create big tarballs (>100MB with warning)
- **Binary files**: Stored in tarball as-is (may be large)
- **Symlinks**: Handled by tar (absolute symlinks may break)
- **Permissions**: Preserved from tarball extraction

## Future Enhancements

- [ ] `/export-capture <id>` - Export to portable archive
- [ ] `/import-capture <path>` - Import from archive
- [ ] `/diff-captures <id1> <id2>` - Compare repo state
- [ ] `/test-capture <id> --models <list>` - Batch testing
- [ ] Model override on replay (`--model <provider/model>`)
- [ ] Think level override on replay
- [ ] Capture descriptions/notes
- [ ] Search captures by message content

## Dependencies

- Node.js built-ins: `fs`, `path`, `crypto`, `child_process`
- No external dependencies

## License

Same as Pi.

## See Also

- `git-checkpoint.ts` - Similar concept but uses git stashes
- Pi session docs: `/workspace/vendor/pi-mono/packages/coding-agent/docs/session.md`
- Extension docs: `/workspace/vendor/pi-mono/packages/coding-agent/docs/extensions.md`