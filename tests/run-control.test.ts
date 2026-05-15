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
