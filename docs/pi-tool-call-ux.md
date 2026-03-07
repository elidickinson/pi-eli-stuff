# Tool Call UX Options in Pi

Pi extensions can customize how tool calls and results are displayed in the TUI through several mechanisms.

## Overview

```typescript
pi.registerTool({
  name: "myTool",
  label: "My Tool",                          // UI label
  description: "...",                         // LLM description
  promptSnippet: "...",                       // Short prompt description
  promptGuidelines: ["...", "..."],          // Prompt guidelines

  // Custom rendering
  renderCall(args, theme) { ... },           // Display tool call
  renderResult(result, { expanded }, theme) { ... },  // Display result

  async execute(id, params, signal, onUpdate, ctx) {
    // Streaming updates
    onUpdate?.({ content: [...], details: {...} });

    return { content: [...], details: {...} };
  },
});
```

## 1. `details` Field

Store structured metadata that's accessible to extensions and custom rendering.

```typescript
interface MyToolDetails {
  model: string;
  executionTime: number;
  status: "success" | "error";
}

return {
  content: [{ type: "text", text: "Done" }],
  details: {
    model: params.model,
    executionTime: Date.now() - startTime,
    status: "success"
  }
};
```

- Used by `renderResult` for expanded views
- Accessible via event handlers (`tool_result`, `tool_call`)
- Stored in session history

## 2. Custom Rendering

### `renderCall(args, theme)`
Renders the tool call header (before/during execution).

```typescript
import { Text } from "@mariozechner/pi-tui";

renderCall(args, theme) {
  let text = theme.fg("toolTitle", theme.bold("my_tool "));
  text += theme.fg("muted", args.action);
  if (args.param) {
    text += ` ${theme.fg("dim", `"${args.param}"`)}`;
  }
  return new Text(text, 0, 0);
}
```

### `renderResult(result, { expanded, isPartial }, theme)`
Renders the tool result. Support `expanded` for details on demand, `isPartial` for streaming.

```typescript
renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Processing..."), 0, 0);
  }

  const details = result.details as MyToolDetails;
  let text = details.status === "error"
    ? theme.fg("error", "✗ Failed")
    : theme.fg("success", "✓ Done");

  if (expanded && details) {
    text += `\n${theme.fg("dim", `Model: ${details.model}`)}`;
    text += `\n${theme.fg("dim", `Time: ${details.executionTime}ms`)}`;
  }

  return new Text(text, 0, 0);
}
```

**Best practices:**
- Use `Text` with padding `(0, 0)` — the outer `Box` handles padding
- Handle `isPartial` for streaming progress
- Support `expanded` for detail on demand
- Keep default view compact
- Use error styling (`theme.fg("error", ...)`) when operations fail, even in compact view

**Fallback:** If not defined, shows tool name (call) or raw text (result).

## 3. Streaming Updates

Provide progress updates during execution via `onUpdate`.

```typescript
async execute(id, params, signal, onUpdate, ctx) {
  onUpdate?.({
    content: [{ type: "text", text: "Starting..." }],
    details: { progress: 0 }
  });

  // Do work...

  onUpdate?.({
    content: [{ type: "text", text: "Processing..." }],
    details: { progress: 50 }
  });

  // Finish...
}
```

## 4. Tool Metadata

### `label`
UI label for the tool (appears in headers, tool lists).

```typescript
pi.registerTool({
  name: "AskClaude",
  label: "Ask Claude (Sonnet)",
  // ...
});
```

### `promptSnippet`
Short one-line description in the "Available tools" section of the system prompt.

```typescript
promptSnippet: "Delegate to Claude Code for complex analysis",
```

If omitted, pi falls back to `description`.

### `promptGuidelines`
Tool-specific bullets added to the "Guidelines" section of the system prompt.

```typescript
promptGuidelines: [
  "Use AskClaude when you need Claude's specialized reasoning",
  "Provide clear, self-contained prompts for best results"
],
```

## 5. Keybinding Hints

Display keyboard shortcuts using `keyHint()`.

```typescript
import { keyHint } from "@mariozechner/pi-coding-agent";

renderResult(result, { expanded }, theme) {
  let text = theme.fg("success", "✓ Done");
  if (!expanded) {
    text += ` (${keyHint("expandTools", "to expand")})`;
  }
  return new Text(text, 0, 0);
}
```

Available functions:
- `keyHint(action, description)` — Editor actions (`expandTools`, `selectConfirm`, etc.)
- `appKeyHint(keybindings, action, description)` — App actions
- `editorKey(action)` — Get raw key string for an action
- `rawKeyHint(key, description)` — Format a raw key string

## 6. Custom UI via `ctx.ui`

Trigger notifications and dialogs during execution.

```typescript
async execute(id, params, signal, onUpdate, ctx) {
  ctx.ui.notify(`Running with model: ${params.model}`, "info");

  const confirmed = await ctx.ui.confirm("Continue?", "Confirm action");
  if (!confirmed) {
    return { content: [{ type: "text", text: "Cancelled" }], details: {} };
  }

  // ...
}
```

## Complete Example

```typescript
import { Text } from "@mariozechner/pi-tui";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ProcessDetails {
  model: string;
  duration: number;
  status: "success" | "error";
}

pi.registerTool({
  name: "Process",
  label: "Process",
  description: "Process data with external service",
  promptSnippet: "Send data to external processing service",
  promptGuidelines: [
    "Use for complex transformations not available in built-in tools"
  ],
  parameters: Type.Object({
    input: Type.String(),
    model: Type.Optional(Type.String()),
  }),

  renderCall(args, theme) {
    let text = theme.fg("toolTitle", theme.bold("Process "));
    text += theme.fg("muted", `"${args.input.substring(0, 40)}..."`);
    if (args.model) {
      text += ` ${theme.fg("accent", `[${args.model}]`)}`;
    }
    return new Text(text, 0, 0);
  },

  renderResult(result, { expanded, isPartial }, theme) {
    if (isPartial) {
      return new Text(theme.fg("warning", "Processing..."), 0, 0);
    }

    const details = result.details as ProcessDetails;
    const isError = details.status === "error";
    let text = isError
      ? theme.fg("error", "✗ Failed")
      : theme.fg("success", "✓ Complete");

    if (!expanded) {
      text += ` (${keyHint("expandTools", "for details")})`;
      return new Text(text, 0, 0);
    }

    text += `\n${theme.fg("dim", `Model: ${details.model}`)}`;
    text += `\n${theme.fg("dim", `Duration: ${details.duration}ms`)}`;
    text += `\n${theme.fg("dim", `Status: ${details.status}`)}`;

    return new Text(text, 0, 0);
  },

  async execute(id, params, signal, onUpdate, ctx) {
    const startTime = Date.now();

    onUpdate?.({
      content: [{ type: "text", text: "Starting..." }],
      details: { status: "starting" }
    });

    // ... do work ...
    // On failure: set status: "error" and return error message in content

    const duration = Date.now() - startTime;
    const details: ProcessDetails = {
      model: params.model || "default",
      duration,
      status: "success"  // or "error" on failure
    };

    return {
      content: [{ type: "text", text: "Processed successfully" }],
      details
    };
  },
});
```

## Reference

- **Extensions docs:** `vendor/pi-mono/packages/coding-agent/docs/extensions.md`
- **TUI API:** `vendor/pi-mono/packages/coding-agent/docs/tui.md`
- **Examples:** `vendor/pi-mono/packages/coding-agent/examples/extensions/`
- **Built-in tools:** `vendor/pi-mono/packages/coding-agent/src/core/tools/`
