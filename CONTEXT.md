# CONTEXT: Path-Based Rule Dynamic Context Injection

## Domain Glossary

### Rule
A modular instructional document defining behavioral, architectural, or domain guidelines for an AI assistant.

### Rule Scope
The organizational boundary within which a Rule originates and applies (such as global workspace baselines or project-specific constraints).

### Rule Activation
The runtime transition of a Rule from available storage into the active operational context of an agent.

### Active Path
A file or directory path referenced during the current turn of execution.

### Path Pattern
A criteria or glob expression specifying the workspace paths to which a Rule is relevant.

### Path Matching
The evaluation of whether an Active Path satisfies a Rule's declared Path Pattern.

### Context Injection
The dynamic introduction of active Rule content into an agent's prompt context during task execution.

### Rule Precedence
The deterministic hierarchy used to rank, order, or resolve conflicts when multiple active Rules apply to the same execution turn.
