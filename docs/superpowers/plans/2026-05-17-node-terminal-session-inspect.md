# Node Terminal Session Inspect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Terminal 从全局 tab 改成 Inspect 内的节点级 terminal，并让同一 run 内同一节点在默认配置下复用真实 Codex/Claude CLI 会话上下文。

**Architecture:** 后端新增 node-scoped agent session 语义：`execution.reuseSession` 是节点级配置，默认 `true`。启用时，`runId + nodeId` 生成稳定 terminal session id，并为 Codex/Claude 记录 CLI 原生 conversation/session id。Codex 初次运行用普通 `codex exec`，后续同节点用 `codex exec resume <sessionId>`；Claude 初次运行传稳定 `--session-id`，后续同节点用 `--resume <sessionId>`。关闭时保留原行为：每次进入节点生成新的 terminal session id，Codex 使用 `--ephemeral` 一次性执行，Claude 不传 `--session-id` / `--resume`，也不复用任何 CLI 会话。前端移除全局 Terminal / Controller Decisions tab，Inspect 的节点输出区域挂载当前 activation 对应的 terminal transcript，并按 terminalSessionId 分桶渲染，避免并行节点混流。

**Tech Stack:** TypeScript runtime (`src/scheduler.ts`, `src/execute-runner.ts`, `src/types.ts`), Node child process / JSONL stream parser, Tauri/browser UI (`src/ui/app.js`, `src/ui/index.html`, `src/ui/style.css`), existing `npm.cmd test` and `npm.cmd run typecheck`.

---

## Current Constraints

- 当前 `execute-runner.ts` 的 Codex/Claude 路径是一次性命令：
  - Codex: `codex exec ... --json -`
  - Claude: `claude -p --output-format=stream-json ...`
- 当前 `executeNode()` 为每个 activation 生成随机 `term_<uuid>`，所以同一节点重复进入时 terminal 和 CLI 上下文都会断开；新实现必须让 `execution.reuseSession !== false` 的节点复用，让 `execution.reuseSession: false` 的节点保持这个旧行为。
- 当前 UI 有全局 `Terminal` tab，`terminalEntries` 是全局数组，依靠 node filter 过滤，天然容易在并行节点下混流。
- 当前 `Controller Decisions` 是独立 tab；用户要求去掉该 tab，controller decision 只作为 Inspect 的节点元信息。
- 不能只做 UI transcript 复用；必须复用 CLI 原生会话上下文。

## File Map

- Modify `src/types.ts`
  - 给 `ExecutionConfig` 增加 `reuseSession?: boolean`，作为节点级开关；缺省按 `true` 处理。
  - 给 `TerminalCommandResult` / `RawExecutionResult` / `SchedulerEvent` 增加 `agentSessionId?: string`。
  - 给 `ExecuteRunOptions.terminal` 增加 `nodeTerminalSessionId?: string`、`agentSession?: AgentNodeSessionRuntime` 和 `reuseSession?: boolean`。
  - 定义 `AgentNodeSessionRuntime` 接口，供 `execute-runner` 读取/更新每个节点的 CLI session id。

- Modify `src/graph-loader.ts`
  - 将 YAML 常用配置 `execution.reuse_session` 规范化成 `execution.reuseSession`。

- Modify `src/scheduler.ts`
  - 在单次 run 内维护 `AgentNodeSessionRuntime`。
  - `execution.reuseSession !== false` 时，将 execute 节点 terminal session id 改成稳定的 `term_${safeRunId}_${safeNodeId}`。
  - `execution.reuseSession: false` 时，继续每次 activation 生成随机 `term_<uuid>`，并且不传 node session runtime 给 CLI。
  - 只将启用复用的同一节点多次 activation 绑定到同一 terminal session id。
  - run finalize / cancel 时清理 node session registry。

