# Minimal Start Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成一版最小可用的 VineGraph 自迭代能力，让当前项目可以用 `examples/project-task-loop.yaml` 在隔离 worktree 中启动长任务、并行 review、实时观察输出、导出完整 patch。

**Architecture:** 运行时优先保证可控性：worktree 必须可靠捕获 tracked 与 untracked diff，调度器只并行 read-only frontier，write 节点保持串行。UI 不做完整 Graph Editor，只升级为真实运行工作台：从 graph YAML 读取节点详情，显示 active node、prompt template、terminal 输出和 worktree 状态。

**Tech Stack:** TypeScript + Node.js ESM + `tsx --test`，YAML graph，Mustache prompt 渲染，Node HTTP server + 原生 HTML/CSS/JS UI，Tauri 2 桌面壳。

---

## Scope

本计划只做“开始用它迭代长任务”的最小闭环：

- `project-task-loop` 可以默认跑在 `worktree`。
- read-only review agent 可以在同一轮真正并行。
- execute 节点 history 可以审计“controller 输出 + 当前 prompt template -> final prompt”。
- worktree patch 不漏新增文件。
- UI 可以看真实 graph 节点 prompt、active agent terminal、active node、当前/全部 worktree，并能创建一个手动 worktree。
- 提供 `--doctor` 预检，避免缺 Codex/Controller key/worktree 能力时直接启动长任务。

明确不做：

- 不做拖拽式 Graph Editor。
- 不做 SubGraph。
- 不做多人协作、权限审批流或云端运行。
- 不让多个 write agent 同时写同一个 workspace。

## File Structure

- Modify `src/types.ts`  
  增加 prompt assembly、worktree 列表、readiness result 类型；保持运行记录 JSON 可直接序列化。

- Modify `src/workspace-manager.ts`  
  负责 worktree 创建、tracked/untracked diff 捕获、patch 导出、worktree list/create。

- Modify `src/scheduler.ts`  
  负责 read-only frontier 并行、write 节点串行、activation prompt provenance 记录。

- Modify `src/server.ts`  
  增加 graph detail、worktree list/create、readiness API；保留现有 runs/SSE/patch API。

- Create `src/readiness.ts`  
  封装 `--doctor` 和 UI readiness panel 共用的检查逻辑。

- Modify `src/index.ts`  
  增加 `--doctor <graph-yaml-path>` CLI。

- Modify `src/ui/index.html`  
  增加 Terminal tab 和 Worktrees 面板。

- Modify `src/ui/app.js`  
  从真实 graph definition 构建 inspector 数据；维护 active node、terminal buffer、worktree 状态。

- Modify `src/ui/style.css`  
  增加 active node、terminal、worktree panel 的桌面工具样式。

- Modify `examples/project-task-loop.yaml`  
  默认使用 `runtime.workspace.mode: worktree`，保留现有 read-only review 节点配置。

- Create `.env.example`  
  给长任务最小环境变量入口。

- Create `docs/self-iteration.md`  
  中文说明如何用这一套流程启动当前项目自迭代。

- Modify tests:
  - `tests/runtime.test.ts`
  - `tests/run-control.test.ts`
  - `tests/project-task-loop-graph.test.ts`
  - `tests/server-graphs.test.ts`
  - `tests/ui-run-control.test.ts`
  - `tests/ui-graph-rendering.test.ts`
  - Create `tests/readiness.test.ts`

---

### Task 1: Make Worktree Patch Capture Complete

**Files:**
- Modify: `src/workspace-manager.ts`
- Modify: `tests/runtime.test.ts`

- [ ] **Step 1: Write the failing worktree untracked-file test**

In `tests/runtime.test.ts`, update imports:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
```

Add this test near the existing workspace tests:

```ts
test("worktree workspace exports patches that include tracked and untracked files", async () => {
  const repo = tempDir("agentgraph-worktree-untracked");
  const originalCwd = process.cwd();

  try {
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    process.chdir(repo);

    const graph: GraphDefinition = {
      id: "worktree_untracked_patch_test",
      version: "0.1.0",
      runtime: {
        maxTotalSteps: 5,
        workspace: { mode: "worktree" },
      },
      nodes: [
        {
          id: "write_files",
          type: "execute",
          backend: "shell",
          command: {
            program: "cmd",
            args: [
              "/c",
              "mkdir src && echo export const value = 1;>src\\new-feature.ts && echo changed>>README.md",
            ],
          },
        },
        {
          id: "end_success",
          type: "execute",
          backend: "internal",
          command: { program: "internal", args: ["finish_success"] },
        },
      ],
      edges: [
        { from: "graph.start", to: "write_files.inputs.trigger" },
        { from: "write_files.outputs.done", to: "end_success.inputs.trigger" },
      ],
    };

    const result = await Scheduler.run(graph, resolve("examples/worktree-untracked.yaml"));
    const changedFiles = new Set(result.workspace?.changedFiles ?? []);

    assert.equal(result.status, "success");
    assert.equal(existsSync(join(repo, "src", "new-feature.ts")), false);
    assert.equal(changedFiles.has("README.md"), true);
    assert.equal(changedFiles.has("src/new-feature.ts"), true);
    assert.ok(result.workspace?.patchPath);
    assert.equal(existsSync(result.workspace!.patchPath!), true);

    const patch = readFileSync(result.workspace!.patchPath!, "utf-8");
    assert.match(patch, /diff --git a\/README.md b\/README.md/);
    assert.match(patch, /diff --git a\/src\/new-feature.ts b\/src\/new-feature.ts/);
    assert.match(patch, /export const value = 1;/);
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npm.cmd test -- tests/runtime.test.ts
```

Expected before implementation: FAIL because `src/new-feature.ts` is not present in `changedFiles` and not present in the exported patch.

- [ ] **Step 3: Add tracked + untracked diff capture**

In `src/workspace-manager.ts`, add helpers below `runGit`:

```ts
function splitGitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.replace(/\\/g, "/")))].sort();
}

async function listChangedFiles(cwd: string, compareRef?: string): Promise<string[]> {
  const diffArgs = compareRef
    ? ["diff", "--name-only", compareRef]
    : ["diff", "--name-only"];
  const tracked = await runGit(diffArgs, cwd);
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], cwd);
  return uniqueFiles([...splitGitLines(tracked.stdout), ...splitGitLines(untracked.stdout)]);
}

