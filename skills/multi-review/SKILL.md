---
name: multi-review
description: Multi-agent code review. Invoke with /skill:multi-review or automatically after completing major changes or features. Runs parallel reviews with multiple models, synthesizes and acts on findings.
---

# Multi-Model Code Review

Runs the same code review prompt through 3 different models in parallel, then synthesizes with active validation. The value is in model diversity — different models catch different things.

## Process

### Phase 1: Gather Reviews

1. **Get the diff**
   ```bash
   # If there are uncommitted changes, review those
   git diff HEAD > /tmp/review-diff.txt

   # If working tree is clean, review the most recent commit
   git diff HEAD~1 HEAD > /tmp/review-diff.txt
   ```

2. **Read project guidelines** for context
   Look for and read: `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` in repo root.
   Save a brief summary of key rules to `/tmp/review-guidelines.txt`.

3. **Run 3 parallel reviews**

   Build the review prompt from the diff and guidelines:
   ```
   REVIEW_PROMPT = "You are an expert code reviewer. Review this diff for bugs, security issues, logic errors, performance problems, and style issues. Be specific — cite file paths and line numbers. Score each finding 0-100 confidence. Skip anything below 50. Diff: <diff contents> Guidelines: <guidelines contents>"
   ```

   Then run all 3 in parallel:
   - **Claude**: Use the `AskClaude` tool with the review prompt. Save result to `/tmp/review-claude.md`.
   - **DeepSeek**: Use the `AskPi` tool with model `deepseek/deepseek-v3.2` and the review prompt. Save result to `/tmp/review-deepseek.md`.
   - **Kimi**: Use the `AskPi` tool with model `openrouter/moonshotai/kimi-k2.5` and the review prompt. Save result to `/tmp/review-kimi.md`.

   Run all 3 tool calls in parallel.

   **Note**: `AskClaude` runs `claude -p` on the host. `AskPi` runs `pi -p` on the host with read-only tools (no extensions).

### Phase 2: Active Validation

**Do not blindly trust the reviewers. Validate each finding yourself.**

4. **Read the diff yourself** and form your own impressions before looking at sub-agent reviews.

5. **Collect and deduplicate findings** from all 3 reviews.
   Note which model(s) found each issue.

6. **Validate EACH finding** against actual code:
   - Is this real? (check the code, don't just trust the claim)
   - Is the file/line correct? (verify it exists)
   - Is it a false positive or hallucination?

7. **Categorize by severity**
   - **Major**: Bugs, security issues, data loss, broken functionality
   - **Minor**: Performance, edge cases, maintainability
   - **Style**: Naming, formatting, minor improvements

   Consensus ≠ importance. Unique findings may be the deepest insights.

8. Briefly consider if all models might have missed something.

### Phase 3: Report

Present the synthesized report to the user:

```markdown
# Multi-Model Review: [title]

## Validated Issues

### Major
[issues]

### Minor
[issues]

### Style
[issues]

Each issue:
- **File**: path/to/file.ext#L10-L15
- **Status**: Confirmed | Needs verification | False positive
- **Found by**: Claude / DeepSeek / Kimi
- **Description**: What's wrong and why
- **Suggestion**: How to fix

## False Positives Filtered
[findings that were wrong, with brief explanation]

## Model Coverage

| Issue   | Claude | DeepSeek | Kimi | Status         |
| ------- | :----: | :------: | :--: | -------------- |
| Issue 1 |   ✅   |    ✅    |  ❌  | Confirmed      |
| Issue 2 |   ❌   |    ✅    |  ❌  | Confirmed      |
| Issue 3 |   ✅   |    ❌    |  ✅  | False positive |
```

### Phase 4: Act on Findings

After presenting the report:

1. **Immediately fix** confirmed Major issues that are clear bugs with obvious correct fixes (not judgment calls). Apply the fix, briefly explain what you changed.

2. **For everything else** — minor issues, style suggestions, debatable improvements, anything requiring a judgment call — **stop and ask the user** what they want to do. Present the remaining issues and let them decide which to fix, skip, or discuss.

Do NOT auto-fix style issues, refactoring suggestions, or anything where reasonable people could disagree on the right approach.

### Phase 5: Verify Fixes

If any fixes were applied in Phase 4, run a single verification pass:

Use the `AskClaude` tool with the prompt: "Review these changes and confirm each fix is correct. Just output PASS or FAIL with a brief explanation for each. Changes: <git diff HEAD output>"

If any fix fails verification, report to the user and let them decide.

## Key Principles

1. **Model diversity is the point** — different models have different blind spots
2. **Validate, don't just merge** — you are the senior reviewer, not a secretary
3. **Unique findings deserve MORE attention** — they might be what only one model is smart enough to catch
4. **Fix real bugs, ask about the rest** — auto-fix only clear, confirmed, significant issues