- Modify `src/execute-runner.ts`
  - `reuseSession !== false` 时，Codex 初次运行不再使用 `--ephemeral`，从 JSONL 输出里提取 session id 并存入 registry。
  - `reuseSession !== false` 且已有 session 时，Codex 后续运行改用 `codex exec resume <sessionId> - --json --color always`。
- `reuseSession === false` 或调用方没有传入 node session runtime 时，Codex 维持旧参数，继续使用 `--ephemeral`，且不调用 `codex exec resume`。
  - `reuseSession !== false` 时，Claude 初次运行传 `--session-id <stableUuid>`；后续运行传 `--resume <sessionId>`。
- `reuseSession === false` 或调用方没有传入 node session runtime 时，Claude 维持旧参数，不传 `--session-id` / `--resume`。
  - JSONL stream formatter 保留 clean terminal 输出，同时将 backend session id 暴露到 result。

- Modify `src/server.ts` and `src/terminal-attach.ts`
  - active/persisted terminal snapshot 按稳定 terminalSessionId 汇总多个 activation 的 terminal events。
  - terminal action 必须按 `sessionId` 精确路由，不再默认 latest session。

- Modify `src/ui/index.html`
  - 移除 `Terminal` tab button/panel。
  - 移除 `Controller Decisions` tab button/panel。
  - Inspect panel 内保留节点输入和节点输出；节点输出改为 terminal host。

- Modify `src/ui/app.js`
  - 删除全局 terminal tab 渲染路径里的 UI 入口。
  - 将 terminal entries 从全局数组改成 `Map<terminalSessionId, entries[]>`。
  - Inspect 选择节点时 attach/render 当前节点的 terminal session。
  - 同一个节点多次 activation 继续显示同一个 terminal transcript。
  - controller decision 改成 Inspect 元信息折叠区。

- Modify `src/ui/style.css`
  - 删除或弱化全局 terminal toolbar 样式。
  - 添加 `.inspect-terminal-*` 样式，保证 terminal 在 Inspect 输出卡片内可滚动、可输入、不挤压输入卡片。

- Modify tests under `tests/*.test.ts`
  - 复用现有 test runner，增加 runtime/UI helper 层的 focused tests。
  - 不为 UI pixel 做重型端到端；用纯函数和 DOM hook 验证关键绑定。

---

## Task 1: Backend Node Session Model

**Files:**
- Modify: `src/types.ts`
- Modify: `src/graph-loader.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/execute-runner.ts`

- [ ] **Step 1: Add session runtime types**

In `src/types.ts`, extend `ExecutionConfig`:

```ts
export interface ExecutionConfig {
  timeoutMs?: number;
  workspaceAccess?: "read" | "write";
  model?: string;
  reasoningEffort?: string;
  reuseSession?: boolean;
}
```

`reuseSession` is an execute-node setting. Runtime behavior must treat missing values as `true`.

In `src/graph-loader.ts`, normalize YAML snake_case:

```ts
copyAlias(execution, "reuse_session", "reuseSession");
```

Add these interfaces near terminal types:

```ts
export interface AgentNodeSessionState {
  runId: string;
  nodeId: string;
  terminalSessionId: string;
  agentSessionId?: string;
}

export interface AgentNodeSessionRuntime {
  get(nodeId: string): AgentNodeSessionState | undefined;
  ensure(nodeId: string, backend: Backend): AgentNodeSessionState;
  updateAgentSessionId(nodeId: string, agentSessionId: string): void;
  clear(): void;
}
```

Extend `RawExecutionResult`:

```ts
export interface RawExecutionResult {
  activationId: string;
  nodeId: string;
  backend: Backend;
  terminalSessionId?: string;
  agentSessionId?: string;
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
```

Extend `ExecuteRunOptions.terminal`:

```ts
terminal?: {
  enabled: boolean;
  terminalSessionId?: string;
  nodeTerminalSessionId?: string;
  reuseSession?: boolean;
  agentSession?: AgentNodeSessionRuntime;
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
```

- [ ] **Step 2: Implement run-local session runtime**

