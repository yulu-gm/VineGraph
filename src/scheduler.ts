import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ControllerRunner } from "./controller-runner.js";
import { ExecuteRunner } from "./execute-runner.js";
import { parseEdgeRef, resolveEdgeRef } from "./graph-loader.js";
import { saveRunRecord } from "./run-history.js";
import { buildContext } from "./template.js";
import { WorkspaceManager } from "./workspace-manager.js";
import type {
  GraphDefinition,
  GraphNode,
  ExecuteNode,
  ControllerNode,
  Edge,
  NodeActivation,
  RunRecord,
  ControllerDecision,
  TemplateContext,
} from "./types.js";

export class Scheduler {
  static async run(
    graph: GraphDefinition,
    graphPath: string
  ): Promise<RunRecord> {
    const runId = randomUUID();
    const maxSteps = graph.runtime?.maxTotalSteps ?? 50;
    const maxFixAttempts = graph.runtime?.maxFixAttempts ?? 3;

    const nodeMap = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
    }

    // Setup workspace
    const repoRoot = dirname(graphPath);
    const ws = await WorkspaceManager.setup(graph.runtime, runId, repoRoot);

    const runRecord: RunRecord = {
      runId,
      graphId: graph.id,
      graphPath,
      status: "running",
      startedAt: Date.now(),
      activations: [],
      controllerDecisions: [],
      workspace: ws,
      fixAttempts: 0,
    };

    // Node output cache for template context
    const nodeOutputs = new Map<string, Record<string, unknown>>();

    // Iteration tracking per node
    const nodeIterations = new Map<string, number>();

