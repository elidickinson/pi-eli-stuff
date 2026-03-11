# pi-subagents Development Notes

## `createAgentSession` tool registration gotchas

### `tools` vs `customTools`

The `tools` parameter in `createAgentSession` selects which **built-in** tools to activate (read, bash, edit, write, grep, find, ls). It does NOT register new tools — names not in the base registry are silently filtered out:

```javascript
// sdk.js — only keeps names that exist in allTools (the base registry)
const initialActiveToolNames = options.tools
    ? options.tools.map((t) => t.name).filter((n) => n in allTools)
    : defaultActiveToolNames;
```

To inject a **new** tool into a subagent session, use `customTools`:

```typescript
const sessionOpts = {
  tools,         // selects built-in tools (read, bash, etc.)
  customTools,   // registers NEW tools (e.g., send_message)
  // ...
};
const { session } = await createAgentSession(sessionOpts);
```

Custom tools are merged with extension-registered tools in `_refreshToolRegistry()` and appear in `getActiveToolNames()` automatically.

### Active tool filtering

After session creation, `setActiveToolsByName()` controls which tools the agent can use. The filter in `agent-runner.ts` uses `builtinToolNames` (from the `tools` array) as a whitelist. Custom tools injected via `customTools` are NOT in this set, so they survive because they pass the `extensions !== false` fallthrough — they're treated like extension tools and kept unless explicitly excluded.

If you need to exclude a custom tool from subagents, add its name to `EXCLUDED_TOOL_NAMES`.