In `src/scheduler.ts`, add helper functions near existing helpers:

```ts
function createAgentNodeSessionRuntime(runId: string): AgentNodeSessionRuntime {
  const states = new Map<string, AgentNodeSessionState>();

  return {
    get(nodeId) {
      return states.get(nodeId);
    },
    ensure(nodeId, backend) {
      const existing = states.get(nodeId);
      if (existing) return existing;
      const state: AgentNodeSessionState = {
        runId,
        nodeId,
        terminalSessionId: stableNodeTerminalSessionId(runId, nodeId),
      };
      states.set(nodeId, state);
      return state;
    },
    updateAgentSessionId(nodeId, agentSessionId) {
      if (!agentSessionId.trim()) return;
      const current = states.get(nodeId);
      if (!current) return;
      current.agentSessionId = agentSessionId.trim();
    },
    clear() {
      states.clear();
    },
  };
}

function stableNodeTerminalSessionId(runId: string, nodeId: string): string {
  return `term_${safeSessionPart(runId)}_${safeSessionPart(nodeId)}`;
}

function safeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
```

At the top of `Scheduler.run()`, create:

```ts
const agentSessions = createAgentNodeSessionRuntime(runId);
```

Pass `agentSessions` into every `executeNode(...)` call by adding an argument.

- [ ] **Step 3: Respect node reuseSession in executeNode**

Change `executeNode` signature:

```ts
async function executeNode(
  node: ExecuteNode,
  runId: string,
  iteration: number,
  cwd: string,
  context: TemplateContext,
  agentSessions: AgentNodeSessionRuntime,
  options: SchedulerRunOptions
): Promise<NodeActivation> {
```

Add a helper:

```ts
function shouldReuseNodeSession(node: ExecuteNode): boolean {
  return node.execution?.reuseSession !== false;
}
```

Replace random terminal id only for reuse-enabled nodes:

```ts
const reuseSession = shouldReuseNodeSession(node);
const sessionState = reuseSession ? agentSessions.ensure(node.id, node.backend) : undefined;
const terminalSessionId = sessionState?.terminalSessionId ?? `term_${randomUUID()}`;
```

Pass to `ExecuteRunner.run`:

```ts
terminal: {
  enabled: true,
  terminalSessionId,
  nodeTerminalSessionId: terminalSessionId,
  reuseSession,
  agentSession: reuseSession ? agentSessions : undefined,
  cols: 100,
  rows: 28,
  runId,
  ...
}
```

When `reuseSession` is `false`, the activation must behave like the old runtime: new terminal id for each activation, no stored agent session id, and no CLI resume.

- [ ] **Step 4: Clear registry on run finish**

Wrap `Scheduler.run` final returns so `agentSessions.clear()` is called when the run leaves the scheduler. The simplest acceptable implementation is:

```ts
try {
  // existing Scheduler.run body
} finally {
  agentSessions.clear();
}
```

If this would make the method too invasive, call `agentSessions.clear()` inside the existing `finalize(...)` path immediately before returning from `Scheduler.run`.

- [ ] **Step 5: Verify typecheck**

Run:

```powershell
npm.cmd run typecheck
```

Expected: `tsc --noEmit` exits 0.

---

## Task 2: CLI Conversation Reuse For Codex And Claude

**Files:**
- Modify: `src/execute-runner.ts`
- Test: `tests/agent-cli-session-reuse.test.ts`

- [ ] **Step 1: Extend terminal command result**

In `src/execute-runner.ts`, extend the local `TerminalCommandResult` type with:

```ts
agentSessionId?: string;
```

- [ ] **Step 2: Extract agent session id from JSONL streams**

Add these helpers near stream formatters:

