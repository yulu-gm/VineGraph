# Code Agent Graph Harness 设计案：Controller + Execute 双节点稳定版

> 版本：v0.1 设计草案  
> 目标：先实现一个**单层级 Graph**、**两类核心节点**、**可执行循环**的 Code Agent Harness。  
> 不做 SubGraph、不做 Skill Registry、不做复杂可视化编辑器，先证明核心运行时可用、可控、可循环。

---

## 1. 产品定位

本项目不是重新实现一个 Agent，也不是做通用 Dify-like 平台。

它的定位是：

```text
一个面向代码任务的单层级 Agent Graph Runtime。
```

它通过两类核心节点完成任务编排：

```text
Controller Node：判断、Join、路由、生成下游上下文
Execute Node：执行、调用 Codex / Claude / Internal
```

其中：

```text
Codex / Claude 负责执行具体代码任务。
DeepSeek / 廉价模型负责 Controller 判断。
Runtime 负责规则、状态、权限、循环、输入输出和防死锁。
```

一句话总结：

```text
Execute 负责做事，Controller 负责选择路，Runtime 负责保证不会失控。
```

---

## 2. 第一版设计目标

第一版只需要跑通一个稳定的单层级任务循环：

```text
输入任务
↓
Execute: Implement
↓
Execute: Run Tests
↓
Controller: After Tests
↓
测试失败 → Execute: Fix From Test Logs → Run Tests
测试通过 → End Success
不确定 → End Failed
超过循环次数 → End Failed
```

最小闭环：

```text
Implement → Run Tests → Controller → Fix → Run Tests → Controller → End
```

第一版成功标准：

```text
1. Graph 可以执行。
2. Execute 节点可以调用 Codex / Claude / Internal。
3. Controller 可以根据输入选择一个输出端口。
4. Runtime 可以校验 Controller 的选择是否合法。
5. 测试失败可以循环修复。
6. 循环次数有上限。
7. 所有改动在 isolated workspace 中完成。
8. 最终可以展示 diff / logs / controller decisions。
```

---

## 3. 第一版明确不做什么

为了保证 MVP 足够小，第一版不做：

```text
1. SubGraph / 嵌套 Graph
2. Skill Registry
3. Graph 导出为 Skill
4. 多 Project 管理
5. 复杂节点市场
6. 复杂可视化编辑器
7. 完整 Mediated Approval
8. 多候选方案并行
9. 完整权限策略系统
10. Controller 自动修改 Graph
11. 复杂 Session fork / resume
12. 云端运行
13. 多人协作
14. Workflow Marketplace
15. 复杂 RAG / 知识库
```

第一版只做：

```text
单项目 / 单 Repo / 单层 Graph / 可执行循环 / 日志和 Diff。
```

---

## 4. 核心概念

### 4.1 Graph

Graph 是单层级有向图。

它由两类节点组成：

```text
Controller Node
Execute Node
```

Graph 可以有回边，因此天然支持循环。

循环不需要 LoopNode，而是由：

```text
回边 + Runtime Loop Guard
```

共同实现。

---

### 4.2 Controller Node

Controller 是核心节点。

它的职责是：

```text
1. 从一个或多个上游节点收集输入。
2. 根据 readiness 策略判断是否可以 evaluate。
3. 调用廉价模型，例如 DeepSeek。
4. 根据配置 prompt 选择一个 output port。
5. 生成该 output port 对应的 payload / prompt context。
6. Runtime 校验 selected_output、payload schema、output guard。
7. 从被选中的 output port 继续流转。
```

Controller 本质是：

```text
Join + Decision + Router + Context Builder
```

Controller 不负责：

```text
1. 执行代码修改
2. 调用 Codex / Claude 完成任务
3. 选择 backend
4. 直接执行外部命令
5. 直接 apply patch
6. 绕过 Runtime 规则
```

Controller 只能选择自己的某个 output port。

---

### 4.3 Execute Node

Execute 是所有实际执行动作的统一节点。

它可以调用不同 backend：

```text
codex
claude
internal
```

例如：

```text
Implement             = Execute backend: codex
Fix From Test Logs    = Execute backend: claude
Run Verification      = Execute backend: codex / claude
End Success / Failed  = Execute backend: internal
```

Execute 负责：

