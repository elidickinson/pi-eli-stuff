# Skill Authoring Guide

A skill is a directory containing a `SKILL.md` file. The directory name must match the `name` field in frontmatter. Everything else in the directory is freeform (scripts, references, assets).

## Frontmatter

Required fields:

```yaml
---
name: my-skill          # Must match parent directory name
description: What this skill does and when to use it.
---
```

Optional fields: `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`.

### Name rules

- 1-64 characters, lowercase `a-z`, `0-9`, hyphens only
- No leading/trailing/consecutive hyphens
- Must match parent directory name

### Description

The description is how pi decides whether to load your skill. Be specific about what the skill does and when to use it. A missing description means the skill won't load at all.

Good — states capabilities and trigger conditions:
```yaml
description: Multi-agent code review. Invoke with /skill:multi-review or automatically after completing major changes or features. Runs parallel reviews with multiple models, synthesizes and acts on findings.
```

```yaml
description: Browser automation CLI. Use for scraping web content, navigating complex sites, or interacting with web pages via CSS selectors/XPath.
```

Bad — too vague to trigger on the right tasks:
```yaml
description: Helps with code review.
```

## Body Structure

After frontmatter, write instructions the agent will follow. Common patterns from real skills:

### Phased workflow (multi-review, deep-research)

Break complex skills into numbered phases with clear boundaries:

```markdown
## Phase 1: Gather Data
1. Do X
2. Do Y

## Phase 2: Process
...

## Key Principles
1. ...
```

### Tool reference (br, brave-search)

Document setup, commands, and usage patterns:

```markdown
## Setup
How to install/configure.

## Commands
Command reference with examples.

## Best Practices
Guidance for common patterns.
```

### Review/analysis (code-review)

Define the process, scoring criteria, and output format:

```markdown
## Process
1. Get input
2. Analyze
3. Score findings

## Output format
Template for results.
```

## Tips

- Use `{baseDir}` in script paths — pi resolves it to the skill directory at runtime.
- Use relative paths for references within the skill directory (e.g., `[details](references/REFERENCE.md)`).
- Skills load on-demand: only the description is in the system prompt; the full SKILL.md is read when triggered.
- Users can force-load with `/skill:name`. Add this invocation hint in the description if the skill is primarily manually triggered.
- The body is instructions for the agent — write it as directives, not documentation for humans.

## References

- Official docs: [vendor/pi-mono/packages/coding-agent/docs/skills.md](../vendor/pi-mono/packages/coding-agent/docs/skills.md)
- Example skills in this repo: [skills/](../skills/) (multi-review, deep-research, br)
- Upstream skills: [vendor/pi-skills/](../vendor/pi-skills/) (brave-search, code-review, and more)
- Agent Skills specification: https://agentskills.io/specification
