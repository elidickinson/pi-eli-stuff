# Extension Cookbook

Examples are drawn from extensions in this repo. See also the [official extension docs](../vendor/pi-mono/packages/coding-agent/docs/extensions.md) for the full API reference.

> **Important:** Never guess at pi API method/property names. Always verify against the canonical types in `vendor/pi-mono/packages/coding-agent/src/core/extensions/types.ts`. For example, `ExtensionContext` exposes `ctx.model` (a property), not `ctx.getModel()` — the latter exists on an internal interface and will throw at runtime.

## Minimal Extension

The simplest extension wraps a built-in tool factory. From [`extensions/grep.ts`](../extensions/grep.ts):

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createGrepTool } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createGrepTool(process.cwd()));
}
```

Built-in factories: `createGrepTool`, `createFindTool`, `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`.

## Tool with Custom Schema

Use `@sinclair/typebox` for parameters. From [`extensions/ask-pi.ts`](../extensions/ask-pi.ts):

```typescript
import { Type } from "@sinclair/typebox";

pi.registerTool({
  name: "AskPi",
  label: "Ask Pi",
  description: "Send a prompt to pi and return the response.",
  parameters: Type.Object({
    prompt: Type.String({ description: "The prompt to send" }),
    model: Type.Optional(Type.String({
      description: "Model ID (format: provider/model, e.g. deepseek/deepseek-reasoner)",
    })),
  }),
  async execute(id, params, signal) {
    // ...
    return {
      content: [{ type: "text", text: "result" }],
      details: { executionTime: 123 },
    };
  },
});
```

Use `StringEnum` from `@mariozechner/pi-ai` instead of `Type.Union`/`Type.Literal` for string enums -- `Type.Union` doesn't work with Google's API.

```typescript
import { StringEnum } from "@mariozechner/pi-ai";

parameters: Type.Object({
  action: StringEnum(["list", "add"] as const),
}),
```

## Subprocess Spawning

Wire up the `signal` parameter for abort cleanup. From [`extensions/ask-pi.ts`](../extensions/ask-pi.ts):

```typescript
import { spawn } from "node:child_process";

async execute(id, params, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn("pi", ["-p", "-ne", params.prompt], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      resolve({
        content: [{ type: "text", text: stdout.trim() || stderr.trim() || `(exit ${code})` }],
        details: { exitCode: code ?? undefined },
      });
    });

    proc.on("error", reject);
  });
},
```

Register abort listener with `{ once: true }`, clean up in `close`, reject with `new Error("aborted")` if signal fired.

## TUI Rendering

Basics here; for the full rendering API (details metadata, keybindings, streaming nuances) see [pi-tool-call-ux.md](pi-tool-call-ux.md).

### renderCall

Shows tool invocation before/during execution. From [`extensions/ask-pi.ts`](../extensions/ask-pi.ts):

```typescript
import { Text } from "@mariozechner/pi-tui";

renderCall(args, theme) {
  let text = theme.fg("toolTitle", theme.bold("AskPi "));
  const preview = args.prompt.length > 200
    ? args.prompt.substring(0, 200) + "..." : args.prompt;
  text += theme.fg("muted", `"${preview}"`);
  if (args.model) text += ` ${theme.fg("accent", `[${args.model}]`)}`;
  return new Text(text, 0, 0);
},
```

### renderResult

Supports collapsed (default) and expanded (Ctrl+O) views. From [`extensions/ask-pi.ts`](../extensions/ask-pi.ts):

```typescript
renderResult(result, { expanded }, theme) {
  const details = result.details as AskPiDetails | undefined;
  const isError = details?.exitCode != null && details.exitCode !== 0;
  let text = isError
    ? theme.fg("error", `✗ Pi error (exit ${details?.exitCode})`)
    : theme.fg("success", "✓ Pi responded");

  if (!expanded) {
    const firstLine = result.content[0]?.type === "text"
      ? result.content[0].text.split("\n")[0] : null;
    if (firstLine) text += ` ${theme.fg("muted", firstLine.substring(0, 150))}`;
    return new Text(text, 0, 0);
  }

  // Expanded: full details + response body
  if (details) {
    text += `\n${theme.fg("dim", `Model: ${details.model || "default"}`)}`;
    text += `\n${theme.fg("dim", `Time: ${(details.executionTime / 1000).toFixed(2)}s`)}`;
  }
  const body = result.content[0]?.type === "text" ? result.content[0].text : null;
  if (body) text += `\n\n${theme.fg("muted", "─".repeat(40))}\n${body}`;
  return new Text(text, 0, 0);  // 0,0 padding -- Box handles it
},
```

### Theme Colors

`theme.fg(color, text)` applies foreground color. `theme.bg(color, text)` applies background. Plus `theme.bold(text)`, `theme.italic(text)`, `theme.underline(text)`, `theme.inverse(text)`, `theme.strikethrough(text)`.

Source: `vendor/pi-mono/packages/coding-agent/src/modes/interactive/theme/theme.ts`

**Foreground colors (`ThemeColor`)** — default dark theme values:

| Color | Default | Use |
|-------|---------|-----|
| `accent` | teal `#8abeb7` | Primary accent, selections, bullets |
| `success` | green `#b5bd68` | Success indicators (✓) |
| `error` | red `#cc6666` | Error indicators (✗) |
| `warning` | yellow `#ffff00` | In-progress, caution |
| `muted` | gray `#808080` | Secondary text, descriptions |
| `dim` | dark gray `#666666` | Tertiary text, metadata |
| `text` | (default fg) | Normal text |
| `toolTitle` | (default fg) | Tool name in call headers |
| `toolOutput` | gray `#808080` | Tool output text |
| `border` | blue `#5f87ff` | Borders |
| `borderAccent` | cyan `#00d7ff` | Accent borders |
| `borderMuted` | dark gray `#505050` | Subtle borders |
| `toolDiffAdded` | green | Diff added lines |
| `toolDiffRemoved` | red | Diff removed lines |
| `toolDiffContext` | gray | Diff context lines |

