import assert from "node:assert/strict";
import test from "node:test";
import { GraphLoader } from "../src/graph-loader.js";
import type { ControllerNode, ExecuteNode } from "../src/types.js";

test("project task loop graph implements requested review and task loops", () => {
  const graph = GraphLoader.load("examples/project-task-loop.yaml");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeSet = new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}`));

  assert.equal(graph.runtime?.workspace?.mode, "worktree");
  assert.equal(graph.inputs?.verification_command?.default, "npm test && npm run typecheck");

  const implement = nodes.get("implement_feature") as ExecuteNode | undefined;
  assert.equal(implement?.backend, "codex");
  assert.equal(implement?.execution?.model, "gpt-5.5");
  assert.equal(implement?.execution?.reasoningEffort, "high");
  assert.equal(implement?.execution?.workspaceAccess, "write");

  const reviewCodeQuality = nodes.get("review_code_quality") as
    | ExecuteNode
    | undefined;
  assert.equal(reviewCodeQuality?.execution?.workspaceAccess, "read");

  const reviewFunctionality = nodes.get("review_functionality") as
    | ExecuteNode
    | undefined;
  assert.equal(reviewFunctionality?.execution?.workspaceAccess, "read");

  const assessRemainingTasks = nodes.get("assess_remaining_tasks") as
    | ExecuteNode
    | undefined;
  assert.equal(assessRemainingTasks?.execution?.workspaceAccess, "read");

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

test("VG-M1-014 terminal loop graph is scoped and review-gated", () => {
  const graph = GraphLoader.load("examples/vg-m1-014-terminal-loop.vg.yaml");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeSet = new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}`));

  assert.equal(graph.id, "vg_m1_014_terminal_loop");
  assert.equal(graph.runtime?.workspace?.mode, "worktree");
  assert.equal(graph.inputs?.verification_command?.default, "npm run typecheck && npm test");
  assert.match(String(graph.inputs?.task_scope?.default), /VG-M1-014/);
  assert.doesNotMatch(String(graph.inputs?.task_scope?.default), /VG-M1-002/);

  const implement = nodes.get("implement_terminal_slice") as
    | ExecuteNode
    | undefined;
  assert.equal(implement?.backend, "codex");
  assert.equal(implement?.execution?.workspaceAccess, "write");
  assert.equal(implement?.execution?.reasoningEffort, "high");
  assert.match(implement?.promptTemplate ?? "", /Do not work on VG-M1-002 through VG-M1-013/);
  assert.match(implement?.promptTemplate ?? "", /reliable stdin/);

  assert.equal(nodes.has("run_verification"), false);
  const verification = nodes.get("verify_terminal_slice") as ExecuteNode | undefined;
  assert.equal(verification?.backend, "claude");
  assert.equal(verification?.execution?.workspaceAccess, "read");
  assert.match(verification?.promptTemplate ?? "", /Run the verification command/);
  assert.match(verification?.promptTemplate ?? "", /\{\{inputs\.verification_command\}\}/);
  assert.match(verification?.promptTemplate ?? "", /Return JSON only/);

  const qualityReview = nodes.get("review_code_quality") as
    | ExecuteNode
    | undefined;
  assert.equal(qualityReview?.backend, "claude");
  assert.equal(qualityReview?.execution?.workspaceAccess, "read");
  assert.match(qualityReview?.promptTemplate ?? "", /nodes\.verify_terminal_slice\.stdout/);

  const acceptanceReview = nodes.get("review_terminal_acceptance") as
    | ExecuteNode
    | undefined;
  assert.equal(acceptanceReview?.backend, "claude");
  assert.equal(acceptanceReview?.execution?.workspaceAccess, "read");
  assert.match(acceptanceReview?.promptTemplate ?? "", /sessionId/);
  assert.match(acceptanceReview?.promptTemplate ?? "", /portable-pty/);
  assert.match(acceptanceReview?.promptTemplate ?? "", /nodes\.verify_terminal_slice\.stdout/);

  const reviewGate = nodes.get("review_gate") as ControllerNode | undefined;
  assert.equal(reviewGate?.type, "controller");
  assert.equal(reviewGate?.inputs.verification_report.required, true);
  assert.equal(reviewGate?.inputs.quality_review.required, true);
  assert.equal(reviewGate?.inputs.terminal_acceptance_review.required, true);
  assert.ok(reviewGate?.outputs.fix_review_issues);
  assert.ok(reviewGate?.outputs.assess_remaining_terminal_work);
  assert.equal(reviewGate?.outputGuards?.assess_remaining_terminal_work, undefined);
  assert.doesNotMatch(reviewGate?.promptTemplate ?? "", /run_verification/);
  assert.match(reviewGate?.promptTemplate ?? "", /nodes\.verify_terminal_slice\.stdout/);

  const remainingAssessment = nodes.get("assess_remaining_terminal_work") as
    | ExecuteNode
    | undefined;
  assert.equal(remainingAssessment?.backend, "claude");
  assert.match(remainingAssessment?.promptTemplate ?? "", /nodes\.verify_terminal_slice\.stdout/);

  assert.ok(
    edgeSet.has("implement_terminal_slice.outputs.done->verify_terminal_slice.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("verify_terminal_slice.outputs.done->review_code_quality.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("verify_terminal_slice.outputs.done->review_terminal_acceptance.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("verify_terminal_slice.outputs.done->review_gate.inputs.verification_report")
  );
  assert.ok(
    edgeSet.has("review_gate.outputs.fix_review_issues->fix_review_issues.inputs.trigger")
  );
  assert.ok(edgeSet.has("fix_review_issues.outputs.done->verify_terminal_slice.inputs.trigger"));
  assert.ok(
    edgeSet.has("review_gate.outputs.assess_remaining_terminal_work->assess_remaining_terminal_work.inputs.trigger")
  );
  assert.ok(
    edgeSet.has("assess_remaining_terminal_work.outputs.done->task_gate.inputs.terminal_assessment")
  );
  assert.ok(edgeSet.has("task_gate.outputs.next_task->implement_terminal_slice.inputs.trigger"));
  assert.ok(edgeSet.has("task_gate.outputs.end_success->end_success.inputs.trigger"));
});
