# Multi-Agent Code Review Research

## Existing Art: Multi-Agent Code Review

### Already in vendor/pi-skills

1. **`code-review`** — Single-reviewer skill that uses `gh pr diff`, scores findings 0-100 confidence, filters at >= 50
2. **`multi-review`** — Spawns 3 parallel `pi -p` subagents (Opus, Codex, Gemini), waits, then synthesizes findings with validation against actual code. Outputs a unified report with per-model attribution and a MERGE / FIX FIRST / NEEDS DISCUSSION verdict.

### Notable projects elsewhere

| Project | Approach |
|---|---|
| **[Anthropic code-review plugin](https://github.com/anthropics/claude-plugins-official)** | 5 parallel Sonnet agents + Haiku confidence scorers (0-100, filter at 80). Gold standard. |
| **[hamy.xyz 9-reviewer](https://hamy.xyz/blog/2026-02_code-reviews-claude-subagents)** | 9 specialized `claude -p` subagents (security, perf, tests, deps, simplification, etc.) |
| **[hamelsmu/claude-review-loop](https://github.com/hamelsmu/claude-review-loop)** | Stop-hook pattern: 4 parallel Codex agents fire after task completion, findings go to `reviews/` |
| **[MCO](https://github.com/mco-org/mco)** | Fans out same review to Claude/Codex/Gemini/Qwen, deduplicates, outputs SARIF |
| **[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)** | Pi fork with `/review` command, P0-P3 findings, spawns explore sub-agents |
| **[cmf/pi-subagent](https://github.com/cmf/pi-subagent)** | TypeScript lib for orchestrating parallel `pi` processes with fan-out/fan-in |
| **[St1ma/claude-code-openrouter-code-reviewer](https://github.com/St1ma/claude-code-openrouter-code-reviewer)** | Claude Code + OpenRouter to route to free-tier models |

### Key patterns worth stealing

1. **Specialized reviewer roles** — Don't just run the same prompt N times. Give each subagent a focus: security, performance, correctness, style, test quality, simplification
2. **Confidence scoring + filtering** — Anthropic's plugin has a second pass with a cheap/fast model scoring each finding 0-100, discarding < 80. Dramatically reduces noise.
3. **Active validation** — The existing `multi-review` skill does this: the synthesizer re-reads the actual diff to validate findings rather than blindly trusting reviewers
4. **Cross-model diversity** — MCO and multi-review both fan out to different models (not just different prompts), catching model-specific blind spots

### The `pi -p` subagent pattern (from multi-review skill)

```bash
pi -p --model claude-opus-4-5 "review prompt..." > /tmp/review-opus.md &
pi -p --model gpt-5.2-codex "review prompt..." > /tmp/review-codex.md &
pi -p --model gemini-2.5-pro "review prompt..." > /tmp/review-gemini.md &
wait
# then synthesize all three
```

### Anthropic code-review plugin pipeline

```
Initial Eligibility (Haiku) → CLAUDE.md Fetch (Haiku) → PR Summary (Haiku)
                                    ↓
                  5 Parallel Sonnet Agents:
                  1. CLAUDE.md compliance audit
                  2. Shallow bug scan (changes only)
                  3. Git blame/history analysis
                  4. Previous PRs touching same files
                  5. Code comments compliance
                                    ↓
              N Parallel Haiku Confidence Scorers (one per flagged issue)
                                    ↓
              Filter (Score ≥ 80) → Re-Check Eligibility → Post PR Comment
```

### hamy.xyz 9-reviewer roles

1. Test Runner
2. Linter & Static Analysis
3. Code Reviewer (top 5 improvements by impact/effort)
4. Security Reviewer (injections, auth, secrets)
5. Quality & Style Reviewer
6. Test Quality Reviewer (coverage ROI, flakiness)
7. Performance Reviewer (N+1 queries, memory leaks)
8. Dependency & Deployment Safety
9. Simplification & Maintainability

Results synthesized into prioritized summary with verdict: Ready to Merge / Needs Attention / Needs Work. ~75% useful suggestion rate reported.

### Pi skill structure (minimum needed)

```
my-skill/
├── SKILL.md         # Required: YAML frontmatter + markdown instructions
├── scripts/         # Optional helper scripts
├── references/      # Optional supplemental docs loaded on-demand
└── assets/          # Optional data files
```

SKILL.md frontmatter:
```yaml
---
name: my-skill          # must match parent directory name, lowercase a-z/0-9/hyphens
description: ...        # What it does and WHEN to use it
---
```
