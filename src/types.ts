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

export type WorkspaceMode = "worktree" | "local";

export interface WorkspaceInfo {
  mode: WorkspaceMode;
  path: string;
  worktreeName?: string;
  diff?: string;
  changedFiles?: string[];
  patchPath?: string;
}

export interface WorktreeListItem {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  current: boolean;
}

// ─── Execution Results ──────────────────────────────────────────────

export type Backend = "shell" | "internal" | "codex" | "claude" | "git";

export interface RawExecutionResult {
  activationId: string;
  nodeId: string;
  backend: Backend;
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
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
    };

export interface SchedulerRunOptions {
  runId?: string;
  signal?: AbortSignal;
  onEvent?: (event: SchedulerEvent) => void;
}

export interface ExecuteRunOptions {
  signal?: AbortSignal;
  onOutput?: (event: {
    backend: Backend;
    stream: OutputStream;
    chunk: string;
  }) => void;
}

// ─── Template Context ───────────────────────────────────────────────

export interface TemplateContext {
  inputs: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
  runtime: Record<string, unknown>;
  workspace: Record<string, unknown>;
  controller: Record<string, unknown>;
}