Other valid colors: `thinkingText`, `userMessageText`, `customMessageText`, `customMessageLabel`, `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`, `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`, `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `bashMode`.

**Background colors (`ThemeBg`):** `selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`.

Themes are JSON files in `vendor/pi-mono/packages/coding-agent/src/modes/interactive/theme/`. Colors reference vars or hex values directly.

## Streaming Progress

Use the `onUpdate` callback to stream partial results. In `renderResult`, check `isPartial`. Pattern from [official docs](../vendor/pi-mono/packages/coding-agent/docs/extensions.md):

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  onUpdate?.({ content: [{ type: "text", text: "Working..." }], details: { progress: 50 } });
  // ... do work ...
  return { content: [{ type: "text", text: "Done" }], details: {} };
},

renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) return new Text(theme.fg("warning", "Processing..."), 0, 0);
  // ... render final result
},
```

## Commands

Register slash commands with `pi.registerCommand`. `args` is the raw string after the command name. From [`extensions/statusnote.ts`](../extensions/statusnote.ts):

```typescript
pi.registerCommand("status", {
  description: "Set custom status text shown in footer",
  async handler(args, ctx) {
    const text = args?.trim();
    if (!text || text === "clear") {
      pi.appendEntry(CUSTOM_TYPE, { text: "" });
      ctx.ui.notify("Status cleared", "info");
    } else {
      pi.appendEntry(CUSTOM_TYPE, { text });
      ctx.ui.notify(`Status: ${text}`, "info");
    }
  },
});
```

Command handlers receive `ExtensionCommandContext` which extends `ExtensionContext` with `ctx.waitForIdle()`, `ctx.newSession()`, `ctx.fork()`, and `ctx.reload()`.

## Session State Persistence

Use `pi.appendEntry()` to persist state and `ctx.sessionManager.getBranch()` to restore it. State survives forks, resumes, and restarts. From [`extensions/statusnote.ts`](../extensions/statusnote.ts):

```typescript
const CUSTOM_TYPE = "statusnote";

// Persist
pi.appendEntry(CUSTOM_TYPE, { text: "working on auth" });

// Restore on session events
function restoreStatus(ctx: ExtensionContext) {
  currentStatus = "";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
      const data = entry.data as StatusNote | undefined;
      currentStatus = data?.text ?? "";
    }
  }
}

pi.on("session_start", async (_event, ctx) => restoreStatus(ctx));
pi.on("session_fork", async (_event, ctx) => restoreStatus(ctx));
pi.on("session_switch", async (_event, ctx) => restoreStatus(ctx));
pi.on("session_tree", async (_event, ctx) => restoreStatus(ctx));
```

Entries from `appendEntry` are NOT sent to the LLM -- they're for extension state only. Use `ctx.ui.setStatus(key, text)` to display restored state in the footer (pass `undefined` to clear).

## Events

Subscribe to lifecycle events with `pi.on()`. From [`extensions/statusnote.ts`](../extensions/statusnote.ts) and [`sandbox/index.ts`](../sandbox/index.ts):

