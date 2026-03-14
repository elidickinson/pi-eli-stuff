# Extension Settings & Configuration

How to handle user-configurable settings in pi extensions. Pi's `ExtensionAPI` has no built-in settings mechanism, so extensions manage their own config using established conventions.

## Config Mechanisms

### 1. JSON Config Files (persistent preferences)

The standard pattern for extension settings. Supports global + project-local with project taking precedence.

**File locations:**
- Global: `~/.pi/agent/<extension-name>.json`
- Project: `.pi/<extension-name>.json`

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface MyExtConfig {
  verbose?: boolean;
  maxResults?: number;
}

const DEFAULTS: MyExtConfig = { verbose: false, maxResults: 100 };

function loadConfig(cwd: string): MyExtConfig {
  const globalPath = join(homedir(), ".pi", "agent", "my-ext.json");
  const projectPath = join(cwd, ".pi", "my-ext.json");

  let global: Partial<MyExtConfig> = {};
  let project: Partial<MyExtConfig> = {};

  if (existsSync(globalPath)) {
    try { global = JSON.parse(readFileSync(globalPath, "utf-8")); } catch {}
  }
  if (existsSync(projectPath)) {
    try { project = JSON.parse(readFileSync(projectPath, "utf-8")); } catch {}
  }

  return { ...DEFAULTS, ...global, ...project };
}
```

**When to use:** User preferences that should persist across sessions — feature toggles, default values, credentials.

**Examples in this repo:**
- `extensions/fetch.ts` — proxy credentials in `~/.pi/agent/fetch.json`

**In vendor/pi-mono:**
- `preset.ts` — model presets in `~/.pi/agent/presets.json` + `.pi/presets.json`
- `sandbox/index.ts` — VM config in `~/.pi/agent/sandbox.json` + `.pi/sandbox.json`
- `antigravity-image-gen.ts` — image gen config in `~/.pi/agent/extensions/antigravity-image-gen.json`

### 2. Environment Variables (runtime overrides)

Quick overrides, CI/CD integration, secrets that shouldn't be in config files.

```typescript
const DEBUG = process.env.MY_EXT_DEBUG === "1";
const apiKey = process.env.MY_EXT_API_KEY || config.apiKey;
```

**Convention:** Use `PI_*` or `<EXTENSION>_*` prefixes.

**When to use:** Debug flags, API keys, CI/CD overrides, anything that varies by environment.

**Examples in this repo:**
- `extensions/llm-perf/` — `LLM_PERF_DEBUG=1`
- `extensions/fetch.ts` — `IPROYAL_UNBLOCKER_USER`/`IPROYAL_UNBLOCKER_PASS`

### 3. Session Entries (per-session state)

State that follows branch navigation, survives forks and resumes. Not user-configurable — this is runtime state.

```typescript
pi.appendEntry("my-ext-state", { key: "value" });

