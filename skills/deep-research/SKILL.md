---
name: deep-research
description: Deep research via parallel web agents. Spawns multiple research agents in background, synthesizes findings into a concise thematic report with source citations.
---

# Deep Research

Runs parallel web research via multiple agents and synthesizes findings into a concise report.

## Phase 0: Understand & Gather Context

1. **Parse the research question.** If anything is ambiguous or underspecified, ask the user to clarify before proceeding. Do not guess.

2. **Local context (conditional).** If the topic relates to the current repo or codebase, do a quick exploration — grep/glob/read, no subagents. Produce a context block of 3-5 bullets. Skip entirely for purely external topics.

3. **Build RESEARCH_PROMPT.** Combine the user's question + any local context into a single research prompt. Include:
   - The specific question to answer
   - Any constraints or scope from the user
   - Local context bullets (if any)

4. **Pick a short TOPIC slug** from the question (e.g., "sqlite-wal", "react-server-components"). Used in file names below.

## Phase 1: Parallel Research

Spawn subagents for research tasks so they can run in parallel.

### Subagent 1: Claude Web (always)

Bash tool:
```bash
acpx --approve-all claude sessions new --name research-TOPIC-claude && \
acpx --approve-all claude -s research-TOPIC-claude --timeout 180 "RESEARCH_PROMPT

Research this topic thoroughly using web search. Write your findings to /tmp/research-TOPIC-claude-web.md using this format:

# Research: TOPIC

## <Subtopic>
- Finding with detail [source](url)
- UNCERTAIN: Conflicting claim [source](url) vs [other](url)

## <Another Subtopic>
- ...

## Sources
- [Title](url) - what was found here

Group findings by subtopic, cite every claim with a source URL. Flag uncertainty. Do NOT synthesize or draw conclusions — just report what you find."
```

### Subagent 2: Pi Web (always)

Agent tool (general-purpose subagent):
```
RESEARCH_PROMPT

Research this topic thoroughly using web search. Write your findings to /tmp/research-TOPIC-pi-web.md using this format:

# Research: TOPIC

## <Subtopic>
- Finding with detail [source](url)
- UNCERTAIN: Conflicting claim [source](url) vs [other](url)

## <Another Subtopic>
- ...

## Sources
- [Title](url) - what was found here

Group findings by subtopic, cite every claim with a source URL. Flag uncertainty. Do NOT synthesize or draw conclusions — just report what you find.
```

### Subagent 3: Pi Browser (conditional)

**Only spawn if** the task involves sites that block automated search agents or require on-site interaction or need to be explored explicitly. Examples: TripAdvisor, restaurant reservations, booking sites, directory sites (anything that lists a bunch of items and provides filter/search/similar), forums with custom search, price comparison requiring navigation. 

Agent tool (general-purpose subagent):
```
RESEARCH_PROMPT

Use the `br` CLI to navigate specific relevant sites and extract information. Write findings to /tmp/research-TOPIC-pi-browser.md using the same format as above.

br usage: `br goto <url>`, `br extract-content`, `br view-tree`, `br click <id>`, `br fill-search <query>`. The daemon auto-starts. Chain commands with &&.
```

**As each agent completes**, output a one-line progress update:
```
Claude web complete: <top 1-2 findings in ~20 words>
```

## Phase 2: Synthesis

After all agents complete:

1. **Read all** `/tmp/research-TOPIC-*.md` files.

2. **Synthesize inline response:**
   - Organize by theme, NOT by agent
   - Cite sources inline with URLs
   - Flag contradictions between sources
   - Keep it concise — bullets over paragraphs
   - Note gaps: important aspects with no good sources

3. **Write full report** to `/tmp/research-TOPIC-report.md` with:
   - All findings organized thematically
   - Source list with annotations
   - Contradictions section (if any)
   - Confidence notes (well-sourced vs sparse)

## Key Principles

1. **Diversity is the point** — different agents find different things
2. **Theme over source** — organize by what was found, not who found it
3. **Flag conflicts** — contradictions between sources are valuable signal
4. **Concise inline, thorough in file** — the user gets a summary, the file gets everything
