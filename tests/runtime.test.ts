import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GraphLoader } from "../src/graph-loader.js";
import { Scheduler } from "../src/scheduler.js";
import type { ControllerDecision, GraphDefinition } from "../src/types.js";

function tempDir(prefix: string): string {
  const dir = resolve(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withMockController<T>(
  decision: ControllerDecision,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(decision) } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function commitInitialReadme(repoRoot: string): void {
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "core.autocrlf", "false"], {
    cwd: repoRoot,
  });
  writeFileSync(resolve(repoRoot, "README.md"), "initial\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentGraph Test",
      GIT_AUTHOR_EMAIL: "agentgraph@example.test",
      GIT_COMMITTER_NAME: "AgentGraph Test",
      GIT_COMMITTER_EMAIL: "agentgraph@example.test",
    },
  });
}

const WRITE_SPECIAL_PATHS_SCRIPT =
  "const fs=require('fs');" +
  "fs.mkdirSync('src',{recursive:true});" +
  "fs.writeFileSync('src/new-feature.ts','export const value = 1;\\n');" +
  "fs.writeFileSync('src/R&D.ts','export const ampersand = true;\\n');" +
  "fs.writeFileSync('src/R&D feature.ts','export const feature = true;\\n');" +
  "fs.writeFileSync('README.md','changed\\n');";