```ts
function extractCodexSessionIdFromRecord(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === "object"
    ? record.payload as Record<string, unknown>
    : {};
  const candidates = [
    record.session_id,
    record.sessionId,
    record.conversation_id,
    record.conversationId,
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
  ];
  return firstString(candidates);
}

function extractClaudeSessionIdFromRecord(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidates = [
    record.session_id,
    record.sessionId,
    record.conversation_id,
    record.conversationId,
  ];
  return firstString(candidates);
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
```

Inside `spawnCodexTerminalJsonCommand`, introduce:

```ts
let agentSessionId: string | undefined;
```

When parsing each JSONL line in `handleStdoutChunk`, parse once before formatting:

```ts
const record = safeJsonParse(line);
const sessionId = extractCodexSessionIdFromRecord(record);
if (sessionId) agentSessionId = sessionId;
const formatted = formatCodexStreamLineFromParsed(record, line);
```

If changing `formatCodexStreamLine` signature is too invasive, keep existing formatting and only parse for session id:

```ts
const sessionId = extractCodexSessionIdFromRecord(safeJsonParse(line));
if (sessionId) agentSessionId = sessionId;
const formatted = formatCodexStreamLine(line);
```

Add:

```ts
function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
```

Return `agentSessionId` in the terminal result.

Repeat the same pattern in `spawnClaudeTerminalStreamCommand` using `extractClaudeSessionIdFromRecord`.

- [ ] **Step 3: Build Codex args with optional resume**

Replace the current Codex args block in `runCodex` with:

```ts
const reuseSession = options.terminal?.reuseSession !== false;
const sessionState = reuseSession
  ? options.terminal?.agentSession?.ensure(node.id, "codex")
  : undefined;
const existingAgentSessionId = sessionState?.agentSessionId;
const args = existingAgentSessionId
  ? ["exec", "resume", existingAgentSessionId]
  : ["exec"];

if (model) args.push("-m", model);
if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
if (sandbox) args.push("--sandbox", sandbox);
args.push("--skip-git-repo-check");
if (reuseSession && !existingAgentSessionId) {
  // Session persistence is required for later `codex exec resume`.
  // Do not pass --ephemeral in node session mode.
}
if (!reuseSession) {
  args.push("--ephemeral");
}
if (finalMessagePath) args.push("--output-last-message", finalMessagePath);
```

Keep terminal invocation:

```ts
const terminalArgs = options.terminal?.enabled
  ? [...args, "--json", "--color", "always"]
  : args;
```

After result:

```ts
if (reuseSession && terminalResult.agentSessionId) {
  options.terminal?.agentSession?.updateAgentSessionId(
    node.id,
    terminalResult.agentSessionId
  );
}
```

Add `agentSessionId: terminalResult.agentSessionId` to `RawExecutionResult`.

When `reuseSession` is `false`, do not read or update `agentSession`; the next activation must start a fresh Codex session.

- [ ] **Step 4: Build Claude args with optional stable session id**

Add deterministic UUID helper:

```ts
function uuidFromRunNode(runId: string | undefined, nodeId: string): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const hash = crypto.createHash("sha1").update(`${runId ?? "run"}:${nodeId}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join("-");
}
```

Before `buildClaudeArgs`, ensure session state:

```ts
const reuseSession = options.terminal?.reuseSession !== false;
const sessionState = reuseSession
  ? options.terminal?.agentSession?.ensure(node.id, "claude")
  : undefined;
const claudeSessionId =
  reuseSession
    ? sessionState?.agentSessionId ?? uuidFromRunNode(options.terminal?.runId, node.id)
    : undefined;
