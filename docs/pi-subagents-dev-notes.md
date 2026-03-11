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

## Working example: `send_message` via `customTools`

`agent-runner.ts` injects a `send_message` tool into subagent sessions so they can send fire-and-forget messages back to the parent agent. This is the canonical example of why `customTools` exists — the tool needs access to the parent's `pi.sendUserMessage()`, which isn't available as a built-in.

```typescript
// agent-runner.ts — inside runAgent()

const customTools: typeof tools = [];
if (options.pi && options.agentId) {
  const agentId = options.agentId;
  const agentLabel = `${type} (${options.agentDescription ?? agentId})`;

  customTools.push({
    name: "send_message",
    label: "Send Message",
    description: "Send a fire-and-forget message to the parent agent. ...",
    parameters: Type.Object({
      message: Type.String({ description: "The message to send to the parent." }),
    }),
    execute: async (_id: string, params: { message: string }) => {
      options.pi.sendUserMessage(
        `Message from agent ${agentId} (${agentLabel}):\n\n${params.message}`,
        { deliverAs: "followUp" },
      );
      return { content: [{ type: "text" as const, text: "Message sent to parent." }], details: {} };
    },
  });
}

// Later, passed to createAgentSession:
const { session } = await createAgentSession({
  // ...
  tools,        // built-in tools (read, bash, etc.) — selected per agent type
  customTools,  // send_message — injected as a new tool
  // ...
});
```

Key points from this example:
- `tools` selects which built-in tools the subagent gets (via `getToolsForType()`)
- `customTools` injects `send_message` as a new tool the LLM can call
- The custom tool closes over `options.pi` to access the parent extension API
- The tool uses `deliverAs: "followUp"` so the parent sees it after current work finishes
