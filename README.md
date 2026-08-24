# omp-path-rules

> Dynamic, path-triggered context rule injector for [OMP (Oh My Pi)](https://omp.sh).

Pre-injects relevant rule bodies into the LLM context *before* inference when current active files match specified globs, bridging the gap where native Rulebook rules are only passive index entries.

---

## Features

- **Active Pre-Turn Injection**: Automatically injects matching rule markdown bodies into `messages` before model inference.
- **Clean Coexistence with Native TTSR**: Scans project `.omp/rules/`, `~/.omp/rules/`, and `~/.omp/agent/rules/` (or the directory selected by `PI_CODING_AGENT_DIR`), cleanly separating:
  - **TTSR Stream Rules** (`condition`, `astCondition`, `ast_condition`, `ttsr_trigger`, or `ttsrTrigger` non-empty) -> Ignored; left exclusively to OMP's native real-time stream engine.
  - **Always-Apply Rules** (`alwaysApply: true` without trigger conditions) -> Ignored; already handled by OMP core.
  - **Path Rules** (`globs`/`paths`, or scope-only rules like `scope: tool:edit(*.ts)` without trigger conditions) -> Actively matched and dynamically injected.
- **Single-Turn Transient Scope**: Matches paths extracted from the latest user message and subsequent tool activity in the current message array. Previous synthetic rule messages are removed before refreshed rules are injected.
- **Content-Hash Invalidation**: Reads and hashes discovered Markdown files on each scan; unchanged files reuse parsed results, while same-size edits are still detected.
- **Token Budget Protection**: Uses a fixed default character budget of 16,000 for the generated block; the exported builder supports a `maxCharacters` override.
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
| `globs` | `string[]` \| `string` | Glob patterns matched against extracted active paths. |
| `paths` | `string[]` \| `string` | Accepted by the frontmatter type, but currently not used by the scanner for matching. Prefer `globs`. |
| `scope` (fallback) | `string` \| `string[]` | If `globs` is omitted, extracts globs from `tool:edit(<glob>)`-style tokens. |
| `description` | `string` | Human-readable summary. |
| `priority` | `number` | Sorting weight when multiple rules match (default `100`; higher runs first). |

*Note: Rules declaring non-empty TTSR triggers (`condition`, `astCondition`, `ast_condition`, `ttsr_trigger`, `ttsrTrigger`) or `alwaysApply: true` are recognized as native OMP TTSR/Always-Apply and skipped by this extension to prevent duplicate injection.*


## Designing Path Rules and TTSR Rules

`omp-path-rules` and OMP's native TTSR engine have different lifecycles and
different responsibilities:

| Rule type | Use for | Frontmatter | Lifecycle |
|---|---|---|---|
| Path rule | Tell the LLM which conventions to follow before inference | `globs` or `paths`, without a TTSR trigger | Pre-turn injection for the current active paths |
| TTSR rule | Inspect, interrupt, or control a runtime/tool stream | `condition`, `astCondition`, `ast_condition`, `ttsr_trigger`, or `ttsrTrigger` | OMP-native stream processing |
| Always-Apply rule | Session-wide conventions | `alwaysApply: true`, without a TTSR trigger | OMP-native base system prompt |

These rule types are intentionally mutually exclusive in this extension. A
rule with a TTSR trigger is left to OMP's native TTSR engine, and an
`alwaysApply` rule is left to OMP core. The extension does not inject the same
rule body a second time.

### Recommended split

Use two rules when you need both pre-inference guidance and runtime
enforcement. Keep the guidance in a path rule and the runtime condition in a
separate TTSR rule:

```text
.omp/rules/
├── typescript-style.md   # pre-inference guidance for matching files
└── typescript-guard.md   # native TTSR runtime enforcement
```

Path rule:

```markdown
---
description: "TypeScript implementation conventions"
globs: ["src/**/*.ts", "src/**/*.tsx"]
priority: 100
---

# TypeScript conventions
- Validate external input at the trust boundary.
- Keep exported functions explicitly typed.
- Add or update focused tests for behavior changes.
```

TTSR rule:

```markdown
---
description: "TypeScript runtime guard"
condition: "eval(...)"
---

# Runtime guard
Reject unsafe evaluation before it reaches the tool execution stream.
```

Do not put a TTSR trigger on the path rule if the same rule must be
pre-injected. Do not copy the same rule body into both files. The intended
composition is:

```text
path rule -> tell the LLM what to do before generation
TTSR rule  -> inspect or interrupt execution when its condition is met
```

Path-rule activation is session-retained: once injected, a rule block remains
in the conversation even when later turns have no matching active paths. This
preserves a stable prompt-cache prefix, but historical rule blocks can increase
token usage and retain older guidance for the rest of the session.

When the extension has a UI, the `path-rules` status shows the number of
currently active rules after each context refresh. At session start it first
shows the number of discovered path rules; the context status then replaces
that value with the number of rules matched for the current turn. The
extension maintains a session-level rule set that only grows: notifications
report only newly added rule versions and never report removals. Repeated
matches of already observed rules do not create duplicate notifications.
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