```text
1. 渲染 prompt / command。
2. 调用对应 backend。
3. 保存 raw output。
4. 捕获 stdout / stderr / exitCode。
5. 捕获 git diff / changed files。
6. 产出可供下游消费的结果 token。
```

---

## 5. 两类节点模型

### 5.1 Controller Node 数据结构

```ts
interface ControllerNode {
  id: string;
  type: "controller";

  model: string; // deepseek / cheap model / local model

  inputs: Record<string, InputPortSpec>;
  outputs: Record<string, OutputPortSpec>;

  readiness: ReadinessSpec;

  promptTemplate: string;

  decisionSchema: JsonSchema;

  outputGuards?: Record<string, string>;

  limits?: {
    minConfidence?: number;
    maxEvaluations?: number;
  };
}
```

Controller 的输出必须是结构化 JSON：

```ts
interface ControllerDecision {
  selected_output: string;
  reason: string;
  confidence: number;
  payload?: unknown;
}
```

示例：

```json
{
  "selected_output": "fix_from_test_logs",
  "reason": "Tests failed with a localized assertion error after implementation.",
  "confidence": 0.86,
  "payload": {
    "failureSummary": "The inventory stacking test fails when the target slot is empty.",
    "focus": "Fix empty-slot handling only.",
    "constraints": [
      "Do not modify unrelated files.",
      "Do not commit."
    ]
  }
}
```

---

### 5.2 Execute Node 数据结构

```ts
interface ExecuteNode {
  id: string;
  type: "execute";

  backend:
    | "codex"
    | "claude"
    | "internal";

  inputs: Record<string, InputPortSpec>;
  outputs?: Record<string, OutputPortSpec>;

  promptTemplate?: string;

  command?: {
    program: string;
    args: string[];
    cwd?: string;
  };

  execution?: {
    timeoutMs?: number;
    workspaceAccess?: "read" | "write";
    sessionPolicy?: "ephemeral" | "sticky_by_lineage";
  };

  canonicalOutputs?: Record<string, string>;
}
```

---

## 6. Controller 的核心规则

Controller 的设计原则：

```text
Controller 有判断权，但没有执行权。
Runtime 有最终裁决权。
```

Controller 只能做三件事：

```text
1. 选择自己的某个 output port。
2. 解释为什么选择它。
3. 生成给下游节点使用的 payload / prompt context。
```

Controller 不能：

```text
1. 选择 backend。
2. 选择不存在的节点。
3. 直接运行命令。
4. 直接修改文件。
5. 直接 apply patch。
6. 直接跳过 Runtime guard。
```

### 6.1 Controller 选择 output，不直接选择 node

Controller 的输出是：

```json
{
  "selected_output": "fix_from_test_logs",
  "payload": {}
}
```

而不是：

```json
{
  "next_node": "fix_from_test_logs"
}
```

Runtime 根据 selected output port 找到对应 edge：

```text
Controller.outputs.fix_from_test_logs → Execute.fix_from_test_logs
```

这样更接近 Blueprint 的 output pin。

---

### 6.2 Controller 不选择 backend

backend 由 Execute 节点配置。

例如：

```yaml
- id: fix_from_test_logs
  type: execute
  backend: claude
```

Controller 只选择：

```text
fix_from_test_logs output
```

至于这个 output 连到的节点用 Claude 还是 Codex，由目标 Execute 节点决定。

---

### 6.3 Controller 不生成完整 prompt

Controller 不应该生成完整 prompt。

它应该生成：

```text
prompt_context / payload
```

完整 prompt 由目标 Execute 节点的 `prompt_template` 生成。

原因：

```text
1. Execute 节点自己的规则更稳定。
2. Controller 不能覆盖节点安全约束。
3. Prompt Template 可以版本化和审计。
4. Runtime 可以注入固定规则、workspace、diff、test logs。
```

例如 Controller 生成：

```json
{
  "failureSummary": "Empty inventory slot handling failed.",
  "focus": "Fix only empty-slot handling.",
  "constraints": ["Do not modify unrelated files."]
}
```

Execute 节点 prompt：

```text
Fix the failing tests.

Original task:
{{inputs.task}}

Failure summary:
{{controller.payload.failureSummary}}

Focus:
{{controller.payload.focus}}

Test stderr:
{{nodes.run_tests.stderr}}

Current diff:
{{runtime.gitDiff}}

Rules:
- Fix only the failing issue.
- Keep changes minimal.
- Do not commit.
```