    try {
      let currentNodeIds = getStartNodes(graph.edges);
      const visited = new Set<string>();

      for (let step = 0; step < maxSteps; step++) {
        if (currentNodeIds.length === 0) {
          runRecord.status = "success";
          break;
        }

        const nextNodeIds: string[] = [];

        for (const nodeId of currentNodeIds) {
          const iteration = (nodeIterations.get(nodeId) ?? 0) + 1;
          nodeIterations.set(nodeId, iteration);

          const node = nodeMap.get(nodeId);
          if (!node) {
            throw new Error(
              `Node "${nodeId}" not found in graph definition`
            );
          }

          // Build template context
          const runtimeFacts = buildRuntimeFacts(
            runRecord,
            maxFixAttempts,
            maxSteps
          );
          const context = buildContext({
            graphInputs: graph.inputs
              ? Object.fromEntries(
                  Object.entries(graph.inputs).map(([k, v]) => [
                    k,
                    v.default ?? "",
                  ])
                )
              : {},
            nodeOutputs,
            runtimeFacts,
            workspacePath: ws.path,
            controllerPayloads: {},
          });

          if (node.type === "execute") {
            const activation = await executeNode(
              node,
              runId,
              iteration,
              ws.path,
              context
            );
            runRecord.activations.push(activation);

            // Track fix attempts (nodes with "fix" in id)
            if (
              node.id.toLowerCase().includes("fix") &&
              activation.status === "succeeded"
            ) {
              runRecord.fixAttempts =
                (runRecord.fixAttempts ?? 0) + 1;
            }

            // Store node outputs for downstream context
            if (activation.rawResult) {
              nodeOutputs.set(nodeId, {
                stdout: activation.rawResult.stdout,
                stderr: activation.rawResult.stderr,
                exitCode: activation.rawResult.exitCode,
                passed: activation.rawResult.exitCode === 0,
              });
            }

            // Capture diff after shell/agent nodes
            if (node.backend !== "internal") {
              await WorkspaceManager.captureDiff(ws);
            }

            if (activation.status === "failed") {
              // Check if we can still route through a controller
              const outEdges = getOutgoingEdges(
                graph.edges,
                nodeId
              );
              const controllerEdges = outEdges.filter((e) => {
                const targetId = resolveEdgeRef(
                  e.to,
                  new Set(graph.nodes.map((n) => n.id))
                );
                const target = nodeMap.get(targetId);
                return target?.type === "controller";
              });

              if (controllerEdges.length > 0) {
                // Allow routing through controller even on failure
                for (const edge of controllerEdges) {
                  const targetId = resolveEdgeRef(
                    edge.to,
                    new Set(graph.nodes.map((n) => n.id))
                  );
                  if (!nextNodeIds.includes(targetId)) {
                    nextNodeIds.push(targetId);
                  }
                }
              } else {
                runRecord.status = "failed";
                runRecord.error = `Node "${nodeId}" failed: ${activation.error ?? "unknown error"}`;
                return await finalize(
                  runRecord,
                  ws,
                  repoRoot
                );
              }
            } else {
              // Follow outgoing edges
              followEdges(
                graph.edges,
                nodeId,
                "done",
                nodeMap,
                nextNodeIds
              );
            }

            if (isTerminalNode(node)) {
              const action =
                node.command?.args?.[0] ?? "finish_success";
              runRecord.status =
                action === "finish_success" ? "success" : "failed";
              return await finalize(
                runRecord,
                ws,
                repoRoot
              );
            }
          } else if (node.type === "controller") {
            // Count controller executions
            visited.add(nodeId + "_" + iteration);

            const activation = await executeController(
              node,
              runId,
              iteration,
              context
            );
            runRecord.activations.push(activation);

            if (
              activation.status === "failed" ||
              !activation.controllerDecision
            ) {
              runRecord.status = "failed";
              runRecord.error =
                activation.error ??
                "Controller failed without a decision";
              return await finalize(
                runRecord,
                ws,
                repoRoot
              );
            }

            const decision = activation.controllerDecision;
            runRecord.controllerDecisions!.push(decision);

            // Store controller payload for downstream context
            nodeOutputs.set(nodeId, {
              selected_output: decision.selected_output,
              reason: decision.reason,
              confidence: decision.confidence,
              payload: decision.payload ?? {},
            });

            // Route: only follow the selected output's edge
            const selectedPort = decision.selected_output;
            followEdges(
              graph.edges,
              nodeId,
              selectedPort,
              nodeMap,
              nextNodeIds
            );

            // Check fix attempt limits
            if (
              selectedPort === "fix_from_test_logs" ||
              selectedPort === "fix_review_issues"
            ) {
              if (
                (runRecord.fixAttempts ?? 0) >= maxFixAttempts
              ) {
                runRecord.status = "failed";
                runRecord.error = `Exceeded max fix attempts (${maxFixAttempts})`;
                return await finalize(
                  runRecord,
                  ws,
                  repoRoot
                );
              }
            }

            if (
              selectedPort === "end_success" ||
              selectedPort === "end_failed"
            ) {
              runRecord.status =
                selectedPort === "end_success"
                  ? "success"
                  : "failed";
              return await finalize(
                runRecord,
                ws,
                repoRoot
              );
            }
          }
        }

        currentNodeIds = nextNodeIds;
      }

      if (runRecord.status === "running") {
        runRecord.status = "failed";
        runRecord.error = `Exceeded max total steps (${maxSteps})`;
      }
    } catch (err) {
      runRecord.status = "failed";
      runRecord.error =
        err instanceof Error ? err.message : String(err);
    }