// Restore
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.type === "custom" && entry.customType === "my-ext-state") {
    state = entry.data;
  }
}
```

**When to use:** Active session state (current status, mode toggles set via commands). NOT for user preferences.

**Examples in this repo:** `extensions/statusnote.ts`

### 4. Interactive Config (slash commands + `ctx.ui`)

Pi has no form builder, but `ctx.ui` provides enough primitives to build interactive settings flows: `select`, `input`, `confirm`, and `notify`.

#### Settings menu

Show current values in menu labels so users see what they're changing. From `pi-subagents/src/index.ts`:

```typescript
pi.registerCommand("my-ext", {
  description: "Configure my-ext",
  async handler(args, ctx) {
    if (!ctx.hasUI) return;  // Always guard — no dialogs in print mode

    const choice = await ctx.ui.select("Settings", [
      { label: `Max concurrency (current: ${config.maxConcurrency})`, value: "concurrency" },
      { label: `Verbose (current: ${config.verbose ? "on" : "off"})`, value: "verbose" },
    ]);
    if (!choice) return;

    if (choice === "concurrency") {
      const val = await ctx.ui.input("Max concurrency", String(config.maxConcurrency));
      if (!val) return;
      const n = parseInt(val);
      if (isNaN(n) || n < 1) {
        ctx.ui.notify("Must be a number >= 1", "warning");
        return;
      }
      config.maxConcurrency = n;
    } else if (choice === "verbose") {
      config.verbose = await ctx.ui.confirm("Verbose mode", "Enable verbose output?");
    }

    saveConfig(config);
    ctx.ui.notify(`Updated ${choice}`, "info");
  },
});
```

#### Multi-step wizard

For complex setup (creating resources, multi-field config), chain dialogs sequentially. Branching selections unlock follow-up inputs:

```typescript
async function setupWizard(ctx: ExtensionCommandContext) {
  // Step 1: scope
  const scope = await ctx.ui.select("Where?", [
    { label: "Project (.pi/)", value: "project" },
    { label: "Global (~/.pi/agent/)", value: "global" },
  ]);
  if (!scope) return;

  // Step 2: name
  const name = await ctx.ui.input("Name", "my-thing");
  if (!name) return;

  // Step 3: branching option
  const model = await ctx.ui.select("Model", [
    { label: "Inherit from session", value: "inherit" },
    { label: "Sonnet", value: "sonnet" },
    { label: "Custom...", value: "custom" },
  ]);
  if (!model) return;

  let modelId = model;
  if (model === "custom") {
    modelId = await ctx.ui.input("Model ID (provider/model)") ?? "";
    if (!modelId) return;
  }

  // Step 4: confirm overwrite if exists
  const targetPath = getPath(scope, name);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite?", `${targetPath} already exists`);
    if (!overwrite) return;
  }

  writeFileSync(targetPath, buildContent(name, modelId));
  ctx.ui.notify(`Created ${name}`, "info");
}
```

#### UX best practices (from real extensions in this repo)

| Practice | Detail |
|----------|--------|
| Guard `ctx.hasUI` | Dialogs are no-ops in print mode (`-p`). Check before any interactive flow |
| Show current values | Menu labels like `"Max concurrency (current: 4)"` — user sees state before changing |
| Validate after input | Parse and check input, then `ctx.ui.notify(msg, "warning")` on failure |
| Descriptive labels | `"Yes, proceed anyway"` not just `"Yes"` — especially for destructive actions |
| Confirm before destroy | Always `ctx.ui.confirm()` before deletes or overwrites |
| Notify on success | `ctx.ui.notify("Updated X", "info")` closes the feedback loop |
| Return on cancel | Every `await ctx.ui.*` can return `null`/`undefined` — check and bail |
| Hierarchical menus | Recursive calls for back-navigation: sub-menu → parent menu |

#### Available `ctx.ui` primitives

| Method | Returns | Use |
|--------|---------|-----|
| `ctx.ui.select(title, items)` | `string \| null` | Choose from a list |
| `ctx.ui.input(title, placeholder?)` | `string \| null` | Free-text entry |
| `ctx.ui.confirm(title, body)` | `boolean` | Yes/no decision |
| `ctx.ui.notify(msg, level)` | `void` | Feedback banner (`"info"`, `"warning"`, `"error"`) |

There's no multi-field form — build multi-step flows by chaining these sequentially.

## Precedence Order

Tool parameters > Environment variables > Project config > Global config > Defaults

This matches how pi's own settings work (project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`).

## Design Guidelines

**Keep config minimal.** Most extensions need zero config. Add settings only when there's a real user need — not speculatively.

**Sensible defaults.** Extensions should work out of the box. Config is for overriding defaults, not for required setup.

**Fail gracefully on missing config.** Return defaults if config files don't exist or can't be parsed. Never crash on a missing config file.

**Don't duplicate pi.json.** Extension loading paths go in `pi.json`. Extension-specific settings go in their own files. Pi.json has no mechanism for per-extension settings sections.

**Document config options.** If your extension has settings, document them in the extension's section of the main README or in a comment at the top of the extension file.

## pi-extmgr

[pi-extmgr](https://ayagmar.github.io/pi-extmgr/) (`npm:pi-extmgr`) adds a TUI for extension lifecycle management — install, toggle, update. Its "config panel" (`c` key) only toggles individual entrypoints within a package on/off; it has no per-extension settings API or schema system. Extension authors still need their own config mechanism for anything beyond enable/disable.

## What Extensions Can't Access

The `ExtensionAPI` and `ExtensionContext` do **not** expose:
- `SettingsManager` or `getSettings()` — no reading pi's own settings
- Other extensions' state
- The pi.json config directly

Extensions are intentionally sandboxed to their own config. If you need info from the host environment, use `process.cwd()`, `process.env`, or read your own config files.