---

## 7. Execute 节点 backend 设计

### 7.1 backend = codex

用于实现类任务：

```text
Implement
Generate Patch
Refactor Small Scope
```

Execute 行为：

```text
1. 渲染 prompt。
2. 调用 Codex CLI / Codex Backend。
3. 保存 transcript / stdout / events。
4. 捕获 git diff。
5. 捕获 changed files。
```

---

### 7.2 backend = claude

用于修复和 review 类任务：

```text
Fix From Test Logs
Fix Review Issues
Review Code Quality
Review Functionality
```

---

### 7.3 backend = internal

仅用于流程动作，不作为需要 Controller 解析的业务输出来源：

```text
End Success
End Failed
Flow Marker
```

---

## 8. Graph 流转模型

### 8.1 Edge

Edge 连接的是：

```text
output port → input port
```

或者：

```text
Controller output → Execute input
```

示例：

```yaml
edges:
  - from: after_tests_controller.outputs.fix_from_test_logs
    to: fix_from_test_logs.inputs.trigger
```

Controller 选择该 output 后，Runtime 激活对应 edge。

---

### 8.2 回边形成循环

循环不需要 LoopNode。

例如：

```yaml
edges:
  - from: fix_from_test_logs.outputs.done
    to: run_tests.inputs.trigger
```

形成：

```text
Run Tests → Controller → Fix → Run Tests
```

Runtime 通过以下限制防止无限循环：

```text
max_total_steps
max_node_runs
max_fix_attempts
max_runtime_ms
```

---

## 9. Join 与 Deadlock 设计

Controller 可以有多个输入。

例如 Review 阶段：

```text
Review Code Quality       ┐
                          ├─ Review Controller
Review Functionality      ┘
```

Review Controller 必须等两个 review 都完成后才 evaluate。

---

### 9.1 Readiness Policy

Controller 需要配置 readiness：

```yaml
readiness:
  mode: all_required
```

第一版只实现：

```text
all_required
```

含义：

```text
所有 required input port 都收到 token 后，Controller 才 evaluate。
```

---

### 9.2 all_required 的限制

第一版为了避免死锁，规定：

```text
Controller 的 required inputs 必须来自本轮一定会执行的上游路径。
```

也就是说，第一版允许：

```text
并行必跑任务 Join
```

例如：

```text
Review Quality + Review Functionality → Review Controller
```

但第一版不允许：

```text
互斥分支 Join
```

例如：

```text
Branch true  → Controller.input_a
Branch false → Controller.input_b
Controller 等 input_a + input_b
```

因为 true / false 一次只会走一个，Controller 永远等不到另一个输入，会死锁。

---

### 9.3 MVP 死锁规避策略

第一版采用保守策略：

```text
如果 Graph Validator 检测到 Controller required inputs 来自互斥路径，则禁止运行。
```

提示：

```text
This Controller may deadlock because required inputs come from mutually exclusive paths.
Use optional input, split the controller, or wait for all_active readiness support.
```

---

### 9.4 后续扩展：closed token + all_active

后续可以引入：

```text
closed token
all_active readiness
```

当 Controller 选择某个 output 时，未被选中的 outputs 会产生 closed token。

这样下游 Join 节点可以知道：

```text
这个输入不是还没来，而是本轮不会来了。
```

但第一版暂不实现。

---

## 10. Frame / Iteration 设计

循环中同一个节点会执行多次。

例如：

```text
Run Tests #1
Controller #1
Fix #1
Run Tests #2
Controller #2
Fix #2
```

必须避免：

```text
第 1 轮的 test_result
+
第 2 轮的 executor_result
```

被同一个 Controller 消费。

因此每个 token 需要携带：

```ts
interface FlowToken {
  tokenId: string;
  nodeId: string;
  portId: string;
  value: unknown;

  frameId: string;
  lineageId: string;
  iteration: number;

  kind: "data" | "control" | "closed" | "skip";
}
```

第一版至少需要：

```text
frameId
iteration
activationId
```

Controller 只消费同一个 `frameId / iteration` 下的输入。

---

## 11. Runtime 不变量

系统稳定性依赖 Runtime 不变量。

第一版必须保证：

