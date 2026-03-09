---
name: br
description: Browser automation CLI. Use for scraping web content, navigating complex sites, or interacting with web pages via CSS selectors/XPath.
---

# br Browser Automation

## Setup

The daemon auto-starts on first command. No manual `br start` needed.

No `sleep` between calls - the daemon handles synchronization. Navigation commands (`goto`, `reload`, `back`, `forward`) wait for `domcontentloaded` before returning, so explicit waits are usually unnecessary. Use `wait-stable` or `wait-idle` only for SPAs or lazy-loaded content.

## Content Extraction

Choose the right extraction command:

- `extract-content` — main article content as clean Markdown (best for reading pages)
- `extract-text` — all visible text, or text from a specific element with `-s <selector>`
- `view-tree` — DOM structure with numeric IDs (needed to find and interact with elements)
- `view-html` — raw HTML (rarely needed, use as last resort)

Quick page scraping:

```bash
br goto <url> && br extract-content    # Main content as Markdown
br goto <url> && br extract-text       # All visible text
```

With screenshot:

```bash
br goto <url> && br screenshot -o page.png
```

## Navigating Complex Sites

### Discovery pattern

```bash
br goto <url>
br view-tree                               # Find element IDs
br screenshot -o page.png                  # Visual reference
```

The `view-tree` output shows numeric IDs in brackets (e.g., `[42]`, `[108]`). Use the bare number to interact with elements.

### Navigation pattern

```bash
br goto <url>
br view-tree                               # Get IDs
br click 42                                # Use numeric ID from view-tree
br wait-stable                             # Only if page uses dynamic loading
br extract-content                         # Get content
```

### Form interaction

```bash
br fill 42 "text"                          # Fill by view-tree ID
br fill-secret 42 MY_PASSWORD_ENV          # Fill from env var (masked in logs)
br select 42 "value"                       # Select dropdown option
br press Enter
br submit 42                               # Submit form
```

### Pagination

```bash
br goto <url>
br extract-content                        # First page
br click 42                               # Next button (use ID from view-tree)
br wait-stable
br extract-content                        # Second page
```

## Selectors

Prefer view-tree IDs — they are the most reliable. Use CSS selectors only for well-known, stable elements.

```bash
# View-tree numeric ID (preferred)
br click 42

# CSS selector
br click "button.submit"
br fill "#email" "user@example.com"

# XPath (must use xpath= prefix)
br click "xpath=//button[contains(text(),'Submit')]"
```

## Commands

### Navigation
```bash
br goto <url>                              # Navigate (auto-adds https://)
br back                                    # History back
br forward                                 # History forward
br reload                                  # Reload (--hard to bypass cache)
```

### Interaction
```bash
br click <selectorOrId>                    # Click element
br fill <selectorOrId> <text>              # Fill input
br fill-secret <selectorOrId> <envVar>     # Fill from env var (masked)
br type <selectorOrId> <text>              # Type character by character
br press <key>                             # Press key (Enter, Tab, etc.)
br select <selectorOrId> <value>           # Select dropdown option
br submit <selectorOrId>                   # Submit form
br fill-search <query>                     # Auto-detect search input + submit
```

### Content
```bash
br extract-content                         # Main content as Markdown
br extract-text                            # All visible text
br extract-text -s <selector>              # Text from specific element
br view-tree                               # DOM tree with IDs
br view-tree --root 42                     # Subtree under node 42
br view-html                               # Raw HTML (paginated)
br eval "document.title"                   # Run JavaScript
```

### Scrolling
```bash
br scrollTo <percentage>                   # Scroll to % of page
br nextChunk                               # Scroll down one viewport
br prevChunk                               # Scroll up one viewport
br scrollIntoView <selectorOrId>           # Scroll element into view
```

### Waiting
```bash
br wait <selector>                         # Wait for element visible
br wait-stable                             # Wait for DOM to settle
br wait-load                               # Wait for full page load
br wait-idle                               # Wait for network idle
```

### Tabs
```bash
br tabs                                    # List open tabs
br switch-tab <index>                      # Switch to tab
br console                                 # View browser console logs
br console --type error                    # Filter by type
```

### Files
```bash
br screenshot -o <file>                    # Save screenshot (-f for full page)
br pdf -o <file>                           # Save PDF
br download <selectorOrUrl>                # Download file (uses page cookies)
```

### Session management

Named instances are only needed when running multiple concurrent browser tasks. For single-session use, skip `br start` entirely — the daemon auto-starts.

```bash
br start --name mysession                  # Start a named instance
br --name mysession goto <url>             # Use named instance
br list                                    # List running instances
br --name mysession stop                   # Stop specific instance
```

## Best Practices

1. **Start with view-tree** for complex sites — numeric IDs are more reliable than CSS selectors
2. **Wait after SPA navigation** — use `wait-stable` after clicks that trigger dynamic page updates
3. **Use named sessions** — prevents conflicts when running multiple tasks
4. **Chain with &&** — ensures previous command succeeded
5. **Screenshot for debugging** — when elements aren't found or pages look wrong

## Error Handling

```bash
br visible <selector> && echo "found" || echo "not found"
br exists <selector>                        # Exit code 1 if not found
br wait-stable                              # Wait for DOM stability (SPAs)
```
