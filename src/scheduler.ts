import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ControllerRunner,
  renderControllerPrompt,
} from "./controller-runner.js";
import {
  ExecuteRunner,
  renderExecutePrompt,
} from "./execute-runner.js";
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
  SchedulerEvent,
  SchedulerRunOptions,
  TemplateContext,
  WorkspaceInfo,
} from "./types.js";

interface PreparedNodeRun {
  nodeId: string;
  node: GraphNode;
  iteration: number;
  context: TemplateContext;
}

export class Scheduler {
  static async run(
    graph: GraphDefinition,
    graphPath: string,
    options: SchedulerRunOptions = {}
  ): Promise<RunRecord> {
    const runId = options.runId ?? randomUUID();
    const maxSteps = graph.runtime?.maxTotalSteps ?? 50;
    const maxFixAttempts = graph.runtime?.maxFixAttempts ?? 3;

    const nodeMap = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
    }

    // Setup workspace
    const projectRoot = resolve(options.projectRoot ?? process.cwd());
    const ws = options.workspacePath
      ? explicitWorkspace(options)
      : await WorkspaceManager.setup(graph.runtime, runId, projectRoot);

    const runRecord: RunRecord = {
      runId,
      graphId: graph.id,
      graphPath,
      status: "running",
      startedAt: Date.now(),
      activations: [],
      controllerDecisions: [],
      workspace: ws,
      projectId: options.projectId,
      projectRoot,
      fixAttempts: 0,
    };

    if (options.signal?.aborted) {
      runRecord.status = "cancelled";
      runRecord.error = "Run cancelled before start";
      return await finalize(runRecord, ws, projectRoot);
    }

    // Node output cache for template context
    const nodeOutputs = new Map<string, Record<string, unknown>>();
    let controllerContext: Record<string, unknown> = {};
    const inputBuffers = new Map<string, Set<string>>();

    // Iteration tracking per node
    const nodeIterations = new Map<string, number>();

    try {
      let currentNodeIds: string[] = [];
      followEdges(
        graph.edges,
        "graph.start",
        "start",
        nodeMap,
        currentNodeIds,
        inputBuffers
      );
      const visited = new Set<string>();

      for (let step = 0; step < maxSteps; step++) {
        if (options.signal?.aborted) {
          runRecord.status = "cancelled";
          runRecord.error = "Run cancelled by user";
          break;
        }

        if (currentNodeIds.length === 0) {
          const blocked = findBlockedControllers(nodeMap, inputBuffers);
          if (blocked.length > 0) {
            runRecord.status = "failed";
            runRecord.error = `Controller waiting for required inputs: ${blocked.join(", ")}`;
          } else {
            runRecord.status = "success";
          }
          break;
        }

        const nextNodeIds: string[] = [];
        const preparedRuns: PreparedNodeRun[] = [];

        for (const nodeId of currentNodeIds) {
          if (options.signal?.aborted) {
            runRecord.status = "cancelled";
            runRecord.error = "Run cancelled by user";
            return await finalize(runRecord, ws, projectRoot);
          }

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
            controllerPayloads: controllerContext,
          });

          preparedRuns.push({
            nodeId,
            node,
            iteration,
            context,
          });
        }

        const parallelRuns = preparedRuns.filter((run) =>
          canRunInParallel(run.node)
        );
        const parallelActivations = new Map<string, NodeActivation>(
          await Promise.all(
            parallelRuns.map(async (run) => {
              const activation = await executeNode(
                run.node as ExecuteNode,
                runId,
                run.iteration,
                ws.path,
                run.context,
                options
              );
              return [run.nodeId, activation] as const;
            })
          )
        );
        const recordedParallelActivations = new Set<string>();

        const recordExecuteActivation = async (
          nodeId: string,
          node: ExecuteNode,
          activation: NodeActivation
        ): Promise<void> => {
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
        };

        for (const run of preparedRuns) {
          const { nodeId, node } = run;
          if (node.type !== "execute") continue;

          const activation = parallelActivations.get(nodeId);
          if (!activation) continue;

          await recordExecuteActivation(nodeId, node, activation);
          recordedParallelActivations.add(nodeId);
        }