if (reuseSession && claudeSessionId && !sessionState?.agentSessionId) {
  options.terminal?.agentSession?.updateAgentSessionId(node.id, claudeSessionId);
}
```

Modify `buildClaudeArgs` call to accept reuse:

```ts
const args = buildClaudeArgs(
  prompt,
  options.terminal?.enabled ? "stream-json" : "text",
  claudeSessionId,
  reuseSession && Boolean(sessionState?.agentSessionId)
);
```

Update `buildClaudeArgs` signature and append:

```ts
function buildClaudeArgs(
  prompt: string,
  outputFormat: "stream-json" | "text",
  sessionId?: string,
  resume = false
): string[] {
  const args = ["--print"];
  if (resume && sessionId) {
    args.push("--resume", sessionId);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  }
  args.push("--output-format", outputFormat, prompt);
  return args;
}
```

If the current `buildClaudeArgs` already adds permission flags, preserve those existing flags and only add `--session-id` / `--resume`.

When `reuseSession` is `false`, call `buildClaudeArgs(prompt, outputFormat)` without a session id so each activation starts a fresh Claude print session.

- [ ] **Step 5: Add focused tests for arg selection**

Create `tests/agent-cli-session-reuse.test.ts` with pure helper exports or small test-only exported functions:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexExecArgsForSession,
  buildClaudeArgs,
} from "../src/execute-runner.ts";

test("codex first activation does not use ephemeral and later activation resumes session", () => {
  const first = buildCodexExecArgsForSession({ reuseSession: true, sessionId: undefined, model: "gpt-5.5", sandbox: "read-only" });
  assert.equal(first.includes("--ephemeral"), false);
  assert.equal(first[0], "exec");

  const second = buildCodexExecArgsForSession({ reuseSession: true, sessionId: "abc-session", model: "gpt-5.5", sandbox: "read-only" });
  assert.deepEqual(second.slice(0, 3), ["exec", "resume", "abc-session"]);
});

test("codex reuseSession false keeps old ephemeral behavior", () => {
  const args = buildCodexExecArgsForSession({ reuseSession: false, sessionId: "ignored-session", model: "gpt-5.5" });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ephemeral"));
  assert.equal(args.includes("resume"), false);
});

test("claude first activation uses session id and later activation resumes same session", () => {
  const first = buildClaudeArgs("hello", "stream-json", "00000000-0000-4000-8000-000000000001", false);
  assert.ok(first.includes("--session-id"));
  assert.ok(!first.includes("--resume"));

  const second = buildClaudeArgs("again", "stream-json", "00000000-0000-4000-8000-000000000001", true);
  assert.ok(second.includes("--resume"));
  assert.ok(!second.includes("--session-id"));
});

test("claude reuseSession false does not receive session flags", () => {
  const args = buildClaudeArgs("fresh", "stream-json");
  assert.equal(args.includes("--session-id"), false);
  assert.equal(args.includes("--resume"), false);
});
```

If the helper functions are not currently exported, export them explicitly with a comment:

```ts
// Exported for focused runtime argument tests.
export function buildCodexExecArgsForSession(...) { ... }
```

- [ ] **Step 6: Verify**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: all tests pass and typecheck exits 0.

---

## Task 3: Server Terminal Attachment Uses Node Sessions

**Files:**
- Modify: `src/server.ts`
- Modify: `src/terminal-attach.ts`

- [ ] **Step 1: Keep active session entries by stable terminal id**

In `src/server.ts`, update `registerActiveTerminalSession` behavior so repeated registration for the same `terminalSessionId` updates the existing entry instead of appending duplicates:

```ts
function registerActiveTerminalSession(
  runId: string,
  session: TerminalSessionHandle,
  info: TerminalSessionInfo
): void {
  const sessions = activeTerminalSessions.get(runId) ?? [];
  const existingIndex = sessions.findIndex(
    (item) => item.terminalSessionId === info.terminalSessionId
  );
  const next = { ...info, session };
  if (existingIndex >= 0) {
    sessions[existingIndex] = next;
  } else {
    sessions.push(next);
  }
  activeTerminalSessions.set(runId, sessions);
}
```

- [ ] **Step 2: Do not remove transcript identity when one activation ends**

Keep `unregisterActiveTerminalSession` from deleting the entry for a stable node terminal if the run is still active. Instead mark the handle unavailable:

