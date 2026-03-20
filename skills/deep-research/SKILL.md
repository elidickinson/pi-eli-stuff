---
name: deep-research
description: Deep research via parallel web agents. Spawns multiple research agents in background, synthesizes findings into a concise thematic report with source citations.
---

# Deep Research

Runs parallel web research via multiple agents and synthesizes findings into a concise report.

## Orchestrator Role

**CRITICAL:** You are the orchestrator, NOT a researcher. Your job is to:
- Spawn research agents as specified
- Wait for all agents to complete
- Read and synthesize agent outputs
- Write the final report

**Do NOT:**
- Run `web_search` tool directly yourself
- Curl or fetch pages manually
- Do research work personally
- This defeats the purpose of multiple diverse agents

---

## Phase 0: Understand & Gather Context

1. **Parse the research question.** If anything is ambiguous or underspecified, ask the user to clarify before proceeding. Do not guess.

2. **Local context (conditional).** If the topic relates to the current repo or codebase, do a quick exploration — grep/glob/read, no subagents. Produce a context block of 3-5 bullets. Skip entirely for purely external topics.

3. **Build RESEARCH_PROMPT.** Combine the user's question + any local context into a single research prompt. Include:
   - The specific question to answer
   - Any constraints or scope from the user
   - Local context bullets (if any)

4. **Pick a short topic slug** from the question (e.g., `sqlite-wal`, `react-server-components`).

5. **Break the question into research angles.** Identify 2-4 distinct angles that together cover the question. Each angle should produce different search queries naturally. Give each a short slug.

   Examples:
   - "Best database for time-series data" → `technical-specs`, `benchmarks-comparisons`, `production-experience`
   - "How does QUIC work?" → `protocol-design`, `implementation-status`, `performance-vs-tcp`

6. **Create the research directory** at `research/<topic>/` (relative to cwd). All agent output and the final report go here.
   ```bash
   mkdir -p research/<topic>
   ```

---

## Phase 1: Parallel Research

**Spawn all subagents in a single tool response so they run in parallel.** Use `run_in_background: true` on every agent. Background agents notify you on completion automatically — do not poll or check on them. Wait for all notifications before proceeding to Phase 2.

Every agent prompt must include the **absolute path** to `research/<topic>/` so it knows where to write. Resolve it once in Phase 0 and embed it in each prompt.

### Research prompt template

All agents get a prompt structured like this (substitute the correct output filename per agent):

```
<RESEARCH_PROMPT>

Research this topic thoroughly using web search. Write your findings to <absolute path>/research/<topic>/<agent>.md using this format:

# Research: <topic>

## <Subtopic>
- Finding with detail [source](url)
- UNCERTAIN: Conflicting claim [source](url) vs [other](url)

## <Another Subtopic>
- ...

## Sources
- [Title](url) - what was found here

CRITICAL RULE: You are a research GATHERING agent, NOT an analyst. Do NOT synthesize, analyze, or draw conclusions. Report what you find with sources. Flag conflicts. That's it.

The synthesis happens in Phase 2 by the orchestrator who has access to all agent outputs.
```

### Claude Web (always, 1 agent)

Gets the full unscoped research prompt — different model/toolset provides natural diversity without needing angle scoping.

```
Agent({
  subagent_type: "ask-claude",
  prompt: "<research prompt — output file: claude-web.md>",
  description: "Research <topic> via Claude",
  run_in_background: true
})
```

### Pi Web (always, 1 agent per angle)

Spawn one `general-purpose` agent per research angle from Phase 0. Prepend the angle focus to the research prompt so each agent searches differently.

```
Agent({
  subagent_type: "general-purpose",
  prompt: "Focus your research on: <angle description>\n\n<research prompt — output file: <angle-slug>.md>",
  description: "<angle-slug>",
  run_in_background: true
})
```

### Pi Browser (conditional)

**Only spawn if** the topic involves sites that require a real browser to navigate — SPAs, interactive search, pagination, form input. Examples: TripAdvisor, booking sites, directory sites with custom search.

Do NOT spawn for sites that serve static HTML — the other agents can use `fetch` for that.

```
Agent({
  subagent_type: "general-purpose",
  prompt: "<research prompt — output file: browser.md>

Use the `br` CLI to navigate the target sites and extract information.
br usage: `br goto <url>`, `br extract-content`, `br view-tree`, `br click <id>`, `br fill-search <query>`. The daemon auto-starts. Chain commands with &&.",
  description: "Browse sites for <topic>",
  run_in_background: true
})
```

### All agents must be spawned in the same tool response.

This ensures they run concurrently. Do NOT spawn one, wait, then spawn the next.

**As each agent completes**, output a one-line progress update:
```
[agent-type] complete: found X findings covering Y subtopics
```

---

## Phase 2: Synthesis

After all agents complete:

1. **Read all `.md` files** in `research/<topic>/` (excluding `report.md`).

   **If a file is missing:** Note in the report that the agent failed to produce output, and exclude it from confidence assessments. Continue with other agents' data.

2. **Synthesize inline response:**
   - Organize by theme, NOT by agent
   - Cite sources inline with URLs
   - Flag contradictions between sources
   - Keep it concise — bullets over paragraphs
   - Note gaps: important aspects with no good sources

3. **Write full report** to `research/<topic>/<topic>-report.md` with:
   - All findings organized thematically
   - Source list with annotations
   - Contradictions section (if any)
   - Confidence notes (well-sourced vs sparse)
   - Agent status section (which completed, which failed)

---

## Environment Considerations

### Sandbox/VM Environments (Gondolin, containers, etc.)

- Resolve `research/<topic>/` to an absolute path before embedding in agent prompts
- **Avoid `/tmp` or other host-relative paths** that may not be accessible
- **Test file write/read permissions** before spawning agents
- Agent output must be readable from the orchestrator's context

### File Access Checklist

If running in a sandboxed environment:
- [ ] Can orchestrator read files written by agents?
- [ ] Is the output directory writable?
- [ ] Do agents have `web_search` tool access?

---

## Key Principles

1. **Diversity is the point** — different agents find different things
2. **Theme over source** — organize by what was found, not who found it
3. **Flag conflicts** — contradictions between sources are valuable signal
4. **Concise inline, thorough in file** — the user gets a summary, the file gets everything
5. **Agent, not analyst** — each agent gathers data; orchestrator synthesizes in Phase 2