        for (const run of preparedRuns) {
          const { nodeId, node, iteration, context } = run;

          if (node.type === "execute") {
            const activation =
              parallelActivations.get(nodeId) ??
              (await executeNode(
                node,
                runId,
                iteration,
                ws.path,
                context,
                options
              ));

            if (!recordedParallelActivations.has(nodeId)) {
              await recordExecuteActivation(nodeId, node, activation);
            }

            if (activation.status === "cancelled") {
              runRecord.status = "cancelled";
              runRecord.error = activation.error ?? "Run cancelled by user";
              return await finalize(
                runRecord,
                ws,
                projectRoot
              );
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
                  activateEdgeTarget(
                    edge,
                    nodeMap,
                    nextNodeIds,
                    inputBuffers
                  );
                }
              } else {
                runRecord.status = "failed";
                runRecord.error = `Node "${nodeId}" failed: ${activation.error ?? "unknown error"}`;
                return await finalize(
                  runRecord,
                  ws,
                  projectRoot
                );
              }
            } else {
              // Follow outgoing edges
              followEdges(
                graph.edges,
                nodeId,
                "done",
                nodeMap,
                nextNodeIds,
                inputBuffers
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
                projectRoot
              );
            }
          } else if (node.type === "controller") {
            // Count controller executions
            visited.add(nodeId + "_" + iteration);

            const activation = await executeController(
              node,
              runId,
              iteration,
              context,
              options
            );
            runRecord.activations.push(activation);
            inputBuffers.set(nodeId, new Set());

            if (activation.status === "cancelled") {
              runRecord.status = "cancelled";
              runRecord.error = activation.error ?? "Run cancelled by user";
              return await finalize(
                runRecord,
                ws,
                projectRoot
              );
            }

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
                projectRoot
              );
            }

            const decision = activation.controllerDecision;
            runRecord.controllerDecisions!.push(decision);

            controllerContext = {
              nodeId: node.id,
              selected_output: decision.selected_output,
              reason: decision.reason,
              confidence: decision.confidence,
              payload: decision.payload ?? {},
            };

            // Store controller payload for downstream context
            nodeOutputs.set(nodeId, {
              selected_output: decision.selected_output,
              reason: decision.reason,
              confidence: decision.confidence,
              payload: decision.payload ?? {},
            });

            // Route: only follow the selected output's edge
            const selectedPort = decision.selected_output;
            const nextCountBeforeRoute = nextNodeIds.length;
            followEdges(
              graph.edges,
              nodeId,
              selectedPort,
              nodeMap,
              nextNodeIds,
              inputBuffers
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
                  projectRoot
                );
              }
            }

            if (
              (selectedPort === "end_success" ||
                selectedPort === "end_failed") &&
              nextNodeIds.length === nextCountBeforeRoute
            ) {
              runRecord.status =
                selectedPort === "end_success"
                  ? "success"
                  : "failed";
              return await finalize(
                runRecord,
                ws,
                projectRoot
              );
            }
          }
        }

        currentNodeIds = nextNodeIds;
      }

      if (runRecord.status === "running") {
        if (options.signal?.aborted) {
          runRecord.status = "cancelled";
          runRecord.error = "Run cancelled by user";
        } else {
          runRecord.status = "failed";
          runRecord.error = `Exceeded max total steps (${maxSteps})`;
        }
      }
    } catch (err) {
      if (options.signal?.aborted) {
        runRecord.status = "cancelled";
        runRecord.error = "Run cancelled by user";
      } else {
        runRecord.status = "failed";
        runRecord.error =
          err instanceof Error ? err.message : String(err);
      }
    }

    return await finalize(runRecord, ws, projectRoot);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function explicitWorkspace(options: SchedulerRunOptions): WorkspaceInfo {
  return {
    mode: options.workspaceMode ?? "directory",
    path: resolve(options.workspacePath!),
    gitEnabled: options.workspaceGitEnabled ?? false,
  };
}

function canRunInParallel(node: GraphNode): boolean {
  return (
    node.type === "execute" &&
    node.backend === "codex" &&
    node.execution?.workspaceAccess === "read"
  );
}

async function executeNode(
  node: ExecuteNode,
  runId: string,
  iteration: number,
  cwd: string,
  context: TemplateContext,
  options: SchedulerRunOptions
): Promise<NodeActivation> {
  const activationId = `${runId}_${node.id}_${iteration}`;
  const startedAt = Date.now();
  const controllerInput = cloneJsonObject(context.controller);
  const renderedPrompt = renderExecutePrompt(node, context);

  const activation: NodeActivation = {
    activationId,
    nodeId: node.id,
    status: "running",
    inputs: {
      trigger: true,
      controllerInput,
      promptTemplate: node.promptTemplate ?? null,
    },
    ...(renderedPrompt !== undefined ? { renderedPrompt } : {}),
    promptAssembly: {
      controllerInput,
      ...(node.promptTemplate !== undefined
        ? { promptTemplate: node.promptTemplate }
        : {}),
      ...(renderedPrompt !== undefined ? { renderedPrompt } : {}),
    },
    iteration,
    startedAt,
  };

  publishSchedulerEvent(options, {
    type: "node:started",
    runId,
    activation,
  });

  try {
    const result = await ExecuteRunner.run(
      node,
      activationId,
      cwd,
      context,
      {
        signal: options.signal,
        onOutput: (event) =>
          publishSchedulerEvent(options, {
            type: "node:output",
            runId,
            activationId,
            nodeId: node.id,
            backend: event.backend,
            stream: event.stream,
            chunk: event.chunk,
            timestamp: Date.now(),
          }),
        terminal: {
          enabled: true,
          cols: 100,
          rows: 28,
          runId,
          onStart: ({ cols, rows }) =>
            publishSchedulerEvent(options, {
              type: "terminal:started",
              runId,
              activationId,
              nodeId: node.id,
              backend: node.backend,
              cols,
              rows,
              timestamp: Date.now(),
            }),
          onOutput: (chunk) =>
            publishSchedulerEvent(options, {
              type: "terminal:output",
              runId,
              activationId,
              nodeId: node.id,
              backend: node.backend,
              chunk,
              timestamp: Date.now(),
            }),
          onEnd: ({ exitCode }) =>
            publishSchedulerEvent(options, {
              type: "terminal:ended",
              runId,
              activationId,
              nodeId: node.id,
              backend: node.backend,
              exitCode,
              timestamp: Date.now(),
            }),
          registerSession: options.registerSession,
          unregisterSession: options.unregisterSession,
        },
      }
    );
    activation.rawResult = result;
    activation.status = result.aborted
      ? "cancelled"
      : result.exitCode === 0
        ? "succeeded"
        : "failed";
    if (result.aborted) {
      activation.error = "Cancelled by user";
    } else if (result.timedOut) {
      activation.error = result.stderr || `Timed out after ${result.durationMs}ms`;
    } else if (result.exitCode !== 0) {
      activation.error = `Exit code: ${result.exitCode}`;
    }
  } catch (err) {
    activation.status = options.signal?.aborted ? "cancelled" : "failed";
    activation.error = options.signal?.aborted
      ? "Cancelled by user"
      : err instanceof Error
        ? err.message
        : String(err);
  }

  activation.finishedAt = Date.now();
  publishSchedulerEvent(options, {
    type: "node:completed",
    runId,
    activation,
  });
  return activation;
}

