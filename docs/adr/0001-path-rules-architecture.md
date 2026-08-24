# ADR 0001: Path-Rules Architecture and OMP TTSR Coexistence

## Status
Accepted

## Context
OMP (Oh My Pi) natively discovers rules from `.omp/rules/` and `~/.omp/agent/rules/`. Its built-in `bucketRules` pipeline divides rules into:
1. TTSR Stream Rules (interception during tool streaming via `condition` / `astCondition`);
2. Always-Apply Rules (static injection into the session's base system prompt via `alwaysApply: true`);
3. Rulebook Rules (passive index listings rendered in system prompt for on-demand `rule://` fetching).

Native OMP does not automatically pre-inject the full markdown body of path-scoped rules into the prompt before model inference. The `omp-path-rules` extension provides active, pre-turn context injection based on active file paths.

## Decisions

1. **Rule Classification & TTSR Coexistence**:
   - The scanner checks for non-empty TTSR triggers (`condition`, `astCondition`, `ast_condition`, `ttsr_trigger`, `ttsrTrigger`). If present, the rule is classified as `ttsr_stream` and skipped by this extension to avoid interfering with OMP's native real-time stream engine.
   - Rules with `alwaysApply: true` are classified as `always_apply` and skipped to prevent duplicate system prompt injection.
   - Rules declaring `globs` / `paths` (or scope-only tokens like `scope: tool:edit(*.ts)`) without TTSR triggers are classified as `path_rule` and actively matched.

2. **Session-Retained Rule Context**:
   - Once injected, a path-rule block remains in the conversation even when later turns have no matching active paths.
   - This preserves a stable prompt-cache prefix, at the cost of historical token growth and older guidance remaining in the session.
   - The session's observed rule set is monotonic: it may only grow. Notifications report only rules newly added to that set; removals are never emitted.

3. **Content-Hash Cache Invalidation**:
   - Each discovered Markdown file is read and hashed with SHA-256 on every scan. The cached parsed rule is reused only when the content hash is unchanged.
   - This avoids resident file watcher daemons and detects same-size edits even on filesystems with coarse timestamp resolution.

4. **Message Pipeline Injection**:
   - Matched rules are assembled into an `<active_path_rules>` block within the fixed default character budget of 16,000 characters (the exported builder accepts an optional `maxCharacters` override) and prepended as a synthetic `developer` message containing a structured text block in `event.messages`.
   - The extension removes its previous synthetic rules message before prepending the refreshed one, so repeated context refreshes remain idempotent.

## Consequences
- Clean, non-interfering coexistence with OMP native capabilities.
- Content changes are detected on the next scan without session restarts, at the cost of reading and hashing rule files on each scan.
- Strict character budget and fail-open resilience.
