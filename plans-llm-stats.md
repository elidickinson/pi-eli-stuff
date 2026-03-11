# Plan: `llm-perf` Pi Extension

## Context

Evaluate different LLM providers/models for use in Pi by passively tracking real-world responsiveness metrics (latency, TTFT, throughput, cost) as you work. No existing tool does this well:
- **agent-cost-dashboard** — post-hoc JSONL parser, no TTFT, no real-time, no persistence
- **pi-otlp** — requires OTel stack + Docker + Prometheus + Grafana; no TTFT despite claiming Pi lacks streaming events (it doesn't — `message_update` has `text_delta`)

Our extension: passive event-driven collection → SQLite → in-session `/llm-perf` command.

## Files

- **Create** `extensions/llm-perf.ts` — single-file extension (project convention)
- **Modify** `package.json` — add `better-sqlite3` + `@types/better-sqlite3`
- **Modify** `CLAUDE.md` — document the extension

## Schema (SQLite, WAL mode)

```sql
CREATE TABLE llm_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_ms    INTEGER NOT NULL,       -- unix epoch ms, turn_start time
  session_id      TEXT,                    -- unique per Pi instance (UUID generated at load)
  turn_index      INTEGER,                -- from turn_start event

  -- model
  provider        TEXT NOT NULL,           -- "anthropic", "openrouter", etc.
  model           TEXT NOT NULL,           -- "claude-sonnet-4-20250514", etc.
  api             TEXT,                    -- "anthropic-messages", "openai-completions"

  -- timing (ms)
  ttft_ms         REAL,                    -- turn_start → first text_delta/thinking_delta
  duration_ms     REAL,                    -- turn_start → message_end

  -- tokens
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cache_read      INTEGER,
  cache_write     INTEGER,

  -- cost (USD, from Usage.cost)
  cost_input      REAL,
  cost_output     REAL,
  cost_cache_read REAL,
  cost_cache_write REAL,
  cost_total      REAL,

  -- context at call time
  context_tokens  INTEGER,
  context_window  INTEGER,

  -- outcome
  stop_reason     TEXT,                    -- "stop", "length", "toolUse", "error", "aborted"
  error_message   TEXT                     -- null if no error
);

CREATE INDEX idx_timestamp ON llm_calls(timestamp_ms);
CREATE INDEX idx_provider_model ON llm_calls(provider, model);
CREATE INDEX idx_session ON llm_calls(session_id);
```

Migrations via `PRAGMA user_version`. Version 0 → create table (v1). Future changes use ALTER TABLE.

**Schema notes:**
- Flat/denormalized — provider/model cardinality is low, no joins needed
- `session_id` + `turn_index` — cheap, useful for dev troubleshooting and grouping
- `session_id` is a UUID generated at extension load (one per Pi instance)
- Cost broken out (input/output/cache_read/cache_write/total) — enables cache efficiency analysis per provider
- `context_tokens` + `context_window` — enables context utilization % correlation with latency
- `error_message` instead of `is_error` boolean — more useful, error state derivable from stop_reason

## DB Location & Concurrency

**Path:** `~/.pi/agent/llm-perf.db` (alongside Pi's existing session data).

**Concurrency:** Multiple Pi instances may write simultaneously.
- WAL mode (`PRAGMA journal_mode=WAL`)
- `PRAGMA busy_timeout=1000` (1s — INSERTs take microseconds, longer means something is wrong)
- `better-sqlite3` is synchronous — holds write lock only during INSERT

## Event Wiring

```
turn_start       →  Create pending: { startTime: timestamp, turnIndex }
                     Capture ctx.model, ctx.getContextUsage()
message_start    →  Capture provider/model/api from event.message (authoritative)
message_update   →  On first text_delta or thinking_delta: record firstTokenTime
message_end      →  Compute metrics, INSERT row, clear pending
```

State: single `pending` variable (Pi processes one LLM call at a time per extension instance).

```typescript
interface PendingCall {
  startTime: number          // from turn_start timestamp
  turnIndex: number
  firstTokenTime: number | null
  provider: string
  model: string
  api: string
  contextTokens: number | null
  contextWindow: number
}
```

**TTFT detection:** Check `assistantMessageEvent.type` for `"text_delta"` or `"thinking_delta"` only. Record `Date.now()` on the first hit (when `firstTokenTime === null`). The `contentIndex` value doesn't matter — we want the first content token of any type. All other event types are ignored: `start`, `done`, `error`, `text_start`, `text_end`, `thinking_start`, `thinking_end`, `toolcall_*`.

**No turn_start ambiguity:** Every Pi turn involves exactly one LLM call — tool results are fed back as the next turn's input. There are no tool-only turns without an LLM call, so each `turn_start` corresponds to one `message_start`→`message_end` cycle.

**Event ordering edge cases:**
- **Retries within a turn:** If Pi retries after an error, we get: `turn_start` → `message_start` → `message_end`(error) → `message_start` → `message_end`(success). The first `message_end` INSERTs the failed attempt and clears `pending`. The second `message_start` finds `pending === null` and creates a new one from `message.timestamp` (same as mid-stream fallback). Both attempts are recorded. The retry's TTFT is measured from stream start, not the original turn_start — more accurate for the retry anyway.
- **Defensive overwrite:** if `turn_start` fires again before `message_end` cleared `pending`, overwrite (lose incomplete data, don't crash)
- **message_start without turn_start:** Create pending from `message.timestamp`. Handles extension loaded mid-stream AND retries.
- **message_end never fires** (crash/disconnect): `pending` leaks until next `turn_start` overwrites. One lost data point, acceptable.
- **Thinking before text:** Extended thinking models emit `thinking_delta` before `text_delta`. TTFT captures first `thinking_delta` — correct, it's the first visible output.
- **Error before tokens:** TTFT stays null, duration still recorded
- **Aborted calls:** recorded with stop_reason "aborted"
- **Streaming "error" vs Pi "message_end":** The `AssistantMessageEvent.type === "error"` is a streaming event; the Pi-level `message_end` still fires separately with `stopReason: "error"`, so our INSERT always happens.
- **DB write failure:** `console.warn`, never disrupt the user's work

## Debug Logging

Controlled by `LLM_PERF_DEBUG=1` env var. Uses `console.warn` (goes to Pi's debug log, not TUI).

When enabled, log:
- Each event as it fires: `[llm-perf] turn_start turnIndex=3 timestamp=...`
- Pending state transitions: `[llm-perf] pending created`, `[llm-perf] TTFT recorded 823ms`
- Event ordering issues: `[llm-perf] WARN: message_start without turn_start`
- DB operations: `[llm-perf] INSERT id=47 provider=anthropic model=claude-sonnet-4 ttft=823ms dur=4200ms`
- Errors: `[llm-perf] ERROR: DB write failed: ...`

All log lines prefixed with `[llm-perf]` for easy grep.

## Commands

### `/llm-perf [time] [filter]`

Args are order-independent. Time ranges: `24h` (default), `week`, `month`, `all`. Anything else is a model substring filter.

```
/llm-perf              → last 24h, all models
/llm-perf week         → last 7 days
/llm-perf week sonnet  → last 7 days, models matching "sonnet"
/llm-perf deepseek     → last 24h, models matching "deepseek"
```

Output (via `sendMessage` + custom message renderer):
```
LLM Perf (last 24h)
──────────────────────────────────────────────────────────────
 Model                   Calls  TTFT p50  Dur p50   Tok/s   Cost
 anthropic/claude-so…       47    820ms     4.2s    62.3  $1.24
 openrouter/deepseek…       12   1200ms     6.1s    48.7  $0.08
──────────────────────────────────────────────────────────────
 Total                      59                             $1.32
```

Percentiles computed in JS (sort + pick middle). Tok/s = median of per-call `output_tokens / (duration_ms / 1000)`.

### `/llm-perf purge <duration>`

Duration: `30d`, `7d`, `24h`, etc. (regex `(\d+)([dhm])`). Deletes entries older than duration. Prints count of deleted rows.

### Argument completions

`getArgumentCompletions` returns `["week", "month", "all", "purge"]` plus distinct model names from the DB.

## Testing (TDD for event state machine)

**Runner:** vitest (used by Pi monorepo, pi-subagents, and this project's conventions).

**Scope:** Only the event state machine — the tricky part. DB writes and command rendering verified manually.

**Approach:** Extract the core pending-state logic into pure functions that don't depend on Pi's ExtensionAPI or SQLite. The state machine takes events in and produces insert-ready row objects out.

```typescript
// Testable core: handleTurnStart(), handleMessageStart(), handleMessageUpdate(), handleMessageEnd()
// Each takes current pending state + event data, returns new pending state (or a completed row)
```

**Test cases:**
1. Happy path: turn_start → message_start → text_delta → message_end → verify row
2. TTFT from thinking_delta (extended thinking model)
3. Error before any tokens → null TTFT, duration still recorded
4. Retry within turn: message_end(error) → message_start → message_end(success) → two rows
5. message_start without turn_start → fallback to message.timestamp
6. Aborted call → stop_reason "aborted"
7. Defensive overwrite: double turn_start before message_end
8. toolcall_delta does NOT trigger TTFT
9. Multiple text_delta events → only first sets TTFT

**Files:** `extensions/llm-perf.test.ts` alongside the extension.

## File Organization (single file, top to bottom)

```
// Imports (pi types, better-sqlite3, node:fs, node:path, node:os, node:crypto)
// Types (PendingCall, StatsRow, ModelStats)
// Debug logger (debug() helper gated by LLM_PERF_DEBUG env var)
// DB helpers (getDbPath, openDb, insertCall, queryCalls, purgeBefore)
// Stats computation (percentile, computeModelStats)
// Report formatting (formatReport)
// Argument parsing (parseArgs, parseDuration)
// export default function(pi) {
//   const sessionId = crypto.randomUUID()
//   lazy db init
//   event handlers (turn_start, message_start, message_update, message_end)
//   registerCommand("llm-perf", ...)
//   registerMessageRenderer("llm-perf-report", ...)
// }
```

## Reference Files

- `extensions/activity.ts` — event hooks + command registration pattern
- `extensions/claude-acp.ts` — `sendMessage` + custom message renderer pattern
- `docs/pi-tool-call-ux.md` — rendering patterns (Text, theme, expanded/isPartial)
- `vendor/pi-mono/packages/coding-agent/dist/core/extensions/types.d.ts` — all event/API types
- `vendor/pi-mono/packages/ai/dist/types.d.ts` — AssistantMessage, Usage, Model types

## Verification

1. `npm install better-sqlite3 @types/better-sqlite3`
2. Add extension path to `~/.config/pi/pi.json`
3. Start Pi with `LLM_PERF_DEBUG=1`, make a few LLM calls
4. Check debug log for correct event ordering and state transitions
5. `/llm-perf` — should show table with TTFT, duration, tok/s, cost
6. `sqlite3 ~/.pi/agent/llm-perf.db "SELECT * FROM llm_calls ORDER BY id DESC LIMIT 5;"`
7. `/llm-perf purge 1h` — should report deleted count
8. Open two Pi sessions, both making calls — no SQLITE_BUSY errors
9. Use a model with invalid API key — should record with stop_reason "error"
