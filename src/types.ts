/**
 * Core type definitions for omp-path-rules
 */

export type RuleKind =
  | "path_rule" // Dynamically injected when path matches globs
  | "ttsr_stream" // Ignored: Handled natively by OMP TTSR stream engine
  | "always_apply" // Ignored: Handled natively by OMP system prompt
  | "rulebook"; // Generic advisory rule

export interface RuleFrontmatter {
  description?: string;
  globs?: string[] | string;
  paths?: string[] | string;
  alwaysApply?: boolean;
  priority?: number;
  // TTSR specific properties
  condition?: string | string[];
  astCondition?: string | string[];
  scope?: string | string[];
  interruptMode?: string;
  [key: string]: unknown;
}

export interface ParsedRule {
  id: string; // Identifier derived from filename (without .md/.mdc)
  filePath: string;
  scope: "project" | "global";
  kind: RuleKind;
  frontmatter: RuleFrontmatter;
  globs: string[];
  priority: number;
  content: string; // Markdown body without frontmatter
  rawSignature: string; // filename:mtimeMs:size
}

export interface MatchedRule {
  rule: ParsedRule;
  matchedGlobs: string[];
  matchedPaths: string[];
}

export interface RuleRegistryState {
  rules: Map<string, ParsedRule>; // key: filePath
  lastScanTime: number;
}

export interface ChatMessage {
  role: string;
  content: string | unknown[];
  [key: string]: unknown;
}

export interface ContextEvent {
  messages: ChatMessage[];
  [key: string]: unknown;
}

export interface ReadTelemetry {
  toolCallId: string;
  path: string;
  resolvedPath?: string;
  fileSize?: number;
  totalLines?: number;
  startedAt: number;
  durationMs?: number;
}

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ExtensionTheme {
  fg(color: string, text: string): string;
}

export interface ExtensionUIContext {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  theme?: ExtensionTheme;
}

export interface ExtensionContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI?: boolean;
  ui?: ExtensionUIContext;
  [key: string]: unknown;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  newSession(opts?: unknown): Promise<void>;
  reload(): Promise<void>;
}

export type ExtensionEvent = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  input?: Record<string, unknown>;
  details?: unknown;
  message?: unknown;
  [key: string]: unknown;
};

export interface ExtensionAPI {
  setLabel(label: string): void;
  on(
    event: "context",
    handler: (
      event: ContextEvent,
      ctx: ExtensionContext
    ) =>
      | Promise<{ messages?: ChatMessage[] } | void>
      | { messages?: ChatMessage[] }
      | void
  ): void;
  on(
    event: "session_start",
    handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void
  ): void;
  on(
    event:
      | "tool_execution_start"
      | "tool_execution_end"
      | "tool_result"
      | "turn_end",
    handler: (event: ExtensionEvent, ctx: ExtensionContext) => Promise<unknown> | unknown
  ): void;
  on(
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown
  ): void;
  registerCommand(
    name: string,
    def: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
    }
  ): void;
  logger: {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}
