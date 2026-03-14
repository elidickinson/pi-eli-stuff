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

4. **Pick a short TOPIC slug** from the question (e.g., "sqlite-wal", "react-server-components"). Used in file names below.

5. **Determine OUTPUT_DIR.** Use current working directory for agent outputs:
   ```bash
   OUTPUT_DIR=$(pwd)
   # Will be something like /workspace or /Users/esd/projects/...
   ```
   Write all research files to `$OUTPUT_DIR/research-TOPIC-*.md`

---

## Phase 1: Parallel Research

**Spawn all subagents at once without waiting for any to complete so they work in parallel. You should wait for them all to complete to assemble your results. **


Replace `TOPIC`, `RESEARCH_PROMPT`, and `$OUTPUT_DIR` with the values from Phase 0 before executing.

### Subagent 1: Claude Web (always)

Create a background subagent using the Agent tool that is instructed to ask claude to do research.

**Session:** `research-TOPIC-claude` (auto-created by the tool)

Here's an example of what you should ask the subagent to do:

```
ClaudeAcp({
  prompt: "RESEARCH_PROMPT

Research this topic thoroughly using web search. Write your findings to $OUTPUT_DIR/research-TOPIC-claude-web.md using this format:

# Research: TOPIC

## <Subtopic>
- Finding with detail [source](url)
- UNCERTAIN: Conflicting claim [source](url) vs [other](url)

## <Another Subtopic>
- ...

## Sources
- [Title](url) - what was found here

CRITICAL RULE: You are a research GATHERING agent, NOT an analyst. Do NOT synthesize, analyze, or draw conclusions. Report what you find with sources. Flag conflicts. That's it.

The synthesis happens in Phase 2 by the orchestrator who has access to all agent outputs.",
  session_name: "research-TOPIC-claude",
  permissions: "approve-all",
  timeout: 300
})
```

### Subagent 2: Pi Web (always)

Create a background subagent with your Agent tool that uses a prompt like:
```
RESEARCH_PROMPT

Research this topic thoroughly using web search. Write your findings to $OUTPUT_DIR/research-TOPIC-pi-web.md using this format:

# Research: TOPIC

## <Subtopic>
- Finding with detail [source](url)
- UNCERTAIN: Conflicting claim [source](url) vs [other](url)

## <Another Subtopic>
- ...

## Sources
- [Title](url) - what was found here

CRITICAL RULE: Do NOT synthesize or analyze. Just report findings with sources.
```

### Subagent 3: Pi Browser (conditional)

**Only spawn if** the task involves sites that block automated search agents or require on-site interaction. Examples: TripAdvisor, restaurant reservations, booking sites, directory sites, forums with custom search, price comparison requiring navigation.

Create a background subagent with a prompt like:
```
RESEARCH_PROMPT

Use the `br` CLI to navigate specific relevant sites and extract information. Write findings to $OUTPUT_DIR/research-TOPIC-pi-browser.md using the same format as above.

br usage: `br goto <url>`, `br extract-content`, `br view-tree`, `br click <id>`, `br fill-search <query>`. The daemon auto-starts. Chain commands with &&.

CRITICAL RULE: Do NOT synthesize or analyze. Just report findings with sources.
```

**As each agent completes**, output a one-line progress update:
```
[agent-type] complete: found X findings covering Y subtopics
```

Example:
```
Claude web complete: found 15 findings covering GitHub extensions, MCP servers, and CLI tools
Pi web complete: found 12 findings covering npm packages and documentation
```

---

## Phase 2: Synthesis

After all agents complete:

1. **Read all** `$OUTPUT_DIR/research-TOPIC-*.md` files.

   **If a file is missing:** Note in the report that the agent failed to produce output, and exclude it from confidence assessments. Continue with other agents' data.

2. **Synthesize inline response:**
   - Organize by theme, NOT by agent
   - Cite sources inline with URLs
   - Flag contradictions between sources
   - Keep it concise — bullets over paragraphs
   - Note gaps: important aspects with no good sources

3. **Write full report** to `$OUTPUT_DIR/research-TOPIC-report.md` with:
   - All findings organized thematically
   - Source list with annotations
   - Contradictions section (if any)
   - Confidence notes (well-sourced vs sparse)
   - Agent status section (which completed, which failed)

---

## Optional Cleanup

After research is complete and you no longer need session history:
```bash
acpx claude sessions delete research-TOPIC-claude
```
Sessions persist indefinitely otherwise, which is useful for follow-up queries like "tell me more about X that you found."

---

## Environment Considerations

### Sandbox/VM Environments (Gondolin, containers, etc.)

- **Use `$OUTPUT_DIR`** (resolved in Phase 0 from `$(pwd)`) for all file paths
- **Avoid `/tmp` or other host-relative paths** that may not be accessible
- **Test file write/read permissions** before spawning agents
- Agent output must be readable from the orchestrator's context

### File Access Checklist

If running in a sandboxed environment:
- [ ] Are output paths relative to working directory?
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
