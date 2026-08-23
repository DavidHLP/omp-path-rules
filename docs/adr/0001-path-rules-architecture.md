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

2. **Single-Turn Transient Scope**:
   - Active paths are extracted only from the current turn (the latest user message and its subsequent tool executions).
   - Rules are evicted immediately when focus shifts to unrelated files, minimizing token consumption.

3. **Compound Signature Cache Invalidation**:
   - Dynamic hot-reloading is achieved by computing a per-file signature (`filename:mtimeMs:size`) during `pi.on("context")` calls.
   - Avoids resident file watcher daemons, preventing file handle leaks and cross-platform watcher instability.

4. **Message Pipeline Injection**:
   - Matched rules are assembled into an `<active_path_rules>` block within a configured character budget (default 16,000 chars) and prepended as a synthetic system message in `event.messages`.

## Consequences
- Clean, non-interfering coexistence with OMP native capabilities.
- Zero-latency hot reloading of rule modifications without session restarts.
- Strict token budget and fail-open resilience.
