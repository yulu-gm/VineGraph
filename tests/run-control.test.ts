import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../src/scheduler.js";
import type {
  GraphDefinition,
  SchedulerEvent,
  TerminalSessionHandle,
} from "../src/types.js";

function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeCliPath(root: string, name: string): string {
  return join(root, process.platform === "win32" ? `${name}.cmd` : name);
}

function writeFakeCli(path: string, windowsLines: string[], posixLines: string[]): void {
  if (process.platform === "win32") {
    writeFileSync(path, [...windowsLines, ""].join("\r\n"), "utf-8");
    return;
  }

  writeFileSync(path, ["#!/bin/sh", ...posixLines, ""].join("\n"), "utf-8");
  chmodSync(path, 0o755);
}

function writeFakeCodexCli(
  path: string,
  options: {
    stdout?: string[];
    stderr?: string[];
    finalMessage: string;
  }
): void {
  const scriptPath = `${path}.mjs`;
  writeFileSync(
    scriptPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `const stdout = ${JSON.stringify(options.stdout ?? [])};`,
      `const stderr = ${JSON.stringify(options.stderr ?? [])};`,
      `const finalMessage = ${JSON.stringify(options.finalMessage)};`,
      "let outputPath = '';",
      "for (let index = 0; index < process.argv.length; index += 1) {",
      "  if (process.argv[index] === '--output-last-message') {",
      "    outputPath = process.argv[index + 1] || '';",
      "  }",
      "}",
      "for (const line of stdout) console.log(line);",
      "for (const line of stderr) console.error(line);",
      "if (outputPath) writeFileSync(outputPath, `${finalMessage}\\n`, 'utf8');",
      "",
    ].join("\n"),
    "utf-8"
  );
  writeFakeCli(
    path,
    ["@echo off", "node \"%~dp0codex.cmd.mjs\" %*", "exit /b %errorlevel%"],
    [`node ${JSON.stringify(scriptPath)} "$@"`, "exit 0"]
  );
}

function shellCommand(command: string): { program: string; args: string[] } {
  return process.platform === "win32"
    ? { program: "cmd", args: ["/c", command] }
    : { program: "sh", args: ["-lc", command] };
}

