import assert from "node:assert/strict";
import test from "node:test";
import { buildTerminalSessionAttachSnapshot } from "../src/terminal-attach.js";
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
