# omp-path-rules

> Dynamic, path-triggered context rule injector for [OMP (Oh My Pi)](https://omp.sh).

Pre-injects relevant rule bodies into the LLM context *before* inference when current active files match specified globs, bridging the gap where native Rulebook rules are only passive index entries.

---

## Features

- **Active Pre-Turn Injection**: Automatically injects matching rule markdown bodies into `messages` before the model inference runs (Cursor MDC-style experience).
- **Clean Coexistence with Native TTSR**: Scans native `.omp/rules/*.md` and `~/.omp/agent/rules/*.md`, cleanly separating:
  - **TTSR Stream Rules** (`condition`, `astCondition`, `ttsr_trigger`, `ttsrTrigger` non-empty) -> Ignored; left exclusively to OMP's native real-time stream engine.
  - **Always-Apply Rules** (`alwaysApply: true` without trigger conditions) -> Ignored; already injected into system prompt by OMP core.
  - **Path Rules** (`globs`/`paths`, or scope-only rules like `scope: tool:edit(*.ts)` without trigger conditions) -> Actively matched and dynamically injected.
- **Single-Turn Transient Scope**: Only matches paths in the *current* turn (latest user prompt + active tool executions). Exiting a file immediately evicts its rules to keep context minimal.
- **High-Performance Invalidation**: Uses compound directory + `mtimeMs` + `size` signatures for hot-reloading with zero background watcher leaks.
- **Token Budget Protection**: Configurable character/token budget with automatic priority-based truncation.
- **Fail-Open Resilience**: Malformed YAML or file I/O errors log a warning and skip the damaged rule without crashing the agent session.

---

## Rule Format (`.omp/rules/*.md`)

Create a Markdown file in `.omp/rules/` (project-level) or `~/.omp/agent/rules/` (global):

```markdown
---
description: "React / Next.js Component Standards"
globs: ["src/components/**/*.tsx", "src/pages/**/*.tsx", "app/**/*.tsx"]
priority: 100
---

# React Component Guidelines
- Always type Props with TypeScript interfaces.
- Use Tailwind CSS utility classes; avoid inline styles.
- Keep components focused and pure where possible.
```

### Frontmatter Fields

| Field | Type | Description |
|---|---|---|
| `globs` / `paths` | `string[]` \| `string` | Glob patterns to match against active working files. |
| `scope` (fallback) | `string` \| `string[]` | If `globs` is omitted and no TTSR condition is present, extracts globs from `tool:edit(<glob>)` tokens. |
| `description` | `string` | Human-readable summary. |
| `priority` | `number` | Sorting weight when multiple rules match (default `100`, higher runs first). |

*Note: Rules declaring non-empty TTSR triggers (`condition`, `astCondition`, `ttsr_trigger`, `ttsrTrigger`) or `alwaysApply: true` are recognized as native OMP TTSR/Always-Apply and skipped by this extension to prevent duplicate injection.*

---

## Slash Commands

- `/path-rules list` — List all discovered rules, their classification, and active patterns.
- `/path-rules reload` — Invalidate cache and force re-scan of all rules directories.
- `/path-rules test <path>` — Simulate matching for a specific file path (e.g. `/path-rules test src/api/user.ts`).

---

## Installation

### Local / Project Extension
Link or load the extension directly in your project:
```bash
# Run with explicit extension
omp --extension /path/to/omp-path-rules/src/index.ts

# Or copy/link into ~/.omp/agent/extensions/
cp -r omp-path-rules ~/.omp/agent/extensions/
```

---

## Development

```bash
bun install
bun test
bun run typecheck
```
