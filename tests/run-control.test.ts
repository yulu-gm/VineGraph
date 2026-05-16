import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../src/scheduler.js";
import type { GraphDefinition, SchedulerEvent } from "../src/types.js";

function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("scheduler streams codex stdout and stderr events to UI subscribers", async () => {
  const tempRoot = tempDir("agentgraph-codex-stream");
  const fakeCodex = join(tempRoot, "codex.cmd");
  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let parentStdout = "";
  let parentStderr = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    parentStdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    parentStderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  writeFileSync(
    fakeCodex,
    [
      "@echo off",
      "echo CODEX_STDOUT_VISIBLE",
      "echo CODEX_STDERR_VISIBLE 1>&2",
      "exit /b 0",
      "",
    ].join("\r\n"),
    "utf-8"
  );

  const graph: GraphDefinition = {
    id: "codex_stream_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 3, workspace: { mode: "local" } },
    nodes: [
      {
        id: "codex_node",
        type: "execute",
        backend: "codex",
        promptTemplate: "stream output",
        execution: { model: "gpt-5.5", reasoningEffort: "high" },
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "codex_node.inputs.trigger" },
      { from: "codex_node.outputs.done", to: "end_success.inputs.trigger" },
    ],
  };

  const events: SchedulerEvent[] = [];

  try {
    const result = await Scheduler.run(graph, join(tempRoot, "codex-stream.yaml"), {
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.status, "success");
    assert.ok(
      events.some(
        (event) =>
          event.type === "node:output" &&
          event.nodeId === "codex_node" &&
          event.backend === "codex" &&
          event.stream === "stdout" &&
          event.chunk.includes("CODEX_STDOUT_VISIBLE")
      )
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "node:output" &&
          event.nodeId === "codex_node" &&
          event.backend === "codex" &&
          event.stream === "stderr" &&
          event.chunk.includes("CODEX_STDERR_VISIBLE")
      )
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "node:completed" &&
          event.activation.nodeId === "codex_node" &&
          event.activation.rawResult?.stdout.includes("CODEX_STDOUT_VISIBLE")
      )
    );
    assert.doesNotMatch(parentStdout, /CODEX_STDOUT_VISIBLE/);
    assert.doesNotMatch(parentStderr, /CODEX_STDERR_VISIBLE/);
  } finally {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    if (previousPath === undefined) {
      delete process.env.AGENTGRAPH_CODEX_PATH;
    } else {
      process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler stores rendered prompts on execute and controller activations", async () => {
  const tempRoot = tempDir("agentgraph-rendered-prompts");
  const fakeCodex = join(tempRoot, "codex.cmd");
  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;
  const originalFetch = globalThis.fetch;

  writeFileSync(
    fakeCodex,
    [
      "@echo off",
      "echo CODEX_DONE_FOR_PROMPT",
      "exit /b 0",
      "",
    ].join("\r\n"),
    "utf-8"
  );

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                selected_output: "end_success",
                reason: "prompt captured",
                confidence: 0.9,
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const graph: GraphDefinition = {
    id: "prompt_visibility_graph",
    version: "0.1.0",
    inputs: {
      task: { type: "string", default: "ship prompt visibility" },
    },
    runtime: { maxTotalSteps: 4, workspace: { mode: "local" } },
    nodes: [
      {
        id: "implement_feature",
        type: "execute",
        backend: "codex",
        promptTemplate: "Implement {{inputs.task}} in {{workspace.path}}",
        execution: { model: "gpt-5.5", reasoningEffort: "high" },
      },
      {
        id: "review_gate",
        type: "controller",
        model: "deepseek-chat",
        apiKey: "test-key",
        readiness: { mode: "all_required" },
        inputs: { trigger: { required: true } },
        outputs: { end_success: { description: "finish" } },
        promptTemplate: "Review output: {{nodes.implement_feature.stdout}}",
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "implement_feature.inputs.trigger" },
      { from: "implement_feature.outputs.done", to: "review_gate.inputs.trigger" },
      { from: "review_gate.outputs.end_success", to: "end_success.inputs.trigger" },
    ],
  };

  try {
    const result = await Scheduler.run(graph, join(tempRoot, "prompt-visibility.yaml"));
    const implementActivation = result.activations.find((item) => item.nodeId === "implement_feature");
    const gateActivation = result.activations.find((item) => item.nodeId === "review_gate");
    const implementPromptTemplate = "Implement {{inputs.task}} in {{workspace.path}}";

    assert.deepEqual(implementActivation?.inputs.controllerInput, {});
    assert.equal(implementActivation?.inputs.promptTemplate, implementPromptTemplate);
    assert.deepEqual(implementActivation?.promptAssembly?.controllerInput, {});
    assert.equal(implementActivation?.promptAssembly?.promptTemplate, implementPromptTemplate);
    assert.match(implementActivation?.promptAssembly?.renderedPrompt ?? "", /Implement ship prompt visibility/);
    assert.match(implementActivation?.renderedPrompt ?? "", /Implement ship prompt visibility/);
    assert.match(implementActivation?.renderedPrompt ?? "", new RegExp(escapeRegExp(process.cwd())));
    assert.match(gateActivation?.renderedPrompt ?? "", /Review output: CODEX_DONE_FOR_PROMPT/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousPath === undefined) {
      delete process.env.AGENTGRAPH_CODEX_PATH;
    } else {
      process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler runs enforced read-only codex frontier nodes concurrently", async () => {
  const tempRoot = tempDir("agentgraph-read-frontier");
  const fakeCodex = join(tempRoot, "codex.cmd");
  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;

  writeFileSync(
    fakeCodex,
    [
      "@echo off",
      "ping -n 2 127.0.0.1 > nul",
      "more",
      "exit /b 0",
      "",
    ].join("\r\n"),
    "utf-8"
  );

  const graph: GraphDefinition = {
    id: "read_frontier_parallel",
    version: "0.1.0",
    runtime: { maxTotalSteps: 3, workspace: { mode: "local" } },
    nodes: [
      {
        id: "review_a",
        type: "execute",
        backend: "codex",
        promptTemplate: "review-a",
        execution: { workspaceAccess: "read", timeoutMs: 10_000 },
      },
      {
        id: "review_b",
        type: "execute",
        backend: "codex",
        promptTemplate: "review-b",
        execution: { workspaceAccess: "read", timeoutMs: 10_000 },
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "review_a.inputs.trigger" },
      { from: "graph.start", to: "review_b.inputs.trigger" },
      { from: "review_a.outputs.done", to: "end_success.inputs.trigger" },
      { from: "review_b.outputs.done", to: "end_success.inputs.trigger" },
    ],
  };

  const events: SchedulerEvent[] = [];

  try {
    const result = await Scheduler.run(graph, join(tempRoot, "read-frontier.yaml"), {
      onEvent: (event) => events.push(event),
    });
    const reviewA = result.activations.find((item) => item.nodeId === "review_a");
    const reviewB = result.activations.find((item) => item.nodeId === "review_b");
    const reviewAStartedIndex = events.findIndex(
      (event) => event.type === "node:started" && event.activation.nodeId === "review_a"
    );
    const reviewBStartedIndex = events.findIndex(
      (event) => event.type === "node:started" && event.activation.nodeId === "review_b"
    );
    const firstCompletedIndex = events.findIndex(
      (event) =>
        event.type === "node:completed" &&
        (event.activation.nodeId === "review_a" || event.activation.nodeId === "review_b")
    );

    assert.equal(result.status, "success");
    assert.match(reviewA?.rawResult?.stdout ?? "", /review-a/);
    assert.match(reviewB?.rawResult?.stdout ?? "", /review-b/);
    assert.ok(reviewA, "review_a activation should exist");
    assert.ok(reviewB, "review_b activation should exist");
    assert.ok(
      reviewAStartedIndex >= 0 && reviewBStartedIndex >= 0 && firstCompletedIndex >= 0,
      "expected started and completed events for both review nodes"
    );
    assert.ok(
      reviewAStartedIndex < firstCompletedIndex && reviewBStartedIndex < firstCompletedIndex,
      "expected both codex read-only nodes to start before either completes"
    );
    assert.ok(
      Math.abs(reviewA.startedAt - reviewB.startedAt) < 500,
      `expected read-only codex nodes to start within 500ms, got ${Math.abs(reviewA.startedAt - reviewB.startedAt)}ms`
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGENTGRAPH_CODEX_PATH;
    } else {
      process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler records all completed parallel activations before failing the run", async () => {
  const tempRoot = tempDir("agentgraph-read-frontier-failure");
  const fakeCodex = join(tempRoot, "codex.cmd");
  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;

  writeFileSync(
    fakeCodex,
    [
      "@echo off",
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$p = [Console]::In.ReadToEnd(); if ($p -match 'fail-a') { Write-Output 'fail-a'; exit 1 }; Start-Sleep -Milliseconds 500; Write-Output 'ok-b'; exit 0\"",
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"),
    "utf-8"
  );

  const graph: GraphDefinition = {
    id: "read_frontier_failure_history",
    version: "0.1.0",
    runtime: { maxTotalSteps: 3, workspace: { mode: "local" } },
    nodes: [
      {
        id: "review_a",
        type: "execute",
        backend: "codex",
        promptTemplate: "review fail-a",
        execution: { workspaceAccess: "read", timeoutMs: 10_000 },
      },
      {
        id: "review_b",
        type: "execute",
        backend: "codex",
        promptTemplate: "review ok-b",
        execution: { workspaceAccess: "read", timeoutMs: 10_000 },
      },
    ],
    edges: [
      { from: "graph.start", to: "review_a.inputs.trigger" },
      { from: "graph.start", to: "review_b.inputs.trigger" },
    ],
  };

  const events: SchedulerEvent[] = [];

  try {
    const result = await Scheduler.run(graph, join(tempRoot, "read-frontier-failure.yaml"), {
      onEvent: (event) => events.push(event),
    });
    const completedEvents = events.filter(
      (event) => event.type === "node:completed"
    );
    const reviewA = result.activations.find((item) => item.nodeId === "review_a");
    const reviewB = result.activations.find((item) => item.nodeId === "review_b");

    assert.deepEqual(
      completedEvents.map((event) => event.activation.nodeId).sort(),
      ["review_a", "review_b"]
    );
    assert.equal(result.status, "failed");
    assert.equal(reviewA?.status, "failed");
    assert.match(reviewA?.rawResult?.stdout ?? "", /fail-a/);
    assert.equal(reviewB?.status, "succeeded");
    assert.match(reviewB?.rawResult?.stdout ?? "", /ok-b/);
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGENTGRAPH_CODEX_PATH;
    } else {
      process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler does not parallelize read-marked shell nodes because read access is not enforced", async () => {
  const tempRoot = tempDir("agentgraph-read-shell-sequential");
  const graph: GraphDefinition = {
    id: "read_shell_sequential",
    version: "0.1.0",
    runtime: { maxTotalSteps: 4, workspace: { mode: "local" } },
    nodes: [
      {
        id: "shell_a",
        type: "execute",
        backend: "shell",
        command: {
          program: process.execPath,
          args: ["-e", "setTimeout(() => console.log('shell-a'), 300)"],
        },
        execution: { workspaceAccess: "read", timeoutMs: 10_000 },
      },
      {
        id: "shell_b",
        type: "execute",
        backend: "shell",
        command: {
          program: process.execPath,
          args: ["-e", "setTimeout(() => console.log('shell-b'), 300)"],
        },
        execution: { workspaceAccess: "read", timeoutMs: 10_000 },
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "shell_a.inputs.trigger" },
      { from: "graph.start", to: "shell_b.inputs.trigger" },
      { from: "shell_a.outputs.done", to: "end_success.inputs.trigger" },
      { from: "shell_b.outputs.done", to: "end_success.inputs.trigger" },
    ],
  };

  const events: SchedulerEvent[] = [];

  try {
    const result = await Scheduler.run(graph, join(tempRoot, "read-shell-sequential.yaml"), {
      onEvent: (event) => events.push(event),
    });
    const shellA = result.activations.find((item) => item.nodeId === "shell_a");
    const shellB = result.activations.find((item) => item.nodeId === "shell_b");
    const shellACompletedIndex = events.findIndex(
      (event) => event.type === "node:completed" && event.activation.nodeId === "shell_a"
    );
    const shellBStartedIndex = events.findIndex(
      (event) => event.type === "node:started" && event.activation.nodeId === "shell_b"
    );

    assert.equal(result.status, "success");
    assert.match(shellA?.rawResult?.stdout ?? "", /shell-a/);
    assert.match(shellB?.rawResult?.stdout ?? "", /shell-b/);
    assert.ok(shellA, "shell_a activation should exist");
    assert.ok(shellB, "shell_b activation should exist");
    assert.ok(
      shellACompletedIndex >= 0 && shellBStartedIndex >= 0,
      "expected shell_a completion and shell_b start events"
    );
    assert.ok(
      shellACompletedIndex < shellBStartedIndex,
      "expected read-marked shell nodes to run sequentially"
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler cancellation aborts a running execute process and finalizes the run as cancelled", async () => {
  const controller = new AbortController();
  const graph: GraphDefinition = {
    id: "cancel_running_shell",
    version: "0.1.0",
    runtime: { maxTotalSteps: 3, workspace: { mode: "local" } },
    nodes: [
      {
        id: "slow_shell",
        type: "execute",
        backend: "shell",
        command: {
          program: "cmd",
          args: ["/c", "ping -n 8 127.0.0.1 > nul && echo SHOULD_NOT_FINISH"],
        },
        execution: { timeoutMs: 20_000 },
      },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "slow_shell.inputs.trigger" },
      { from: "slow_shell.outputs.done", to: "end_success.inputs.trigger" },
    ],
  };

  const events: SchedulerEvent[] = [];
  setTimeout(() => controller.abort(), 250);

  const result = await Scheduler.run(graph, "cancel-running-shell.yaml", {
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "cancelled");
  assert.match(result.error ?? "", /cancel/i);
  assert.ok(
    events.some(
      (event) =>
        event.type === "node:completed" &&
        event.activation.nodeId === "slow_shell" &&
        event.activation.status === "cancelled"
    )
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