```ts
function unregisterActiveTerminalSession(
  runId: string,
  session: TerminalSessionHandle,
  info: TerminalSessionInfo
): void {
  const sessions = activeTerminalSessions.get(runId);
  if (!sessions) return;
  const index = sessions.findIndex((item) => item.terminalSessionId === info.terminalSessionId);
  if (index < 0) return;
  sessions[index] = { ...sessions[index], session: undefined };
  activeTerminalSessions.set(runId, sessions);
}
```

Update the local type for active sessions to allow `session?: TerminalSessionHandle`.

- [ ] **Step 3: Require session id for terminal actions**

In `resolveTerminalSession`, if `terminalSessionId` is missing, return 400:

```ts
if (!terminalSessionId) {
  sendError(res, "Missing terminal session id", 400);
  return null;
}
```

If the entry exists but has no active process handle:

```ts
if (!sessionEntry?.session) {
  sendError(res, "Terminal session is not currently accepting input", 409);
  return null;
}
```

This prevents input meant for one node from going to another node's latest session.

- [ ] **Step 4: Ensure active attach snapshot joins all events for the stable terminal id**

`buildActiveTerminalSessionAttachSnapshot` already iterates SSE events by `terminalSessionId`; keep that behavior and verify it does not stop at the first `terminal:ended`. If multiple activations for one node emit multiple started/ended events, the transcript should include all matching `terminal:output` chunks.

Add this local assertion in the test file from Task 2 or a new server helper test if helper exports are practical:

```ts
test("active terminal snapshot accumulates repeated node session output", () => {
  const events = [
    { event: "terminal:started", data: { terminalSessionId: "term_run_node", activationId: "a1", nodeId: "n" } },
    { event: "terminal:output", data: { terminalSessionId: "term_run_node", chunk: "first\n" } },
    { event: "terminal:ended", data: { terminalSessionId: "term_run_node", exitCode: 0 } },
    { event: "terminal:started", data: { terminalSessionId: "term_run_node", activationId: "a2", nodeId: "n" } },
    { event: "terminal:output", data: { terminalSessionId: "term_run_node", chunk: "second\n" } },
  ];
  const snapshot = buildTerminalSnapshotFromEventsForTest("run", "term_run_node", events);
  assert.match(snapshot.snapshot, /first/);
  assert.match(snapshot.snapshot, /second/);
});
```

If exporting a helper would make production API noisy, skip this export and verify with an inline script in Step 5.

- [ ] **Step 5: Verify**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: all tests pass and typecheck exits 0.

---

## Task 4: Inspect Owns Terminal UI

**Files:**
- Modify: `src/ui/index.html`
- Modify: `src/ui/app.js`
- Modify: `src/ui/style.css`

- [ ] **Step 1: Remove global Terminal and Controller Decisions tabs**

In `src/ui/index.html`, remove these buttons:

```html
<button id="tab-terminal" class="dock-tab" data-panel="terminal" ...>Terminal</button>
<button id="tab-decision" class="dock-tab" data-panel="decision" ...>Controller Decisions</button>
```

Remove these panels:

```html
<div id="terminal-panel" class="dock-pane" role="tabpanel" aria-labelledby="tab-terminal">...</div>
<div id="decision-panel" class="dock-pane" role="tabpanel" aria-labelledby="tab-decision">...</div>
```

Do not remove `Inspect` or `Diff`.

- [ ] **Step 2: Replace global terminal state with session buckets**

In `src/ui/app.js`, replace:

```js
let terminalEntries = [];
let terminalNodeIds = new Set();
```

with:

```js
let terminalEntriesBySession = new Map();
let selectedInspectTerminalSessionId = null;
```

Add:

```js
function terminalSessionBucket(sessionId) {
  const key = String(sessionId || "");
  if (!key) return [];
  const existing = terminalEntriesBySession.get(key);
  if (existing) return existing;
  const created = [];
  terminalEntriesBySession.set(key, created);
  return created;
}

function appendTerminalEntryToSession(data) {
  const sessionId = data.terminalSessionId ?? data.sessionId;
  if (!sessionId) return;
  const bucket = terminalSessionBucket(sessionId);
  bucket.push({
    ...data,
    chunk: String(data.chunk ?? ""),
    timestamp: data.timestamp ?? Date.now(),
  });
  const overflow = bucket.length - TERMINAL_MAX_ENTRIES;
  if (overflow > 0) bucket.splice(0, overflow);
}

function terminalEntriesForActivation(activation) {
  const sessionId = terminalSessionIdForActivation(activation);
  return sessionId ? terminalEntriesBySession.get(sessionId) ?? [] : [];
}
```

- [ ] **Step 3: Route terminal SSE into session buckets**

Change `handleTerminalOutput(payload)` to call:

```js
appendTerminalEntryToSession(payload);
if (payload.terminalSessionId === selectedInspectTerminalSessionId) {
  renderRuntimeInspect();
}
```

Do not write all terminal output into one xterm instance.

- [ ] **Step 4: Render terminal inside Inspect output**

Replace `renderInspectOutput(activation)` behavior for execute nodes with:

```js
function renderInspectOutput(activation) {
  if (!activation) return '<div class="empty-state">节点尚未执行，暂无输出</div>';
  if (activation.controllerDecision) return renderControllerDecisionInspect(activation);
  return renderInspectTerminal(activation);
}

function renderInspectTerminal(activation) {
  const sessionId = terminalSessionIdForActivation(activation);
  selectedInspectTerminalSessionId = sessionId || null;
  if (!sessionId) {
    return '<div class="empty-state">该节点暂无 terminal session</div>';
  }
  const entries = terminalEntriesForActivation(activation);
  const lines = entries.length
    ? entries.map(renderInspectTerminalLine).join("")
    : renderTerminalTranscriptFallback(activation);
  return `<div class="inspect-terminal" data-session-id="${escapeAttr(sessionId)}">
    <div class="inspect-terminal-toolbar">
      <span>${escapeHtml(sessionId)}</span>
      <button class="toolbar-button" type="button" data-terminal-action="interrupt">Interrupt</button>
    </div>
    <div class="inspect-terminal-lines">${lines}</div>
    <textarea class="inspect-terminal-input" rows="2" placeholder="发送到当前节点 terminal"></textarea>
    <button class="toolbar-button primary" type="button" data-terminal-action="input">Send</button>
  </div>`;
}
```

For `execution.reuseSession: false`, each activation has a different `terminalSessionId`; Inspect should show the selected/latest activation's own session instead of merging by node id. For default reuse-enabled nodes, repeated activations point at the same stable `terminalSessionId`, so the same rendering path naturally appends to one transcript.

Add `bindInspectTerminalControls()` after `domRuntimeInspect.innerHTML = ...`:

```js
bindInspectTerminalControls();
```

Implement:

```js
function bindInspectTerminalControls() {
  const root = domRuntimeInspect?.querySelector(".inspect-terminal");
  if (!root) return;
  const sessionId = root.dataset.sessionId;
  root.querySelector("[data-terminal-action='input']")?.addEventListener("click", () => {
    const value = root.querySelector(".inspect-terminal-input")?.value ?? "";
    if (value) sendTerminalInputToSession(sessionId, value);
  });
  root.querySelector("[data-terminal-action='interrupt']")?.addEventListener("click", () => {
    sendTerminalActionToSession("interrupt", sessionId);
  });
}
```

Use existing `sendTerminalAction` logic as source, but require `sessionId`.

- [ ] **Step 5: Render controller decision as Inspect metadata**

Add:

```js
function renderControllerDecisionInspect(activation) {
  const decision = activation.controllerDecision;
  if (!decision) return '<div class="empty-state">暂无 controller decision</div>';
  return `<details class="inspect-controller-decision" open>
    <summary>Controller Decision</summary>
    ${renderInspectJson(decision, "暂无决策")}
  </details>`;
}
```