```text
1. Controller 只能选择自己声明过的 output。
2. Controller 不能选择 backend。
3. Controller payload 必须符合 selected output 的 schema。
4. Controller output guard 必须通过。
5. Controller confidence 低于阈值时不能自动继续。
6. Execute backend 由节点配置决定。
7. 测试是否通过由 Runtime 根据 exitCode 判断。
8. 循环次数必须受 max_fix_attempts / max_total_steps 限制。
9. 同一个 workspace 同时只能有一个写 Execute。
10. 所有代码修改默认发生在 isolated worktree。
11. Run 的每一步都必须写入 history。
12. App 取消任务时必须释放 workspace lock 和 session lock。
```

---

## 12. 最小 Graph 示例

```yaml
id: simple_bug_fix_loop
version: 0.1.0

inputs:
  task:
    type: string

  test_command:
    type: string
    default: "pnpm test"

runtime:
  max_fix_attempts: 3
  max_total_steps: 12
  workspace:
    mode: git_worktree

nodes:
  - id: implement
    type: execute
    backend: codex
    prompt_template: |
      Implement the task.

      Task:
      {{inputs.task}}

      Rules:
      - Keep changes minimal.
      - Do not commit.
      - Do not modify unrelated files.

  - id: run_tests
    type: execute
    backend: codex
    prompt_template: |
      Run or inspect the requested verification command in the workspace.

      Command:
      {{inputs.test_command}}

      Return a concise JSON summary with:
      - passed
      - stdout
      - stderr
    canonical_outputs:
      passed: "{{json.passed}}"
      stdout: "{{json.stdout}}"
      stderr: "{{json.stderr}}"

  - id: after_tests_controller
    type: controller
    model: deepseek

    readiness:
      mode: all_required

    inputs:
      test_result:
        required: true
        schema: TestResult

      runtime_facts:
        required: true
        schema: RuntimeFacts

    outputs:
      fix_from_test_logs:
        payload_schema: FixFromTestLogsContext

      rerun_tests:
        payload_schema: EmptyPayload

      end_success:
        payload_schema: SuccessSummary

      end_failed:
        payload_schema: FailureSummary

    output_guards:
      end_success: "{{inputs.test_result.passed == true}}"
      fix_from_test_logs: "{{inputs.test_result.passed == false && runtime.fixAttempts < runtime.maxFixAttempts}}"
      end_failed: "{{runtime.fixAttempts >= runtime.maxFixAttempts || inputs.test_result.passed == false}}"

    prompt_template: |
      You are a graph controller.

      Choose exactly one output from the available outputs.

      Test result:
      {{inputs.test_result}}

      Runtime facts:
      {{inputs.runtime_facts}}

      Available outputs:
      {{outputs}}

      Rules:
      - If tests passed, prefer end_success.
      - If tests failed and fix attempts remain, prefer fix_from_test_logs.
      - If the failure looks flaky, choose rerun_tests.
      - If no fix attempts remain, choose end_failed.

      Output JSON only:
      {
        "selected_output": "...",
        "reason": "...",
        "confidence": 0.0,
        "payload": {}
      }

  - id: fix_from_test_logs
    type: execute
    backend: claude
    prompt_template: |
      Fix the failing tests.

      Original task:
      {{inputs.task}}

      Controller context:
      {{controller.payload}}

      Test stderr:
      {{nodes.run_tests.stderr}}

      Current diff:
      {{runtime.gitDiff}}

      Rules:
      - Fix only the failing issue.
      - Keep changes minimal.
      - Do not modify unrelated files.
      - Do not commit.

  - id: end_success
    type: execute
    backend: internal
    action: finish_success

  - id: end_failed
    type: execute
    backend: internal
    action: finish_failed

edges:
  - from: graph.start
    to: implement

  - from: implement.outputs.done
    to: run_tests.inputs.trigger

  - from: run_tests.outputs.result
    to: after_tests_controller.inputs.test_result

  - from: runtime.outputs.facts
    to: after_tests_controller.inputs.runtime_facts

  - from: after_tests_controller.outputs.fix_from_test_logs
    to: fix_from_test_logs.inputs.controller_payload

  - from: after_tests_controller.outputs.rerun_tests
    to: run_tests.inputs.trigger

  - from: fix_from_test_logs.outputs.done
    to: run_tests.inputs.trigger

  - from: after_tests_controller.outputs.end_success
    to: end_success.inputs.trigger

  - from: after_tests_controller.outputs.end_failed
    to: end_failed.inputs.trigger
```

