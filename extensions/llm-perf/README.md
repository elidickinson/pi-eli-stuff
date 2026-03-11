# llm-perf

Passively tracks LLM performance metrics (TTFT, latency, throughput, cost) per model/provider as you work. Data stored in `~/.pi/agent/llm-perf.db` (SQLite).

## Usage

```bash
/llm-perf              # Last 24h, all models
/llm-perf week sonnet  # Last 7 days, models matching "sonnet"
/llm-perf purge 30d    # Delete entries older than 30 days
```

Time ranges: `24h` (default), `week`, `month`, `all`.

## Debug

```bash
LLM_PERF_DEBUG=1 pi ...
```

## Files

- `index.ts` — Extension entry point (event wiring, command, renderer)
- `state-machine.ts` — Pure event state machine (no runtime deps)
- `db.ts` — SQLite schema, queries, migrations
- `stats.ts` — Aggregation and report formatting
- `state-machine.test.ts` — Tests for the state machine