- [ ] **Step 6: Add CSS**

In `src/ui/style.css`, add:

```css
.inspect-terminal {
  display: grid;
  grid-template-rows: auto minmax(180px, 1fr) auto auto;
  gap: 8px;
  min-height: 260px;
}

.inspect-terminal-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}

.inspect-terminal-lines {
  min-height: 180px;
  max-height: 44vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--terminal-bg, #050b14);
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.45;
}

.inspect-terminal-input {
  resize: vertical;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  padding: 8px;
  font: inherit;
}
```

- [ ] **Step 7: Verify UI hook behavior**

Use existing UI test hooks in `window.__AGENTGRAPH_UI_TEST_HOOKS__` or add:

```js
getTerminalEntriesBySessionForTest: () => terminalEntriesBySession,
renderInspectTerminalForTest: renderInspectTerminal,
```

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: all existing tests still pass.

---

## Task 5: End-to-End Smoke And Cleanup

**Files:**
- Modify: `docs/superpowers/plans/2026-05-17-node-terminal-session-inspect.md`
- No production code unless smoke reveals a defect.

- [ ] **Step 1: Run graph loader check**

Run:

```powershell
npx.cmd tsx -e "import { GraphLoader } from './src/graph-loader.ts'; const graph = GraphLoader.load('examples/implementation-plan-task-loop.vg.yaml'); console.log(graph.id, graph.nodes.length, graph.edges.length);"
```

Expected:

```text
implementation_plan_task_loop 10 17
```

- [ ] **Step 2: Run tests**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: tests pass and typecheck exits 0.

- [ ] **Step 3: Run server smoke**

Start server:

```powershell
$env:AGENTGRAPH_PORT='3456'; npm.cmd run start -- --serve --port 3456
```

In another terminal or via browser/Tauri app:

1. Open VineGraph.
2. Open `examples/implementation-plan-task-loop.vg.yaml`.
3. Start a run.
4. Select `implement_feature`, then `review_code_quality`, then back to `implement_feature`.
5. Confirm Inspect output area shows each node's own terminal transcript.
6. Confirm Terminal and Controller Decisions tabs are gone.
7. Confirm repeated entry into the same node appends to the same terminal transcript and does not mix with parallel review nodes.

- [ ] **Step 4: Dirty diff audit**

Run:

```powershell
git status --short
git diff -- src/scheduler.ts src/execute-runner.ts src/server.ts src/terminal-attach.ts src/types.ts src/ui/index.html src/ui/app.js src/ui/style.css
```

Expected:

- Only this feature's files and already-intended plan/graph files are dirty.
- No unrelated generated run records are staged.

- [ ] **Step 5: Commit if requested**

Only commit if the user explicitly asks. Suggested message:

```powershell
git add src/scheduler.ts src/execute-runner.ts src/server.ts src/terminal-attach.ts src/types.ts src/ui/index.html src/ui/app.js src/ui/style.css tests docs/superpowers/plans/2026-05-17-node-terminal-session-inspect.md
git commit -m "feat: bind terminal sessions to graph nodes"
```

---

## Self-Review

- Spec coverage: plan covers default-on `execution.reuseSession`, opt-out old fresh-session behavior, real CLI conversation reuse, stable node terminal session id, Inspect-only terminal UI, removal of Terminal and Controller Decisions tabs, per-node non-mixed output, repeated node entry context reuse, and terminal actions scoped by session id.
- Placeholder scan: no TBD/TODO/fill-in placeholders remain.
- Type consistency: `agentSessionId`, `terminalSessionId`, `AgentNodeSessionRuntime`, `node.inputs`, and `TerminalSessionInfo` names are used consistently across tasks.
- Risk note: Codex/Claude persistent context is implemented through their native conversation/session mechanisms (`codex exec resume`, `claude --session-id/--resume`). This is the reliable CLI-supported way to preserve agent context without trying to drive full-screen TUI internals.