---

## 13. Review Loop 扩展示例

Review 不放进第一版 MVP，但双节点模型可以自然扩展。

```text
Run Tests passed
↓
Execute: Review Code Quality
+
Execute: Review Functionality
↓
Controller: Review Controller
├─ fix_review_issues → Execute: Fix Review Issues → Run Tests
├─ end_success
└─ end_failed
```

Review Controller 是多输入 Controller：

```yaml
- id: review_controller
  type: controller
  model: deepseek

  readiness:
    mode: all_required

  inputs:
    quality_review:
      required: true
      schema: ReviewResult

    functionality_review:
      required: true
      schema: ReviewResult

    test_result:
      required: true
      schema: TestResult

  outputs:
    fix_review_issues:
      payload_schema: FixReviewIssuesContext

    end_failed:
      payload_schema: FailureSummary

  output_guards:
    end_success: "{{inputs.test_result.passed == true}}"
```

注意：

```text
Review Quality 和 Review Functionality 是并行必跑路径，所以 all_required 不会死锁。
```

---

## 14. Runtime 模块拆分

第一版需要以下模块。

### 14.1 GraphLoader

负责：

```text
1. 解析 graph YAML。
2. 校验基本结构。
3. 构建节点和边索引。
```

---

### 14.2 GraphValidator

负责运行前静态检查：

```text
1. 所有 edge 指向存在。
2. Controller outputs 是否有对应 outgoing edge。
3. Controller required inputs 是否有来源。
4. Controller payload schema 是否合法。
5. output guard 表达式是否合法。
6. 是否存在无上限循环。
7. required inputs 是否可能来自互斥分支。
```

MVP 重点：

```text
required inputs 来自互斥路径时禁止运行。
```

---

### 14.3 RuntimeScheduler

负责：

```text
1. 调度节点执行。
2. 管理 input buffer。
3. 检查 Controller readiness。
4. 处理回边和循环。
5. 控制 max_total_steps / max_fix_attempts。
```

---

### 14.4 ControllerRunner

负责：

```text
1. 构造 Controller 输入。
2. 渲染 Controller prompt。
3. 调用 DeepSeek / cheap model。
4. 解析 JSON。
5. 校验 decision schema。
6. 校验 selected output。
7. 校验 payload schema。
8. 校验 output guard。
```

---

### 14.5 ExecuteRunner

负责：

```text
1. 根据 backend 执行任务。
2. 调用 Codex / Claude / internal。
3. 管理 timeout / cancel。
4. 保存 raw output。
5. 捕获 canonical outputs。
```

---

### 14.6 WorkspaceManager

负责：

```text
1. 创建 git worktree。
2. 执行前检查 dirty repo。
3. 管理 workspace path。
4. 捕获 git diff。
5. 捕获 changed files。
6. 导出 patch。
7. 清理 worktree。
8. 管理 workspace write lock。
```

---

### 14.7 ArtifactStore

保存：

```text
stdout
stderr
controller decisions
executor transcripts
git diff
changed files
node inputs
node outputs
run timeline
```

---

### 14.8 RunHistory

记录每次运行：

```ts
interface RunRecord {
  runId: string;
  graphId: string;
  status: "running" | "success" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  activations: NodeActivation[];
}
```

---

## 15. NodeActivation

每次节点执行都是一个 Activation。

```ts
interface NodeActivation {
  activationId: string;
  runId: string;
  nodeId: string;

  type: "controller" | "execute";

  frameId: string;
  iteration: number;

  status:
    | "queued"
    | "running"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "cancelled";

  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;

  rawResult?: RawExecutionResult;
  controllerDecision?: ControllerDecision;

  startedAt?: number;
  finishedAt?: number;

  artifacts: ArtifactRef[];
}
```

---

## 16. RawExecutionResult

Execute 节点产生原始结果。

```ts
interface RawExecutionResult {
  activationId: string;
  nodeId: string;

  backend: "codex" | "claude" | "internal";

  stdout?: string;
  stderr?: string;
  transcript?: string;
  events?: unknown[];

  exitCode?: number;

  startedAt: number;
  finishedAt: number;
  durationMs: number;

  artifacts: {
    gitDiff?: string;
    changedFiles?: string[];
    logs?: string[];
  };
}
```

---

## 17. ControllerDecision

