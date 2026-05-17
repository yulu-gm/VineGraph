import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActiveTerminalSessionSummaries,
  buildPersistedTerminalSessionSummaries,
  buildTerminalSessionAttachSnapshot,
} from "../src/terminal-attach.js";
import type { RunRecord } from "../src/types.js";

test("terminal attach snapshot is built from run history by session id and bounded", () => {
  const run: RunRecord = {
    runId: "run-attach",
    graphId: "graph",
    graphPath: "graph.vg.yaml",
    status: "success",
    startedAt: 1,
    finishedAt: 2,
    activations: [
      {
        activationId: "act-1",
        nodeId: "node_a",
        terminalSessionId: "term_a",
        status: "succeeded",
        inputs: {},
        iteration: 1,
        startedAt: 1,
        finishedAt: 2,
        rawResult: {
          activationId: "act-1",
          nodeId: "node_a",
          backend: "shell",
          terminalSessionId: "term_a",
          stdout: "",
          stderr: "",
          exitCode: 0,
          terminalTranscript: "0123456789ATTACH",
          terminalMode: "pty",
          startedAt: 1,
          finishedAt: 2,
          durationMs: 1,
        },
      },
    ],
  };

  const snapshot = buildTerminalSessionAttachSnapshot(run, "term_a", 8);

  assert.equal(snapshot?.runId, "run-attach");
  assert.equal(snapshot?.sessionId, "term_a");
  assert.equal(snapshot?.activationId, "act-1");
  assert.equal(snapshot?.nodeId, "node_a");
  assert.equal(snapshot?.backend, "shell");
  assert.equal(snapshot?.status, "exited");
  assert.equal(snapshot?.exitCode, 0);
  assert.equal(snapshot?.snapshot, "89ATTACH");
  assert.equal(snapshot?.truncated, true);
  assert.equal(snapshot?.snapshotMaxChars, 8);
  assert.equal(snapshot?.terminalMode, "pty");
  assert.equal(snapshot?.liveEventsUrl, "/api/runs/run-attach/events");
});

test("terminal attach snapshot bounds transcripts by Unicode characters", () => {
  const run: RunRecord = {
    runId: "run-attach-unicode",
    graphId: "graph",
    graphPath: "graph.vg.yaml",
    status: "success",
    startedAt: 1,
    finishedAt: 2,
    activations: [
      {
        activationId: "act-unicode",
        nodeId: "node_unicode",
        terminalSessionId: "term_unicode",
        status: "succeeded",
        inputs: {},
        iteration: 1,
        startedAt: 1,
        finishedAt: 2,
        rawResult: {
          activationId: "act-unicode",
          nodeId: "node_unicode",
          backend: "shell",
          terminalSessionId: "term_unicode",
          stdout: "",
          stderr: "",
          exitCode: 0,
          terminalTranscript: "A🙂B",
          terminalMode: "pty",
          startedAt: 1,
          finishedAt: 2,
          durationMs: 1,
        },
      },
    ],
  };

  const snapshot = buildTerminalSessionAttachSnapshot(run, "term_unicode", 2);

  assert.equal(snapshot?.snapshot, "🙂B");
  assert.equal(snapshot?.truncated, true);
});

test("terminal attach snapshot returns null for an unknown session id", () => {
  const run: RunRecord = {
    runId: "run-attach",
    graphId: "graph",
    graphPath: "graph.vg.yaml",
    status: "success",
    startedAt: 1,
    activations: [],
  };

  assert.equal(buildTerminalSessionAttachSnapshot(run, "missing"), null);
});

test("persisted terminal session summaries are built from activations and raw results", () => {
  const run: RunRecord = {
    runId: "run-list-persisted",
    graphId: "graph",
    graphPath: "graph.vg.yaml",
    status: "success",
    startedAt: 10,
    finishedAt: 30,
    activations: [
      {
        activationId: "act-shell",
        nodeId: "shell_node",
        terminalSessionId: "term_shell",
        status: "succeeded",
        inputs: {},
        iteration: 1,
        startedAt: 10,
        finishedAt: 20,
        rawResult: {
          activationId: "act-shell",
          nodeId: "shell_node",
          backend: "shell",
          terminalSessionId: "term_shell",
          stdout: "",
          stderr: "",
          exitCode: 0,
          terminalTranscript: "hello persisted",
          terminalMode: "pty",
          startedAt: 10,
          finishedAt: 20,
          durationMs: 10,
        },
      },
      {
        activationId: "act-internal",
        nodeId: "internal_node",
        status: "succeeded",
        inputs: {},
        iteration: 1,
        startedAt: 21,
      },
    ],
  };

  const summaries = buildPersistedTerminalSessionSummaries(run);

  assert.deepEqual(summaries, [
    {
      runId: "run-list-persisted",
      sessionId: "term_shell",
      terminalSessionId: "term_shell",
      activationId: "act-shell",
      nodeId: "shell_node",
      backend: "shell",
      status: "exited",
      exitCode: 0,
      terminalMode: "pty",
      source: "persisted",
      snapshotChars: "hello persisted".length,
      liveEventsUrl: "/api/runs/run-list-persisted/events",
    },
  ]);
});

test("active terminal session summaries are built from active SSE events", () => {
  const summaries = buildActiveTerminalSessionSummaries("run-active", [
    {
      event: "terminal:started",
      data: {
        terminalSessionId: "term-active",
        activationId: "act-active",
        nodeId: "shell_node",
        backend: "shell",
      },
    },
    {
      event: "terminal:output",
      data: {
        terminalSessionId: "term-active",
        chunk: "live output",
      },
    },
  ]);

  assert.deepEqual(summaries, [
    {
      runId: "run-active",
      sessionId: "term-active",
      terminalSessionId: "term-active",
      activationId: "act-active",
      nodeId: "shell_node",
      backend: "shell",
      status: "running",
      source: "active",
      snapshotChars: "live output".length,
      liveEventsUrl: "/api/runs/run-active/events",
    },
  ]);
});
