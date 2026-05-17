// ─── Graph Definition ───────────────────────────────────────────────

export type GraphNode = ExecuteNode | ControllerNode;

export interface GraphDefinition {
  id: string;
  version: string;
  inputs?: Record<string, InputSpec>;
  nodes: GraphNode[];
  edges: Edge[];
  runtime?: RuntimeConfig;
}

export interface InputSpec {
  type: string;
  default?: string;
}

export interface PortSpec {
  required?: boolean;
  schema?: string;
}

export interface OutputPortSpec extends PortSpec {
  payloadSchema?: string;
  description?: string;
}

export interface ExecuteNode {
  id: string;
  type: "execute";
  backend: Backend;
  promptTemplate?: string;
  command?: CommandSpec;
  execution?: ExecutionConfig;
}

export interface ControllerNode {
  id: string;
  type: "controller";
  model: string;
  apiKey?: string;
  readiness: ReadinessSpec;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, OutputPortSpec>;
  promptTemplate: string;
  decisionSchema?: Record<string, unknown>;
  outputGuards?: Record<string, string>;
  limits?: ControllerLimits;
}

export interface ReadinessSpec {
  mode: "all_required";
}

export interface ControllerLimits {
  minConfidence?: number;
  maxEvaluations?: number;
}

export interface CommandSpec {
  program: string;
  args: string[];
  cwd?: string;
}

export interface ExecutionConfig {
  timeoutMs?: number;
  workspaceAccess?: "read" | "write";
  model?: string;
  reasoningEffort?: string;
}

export interface Edge {
  from: string;
  to: string;
}

export interface RuntimeConfig {
  maxTotalSteps?: number;
  maxFixAttempts?: number;
  workspace?: {
    mode?: WorkspaceMode;
  };
}

// ─── Workspace ─────────────────────────────────────────────────────

export type WorkspaceMode = "worktree" | "local" | "directory";

export interface WorkspaceInfo {
  mode: WorkspaceMode;
  path: string;
  worktreeName?: string;
  diff?: string;
  changedFiles?: string[];
  patchPath?: string;
  gitEnabled?: boolean;
}

export interface WorktreeListItem {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  current: boolean;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  status: "pass" | "fail";
  message: string;
}

export interface ReadinessResult {
  ok: boolean;
  graphPath: string;
  checks: ReadinessCheck[];
}

// ─── Execution Results ──────────────────────────────────────────────

export type Backend = "shell" | "internal" | "codex" | "claude" | "git";

export interface RawExecutionResult {
  activationId: string;
  nodeId: string;
  backend: Backend;
  terminalSessionId?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
  timedOut?: boolean;
  terminalTranscript?: string;
  terminalMode?: "pty" | "stream";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

// ─── Controller ────────────────────────────────────────────────────

export interface ControllerDecision {
  selected_output: string;
  reason: string;
  confidence: number;
  payload?: unknown;
}

// ─── Run History ─────────────────────────────────────────────────────

export type ActivationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunStatus = "running" | "success" | "failed" | "cancelled";

export interface PromptAssembly {
  controllerInput: Record<string, unknown>;
  promptTemplate?: string | null;
  renderedPrompt?: string;
}

export interface NodeActivation {
  activationId: string;
  nodeId: string;
  terminalSessionId?: string;
  status: ActivationStatus;
  inputs: Record<string, unknown>;
  renderedPrompt?: string;
  promptAssembly?: PromptAssembly;
  rawResult?: RawExecutionResult;
  controllerDecision?: ControllerDecision;
  iteration: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface RunRecord {
  runId: string;
  graphId: string;
  graphPath: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  totalDurationMs?: number;
  activations: NodeActivation[];
  controllerDecisions?: ControllerDecision[];
  workspace?: WorkspaceInfo;
  projectId?: string;
  projectRoot?: string;
  fixAttempts?: number;
  error?: string;
}

// ─── Scheduler Events ───────────────────────────────────────────────

export type OutputStream = "stdout" | "stderr";

export type SchedulerEvent =
  | {
      type: "node:started";
      runId: string;
      activation: NodeActivation;
    }
  | {
      type: "node:output";
      runId: string;
      activationId: string;
      nodeId: string;
      backend: Backend;
      stream: OutputStream;
      chunk: string;
      timestamp: number;
    }
  | {
      type: "node:completed";
      runId: string;
      activation: NodeActivation;
    }
  | {
      type: "terminal:started";
      runId: string;
      terminalSessionId: string;
      activationId: string;
      nodeId: string;
      backend: Backend;
      cols: number;
      rows: number;
      timestamp: number;
    }
  | {
      type: "terminal:output";
      runId: string;
      terminalSessionId: string;
      activationId: string;
      nodeId: string;
      backend: Backend;
      chunk: string;
      timestamp: number;
    }
  | {
      type: "terminal:ended";
      runId: string;
      terminalSessionId: string;
      activationId: string;
      nodeId: string;
      backend: Backend;
      exitCode: number;
      timestamp: number;
    };

export interface SchedulerRunOptions {
  runId?: string;
  signal?: AbortSignal;
  onEvent?: (event: SchedulerEvent) => void;
  registerSession?: (
    session: TerminalSessionHandle,
    info: TerminalSessionInfo
  ) => void;
  unregisterSession?: (
    session: TerminalSessionHandle,
    info: TerminalSessionInfo
  ) => void;
  projectId?: string;
  projectRoot?: string;
  workspacePath?: string;
  workspaceMode?: WorkspaceMode;
  workspaceGitEnabled?: boolean;
}

export interface TerminalSessionHandle {
  write(input: string): void;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  kill(): void;
}

export interface TerminalSessionInfo {
  terminalSessionId: string;
  runId?: string;
  activationId: string;
  nodeId: string;
}

export type TerminalSessionLifecycleStatus =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "cancelled"
  | "killed";

export interface TerminalSessionAttachSnapshot {
  runId: string;
  sessionId: string;
  terminalSessionId: string;
  activationId: string;
  nodeId: string;
  backend?: Backend;
  status: TerminalSessionLifecycleStatus;
  exitCode?: number;
  terminalMode?: "pty" | "stream";
  snapshot: string;
  truncated: boolean;
  snapshotMaxChars: number;
  liveEventsUrl: string;
}

export interface ExecuteRunOptions {
  signal?: AbortSignal;
  onOutput?: (event: {
    backend: Backend;
    stream: OutputStream;
    chunk: string;
  }) => void;
  terminal?: {
    enabled: boolean;
    terminalSessionId?: string;
    cols?: number;
    rows?: number;
    runId?: string;
    onStart?: (event: { cols: number; rows: number }) => void;
    onOutput?: (chunk: string) => void;
    onEnd?: (event: { exitCode: number }) => void;
    registerSession?: (
      session: TerminalSessionHandle,
      info: TerminalSessionInfo
    ) => void;
    unregisterSession?: (
      session: TerminalSessionHandle,
      info: TerminalSessionInfo
    ) => void;
  };
}

// ─── Template Context ───────────────────────────────────────────────

export interface TemplateContext {
  inputs: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
  runtime: Record<string, unknown>;
  workspace: Record<string, unknown>;
  controller: Record<string, unknown>;
}