```ts
interface ControllerDecision {
  selected_output: string;
  reason: string;
  confidence: number;
  payload?: unknown;
}
```

Runtime 校验步骤：

```text
1. JSON parse。
2. schema validate。
3. selected_output 存在。
4. payload schema validate。
5. output guard validate。
6. confidence >= minConfidence。
7. loop guard validate。
```

---

## 18. Prompt 构建原则

### 18.1 Controller Prompt

Controller prompt 输入：

```text
1. 当前 Controller 的 inputs。
2. Runtime facts。
3. 可选 outputs 列表。
4. 每个 output 的语义说明。
5. 当前循环次数和限制。
6. JSON 输出 schema。
```

Controller prompt 输出：

```text
selected_output
reason
confidence
payload
```

---

### 18.2 Execute Prompt

Execute prompt 由节点模板生成。

输入来源：

```text
1. Graph inputs。
2. 上游 Execute outputs。
3. Controller payload。
4. Runtime facts。
5. git diff。
6. test logs。
7. controller guidance。
```

原则：

```text
Controller 只生成上下文，不直接生成完整 prompt。
```

---

## 19. UI MVP

第一版不需要完整节点编辑器。

可以先做一个固定流程 UI。

### 19.1 页面结构

```text
左侧：Graph / Run 列表
中间：Run Timeline
右侧：日志 / Diff / Controller Decision
底部：当前 stdout / stderr
```

### 19.2 必要功能

```text
1. 选择 repo。
2. 输入 task。
3. 输入 test command。
4. Run / Cancel。
5. 查看每个节点状态。
6. 查看 Controller 选择了哪个 output。
7. 查看 Controller reason / confidence / payload。
8. 查看 Codex / Claude 输出。
9. 查看测试 stdout / stderr。
10. 查看最终 git diff。
11. Export patch。
```

---

## 20. 阶段落地计划

### Phase 0：CLI 原型

目标：不用 UI，先跑通最小 Runtime。

完成内容：

```text
1. Graph YAML 解析。
2. Execute backend = internal / codex / claude。
3. 简单 edge 调度。
4. stdout / stderr / exitCode 捕获。
5. run history 写入本地文件。
```

验收：

```text
Start → Run Tests → End 可以执行。
```

---

### Phase 1：Workspace + Diff

目标：保证代码任务在隔离 workspace 中执行。

完成内容：

```text
1. 识别 git repo。
2. 创建 git worktree。
3. 在 worktree 内执行 agent backend。
4. 捕获 git diff。
5. 捕获 changed files。
6. 导出 patch。
```

验收：

```text
任何修改都发生在 worktree 中，主仓库不被污染。
```

---

### Phase 2：Execute backend 接入 Codex / Claude

目标：Execute 节点可以调用真实 Agent。

完成内容：

```text
1. Execute backend = codex。
2. Execute backend = claude。
3. prompt_template 渲染。
4. timeout。
5. cancel。
6. raw output 保存。
7. 执行后捕获 diff。
```

验收：

```text
Implement 节点可以调用 Codex 修改代码。
Fix 节点可以调用 Claude 修复代码。
```

---

### Phase 3：Controller Node

目标：实现核心 Controller 节点。

完成内容：

```text
1. Controller inputs。
2. readiness = all_required。
3. Controller prompt 渲染。
4. 调用 DeepSeek。
5. JSON parse。
6. decision schema validate。
7. selected_output 校验。
8. payload schema 校验。
9. output guard 校验。
10. confidence 检查。
```

验收：

```text
Run Tests 后，Controller 能选择 fix_from_test_logs 或 end_success。
```

---

### Phase 4：可执行循环

目标：跑通 bug fix loop。

完成内容：

```text
1. RunTests → Controller → Fix → RunTests 回边。
2. max_fix_attempts。
3. max_total_steps。
4. iteration / frameId。
5. controller decision history。
6. end_success / end_failed。
```

验收：

```text
测试失败会修复，修复后重跑测试，测试通过后结束。
超过修复次数后失败退出。
```

---

### Phase 5：Tauri UI MVP

目标：让用户可以在 UI 中运行固定 Graph。

完成内容：

```text
1. Repo 选择。
2. Task 输入。
3. Test command 输入。
4. Run / Cancel。
5. Run timeline。
6. Node status。
7. Controller decision 面板。
8. stdout / stderr 面板。
9. Diff viewer。
10. Export patch。
```