function controllerGraph(
  overrides: Partial<GraphDefinition> = {}
): GraphDefinition {
  return {
    id: "controller_guard_test",
    version: "0.1.0",
    runtime: {
      maxTotalSteps: 8,
      maxFixAttempts: 2,
      workspace: { mode: "local" },
    },
    nodes: [
      {
        id: "run_tests",
        type: "execute",
        backend: "shell",
        command: {
          program: "cmd",
          args: ["/c", "echo TESTS FAILED && exit 1"],
        },
      },
      {
        id: "after_tests",
        type: "controller",
        model: "deepseek-chat",
        apiKey: "test-key",
        readiness: { mode: "all_required" },
        inputs: {
          test_result: { required: true },
        },
        outputs: {
          end_success: { description: "Tests passed" },
          end_failed: { description: "Tests failed" },
        },
        outputGuards: {
          end_success: "{{nodes.run_tests.exitCode == 0}}",
          end_failed: "true",
        },
        promptTemplate: "Choose next output.",
        limits: { minConfidence: 0.6 },
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
      {
        id: "end_failed",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_failed"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "run_tests.inputs.trigger" },
      { from: "run_tests.outputs.done", to: "after_tests.inputs.test_result" },
      { from: "after_tests.outputs.end_success", to: "end_success.inputs.trigger" },
      { from: "after_tests.outputs.end_failed", to: "end_failed.inputs.trigger" },
    ],
    ...overrides,
  };
}

test("local workspace defaults to the process project root, not the graph file directory", async () => {
  const graphPath = resolve("examples/simple-test.yaml");
  const graph = GraphLoader.load(graphPath);

  const result = await Scheduler.run(graph, graphPath);

  assert.equal(result.workspace?.mode, "local");
  assert.equal(result.workspace?.path, process.cwd());
});

test("graph loader normalizes documented snake_case runtime limits", () => {
  const graph = GraphLoader.validate(
    {
      id: "runtime_limits",
      version: "0.1.0",
      runtime: {
        max_total_steps: 7,
        max_fix_attempts: 2,
        workspace: { mode: "local" },
      },
      nodes: [
        {
          id: "end_success",
          type: "execute",
          backend: "internal",
          command: { program: "internal", args: ["finish_success"] },
        },
      ],
      edges: [{ from: "graph.start", to: "end_success.inputs.trigger" }],
    },
    "inline"
  );

  assert.equal(graph.runtime?.maxTotalSteps, 7);
  assert.equal(graph.runtime?.maxFixAttempts, 2);
});

test("graph loader rejects all_required joins fed by mutually exclusive controller outputs", () => {
  assert.throws(
    () =>
      GraphLoader.validate(
        {
          id: "mutually_exclusive_join",
          version: "0.1.0",
          runtime: {
            workspace: { mode: "local" },
          },
          nodes: [
            {
              id: "branch",
              type: "controller",
              model: "deepseek-chat",
              readiness: { mode: "all_required" },
              inputs: {},
              outputs: {
                left: { description: "left branch" },
                right: { description: "right branch" },
              },
              promptTemplate: "Choose one branch.",
            },
            {
              id: "join",
              type: "controller",
              model: "deepseek-chat",
              readiness: { mode: "all_required" },
              inputs: {
                left_result: { required: true },
                right_result: { required: true },
              },
              outputs: {
                end_success: { description: "finish" },
              },
              promptTemplate: "Join both branches.",
            },
            {
              id: "end_success",
              type: "execute",
              backend: "internal",
              command: { program: "internal", args: ["finish_success"] },
            },
          ],
          edges: [
            { from: "graph.start", to: "branch.inputs.trigger" },
            { from: "branch.outputs.left", to: "join.inputs.left_result" },
            { from: "branch.outputs.right", to: "join.inputs.right_result" },
            { from: "join.outputs.end_success", to: "end_success.inputs.trigger" },
          ],
        },
        "inline"
      ),
    /may deadlock because required inputs come from mutually exclusive paths/
  );
});

test("git execute backend runs configured git commands in the workspace", async () => {
  const tempRoot = tempDir("agentgraph-git-backend");

  try {
    execFileSync("git", ["init"], { cwd: tempRoot });
    execFileSync("git", ["config", "core.autocrlf", "false"], {
      cwd: tempRoot,
    });
    writeFileSync(resolve(tempRoot, "tracked.txt"), "initial\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: tempRoot });
    execFileSync("git", ["commit", "-m", "initial"], {
      cwd: tempRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "AgentGraph Test",
        GIT_AUTHOR_EMAIL: "agentgraph@example.test",
        GIT_COMMITTER_NAME: "AgentGraph Test",
        GIT_COMMITTER_EMAIL: "agentgraph@example.test",
      },
    });
    writeFileSync(resolve(tempRoot, "tracked.txt"), "changed\n", "utf-8");

    const graph: GraphDefinition = {
      id: "git_backend_status_test",
      version: "0.1.0",
      runtime: {
        maxTotalSteps: 3,
        workspace: { mode: "local" },
      },
      nodes: [
        {
          id: "git_status",
          type: "execute",
          backend: "git",
          command: {
            program: "git",
            args: ["status", "--short"],
            cwd: tempRoot,
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
        { from: "graph.start", to: "git_status.inputs.trigger" },
        { from: "git_status.outputs.done", to: "end_success.inputs.trigger" },
      ],
    };

    const result = await Scheduler.run(
      graph,
      resolve(tempRoot, "git-backend.yaml")
    );
    const gitActivation = result.activations.find(
      (activation) => activation.nodeId === "git_status"
    );

    assert.equal(result.status, "success");
    assert.match(gitActivation?.rawResult?.stdout ?? "", /M tracked\.txt/);
    assert.equal(gitActivation?.rawResult?.backend, "git");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("worktree workspace exports patches that include tracked and untracked files", async () => {
  const tempRoot = tempDir("agentgraph-worktree-patch");
  const originalCwd = process.cwd();

  try {
    commitInitialReadme(tempRoot);

    process.chdir(tempRoot);

    const graph: GraphDefinition = {
      id: "worktree_patch_export_test",
      version: "0.1.0",
      runtime: {
        maxTotalSteps: 3,
        workspace: { mode: "worktree" },
      },
      nodes: [
        {
          id: "edit_files",
          type: "execute",
          backend: "shell",
          command: {
            program: "node",
            args: ["-e", WRITE_SPECIAL_PATHS_SCRIPT],
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
        { from: "graph.start", to: "edit_files.inputs.trigger" },
        { from: "edit_files.outputs.done", to: "end_success.inputs.trigger" },
      ],
    };

    const result = await Scheduler.run(
      graph,
      resolve(tempRoot, "worktree-patch.yaml")
    );

    assert.equal(result.status, "success");
    assert.equal(existsSync(resolve(tempRoot, "src", "new-feature.ts")), false);
    assert.ok(result.workspace?.changedFiles?.includes("README.md"));
    assert.ok(result.workspace?.changedFiles?.includes("src/new-feature.ts"));
    assert.ok(result.workspace?.changedFiles?.includes("src/R&D.ts"));
    assert.ok(result.workspace?.changedFiles?.includes("src/R&D feature.ts"));
    assert.ok(result.workspace?.patchPath);
    assert.equal(existsSync(result.workspace.patchPath), true);

    const patch = readFileSync(result.workspace.patchPath, "utf-8");
    assert.match(patch, /diff --git a\/README\.md b\/README\.md/);
    assert.match(
      patch,
      /diff --git a\/src\/new-feature\.ts b\/src\/new-feature\.ts/
    );
    assert.match(patch, /diff --git a\/src\/R&D\.ts b\/src\/R&D\.ts/);
    assert.match(
      patch,
      /diff --git a\/src\/R&D feature\.ts b\/src\/R&D feature\.ts/
    );
    assert.match(patch, /new file mode/);
    assert.match(patch, /\+export const value = 1;/);
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("local workspace exports patches for untracked files with shell special characters", async () => {
  const tempRoot = tempDir("agentgraph-local-patch");
  const originalCwd = process.cwd();

  try {
    commitInitialReadme(tempRoot);

    process.chdir(tempRoot);

    const graph: GraphDefinition = {
      id: "local_patch_export_test",
      version: "0.1.0",
      runtime: {
        maxTotalSteps: 3,
        workspace: { mode: "local" },
      },
      nodes: [
        {
          id: "edit_files",
          type: "execute",
          backend: "shell",
          command: {
            program: "node",
            args: ["-e", WRITE_SPECIAL_PATHS_SCRIPT],
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
        { from: "graph.start", to: "edit_files.inputs.trigger" },
        { from: "edit_files.outputs.done", to: "end_success.inputs.trigger" },
      ],
    };

    const result = await Scheduler.run(
      graph,
      resolve(tempRoot, "local-patch.yaml")
    );

    assert.equal(result.status, "success");
    assert.ok(result.workspace?.changedFiles?.includes("src/R&D.ts"));
    assert.ok(result.workspace?.changedFiles?.includes("src/R&D feature.ts"));
    assert.ok(result.workspace?.patchPath);
    assert.equal(existsSync(result.workspace.patchPath), true);

    const patch = readFileSync(result.workspace.patchPath, "utf-8");
    assert.match(patch, /diff --git a\/src\/R&D\.ts b\/src\/R&D\.ts/);
    assert.match(
      patch,
      /diff --git a\/src\/R&D feature\.ts b\/src\/R&D feature\.ts/
    );
    assert.match(patch, /\+export const ampersand = true;/);
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("controller output guard blocks end_success when test command failed", async () => {
  const graph = controllerGraph();

  const result = await withMockController(
    {
      selected_output: "end_success",
      reason: "Pretend the tests passed",
      confidence: 0.95,
      payload: {},
    },
    () => Scheduler.run(graph, resolve("examples/controller-guard.yaml"))
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /output guard failed/);
});

test("controller confidence below minConfidence blocks automatic routing", async () => {
  const graph = controllerGraph({
    id: "controller_confidence_test",
    nodes: [
      {
        id: "run_tests",
        type: "execute",
        backend: "shell",
        command: {
          program: "cmd",
          args: ["/c", "echo TESTS PASSED && exit 0"],
        },
      },
      ...(controllerGraph().nodes.slice(1)),
    ],
  });

  const result = await withMockController(
    {
      selected_output: "end_success",
      reason: "Low-confidence pass",
      confidence: 0.2,
      payload: {},
    },
    () => Scheduler.run(graph, resolve("examples/controller-confidence.yaml"))
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /confidence 0\.2 below minimum 0\.6/);
});

test("controller decision must include numeric confidence", async () => {
  const graph: GraphDefinition = {
    id: "controller_decision_schema_test",
    version: "0.1.0",
    runtime: {
      maxTotalSteps: 5,
      workspace: { mode: "local" },
    },
    nodes: [
      {
        id: "route",
        type: "controller",
        model: "deepseek-chat",
        apiKey: "test-key",
        readiness: { mode: "all_required" },
        inputs: {},
        outputs: {
          end_success: { description: "Finish successfully" },
        },
        promptTemplate: "Finish.",
        limits: { minConfidence: 0 },
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "route.inputs.trigger" },
      { from: "route.outputs.end_success", to: "end_success.inputs.trigger" },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                selected_output: "end_success",
                reason: "Missing confidence must be rejected",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  try {
    const result = await Scheduler.run(
      graph,
      resolve("examples/controller-decision-schema.yaml")
    );

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /missing numeric "confidence"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selected controller payload is available to the next execute node", async () => {
  const graph: GraphDefinition = {
    id: "controller_payload_test",
    version: "0.1.0",
    runtime: {
      maxTotalSteps: 5,
      workspace: { mode: "local" },
    },
    nodes: [
      {
        id: "route",
        type: "controller",
        model: "deepseek-chat",
        apiKey: "test-key",
        readiness: { mode: "all_required" },
        inputs: {},
        outputs: {
          inspect: { description: "Inspect payload" },
        },
        promptTemplate: "Route to inspect.",
      },
      {
        id: "echo_payload",
        type: "execute",
        backend: "shell",
        command: {
          program: "cmd",
          args: ["/c", "echo {{controller.payload.focus}}"],
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
      { from: "graph.start", to: "route.inputs.trigger" },
      { from: "route.outputs.inspect", to: "echo_payload.inputs.trigger" },
      { from: "echo_payload.outputs.done", to: "end_success.inputs.trigger" },
    ],
  };

  const result = await withMockController(
    {
      selected_output: "inspect",
      reason: "Payload should flow downstream",
      confidence: 0.95,
      payload: { focus: "needle" },
    },
    () => Scheduler.run(graph, resolve("examples/controller-payload.yaml"))
  );

  const echoActivation = result.activations.find(
    (activation) => activation.nodeId === "echo_payload"
  );
  const controllerInput = {
    nodeId: "route",
    selected_output: "inspect",
    reason: "Payload should flow downstream",
    confidence: 0.95,
    payload: { focus: "needle" },
  };
  assert.equal(result.status, "success");
  assert.match(echoActivation?.rawResult?.stdout ?? "", /needle/);
  assert.deepEqual(echoActivation?.inputs.controllerInput, controllerInput);
  assert.deepEqual(echoActivation?.promptAssembly?.controllerInput, controllerInput);
});

test("controller waits until all required inputs have arrived", async () => {
  const graph: GraphDefinition = {
    id: "controller_readiness_test",
    version: "0.1.0",
    runtime: {
      maxTotalSteps: 8,
      workspace: { mode: "local" },
    },
    nodes: [
      {
        id: "first",
        type: "execute",
        backend: "shell",
        command: {
          program: "cmd",
          args: ["/c", "echo first"],
        },
      },
      {
        id: "second",
        type: "execute",
        backend: "shell",
        command: {
          program: "cmd",
          args: ["/c", "echo second"],
        },
      },
      {
        id: "join",
        type: "controller",
        model: "deepseek-chat",
        apiKey: "test-key",
        readiness: { mode: "all_required" },
        inputs: {
          first_result: { required: true },
          second_result: { required: true },
        },
        outputs: {
          end_success: { description: "All inputs arrived" },
        },
        promptTemplate: "Route after both inputs are ready.",
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "first.inputs.trigger" },
      { from: "first.outputs.done", to: "join.inputs.first_result" },
      { from: "first.outputs.done", to: "second.inputs.trigger" },
      { from: "second.outputs.done", to: "join.inputs.second_result" },
      { from: "join.outputs.end_success", to: "end_success.inputs.trigger" },
    ],
  };

  const result = await withMockController(
    {
      selected_output: "end_success",
      reason: "Both inputs are available",
      confidence: 0.95,
      payload: {},
    },
    () => Scheduler.run(graph, resolve("examples/controller-readiness.yaml"))
  );

  const secondIndex = result.activations.findIndex(
    (activation) => activation.nodeId === "second"
  );
  const joinIndex = result.activations.findIndex(
    (activation) => activation.nodeId === "join"
  );

  assert.equal(result.status, "success");
  assert.ok(secondIndex >= 0);
  assert.ok(joinIndex >= 0);
  assert.ok(secondIndex < joinIndex);
});

test("controller terminal outputs still route through declared internal end nodes", async () => {
  const graph: GraphDefinition = {
    id: "controller_terminal_route_test",
    version: "0.1.0",
    runtime: {
      maxTotalSteps: 5,
      workspace: { mode: "local" },
    },
    nodes: [
      {
        id: "route",
        type: "controller",
        model: "deepseek-chat",
        apiKey: "test-key",
        readiness: { mode: "all_required" },
        inputs: {},
        outputs: {
          end_success: { description: "Finish successfully" },
        },
        promptTemplate: "Finish.",
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "route.inputs.trigger" },
      { from: "route.outputs.end_success", to: "end_success.inputs.trigger" },
    ],
  };

  const result = await withMockController(
    {
      selected_output: "end_success",
      reason: "Done",
      confidence: 0.95,
      payload: {},
    },
    () => Scheduler.run(graph, resolve("examples/controller-terminal.yaml"))
  );

  assert.equal(result.status, "success");
  assert.ok(
    result.activations.some((activation) => activation.nodeId === "end_success")
  );
});