```typescript
// Session lifecycle
pi.on("session_start", async (_event, ctx) => { /* init */ });
pi.on("session_shutdown", async (_event, ctx) => { /* cleanup */ });
pi.on("session_fork", async (_event, ctx) => { /* re-init state */ });

// Modify system prompt before each agent turn
pi.on("before_agent_start", async (event, ctx) => {
  const modified = event.systemPrompt.replace("old text", "new text");
  return { systemPrompt: modified + "\n\nExtra instructions..." };
});

// Intercept user's interactive shell (! command)
pi.on("user_bash", (_event) => {
  if (!vm) return;
  return { operations: createGondolinBashOps(vm, localCwd) };
});
```

See the [official docs event lifecycle diagram](../vendor/pi-mono/packages/coding-agent/docs/extensions.md#lifecycle-overview) for the full event flow.

## Tool Override

Override built-in tools by spreading their metadata and replacing `execute`. From [`sandbox/index.ts`](../sandbox/index.ts):

```typescript
import { createReadTool, createBashTool } from "@mariozechner/pi-coding-agent";

const localRead = createReadTool(localCwd);
const localBash = createBashTool(localCwd);

// Override read to run in VM
pi.registerTool({
  ...localRead,
  async execute(id, params, signal, onUpdate, ctx) {
    const activeVm = await ensureVm(ctx);
    const tool = createReadTool(localCwd, {
      operations: createGondolinReadOps(activeVm, localCwd),
    });
    return tool.execute(id, params, signal, onUpdate);
  },
});
```

This preserves the tool's name, description, parameters, and built-in rendering while redirecting execution. The built-in `renderCall`/`renderResult` are used automatically when your override doesn't provide them.

Operations interfaces available: `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`.

## UI Interaction from Tools

Tools receive `ctx` (5th arg to `execute`). Check `ctx.hasUI` before dialog methods -- they're no-ops in print mode (`-p`). From [`sandbox/index.ts`](../sandbox/index.ts):

```typescript
async execute(_id, params, signal, _onUpdate, ctx) {
  if (!ctx.hasUI) {
    return { content: [{ type: "text", text: "Not available in non-interactive mode." }], details: {} };
  }
  const confirmed = await ctx.ui.confirm("Host execution requested",
    `$ ${params.command}\n\nReason: ${params.reason}`);
  if (!confirmed) {
    return { content: [{ type: "text", text: "User denied." }], details: {} };
  }
  // proceed...
},
```

### ctx.ui methods

| Method | Behavior |
|--------|----------|
| `ctx.ui.notify(msg, level)` | Persistent banner in the TUI. Not part of conversation context — the LLM won't see it in future turns. Levels: `"info"`, `"warning"`, `"error"`. |
| `ctx.ui.confirm(title, body)` | Blocking dialog, returns `boolean`. |
| `ctx.ui.select(title, items)` | Blocking selection dialog. |
| `ctx.ui.input(title, placeholder?)` | Blocking text input. |
| `ctx.ui.setStatus(key, text)` | Footer status line. Pass `undefined` to clear. |
| `ctx.ui.setWidget(key, lines)` | Widget above/below editor. |

To put information into the conversation context (visible to the LLM in future turns), use `pi.sendMessage()` with `{ triggerTurn: false }`. See the [official docs](../vendor/pi-mono/packages/coding-agent/docs/extensions.md) for full UI reference.

## Gotchas

**StringEnum for enums.** Use `StringEnum(["a", "b"] as const)` from `@mariozechner/pi-ai`, not `Type.Union(Type.Literal(...))`. The latter breaks with Google's API.

**Output truncation.** Tools must truncate output to avoid overwhelming context. Built-in limit is 50KB / 2000 lines. Use the exported utilities:

```typescript
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";

const truncation = truncateHead(output, {
  maxLines: DEFAULT_MAX_LINES,
  maxBytes: DEFAULT_MAX_BYTES,
});
```

**Signal errors.** Throw from `execute` to mark a result as error (`isError: true`). Returning a value never sets the error flag.

**Leading `@` in paths.** Some models include a `@` prefix in tool path arguments. Built-in tools strip it automatically. If your custom tool accepts a path, normalize it too.

**`renderResult` padding.** Always use `new Text(text, 0, 0)` -- the wrapping Box handles padding. Non-zero padding doubles it.

**Available imports:** `@mariozechner/pi-coding-agent` (types, tool factories, truncation utils), `@sinclair/typebox` (parameter schemas), `@mariozechner/pi-ai` (`StringEnum`), `@mariozechner/pi-tui` (`Text`, `Component`). Node built-ins and npm deps also work.