async function markUntrackedIntentToAdd(cwd: string): Promise<void> {
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], cwd);
  const files = splitGitLines(untracked.stdout);
  if (files.length === 0) return;
  await runGit(["add", "-N", "--", ...files], cwd);
}
```

Then replace `captureDiff()` with:

```ts
static async captureDiff(ws: WorkspaceInfo): Promise<void> {
  if (ws.mode === "local") {
    await markUntrackedIntentToAdd(ws.path);
    const localDiff = await runGit(["diff"], ws.path);
    ws.diff = localDiff.stdout;
    ws.changedFiles = await listChangedFiles(ws.path);
    return;
  }

  await markUntrackedIntentToAdd(ws.path);
  const worktreeDiff = await runGit(["diff", "HEAD"], ws.path);
  ws.diff = worktreeDiff.stdout;
  ws.changedFiles = await listChangedFiles(ws.path, "HEAD");
}
```

- [ ] **Step 4: Verify the test passes**

Run:

```powershell
npm.cmd test -- tests/runtime.test.ts
```

Expected: PASS, including the new worktree untracked-file test.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: all tests pass and `tsc --noEmit` exits with code 0.

- [ ] **Step 6: Commit**

```powershell
git add src/workspace-manager.ts tests/runtime.test.ts
git commit -m "fix: include untracked files in worktree patches"
```

---

### Task 2: Record Execute Prompt Assembly as Two Explicit Inputs

**Files:**
- Modify: `src/types.ts`
- Modify: `src/scheduler.ts`
- Modify: `tests/run-control.test.ts`
- Modify: `tests/runtime.test.ts`

- [ ] **Step 1: Add failing tests for prompt provenance**

In `tests/run-control.test.ts`, extend the existing `scheduler stores rendered prompts on execute and controller activations` test with:

```ts
assert.deepEqual(implementActivation?.inputs.controllerInput, {});
assert.equal(
  implementActivation?.inputs.promptTemplate,
  "Implement {{inputs.task}} in {{workspace.path}}"
);
assert.deepEqual(implementActivation?.promptAssembly?.controllerInput, {});
assert.equal(
  implementActivation?.promptAssembly?.promptTemplate,
  "Implement {{inputs.task}} in {{workspace.path}}"
);
assert.match(
  implementActivation?.promptAssembly?.renderedPrompt ?? "",
  /Implement ship prompt visibility/
);
```

In `tests/runtime.test.ts`, extend `selected controller payload is available to the next execute node` after the existing stdout assertion:

```ts
assert.deepEqual(echoActivation?.inputs.controllerInput, {
  nodeId: "route",
  selected_output: "inspect",
  reason: "Payload should flow downstream",
  confidence: 0.95,
  payload: { focus: "needle" },
});
assert.deepEqual(echoActivation?.promptAssembly?.controllerInput, {
  nodeId: "route",
  selected_output: "inspect",
  reason: "Payload should flow downstream",
  confidence: 0.95,
  payload: { focus: "needle" },
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/run-control.test.ts tests/runtime.test.ts
```

Expected before implementation: FAIL because `inputs.controllerInput`, `inputs.promptTemplate`, and `promptAssembly` do not exist.

- [ ] **Step 3: Add prompt assembly types**

In `src/types.ts`, add:

```ts
export interface PromptAssembly {
  controllerInput: Record<string, unknown>;
  promptTemplate?: string;
  renderedPrompt?: string;
}
```

Then extend `NodeActivation`:

```ts
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
```

- [ ] **Step 4: Snapshot controller input and template in execute activations**

In `src/scheduler.ts`, add this helper near `publishSchedulerEvent`:

```ts
function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
}
```

In `executeNode()`, replace the activation construction with:

```ts
const controllerInput = cloneJsonObject(context.controller);
const promptTemplate = node.promptTemplate;

const activation: NodeActivation = {
  activationId,
  nodeId: node.id,
  status: "running",
  inputs: {
    trigger: true,
    controllerInput,
    promptTemplate: promptTemplate ?? null,
  },
  ...(renderedPrompt !== undefined ? { renderedPrompt } : {}),
  promptAssembly: {
    controllerInput,
    ...(promptTemplate !== undefined ? { promptTemplate } : {}),
    ...(renderedPrompt !== undefined ? { renderedPrompt } : {}),
  },
  iteration,
  startedAt,
};
```

- [ ] **Step 5: Verify prompt provenance**

Run:

```powershell
npm.cmd test -- tests/run-control.test.ts tests/runtime.test.ts
npm.cmd run typecheck
```

Expected: targeted tests pass and typecheck passes.

- [ ] **Step 6: Commit**

```powershell
git add src/types.ts src/scheduler.ts tests/run-control.test.ts tests/runtime.test.ts
git commit -m "feat: record execute prompt assembly"
```

---

### Task 3: Run Read-Only Frontier Nodes in Parallel

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `tests/run-control.test.ts`

- [ ] **Step 1: Write the failing parallel frontier test**

In `tests/run-control.test.ts`, add:

```ts
test("scheduler runs read-only frontier execute nodes concurrently", async () => {
  const graph: GraphDefinition = {
    id: "read_only_parallel_frontier",
    version: "0.1.0",
    runtime: { maxTotalSteps: 3, workspace: { mode: "local" } },
    nodes: [
      {
        id: "review_a",
        type: "execute",
        backend: "shell",
        command: {
          program: process.execPath,
          args: ["-e", "setTimeout(() => console.log('review-a'), 1000)"],
        },
        execution: { workspaceAccess: "read", timeoutMs: 10000 },
      },
      {
        id: "review_b",
        type: "execute",
        backend: "shell",
        command: {
          program: process.execPath,
          args: ["-e", "setTimeout(() => console.log('review-b'), 1000)"],
        },
        execution: { workspaceAccess: "read", timeoutMs: 10000 },
      },
    ],
    edges: [
      { from: "graph.start", to: "review_a.inputs.trigger" },
      { from: "graph.start", to: "review_b.inputs.trigger" },
    ],
  };

  const startedAt = Date.now();
  const result = await Scheduler.run(graph, join(tempDir("parallel-frontier"), "parallel.yaml"));
  const totalMs = Date.now() - startedAt;
  const reviewA = result.activations.find((item) => item.nodeId === "review_a");
  const reviewB = result.activations.find((item) => item.nodeId === "review_b");

  assert.equal(result.status, "success");
  assert.equal(result.activations.length, 2);
  assert.match(reviewA?.rawResult?.stdout ?? "", /review-a/);
  assert.match(reviewB?.rawResult?.stdout ?? "", /review-b/);
  assert.ok(reviewA?.startedAt && reviewB?.startedAt);
  assert.ok(
    Math.abs(reviewA!.startedAt - reviewB!.startedAt) < 300,
    `expected starts to be close, got ${reviewA!.startedAt} and ${reviewB!.startedAt}`
  );
  assert.ok(totalMs < 1800, `expected parallel runtime under 1800ms, got ${totalMs}ms`);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npm.cmd test -- tests/run-control.test.ts
```

Expected before implementation: FAIL because total runtime is about 2000ms and start times are sequential.

- [ ] **Step 3: Add a read-only concurrency classifier**

In `src/scheduler.ts`, add:

```ts
function canRunInParallel(node: GraphNode): boolean {
  return node.type === "execute" && node.execution?.workspaceAccess === "read";
}
```

- [ ] **Step 4: Refactor one frontier into prepared node runs**

In `src/scheduler.ts`, introduce:

```ts
interface PreparedNodeRun {
  nodeId: string;
  node: GraphNode;
  iteration: number;
  context: TemplateContext;
}
```

Inside the main loop, before running nodes, replace the direct `for (const nodeId of currentNodeIds)` preparation with an array:

```ts
const preparedRuns: PreparedNodeRun[] = [];

for (const nodeId of currentNodeIds) {
  if (options.signal?.aborted) {
    runRecord.status = "cancelled";
    runRecord.error = "Run cancelled by user";
    return await finalize(runRecord, ws, repoRoot);
  }

  const iteration = (nodeIterations.get(nodeId) ?? 0) + 1;
  nodeIterations.set(nodeId, iteration);

  const node = nodeMap.get(nodeId);
  if (!node) {
    throw new Error(`Node "${nodeId}" not found in graph definition`);
  }

  const runtimeFacts = buildRuntimeFacts(runRecord, maxFixAttempts, maxSteps);
  const context = buildContext({
    graphInputs: graph.inputs
      ? Object.fromEntries(
          Object.entries(graph.inputs).map(([k, v]) => [k, v.default ?? ""])
        )
      : {},
    nodeOutputs,
    runtimeFacts,
    workspacePath: ws.path,
    controllerPayloads: controllerContext,
  });

  preparedRuns.push({ nodeId, node, iteration, context });
}
```

- [ ] **Step 5: Execute read-only runs concurrently and all other runs sequentially**

Still inside the main loop, after `preparedRuns` is built:

```ts
const parallelRuns = preparedRuns.filter((item) => canRunInParallel(item.node));
const sequentialRuns = preparedRuns.filter((item) => !canRunInParallel(item.node));

const completedRuns: Array<PreparedNodeRun & { activation: NodeActivation }> = [];

if (parallelRuns.length > 0) {
  const activations = await Promise.all(
    parallelRuns.map((item) => {
      if (item.node.type !== "execute") {
        throw new Error(`Parallel run "${item.nodeId}" is not an execute node`);
      }
      return executeNode(item.node, runId, item.iteration, ws.path, item.context, options);
    })
  );
  for (let i = 0; i < parallelRuns.length; i++) {
    completedRuns.push({ ...parallelRuns[i], activation: activations[i] });
  }
}

for (const item of sequentialRuns) {
  if (options.signal?.aborted) {
    runRecord.status = "cancelled";
    runRecord.error = "Run cancelled by user";
    return await finalize(runRecord, ws, repoRoot);
  }

  if (item.node.type === "execute") {
    const activation = await executeNode(
      item.node,
      runId,
      item.iteration,
      ws.path,
      item.context,
      options
    );
    completedRuns.push({ ...item, activation });
    continue;
  }

  const activation = await executeController(
    item.node,
    runId,
    item.iteration,
    item.context,
    options
  );
  completedRuns.push({ ...item, activation });
}
```

Then process `completedRuns` in `currentNodeIds` order. Move the existing post-execute and post-controller routing logic into helper functions if the file becomes hard to read:

```ts
completedRuns.sort(
  (a, b) => currentNodeIds.indexOf(a.nodeId) - currentNodeIds.indexOf(b.nodeId)
);

for (const completed of completedRuns) {
  const { node, nodeId, activation } = completed;
  runRecord.activations.push(activation);
  // Reuse the existing execute/controller result handling here without changing routing semantics.
}
```

The important invariant: only execution overlaps; mutation of `runRecord`, `nodeOutputs`, `controllerContext`, `inputBuffers`, and `nextNodeIds` remains deterministic and sequential after all parallel reads finish.

- [ ] **Step 6: Verify parallel behavior**

Run:

```powershell
npm.cmd test -- tests/run-control.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: the new parallel test passes; all existing routing/cancellation/prompt tests still pass.

- [ ] **Step 7: Commit**

```powershell
git add src/scheduler.ts tests/run-control.test.ts
git commit -m "feat: run read-only frontier nodes in parallel"
```

---

### Task 4: Make Project Task Loop the First Real Self-Iteration Graph

**Files:**
- Modify: `examples/project-task-loop.yaml`
- Modify: `tests/project-task-loop-graph.test.ts`
- Create: `.env.example`
- Create: `docs/self-iteration.md`

- [ ] **Step 1: Add graph expectations to the test**

In `tests/project-task-loop-graph.test.ts`, after loading `graph`, add:

```ts
assert.equal(graph.runtime?.workspace?.mode, "worktree");
```

Also assert review nodes are read-only:

```ts
const qualityReview = nodes.get("review_code_quality") as ExecuteNode | undefined;
const functionalityReview = nodes.get("review_functionality") as ExecuteNode | undefined;
assert.equal(qualityReview?.execution?.workspaceAccess, "read");
assert.equal(functionalityReview?.execution?.workspaceAccess, "read");
```

- [ ] **Step 2: Run the failing graph test**

Run:

```powershell
npm.cmd test -- tests/project-task-loop-graph.test.ts
```

Expected before implementation: FAIL because `project-task-loop.yaml` still uses `workspace.mode: local`.

- [ ] **Step 3: Switch the graph to worktree**

In `examples/project-task-loop.yaml`, change:

```yaml
runtime:
  max_fix_attempts: 30
  max_total_steps: 120
  workspace:
    mode: worktree
```

Keep existing `workspace_access: read` on `review_code_quality`, `review_functionality`, and `assess_remaining_tasks`. Keep write-capable nodes as `workspace_access: write`.

- [ ] **Step 4: Add environment example**

Create `.env.example`:

```env
# Controller model API key. The runtime currently calls the DeepSeek-compatible chat API.
DEEPSEEK_API_KEY=

# Optional Codex defaults for execute backend = codex.
AGENTGRAPH_CODEX_MODEL=gpt-5.5
AGENTGRAPH_CODEX_REASONING_EFFORT=high

# Optional explicit Codex CLI path on Windows.
AGENTGRAPH_CODEX_PATH=
```

- [ ] **Step 5: Add Chinese self-iteration guide**

Create `docs/self-iteration.md`:

```markdown
# VineGraph 自迭代最小使用指南

这一版的目标是让当前仓库可以用 `examples/project-task-loop.yaml` 开始跑长任务迭代。

## 前置条件

1. 当前目录是 Git 仓库，且 `git status --short` 没有未处理的关键改动。
2. 已安装依赖：

```powershell
npm.cmd install
```

3. Codex CLI 可用：

```powershell
codex.cmd --version
```

4. 已配置 Controller API key：

```powershell
$env:DEEPSEEK_API_KEY="你的 key"
```

## 启动前预检

```powershell
npm.cmd start -- --doctor examples/project-task-loop.yaml
```

预检全部通过后再启动 UI：

```powershell
npm.cmd start -- --serve --port 3456
```

打开：

```text
http://localhost:3456
```

选择 `project-task-loop.yaml`，填写任务范围和验证命令，然后运行。

## 验收标准

- 运行发生在 `.agentgraph/worktrees/<runId>`。
- Review Code Quality 和 Review Functionality 可以并行运行。
- Terminal 能显示当前 active agent 的实时输出。
- Inspector 能看到当前节点的原始 prompt template 和本次 rendered prompt。
- 运行结束后 diff/patch 包含 tracked 和新建文件。

## 当前边界

- 不支持多个 write agent 同时写同一个 worktree。
- Controller 需要 API key；没有 key 时应先通过 `--doctor` 暴露问题。
- UI 不是 Graph Editor，只用于选择、运行、观察和管理 worktree。
```

- [ ] **Step 6: Verify graph and docs**

Run:

```powershell
npm.cmd test -- tests/project-task-loop-graph.test.ts
npm.cmd run typecheck
```

Expected: graph test and typecheck pass.

- [ ] **Step 7: Commit**

```powershell
git add examples/project-task-loop.yaml tests/project-task-loop-graph.test.ts .env.example docs/self-iteration.md
git commit -m "feat: prepare project task loop for self iteration"
```

---

### Task 5: Serve Real Graph Details and Show Prompt Templates in Inspector

**Files:**
- Modify: `src/server.ts`
- Modify: `src/ui/app.js`
- Modify: `tests/server-graphs.test.ts`
- Modify: `tests/ui-run-control.test.ts`

- [ ] **Step 1: Add graph detail server test**

In `tests/server-graphs.test.ts`, update imports:

```ts
import { isAbsolute, resolve } from "node:path";
import { loadGraphDetails } from "../src/server.js";
```

Add:

```ts
test("graph details expose real nodes and prompt templates for the UI", () => {
  const graph = loadGraphDetails(resolve("examples/project-task-loop.yaml"));
  const implement = graph.nodes.find((node) => node.id === "implement_feature");

  assert.equal(graph.id, "project_remaining_tasks_loop");
  assert.equal(implement?.type, "execute");
  if (implement?.type !== "execute") throw new Error("missing implement_feature");
  assert.match(implement.promptTemplate ?? "", /You are implementing the next unfinished VineGraph task/);
});
```

- [ ] **Step 2: Add UI source tests**

In `tests/ui-run-control.test.ts`, add:

```ts
test("UI loads graph details and renders real prompt templates", () => {
  assert.match(uiSource, /loadGraphDefinition/);
  assert.match(uiSource, /currentGraphDefinition/);
  assert.match(uiSource, /nodeInfo\.promptTemplate/);
  assert.doesNotMatch(uiSource, /你是一个代码质量控制器\.\.\./);
});
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
npm.cmd test -- tests/server-graphs.test.ts tests/ui-run-control.test.ts
```

Expected before implementation: FAIL because `loadGraphDetails`, `loadGraphDefinition`, and real prompt rendering are missing.

- [ ] **Step 4: Add graph detail API**

In `src/server.ts`, add route before static serving:

```ts
if (url.pathname === "/api/graphs/detail" && method === "GET") {
  const graphPath = url.searchParams.get("path");
  if (!graphPath) return sendError(res, "Missing graph path");
  try {
    return sendJSON(res, loadGraphDetails(graphPath));
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 400);
  }
}
```

Add exported helper near `listGraphPaths()`:

```ts
export function loadGraphDetails(graphPath: string): ReturnType<typeof GraphLoader.load> {
  const absPath = resolve(graphPath);
  if (!absPath.startsWith(PROJECT_ROOT)) {
    throw new Error(`Graph path must be inside project root: ${graphPath}`);
  }
  return GraphLoader.load(absPath);
}
```

- [ ] **Step 5: Load graph details in UI state**

In `src/ui/app.js`, add state:

```js
let currentGraphDefinition = null;
```

Add:

```js
async function loadGraphDefinition(graphPath) {
  if (!graphPath) {
    currentGraphDefinition = null;
    return;
  }

  const resp = await fetch(apiUrl(`/api/graphs/detail?path=${encodeURIComponent(graphPath)}`), {
    cache: "no-store",
  });
  if (!resp.ok) {
    currentGraphDefinition = null;
    return;
  }
  currentGraphDefinition = await resp.json();
}
```

In the graph select change handler, call:

```js
await loadGraphDefinition(domGraph.value);
renderGraphCanvas();
renderInspectorNode(findGraphNode(selectedGraphNodeId));
```

- [ ] **Step 6: Attach real node config to canvas nodes**

In `src/ui/app.js`, add:

```js
function graphDefinitionNode(id) {
  return currentGraphDefinition?.nodes?.find((item) => item.id === id) ?? null;
}

function enrichCanvasNode(item) {
  const realNode = graphDefinitionNode(item.id);
  if (!realNode) return item;
  return {
    ...item,
    backend: realNode.backend,
    model: realNode.model,
    promptTemplate: realNode.promptTemplate,
    command: realNode.command,
    execution: realNode.execution,
    outputs: item.outputs,
    realNode,
  };
}
```

When rendering nodes:

```js
const nodes = preset.nodes.map((item) => renderGraphNode(enrichCanvasNode(item))).join("");
```

In `findGraphNode()`:

```js
function findGraphNode(id) {
  const presetNode = currentPreset().nodes.find((item) => item.id === id);
  return presetNode ? enrichCanvasNode(presetNode) : null;
}
```

- [ ] **Step 7: Render real prompt templates**

Replace `promptPreview(nodeInfo)` usage in `renderInspectorNode()` with:

```js
const promptTemplate = nodeInfo.promptTemplate ?? promptPreview(nodeInfo);
```

Then render:

```js
<div class="property-code">${escapeHtml(promptTemplate)}</div>
```

Delete the hardcoded Chinese controller sample from `promptPreview()`. Keep this fallback:

```js
function promptPreview(nodeInfo) {
  if (nodeInfo.kind === "start") return "graph.start";
  if (nodeInfo.command) return JSON.stringify(nodeInfo.command, null, 2);
  return `执行 ${nodeInfo.title}\n\n工作区：{{workspace.path}}`;
}
```

- [ ] **Step 8: Verify**

Run:

```powershell
npm.cmd test -- tests/server-graphs.test.ts tests/ui-run-control.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```powershell
git add src/server.ts src/ui/app.js tests/server-graphs.test.ts tests/ui-run-control.test.ts
git commit -m "feat: expose graph details to the UI"
```

---

### Task 6: Add a Real Active Agent Terminal Dock

**Files:**
- Modify: `src/ui/index.html`
- Modify: `src/ui/app.js`
- Modify: `src/ui/style.css`
- Modify: `tests/ui-run-control.test.ts`

- [ ] **Step 1: Add failing UI source tests**

In `tests/ui-run-control.test.ts`, add:

```ts
test("UI provides an active agent terminal backed by streamed output", () => {
  assert.match(htmlSource, /data-panel="terminal"/);
  assert.match(htmlSource, /id="terminal-content"/);
  assert.match(uiSource, /activeTerminalActivationId/);
  assert.match(uiSource, /terminalBuffers/);
  assert.match(uiSource, /renderTerminal/);
  assert.match(uiSource, /appendActivationOutput/);
});
```

- [ ] **Step 2: Run failing UI tests**

Run:

```powershell
npm.cmd test -- tests/ui-run-control.test.ts
```

Expected before implementation: FAIL because terminal DOM and JS state are missing.

- [ ] **Step 3: Add Terminal tab and pane**

In `src/ui/index.html`, update dock tabs:

```html
<button class="dock-tab active" data-panel="timeline" type="button">日志</button>
<button class="dock-tab" data-panel="terminal" type="button">Terminal</button>
<button class="dock-tab" data-panel="decision" type="button">Controller Decisions</button>
<button class="dock-tab" data-panel="diff" type="button">Diff</button>
```

Add pane after `timeline-panel`:

```html
<div id="terminal-panel" class="dock-pane">
  <div id="terminal-content" class="terminal-content">
    <div class="empty-state">Agent 输出会在运行时显示在这里</div>
  </div>
</div>
```

- [ ] **Step 4: Add terminal state**

In `src/ui/app.js`, add DOM ref:

```js
const domTerminal = $("#terminal-content");
```

Add state:

```js
let terminalBuffers = new Map();
let activeTerminalActivationId = null;
```

Reset it in `runGraph()`:

```js
terminalBuffers = new Map();
activeTerminalActivationId = null;
domTerminal.innerHTML = '<div class="empty-state">等待 agent 输出...</div>';
```

- [ ] **Step 5: Update terminal from SSE output**

In `appendActivationOutput(data)`, after updating `streamBuffers`, add:

```js
const terminal = terminalBuffers.get(data.activationId) ?? {
  nodeId: data.nodeId,
  backend: data.backend,
  stdout: "",
  stderr: "",
  startedAt: data.timestamp ?? Date.now(),
};

terminal[data.stream] = `${terminal[data.stream] || ""}${data.chunk || ""}`;
terminalBuffers.set(data.activationId, terminal);

if (data.backend === "codex" || data.backend === "claude") {
  activeTerminalActivationId = data.activationId;
}

renderTerminal();
```

Add:

```js
function renderTerminal() {
  if (!domTerminal) return;
  if (!activeTerminalActivationId) {
    domTerminal.innerHTML = '<div class="empty-state">当前没有 active agent 输出</div>';
    return;
  }

  const current = terminalBuffers.get(activeTerminalActivationId);
  if (!current) {
    domTerminal.innerHTML = '<div class="empty-state">当前 agent 尚未产生输出</div>';
    return;
  }

  const stdout = current.stdout ? `<pre class="terminal-stream stdout">${escapeHtml(current.stdout)}</pre>` : "";
  const stderr = current.stderr ? `<pre class="terminal-stream stderr">${escapeHtml(current.stderr)}</pre>` : "";
  domTerminal.innerHTML = `<div class="terminal-header">
      <span class="node-badge badge-${badgeClass(current.backend)}">${escapeHtml(current.backend)}</span>
      <strong>${escapeHtml(current.nodeId)}</strong>
    </div>
    ${stdout}
    ${stderr || ""}`;
}
```

- [ ] **Step 6: Style terminal like a tool window**

In `src/ui/style.css`, add:

```css
.terminal-content {
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: #070a0f;
  border: 1px solid rgba(137, 164, 255, 0.16);
  font-family: "Cascadia Mono", "Consolas", monospace;
  color: #d7e1ff;
}

.terminal-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: rgba(10, 14, 23, 0.96);
  border-bottom: 1px solid rgba(137, 164, 255, 0.14);
}

.terminal-stream {
  margin: 0;
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.55;
}

.terminal-stream.stderr {
  color: #ffb6bd;
  border-top: 1px solid rgba(242, 93, 104, 0.2);
}
```

- [ ] **Step 7: Verify**

Run:

```powershell
npm.cmd test -- tests/ui-run-control.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/ui/index.html src/ui/app.js src/ui/style.css tests/ui-run-control.test.ts
git commit -m "feat: add active agent terminal"
```

---

### Task 7: Highlight Active Nodes and Manage Worktrees in UI

**Files:**
- Modify: `src/types.ts`
- Modify: `src/workspace-manager.ts`
- Modify: `src/server.ts`
- Modify: `src/ui/index.html`
- Modify: `src/ui/app.js`
- Modify: `src/ui/style.css`
- Modify: `tests/runtime.test.ts`
- Modify: `tests/ui-graph-rendering.test.ts`
- Modify: `tests/ui-run-control.test.ts`

- [ ] **Step 1: Add worktree type**

In `src/types.ts`, add:

```ts
export interface WorktreeListItem {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  current: boolean;
}
```

- [ ] **Step 2: Add failing worktree list/create test**

In `tests/runtime.test.ts`, add:

```ts
test("workspace manager lists and creates manual worktrees", async () => {
  const repo = tempDir("agentgraph-manual-worktree");

  try {
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    const created = await WorkspaceManager.createManualWorktree(repo, "review-sandbox", "HEAD");
    const items = await WorkspaceManager.listWorktrees(repo);

    assert.match(created.path.replace(/\\/g, "/"), /\.agentgraph\/worktrees\/manual-review-sandbox$/);
    assert.equal(items.some((item) => item.path === created.path), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
```

Also import `WorkspaceManager`:

```ts
import { WorkspaceManager } from "../src/workspace-manager.js";
```

- [ ] **Step 3: Implement list/create worktree helpers**

In `src/workspace-manager.ts`, add:

```ts
function slugifyWorktreeName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Worktree name must contain letters or numbers");
  return slug;
}
```

Add static methods:

```ts
static async listWorktrees(repoRoot: string): Promise<WorktreeListItem[]> {
  const result = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to list worktrees");
  }

  const blocks = result.stdout.split(/\n(?=worktree )/).filter(Boolean);
  return blocks.map((block, index) => {
    const lines = splitGitLines(block);
    const values = new Map<string, string>();
    let detached = false;

    for (const line of lines) {
      if (line === "detached") {
        detached = true;
        continue;
      }
      const space = line.indexOf(" ");
      if (space > 0) values.set(line.slice(0, space), line.slice(space + 1));
    }

    return {
      path: values.get("worktree") ?? "",
      head: values.get("HEAD"),
      branch: values.get("branch"),
      detached,
      current: index === 0,
    };
  }).filter((item) => item.path);
}

static async createManualWorktree(
  repoRoot: string,
  name: string,
  ref = "HEAD"
): Promise<WorkspaceInfo> {
  const slug = slugifyWorktreeName(name);
  const worktreesDir = resolve(repoRoot, WORKTREES_DIR);
  mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = join(worktreesDir, `manual-${slug}`);

  const result = await runGit(["worktree", "add", "--detach", worktreePath, ref], repoRoot);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to create worktree");
  }

  return {
    mode: "worktree",
    path: worktreePath,
    worktreeName: `manual-${slug}`,
  };
}
```

Update imports in `src/workspace-manager.ts`:

```ts
import type { RuntimeConfig, WorkspaceInfo, WorkspaceMode, WorktreeListItem } from "./types.js";
```

- [ ] **Step 4: Add worktree API routes**

In `src/server.ts`, add:

```ts
if (url.pathname === "/api/worktrees" && method === "GET") {
  try {
    return sendJSON(res, await WorkspaceManager.listWorktrees(PROJECT_ROOT));
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 500);
  }
}

if (url.pathname === "/api/worktrees" && method === "POST") {
  const body = (await parseBody(req)) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name : "";
  const ref = typeof body.ref === "string" && body.ref ? body.ref : "HEAD";
  try {
    return sendJSON(res, await WorkspaceManager.createManualWorktree(PROJECT_ROOT, name, ref), 201);
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 400);
  }
}
```

Add import:

```ts
import { WorkspaceManager } from "./workspace-manager.js";
```

- [ ] **Step 5: Add UI source tests for active node and worktrees**

In `tests/ui-graph-rendering.test.ts`, add:

```ts
test("graph canvas renders an active node state separate from selection", () => {
  assert.match(uiSource, /activeGraphNodeId/);
  assert.match(uiSource, /is-active/);
  assert.match(cssSource, /\.graph-node\.is-active/);
});
```

In `tests/ui-run-control.test.ts`, add:

```ts
test("UI can list and create worktrees", () => {
  assert.match(htmlSource, /id="worktree-list"/);
  assert.match(htmlSource, /id="btn-create-worktree"/);
  assert.match(uiSource, /loadWorktrees/);
  assert.match(uiSource, /createWorktree/);
  assert.match(uiSource, /\/api\/worktrees/);
});
```

- [ ] **Step 6: Add active node UI state**

In `src/ui/app.js`, add:

```js
let activeGraphNodeId = null;
```

In `connectSSE()`:

```js
eventSource.addEventListener("node:started", (e) => {
  const data = JSON.parse(e.data);
  activeGraphNodeId = data.activation?.nodeId ?? activeGraphNodeId;
  upsertActivation(data.activation);
});

eventSource.addEventListener("node:completed", (e) => {
  const data = JSON.parse(e.data);
  upsertActivation(data.activation ?? data);
  const stillRunning = activations.find((item) => item.status === "running");
  activeGraphNodeId = stillRunning?.nodeId ?? null;
  renderGraphCanvas();
});
```

In `onRunCompleted()`:

```js
activeGraphNodeId = null;
```

In `renderGraphNode()`:

```js
const active = item.id === activeGraphNodeId ? " is-active" : "";
```

Update returned class:

```js
return `<button class="graph-node ${item.kind}${selected}${active}${stateClass}" type="button"
```

- [ ] **Step 7: Style active node in canvas**

In `src/ui/style.css`, add:

```css
.graph-node.is-active {
  border-color: rgba(84, 209, 122, 0.95);
  box-shadow:
    0 0 0 1px rgba(84, 209, 122, 0.45),
    0 0 28px rgba(84, 209, 122, 0.16);
}

.graph-node.is-active::after {
  content: "";
  position: absolute;
  inset: -6px;
  border: 1px solid rgba(84, 209, 122, 0.35);
  pointer-events: none;
}
```

- [ ] **Step 8: Add worktree panel to left sidebar**

In `src/ui/index.html`, add below the project section:

```html
<section class="sidebar-section worktree-section">
  <div class="section-heading">
    <span>Worktrees</span>
    <button id="btn-create-worktree" class="micro-button" type="button" aria-label="创建 worktree">+</button>
  </div>
  <div class="search-box">
    <span class="search-icon"></span>
    <input id="worktree-name-input" type="text" aria-label="worktree 名称">
  </div>
  <div id="worktree-list" class="worktree-list">
    <div class="empty-state">正在加载 worktree...</div>
  </div>
</section>
```

- [ ] **Step 9: Load and create worktrees in UI**

In `src/ui/app.js`, add DOM refs:

```js
const domWorktreeList = $("#worktree-list");
const domWorktreeName = $("#worktree-name-input");
const domCreateWorktree = $("#btn-create-worktree");
```

Add:

```js
async function loadWorktrees() {
  if (!domWorktreeList) return;
  try {
    const resp = await fetch(apiUrl("/api/worktrees"), { cache: "no-store" });
    const items = await resp.json();
    if (!resp.ok) throw new Error(items.error || "Failed to load worktrees");
    renderWorktrees(items);
  } catch (err) {
    domWorktreeList.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderWorktrees(items) {
  if (!items.length) {
    domWorktreeList.innerHTML = '<div class="empty-state">没有 worktree</div>';
    return;
  }

  domWorktreeList.innerHTML = items.map((item) => {
    const label = item.branch ? item.branch.replace("refs/heads/", "") : "detached";
    const current = item.current ? " current" : "";
    return `<div class="worktree-row${current}">
      <span class="worktree-name">${escapeHtml(basename(item.path))}</span>
      <span class="worktree-branch">${escapeHtml(label)}</span>
    </div>`;
  }).join("");
}

async function createWorktree() {
  const name = domWorktreeName?.value?.trim();
  if (!name) return;

  const resp = await fetch(apiUrl("/api/worktrees"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ref: "HEAD" }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    alert(result.error || "创建 worktree 失败");
    return;
  }
  domWorktreeName.value = "";
  await loadWorktrees();
}
```

Bind during initialization:

```js
domCreateWorktree?.addEventListener("click", createWorktree);
loadWorktrees();
```

After a run completes, call:

```js
loadWorktrees();
```

- [ ] **Step 10: Style worktree list**

In `src/ui/style.css`, add:

```css
.worktree-list {
  display: grid;
  gap: 6px;
}

.worktree-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-height: 34px;
  padding: 7px 9px;
  border: 1px solid rgba(137, 164, 255, 0.12);
  background: rgba(13, 18, 29, 0.72);
  color: #dce6ff;
}

.worktree-row.current {
  border-color: rgba(109, 153, 255, 0.42);
  background: rgba(109, 153, 255, 0.12);
}

.worktree-name,
.worktree-branch {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.worktree-branch {
  color: #9fb0d1;
  font-size: 11px;
}
```

- [ ] **Step 11: Verify**

Run:

```powershell
npm.cmd test -- tests/runtime.test.ts tests/ui-graph-rendering.test.ts tests/ui-run-control.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: all tests pass.

- [ ] **Step 12: Commit**

```powershell
git add src/types.ts src/workspace-manager.ts src/server.ts src/ui/index.html src/ui/app.js src/ui/style.css tests/runtime.test.ts tests/ui-graph-rendering.test.ts tests/ui-run-control.test.ts
git commit -m "feat: show active nodes and manage worktrees"
```

---

### Task 8: Add Self-Iteration Doctor

**Files:**
- Create: `src/readiness.ts`
- Modify: `src/index.ts`
- Modify: `src/server.ts`
- Create: `tests/readiness.test.ts`
- Modify: `tests/ui-run-control.test.ts`

- [ ] **Step 1: Write readiness tests**

Create `tests/readiness.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSelfIterationReadiness } from "../src/readiness.js";