test("scheduler streams codex stdout and stderr events to UI subscribers", async () => {
  const tempRoot = tempDir("agentgraph-codex-stream");
  const fakeCodex = fakeCliPath(tempRoot, "codex");
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

  writeFakeCodexCli(
    fakeCodex,
    {
      stdout: ["CODEX_STDOUT_VISIBLE"],
      stderr: ["CODEX_STDERR_VISIBLE"],
      finalMessage: "CODEX_STDOUT_VISIBLE",
    }
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
          event.stream === "stdout" &&
          event.chunk.includes("CODEX_STDERR_VISIBLE")
      )
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "terminal:output" &&
          event.nodeId === "codex_node" &&
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

test("scheduler streams terminal PTY output events for execute nodes", async () => {
  const graph: GraphDefinition = {
    id: "terminal_event_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 2, workspace: { mode: "local" } },
    nodes: [
      {
        id: "shell_node",
        type: "execute",
        backend: "shell",
        command: shellCommand(
          process.platform === "win32"
            ? "echo TERM_EVENT"
            : "printf 'TERM_EVENT\\n'"
        ),
      },
    ],
    edges: [{ from: "graph.start", to: "shell_node.inputs.trigger" }],
  };
  const events: SchedulerEvent[] = [];

  const result = await Scheduler.run(graph, "terminal-event.yaml", {
    onEvent: (event) => events.push(event),
  });
  const activation = result.activations.find(
    (item) => item.nodeId === "shell_node"
  );
  const activationId = activation?.activationId;
  assert.ok(activationId, "shell_node activation should exist");
  const startedIndex = events.findIndex(
    (event) =>
      event.type === "terminal:started" &&
      event.activationId === activationId
  );
  const outputIndex = events.findIndex(
    (event) =>
      event.type === "terminal:output" &&
      event.activationId === activationId &&
      event.chunk.includes("TERM_EVENT")
  );
  const endedEvents = events.filter(
    (event) =>
      event.type === "terminal:ended" &&
      event.activationId === activationId
  );
  const endedIndex = events.findIndex(
    (event) =>
      event.type === "terminal:ended" &&
      event.activationId === activationId
  );

  assert.equal(result.status, "success");
  assert.ok(startedIndex >= 0, "expected terminal:started");
  assert.ok(outputIndex >= 0, "expected terminal:output with TERM_EVENT");
  assert.equal(
    (events[startedIndex] as { terminalSessionId?: string }).terminalSessionId,
    activation?.terminalSessionId
  );
  assert.equal(
    (events[outputIndex] as { terminalSessionId?: string }).terminalSessionId,
    activation?.terminalSessionId
  );
  assert.equal(endedEvents.length, 1);
  assert.equal(endedEvents[0]?.exitCode, 0);
  assert.equal(
    (endedEvents[0] as { terminalSessionId?: string }).terminalSessionId,
    activation?.terminalSessionId
  );
  assert.ok(endedIndex >= 0, "expected terminal:ended");
  assert.ok(
    startedIndex < outputIndex && outputIndex < endedIndex,
    "expected terminal events to be ordered start < output < end"
  );
  assert.match(
    activation?.rawResult?.terminalTranscript ?? "",
    /TERM_EVENT/
  );
});

test("scheduler keeps legacy node output ansi-free when terminal escape sequences split across chunks", async () => {
  const graph: GraphDefinition = {
    id: "terminal_legacy_output_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 2, workspace: { mode: "local" } },
    nodes: [
      {
        id: "split_ansi",
        type: "execute",
        backend: "shell",
        command: {
          program: process.execPath,
          args: [
            "-e",
            "process.stdout.write('\\x1b['); setTimeout(() => process.stdout.write('31mM\\x1b[0m file\\n'), 50);",
          ],
        },
      },
    ],
    edges: [{ from: "graph.start", to: "split_ansi.inputs.trigger" }],
  };
  const nodeOutputChunks: string[] = [];

  const result = await Scheduler.run(graph, "terminal-legacy-output.yaml", {
    onEvent: (event) => {
      if (event.type === "node:output" && event.nodeId === "split_ansi") {
        nodeOutputChunks.push(event.chunk);
      }
    },
  });

  assert.equal(result.status, "success");
  assert.equal(
    nodeOutputChunks.some((chunk) => /\u001B/.test(chunk)),
    false
  );
  assert.match(nodeOutputChunks.join(""), /M file/);
});

test("scheduler treats terminal execution timeout as failure, not user cancellation", async () => {
  const graph: GraphDefinition = {
    id: "terminal_timeout_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 2, workspace: { mode: "local" } },
    nodes: [
      {
        id: "slow_shell",
        type: "execute",
        backend: "shell",
        command: shellCommand(
          process.platform === "win32"
            ? "ping -n 3 127.0.0.1 > nul && echo SHOULD_NOT_PRINT"
            : "sleep 2; printf 'SHOULD_NOT_PRINT\\n'"
        ),
        execution: { timeoutMs: 100 },
      },
    ],
    edges: [{ from: "graph.start", to: "slow_shell.inputs.trigger" }],
  };
  const events: SchedulerEvent[] = [];

  const result = await Scheduler.run(graph, "terminal-timeout.yaml", {
    onEvent: (event) => events.push(event),
  });
  const activation = result.activations.find(
    (item) => item.nodeId === "slow_shell"
  );
  const timeoutText = `${activation?.error ?? ""}\n${activation?.rawResult?.stderr ?? ""}`;

  assert.equal(result.status, "failed");
  assert.equal(activation?.status, "failed");
  assert.equal(activation?.rawResult?.exitCode, -1);
  assert.equal(activation?.rawResult?.aborted, false);
  assert.equal(activation?.rawResult?.timedOut, true);
  assert.match(timeoutText, /timed out|timeout/i);
  assert.doesNotMatch(timeoutText, /cancelled by user/i);
  assert.ok(
    events.some(
      (event) =>
        event.type === "terminal:ended" &&
        event.nodeId === "slow_shell" &&
        event.exitCode === -1
    )
  );
});

test("scheduler registers and unregisters the same terminal session with activation identity", async () => {
  const runId = "terminal-session-registry-run";
  const graph: GraphDefinition = {
    id: "terminal_session_registry_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 2, workspace: { mode: "local" } },
    nodes: [
      {
        id: "shell_node",
        type: "execute",
        backend: "shell",
        command: shellCommand(
          process.platform === "win32"
            ? "echo SESSION_EVENT"
            : "printf 'SESSION_EVENT\\n'"
        ),
      },
    ],
    edges: [{ from: "graph.start", to: "shell_node.inputs.trigger" }],
  };
  let registeredSession: TerminalSessionHandle | undefined;
  let unregisteredSession: TerminalSessionHandle | undefined;
  let registerInfo:
    | { runId?: string; activationId: string; nodeId: string }
    | undefined;
  let unregisterInfo:
    | { runId?: string; activationId: string; nodeId: string }
    | undefined;

  const result = await Scheduler.run(graph, "terminal-session-registry.yaml", {
    runId,
    registerSession: (session, info) => {
      registeredSession = session;
      registerInfo = info;
    },
    unregisterSession: (session, info) => {
      unregisteredSession = session;
      unregisterInfo = info;
    },
  });
  const activation = result.activations.find(
    (item) => item.nodeId === "shell_node"
  );

  assert.equal(result.status, "success");
  assert.ok(registeredSession, "expected terminal session registration");
  assert.strictEqual(unregisteredSession, registeredSession);
  assert.equal(registerInfo?.runId, runId);
  assert.equal(unregisterInfo?.runId, runId);
  assert.equal(registerInfo?.activationId, activation?.activationId);
  assert.equal(unregisterInfo?.activationId, activation?.activationId);
  assert.equal(registerInfo?.nodeId, "shell_node");
  assert.equal(unregisterInfo?.nodeId, "shell_node");
});

test("scheduler records terminal session id on terminal-backed execute activations", async () => {
  const runId = "terminal-session-id-run";
  const tempRoot = tempDir("terminal-session-id");
  const graph: GraphDefinition = {
    id: "terminal_session_id_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 2, workspace: { mode: "local" } },
    nodes: [
      {
        id: "shell_node",
        type: "execute",
        backend: "shell",
        command: shellCommand(
          process.platform === "win32"
            ? "echo SESSION_ID"
            : "printf 'SESSION_ID\\n'"
        ),
      },
    ],
    edges: [{ from: "graph.start", to: "shell_node.inputs.trigger" }],
  };
  let registerInfo:
    | { terminalSessionId?: string; activationId: string; nodeId: string }
    | undefined;
  let unregisterInfo:
    | { terminalSessionId?: string; activationId: string; nodeId: string }
    | undefined;

  try {
    const result = await Scheduler.run(graph, "terminal-session-id.yaml", {
      runId,
      workspacePath: tempRoot,
      workspaceMode: "directory",
      workspaceGitEnabled: false,
      registerSession: (_session, info) => {
        registerInfo = info;
      },
      unregisterSession: (_session, info) => {
        unregisterInfo = info;
      },
    });
    const activation = result.activations.find(
      (item) => item.nodeId === "shell_node"
    );

    assert.equal(result.status, "success");
    assert.match(activation?.terminalSessionId ?? "", /^term_/);
    assert.equal(
      activation?.rawResult?.terminalSessionId,
      activation?.terminalSessionId
    );
    assert.equal(registerInfo?.terminalSessionId, activation?.terminalSessionId);
    assert.equal(unregisterInfo?.terminalSessionId, activation?.terminalSessionId);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler stores rendered prompts on execute and controller activations", async () => {
  const tempRoot = tempDir("agentgraph-rendered-prompts");
  const fakeCodex = fakeCliPath(tempRoot, "codex");
  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;
  const originalFetch = globalThis.fetch;

  writeFakeCodexCli(
    fakeCodex,
    {
      stdout: ["CODEX_DONE_FOR_PROMPT"],
      finalMessage: "CODEX_DONE_FOR_PROMPT",
    }
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
  const fakeCodex = fakeCliPath(tempRoot, "codex");
  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;

  writeFakeCli(
    fakeCodex,
    [
      "@echo off",
      "ping -n 2 127.0.0.1 > nul",
      "more",
      "exit /b 0",
    ],
    [
      "sleep 1",
      "cat",
      "exit 0",
    ]
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
  const fakeCodex = fakeCliPath(tempRoot, "codex");
  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;

  writeFakeCli(
    fakeCodex,
    [
      "@echo off",
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$p = [Console]::In.ReadToEnd(); if ($p -match 'fail-a') { Write-Output 'fail-a'; exit 1 }; Start-Sleep -Milliseconds 500; Write-Output 'ok-b'; exit 0\"",
      "exit /b %errorlevel%",
    ],
    [
      "payload=$(cat)",
      "case \"$payload\" in",
      "  *fail-a*) echo fail-a; exit 1 ;;",
      "esac",
      "sleep 1",
      "echo ok-b",
      "exit 0",
    ]
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
        command: shellCommand(
          process.platform === "win32"
            ? "ping -n 8 127.0.0.1 > nul && echo SHOULD_NOT_FINISH"
            : "sleep 8 && echo SHOULD_NOT_FINISH"
        ),
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