    return await finalize(runRecord, ws, repoRoot);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

async function executeNode(
  node: ExecuteNode,
  runId: string,
  iteration: number,
  cwd: string,
  context: TemplateContext
): Promise<NodeActivation> {
  const activationId = `${runId}_${node.id}_${iteration}`;
  const startedAt = Date.now();

  const activation: NodeActivation = {
    activationId,
    nodeId: node.id,
    status: "running",
    inputs: { trigger: true },
    iteration,
    startedAt,
  };

  try {
    const result = await ExecuteRunner.run(
      node,
      activationId,
      cwd,
      context
    );
    activation.rawResult = result;
    activation.status =
      result.exitCode === 0 ? "succeeded" : "failed";
    if (result.exitCode !== 0) {
      activation.error = `Exit code: ${result.exitCode}`;
    }
  } catch (err) {
    activation.status = "failed";
    activation.error =
      err instanceof Error ? err.message : String(err);
  }

  activation.finishedAt = Date.now();
  return activation;
}

async function executeController(
  node: ControllerNode,
  runId: string,
  iteration: number,
  context: TemplateContext
): Promise<NodeActivation> {
  const activationId = `${runId}_${node.id}_${iteration}`;
  const startedAt = Date.now();

  const activation: NodeActivation = {
    activationId,
    nodeId: node.id,
    status: "running",
    inputs: {},
    iteration,
    startedAt,
  };

  try {
    const decision = await ControllerRunner.evaluate(
      node,
      context
    );
    activation.controllerDecision = decision;
    activation.status = "succeeded";
  } catch (err) {
    activation.status = "failed";
    activation.error =
      err instanceof Error ? err.message : String(err);
  }

  activation.finishedAt = Date.now();
  return activation;
}

function buildRuntimeFacts(
  runRecord: RunRecord,
  maxFixAttempts: number,
  maxTotalSteps: number
): Record<string, unknown> {
  return {
    fixAttempts: runRecord.fixAttempts ?? 0,
    maxFixAttempts,
    maxTotalSteps,
    totalSteps: runRecord.activations.length,
    runId: runRecord.runId,
    graphId: runRecord.graphId,
  };
}

function getStartNodes(edges: Edge[]): string[] {
  const startEdges = edges.filter((e) => e.from === "graph.start");
  const nodeIds: string[] = [];
  for (const edge of startEdges) {
    const parsed = parseEdgeRef(edge.to);
    if (parsed && !nodeIds.includes(parsed.nodeId)) {
      nodeIds.push(parsed.nodeId);
    }
  }
  return nodeIds;
}

function getOutgoingEdges(edges: Edge[], nodeId: string): Edge[] {
  return edges.filter((e) => {
    const parsed = parseEdgeRef(e.from);
    return parsed && parsed.nodeId === nodeId;
  });
}

function followEdges(
  edges: Edge[],
  fromNodeId: string,
  fromPort: string,
  nodeMap: Map<string, GraphNode>,
  nextNodeIds: string[]
): void {
  const outEdges = edges.filter((e) => {
    const parsed = parseEdgeRef(e.from);
    return (
      parsed &&
      parsed.nodeId === fromNodeId &&
      parsed.port === fromPort
    );
  });

  for (const edge of outEdges) {
    const targetId = resolveEdgeRef(
      edge.to,
      new Set(nodeMap.keys())
    );
    if (!nextNodeIds.includes(targetId)) {
      nextNodeIds.push(targetId);
    }
  }
}

function isTerminalNode(node: ExecuteNode): boolean {
  if (node.backend !== "internal") return false;
  const args = node.command?.args ?? [];
  return (
    args.includes("finish_success") ||
    args.includes("finish_failed")
  );
}

async function finalize(
  runRecord: RunRecord,
  ws: RunRecord["workspace"],
  repoRoot: string
): Promise<RunRecord> {
  runRecord.finishedAt = Date.now();
  runRecord.totalDurationMs =
    runRecord.finishedAt - runRecord.startedAt;

  if (ws) {
    try {
      await WorkspaceManager.captureDiff(ws);
      await WorkspaceManager.exportPatch(
        ws,
        runRecord.runId,
        repoRoot
      );
    } catch {
      // Don't let diff/patch failures break the run
    }
    try {
      await WorkspaceManager.cleanup(ws, repoRoot);
    } catch {
      // Don't let cleanup failure break the run
    }
  }

  try {
    saveRunRecord(runRecord);
  } catch {
    // Don't let history save failure break execution
  }

  return runRecord;
}