function tempDir(prefix: string): string {
  const dir = resolve(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("self-iteration doctor reports required runtime capabilities", async () => {
  const repo = tempDir("agentgraph-readiness");
  const originalCwd = process.cwd();

  try {
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    process.chdir(repo);

    const result = await checkSelfIterationReadiness({
      graphPath: resolve(originalCwd, "examples/project-task-loop.yaml"),
      projectRoot: repo,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "test-key",
        AGENTGRAPH_CODEX_PATH: process.execPath,
      },
      commandExists: (program) => {
        const found = spawnSync(program, ["--version"], { shell: true });
        return found.status === 0 || program === process.execPath;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.some((item) => item.id === "git_worktree" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.id === "controller_key" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.id === "codex_cli" && item.status === "pass"), true);
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing readiness test**

Run:

```powershell
npm.cmd test -- tests/readiness.test.ts
```

Expected before implementation: FAIL because `src/readiness.ts` does not exist.

- [ ] **Step 3: Add readiness types**

In `src/types.ts`, add:

```ts
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
```

- [ ] **Step 4: Implement readiness module**

Create `src/readiness.ts`:

```ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GraphLoader } from "./graph-loader.js";
import type { ReadinessCheck, ReadinessResult } from "./types.js";

export interface ReadinessOptions {
  graphPath: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  commandExists?: (program: string) => boolean;
}

function defaultCommandExists(program: string): boolean {
  const result = spawnSync(program, ["--version"], {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function pass(id: string, label: string, message: string): ReadinessCheck {
  return { id, label, status: "pass", message };
}

function fail(id: string, label: string, message: string): ReadinessCheck {
  return { id, label, status: "fail", message };
}

export async function checkSelfIterationReadiness(
  options: ReadinessOptions
): Promise<ReadinessResult> {
  const env = options.env ?? process.env;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const graphPath = resolve(options.graphPath);
  const checks: ReadinessCheck[] = [];

  const graph = GraphLoader.load(graphPath);
  checks.push(pass("graph_load", "Graph loads", `Loaded ${graph.id}`));

  if (graph.runtime?.workspace?.mode === "worktree") {
    checks.push(pass("workspace_mode", "Workspace mode", "Graph uses worktree mode"));
  } else {
    checks.push(fail("workspace_mode", "Workspace mode", "Graph must use runtime.workspace.mode = worktree"));
  }

  const gitCheck = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: options.projectRoot,
    shell: true,
    stdio: "ignore",
  });
  if (gitCheck.status === 0) {
    checks.push(pass("git_repo", "Git repository", "Project root is a Git repository"));
  } else {
    checks.push(fail("git_repo", "Git repository", "Project root is not a Git repository"));
  }

  const worktreeCheck = spawnSync("git", ["worktree", "list"], {
    cwd: options.projectRoot,
    shell: true,
    stdio: "ignore",
  });
  if (worktreeCheck.status === 0) {
    checks.push(pass("git_worktree", "Git worktree", "git worktree is available"));
  } else {
    checks.push(fail("git_worktree", "Git worktree", "git worktree list failed"));
  }

  const codexPath = env.AGENTGRAPH_CODEX_PATH;
  if ((codexPath && existsSync(codexPath)) || commandExists("codex.cmd") || commandExists("codex")) {
    checks.push(pass("codex_cli", "Codex CLI", "Codex CLI is available"));
  } else {
    checks.push(fail("codex_cli", "Codex CLI", "Install Codex CLI or set AGENTGRAPH_CODEX_PATH"));
  }

  if (env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY) {
    checks.push(pass("controller_key", "Controller API key", "Controller API key is configured"));
  } else {
    checks.push(fail("controller_key", "Controller API key", "Set DEEPSEEK_API_KEY before running controller nodes"));
  }

  return {
    ok: checks.every((item) => item.status === "pass"),
    graphPath,
    checks,
  };
}
```

- [ ] **Step 5: Add CLI `--doctor`**

In `src/index.ts`, import:

```ts
import { checkSelfIterationReadiness } from "./readiness.js";
```

Add before server mode:

```ts
if (args[0] === "--doctor") {
  const graphPath = args[1];
  if (!graphPath) {
    console.error("Usage: npx tsx src/index.ts --doctor <graph-yaml-path>");
    process.exit(1);
  }

  const result = await checkSelfIterationReadiness({
    graphPath,
    projectRoot: process.cwd(),
  });

  console.log(`Self-iteration readiness: ${result.ok ? "PASS" : "FAIL"}`);
  for (const check of result.checks) {
    const mark = check.status === "pass" ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${check.label}: ${check.message}`);
  }
  process.exit(result.ok ? 0 : 1);
}
```

- [ ] **Step 6: Add readiness API**

In `src/server.ts`, import:

```ts
import { checkSelfIterationReadiness } from "./readiness.js";
```

Add route:

```ts
if (url.pathname === "/api/readiness" && method === "GET") {
  const graphPath = url.searchParams.get("path") ?? join(PROJECT_ROOT, "examples", "project-task-loop.yaml");
  try {
    return sendJSON(res, await checkSelfIterationReadiness({ graphPath, projectRoot: PROJECT_ROOT }));
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 500);
  }
}
```

- [ ] **Step 7: Add UI readiness source test**

In `tests/ui-run-control.test.ts`, add:

```ts
test("UI can show self-iteration readiness", () => {
  assert.match(uiSource, /loadReadiness/);
  assert.match(uiSource, /\/api\/readiness/);
});
```

Then add `loadReadiness()` to `src/ui/app.js`:

```js
async function loadReadiness() {
  const graphPath = domGraph.value;
  if (!graphPath) return;
  try {
    const resp = await fetch(apiUrl(`/api/readiness?path=${encodeURIComponent(graphPath)}`), {
      cache: "no-store",
    });
    const result = await resp.json();
    if (!resp.ok) return;
    setStatus(result.ok ? "idle" : "failed", result.ok ? "预检通过" : "预检失败");
  } catch {
    // Readiness is advisory; graph runs still report their own errors.
  }
}
```

Call `loadReadiness()` after graph selection changes.

- [ ] **Step 8: Verify**

Run:

```powershell
npm.cmd test -- tests/readiness.test.ts tests/ui-run-control.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd start -- --doctor examples/project-task-loop.yaml
```

Expected on a machine without `DEEPSEEK_API_KEY`: tests pass, typecheck passes, and `--doctor` exits non-zero with a clear `Controller API key` failure.

- [ ] **Step 9: Commit**

```powershell
git add src/readiness.ts src/index.ts src/server.ts src/types.ts tests/readiness.test.ts tests/ui-run-control.test.ts
git commit -m "feat: add self iteration readiness checks"
```

---

## Final Acceptance

Run these commands from `C:\Users\yulu\Documents\VineGraph\VineGraph`:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd start -- examples/simple-test.yaml
npm.cmd start -- --doctor examples/project-task-loop.yaml
```

Expected:

- `npm.cmd test` passes.
- `npm.cmd run typecheck` passes.
- `simple-test.yaml` succeeds.
- `--doctor` clearly reports pass/fail checks. If no `DEEPSEEK_API_KEY` is configured, the only expected failure is the controller key check.

Manual UI smoke:

```powershell
npm.cmd start -- --serve --port 3456
```

Open:

```text
http://localhost:3456
```

Expected:

- Select `project-task-loop.yaml`.
- Inspector shows real prompt template from YAML for `implement_feature`, `review_gate`, and `task_gate`.
- Starting a run shows active node highlight.
- Codex/Claude streamed output appears in Terminal.
- Diff tab shows current run workspace and patch.
- Worktrees panel lists the main worktree and created manual worktrees.
- Creating a worktree named `manual-review` creates `.agentgraph/worktrees/manual-manual-review`.

## Self-Review

- Spec coverage: the plan covers true read-only agent parallelism, prompt assembly provenance, worktree reliability, UI prompt/terminal/active node/worktree display, worktree creation, and self-iteration readiness.
- Placeholder scan: no unspecified implementation slots remain; every task includes file paths, test code, implementation snippets, commands, expected results, and commit commands.
- Type consistency: `PromptAssembly`, `WorktreeListItem`, `ReadinessCheck`, and `ReadinessResult` are introduced before they are used by runtime/server/UI tests.
