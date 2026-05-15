import assert from "node:assert/strict";
import test from "node:test";
import { GraphLoader } from "../src/graph-loader.js";
import type { ExecuteNode } from "../src/types.js";

test("project task loop graph implements requested review and task loops", () => {
  const graph = GraphLoader.load("examples/project-task-loop.yaml");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeSet = new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}`));

  const implement = nodes.get("implement_feature") as ExecuteNode | undefined;
  assert.equal(implement?.backend, "codex");
  assert.equal(implement?.execution?.model, "gpt-5.5");
  assert.equal(implement?.execution?.reasoningEffort, "high");

  assert.ok(
    edgeSet.has("implement_feature.outputs.done->review_code_quality.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("implement_feature.outputs.done->review_functionality.inputs.trigger")
  );

  const reviewGate = nodes.get("review_gate");
  assert.equal(reviewGate?.type, "controller");
  if (reviewGate?.type !== "controller") throw new Error("missing review gate");
  assert.equal(reviewGate.inputs.quality_review.required, true);
  assert.equal(reviewGate.inputs.functionality_review.required, true);
  assert.ok(reviewGate.outputs.fix_review_issues);
  assert.ok(reviewGate.outputs.assess_remaining_tasks);

  assert.ok(
    edgeSet.has("review_gate.outputs.fix_review_issues->fix_review_issues.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("fix_review_issues.outputs.done->review_code_quality.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("fix_review_issues.outputs.done->review_functionality.inputs.trigger")
  );

  assert.ok(
    edgeSet.has("review_gate.outputs.assess_remaining_tasks->assess_remaining_tasks.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("assess_remaining_tasks.outputs.done->task_gate.inputs.task_assessment")
  );
  assert.ok(edgeSet.has("task_gate.outputs.next_task->implement_feature.inputs.trigger"));
  assert.ok(edgeSet.has("task_gate.outputs.end_success->end_success.inputs.trigger"));
});