验收：

```text
用户不需要命令行即可跑完整 bug fix loop。
```

---

### Phase 6：人工介入 UI

目标：当 Controller 不确定时，用户可以在 UI 外部介入，不新增 execute backend。

完成内容：

```text
1. 暂停或结束当前运行。
2. UI 展示 Controller 的不确定原因。
3. 用户修改任务输入或 graph 后重新运行。
4. 低 confidence 不自动进入新的 execute backend。
```

验收：

```text
Controller 不确定时给出可读原因，用户调整输入后重新运行。
```

---

### Phase 7：基础安全与审批

目标：实现最小安全边界。

完成内容：

```text
1. protected paths。
2. 修改 protected path 前提示。
3. apply patch 前确认。
4. 大 diff 前确认。
5. cancel node。
6. approval history。
```

验收：

```text
高风险操作不会无提示执行。
```

---

### Phase 8：Review Loop 扩展

目标：加入并行 Review 和 Review Controller。

完成内容：

```text
1. Execute: Review Code Quality。
2. Execute: Review Functionality。
3. 并行执行。
4. 多输入 Controller。
5. readiness = all_required。
6. Review 不通过 → Fix Review Issues。
7. Review 通过 → End Success。
```

验收：

```text
测试通过后进入两个 review，两个 review 都完成后 Controller 决定是否修复。
```

---

### Phase 9：单层 Graph Editor

目标：从固定流程变成可编辑单层 Graph。

完成内容：

```text
1. 节点画布。
2. 添加 Controller / Execute 节点。
3. 连接 output / input。
4. 配置 backend。
5. 配置 Controller outputs。
6. 配置 prompt_template。
7. 保存 graph YAML。
8. 运行当前 graph。
```

仍然不做 SubGraph。

验收：

```text
用户可以自己搭一个单层可循环 Graph。
```

---

## 21. MVP 版本边界

### v0.1 必须包含

```text
1. 两类节点：Controller / Execute。
2. 单层 Graph。
3. Worktree workspace。
4. Execute backend = codex / claude / internal。
5. Controller model = DeepSeek / cheap model。
6. Controller selected_output。
7. Runtime output guard。
8. Loop guard。
9. Run history。
10. Diff viewer / patch export。
```

### v0.1 可以不包含

```text
1. Review loop。
2. 多输入 Controller。
3. 完整 Mediated Approval。
4. Graph Editor。
5. SubGraph。
6. Skill Registry。
7. 多项目管理。
```

---

## 22. 稳定性证明方向

该方案的稳定性来自：

```text
1. 节点类型极少，Runtime 简单。
2. Execute 和 Controller 职责分离。
3. Controller 只能选择 output，不能执行动作。
4. Execute backend 固定在节点配置中。
5. Runtime 校验 selected_output 和 payload。
6. 测试结果由 exitCode 决定，不由模型判断。
7. 循环由 Runtime 限制。
8. Workspace 默认隔离。
9. 每一步都有 activation history。
10. Controller reason / confidence 可审计。
```

可以验证的不变量：

```text
1. 测试失败时不能走 end_success。
2. 超过 max_fix_attempts 后不能继续 fix。
3. Controller 不能选择不存在的 output。
4. Controller payload 不符合 schema 时不能流转。
5. Codex / Claude 不能决定 Graph 走向。
6. 所有代码改动必须在 worktree 中发生。
```

---

## 23. 最终总结

最终设计收敛为：

```text
Controller Node + Execute Node
```

底层只有两种核心节点：

```text
Controller：Join + Decision + Router + Context Builder
Execute：Backend Runner + Artifact Capture
```

其他概念都可以先作为配置或 backend 存在：

```text
Branch    → Controller
Join      → Controller readiness
Loop      → 回边 + Runtime guard
Agent     → Execute backend = codex / claude
End       → Execute backend = internal
```

这套方案的最大优势是：

```text
简单、稳定、可执行、可扩展。
```

它先保证单层 Graph 能跑通，再逐步扩展 review loop、approval、graph editor、subgraph 和 skill。

第一阶段的核心目标不是做一个完整平台，而是证明：

```text
廉价 Controller + 强 Executor + 硬 Runtime 约束
```

可以比单纯的 Codex / Claude 自主循环更可控、更可观测、更容易收敛。