async function executeController(
  node: ControllerNode,
  runId: string,
  iteration: number,
  context: TemplateContext,
  options: SchedulerRunOptions
): Promise<NodeActivation> {
  const activationId = `${runId}_${node.id}_${iteration}`;
  const startedAt = Date.now();
  const renderedPrompt = renderControllerPrompt(node, context);

  const activation: NodeActivation = {
    activationId,
    nodeId: node.id,
    status: "running",
    inputs: {},
    renderedPrompt,
    iteration,
    startedAt,
  };

  publishSchedulerEvent(options, {
    type: "node:started",
    runId,
    activation,
  });

  try {
    if (options.signal?.aborted) {
      throw new Error("Cancelled by user");
    }
    const decision = await ControllerRunner.evaluate(
      node,
      context
    );
    activation.controllerDecision = decision;
    activation.status = options.signal?.aborted ? "cancelled" : "succeeded";
  } catch (err) {
    activation.status = options.signal?.aborted ? "cancelled" : "failed";
    activation.error = options.signal?.aborted
      ? "Cancelled by user"
      : err instanceof Error
        ? err.message
        : String(err);
  }

  activation.finishedAt = Date.now();
  publishSchedulerEvent(options, {
    type: "node:completed",
    runId,
    activation,
  });
  return activation;
}

function publishSchedulerEvent(
  options: SchedulerRunOptions,
  event: SchedulerEvent
): void {
  try {
    options.onEvent?.(event);
  } catch {
    // UI subscribers must not be able to break the run.
  }
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
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
  nextNodeIds: string[],
  inputBuffers: Map<string, Set<string>>
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
    activateEdgeTarget(edge, nodeMap, nextNodeIds, inputBuffers);
  }
}

function activateEdgeTarget(
  edge: Edge,
  nodeMap: Map<string, GraphNode>,
  nextNodeIds: string[],
  inputBuffers: Map<string, Set<string>>
): void {
  const parsedTarget = parseEdgeRef(edge.to);
  const targetId =
    parsedTarget?.nodeId ?? resolveEdgeRef(edge.to, new Set(nodeMap.keys()));
  const target = nodeMap.get(targetId);
  if (!target) return;

  if (parsedTarget?.port) {
    const buffer = inputBuffers.get(targetId) ?? new Set<string>();
    buffer.add(parsedTarget.port);
    inputBuffers.set(targetId, buffer);
  }

  if (target.type === "controller" && !isControllerReady(target, inputBuffers)) {
    return;
  }

  if (!nextNodeIds.includes(targetId)) {
    nextNodeIds.push(targetId);
  }
}

function isControllerReady(
  node: ControllerNode,
  inputBuffers: Map<string, Set<string>>
): boolean {
  const requiredInputs = Object.entries(node.inputs || {})
    .filter(([, spec]) => spec?.required)
    .map(([name]) => name);

  if (requiredInputs.length === 0) return true;

  const received = inputBuffers.get(node.id) ?? new Set<string>();
  return requiredInputs.every((name) => received.has(name));
}

function findBlockedControllers(
  nodeMap: Map<string, GraphNode>,
  inputBuffers: Map<string, Set<string>>
): string[] {
  const blocked: string[] = [];
  for (const node of nodeMap.values()) {
    if (node.type !== "controller") continue;
    const received = inputBuffers.get(node.id);
    if (received && !isControllerReady(node, inputBuffers)) {
      blocked.push(node.id);
    }
  }
  return blocked;
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
