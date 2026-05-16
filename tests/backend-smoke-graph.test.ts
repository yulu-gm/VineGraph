import assert from "node:assert/strict";
import test from "node:test";
import { GraphLoader } from "../src/graph-loader.js";
import type { ExecuteNode } from "../src/types.js";

test("mac backend smoke graph exercises Codex, Claude, and DeepSeek", () => {
  const graph = GraphLoader.load("examples/mac-agent-backend-smoke.yaml");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeSet = new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}`));

  const codex = nodes.get("call_codex") as ExecuteNode | undefined;
  const claude = nodes.get("call_claude") as ExecuteNode | undefined;
  const gate = nodes.get("deepseek_gate");

  assert.equal(graph.runtime?.workspace?.mode, "local");
  assert.equal(codex?.backend, "codex");
  assert.equal(codex?.execution?.workspaceAccess, "read");
  assert.equal(claude?.backend, "claude");
  assert.equal(claude?.execution?.workspaceAccess, "read");

  assert.equal(gate?.type, "controller");
  if (gate?.type !== "controller") throw new Error("missing deepseek gate");
  assert.equal(gate.model, "deepseek-chat");
  assert.equal(gate.inputs.host_check.required, true);
  assert.equal(gate.inputs.codex_result.required, true);
  assert.equal(gate.inputs.claude_result.required, true);
  assert.ok(gate.outputs.end_success);
  assert.ok(gate.outputs.end_failed);
  assert.match(gate.outputGuards?.end_success ?? "", /nodes\.call_codex\.stdout != ''/);
  assert.match(gate.outputGuards?.end_success ?? "", /nodes\.call_claude\.stdout != ''/);

  assert.ok(edgeSet.has("check_host.outputs.done->call_codex.inputs.trigger"));
  assert.ok(edgeSet.has("check_host.outputs.done->call_claude.inputs.trigger"));
  assert.ok(edgeSet.has("call_codex.outputs.done->deepseek_gate.inputs.codex_result"));
  assert.ok(edgeSet.has("call_claude.outputs.done->deepseek_gate.inputs.claude_result"));
});
