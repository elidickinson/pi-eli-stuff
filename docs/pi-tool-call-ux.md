# Tool Call UX Options in Pi

Deep dive on tool call display customization. For a broader introduction to building extensions (tools, events, commands, persistence), see the [Extension Cookbook](extension-cookbook.md).

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

See the [Extension Cookbook](extension-cookbook.md#tui-rendering) for real `renderCall`/`renderResult` examples with collapsed/expanded views, streaming via `onUpdate`, and theme color reference.

**Key flags in `renderResult(result, { expanded, isPartial }, theme)`:**
- `isPartial` — true while `onUpdate` is streaming; show a progress indicator
- `expanded` — true when user expands (Ctrl+O); show full details

**Fallback:** If not defined, shows tool name (call) or raw text (result).

## 3. Tool Metadata

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

## 4. Keybinding Hints

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

## Reference

- **Extensions docs:** `vendor/pi-mono/packages/coding-agent/docs/extensions.md`
- **TUI API:** `vendor/pi-mono/packages/coding-agent/docs/tui.md`
- **Examples:** `vendor/pi-mono/packages/coding-agent/examples/extensions/`
- **Built-in tools:** `vendor/pi-mono/packages/coding-agent/src/core/tools/`
