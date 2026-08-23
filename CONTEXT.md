# CONTEXT: Path-Based Rule Dynamic Context Injection

## Domain Glossary

### Rule
A modular Markdown document in `.omp/rules/` defining behavioral, architectural, or domain guidelines for an AI coding assistant.

### Rule Classification
The three mutually exclusive runtime behaviors assigned to a Rule based on its declared metadata:
1. **Stream-Intercepted Rule (TTSR Rule)**: A rule declaring dynamic streaming conditions or tool stream scopes (`condition`, `astCondition`, `scope: tool:edit(...)`), evaluated in real-time by the OMP native streaming engine during tool execution.
2. **Global Static Rule (Always-Apply Rule)**: A rule declaring `alwaysApply: true` without streaming conditions, loaded at session initialization into the base system prompt.
3. **Path-Triggered Rule (Context-Injected Rule)**: A rule declaring file glob patterns without streaming conditions and without unconditional application, dynamically evaluated and injected into immediate context when relevant workspace files are touched.

### Active Path
A repository-relative or absolute file path referenced in recent operational context (such as arguments to file inspection and editing tools or explicit prompt mentions).

### Path Matching
The process of testing an Active Path against a Rule's defined glob patterns to determine if the rule is relevant to current execution.

### Pre-Turn Context Injection
The dynamic synthesis and placement of active, matching rule bodies into the LLM message pipeline immediately before model inference, with automatic eviction when focus moves to unrelated paths.

### Cache Invalidation Signature
The compound signature (directory snapshot, file modification timestamps, and file byte sizes) used to detect filesystem changes, additions, and deletions without background daemon overhead.
