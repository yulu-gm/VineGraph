import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import type { GraphDefinition, GraphNode } from "./types.js";

export class GraphLoader {
  static load(graphPath: string): GraphDefinition {
    const absPath = resolve(graphPath);
    const raw = readFileSync(absPath, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown>;

    return GraphLoader.validate(parsed, absPath);
  }

  static validate(
    parsed: Record<string, unknown>,
    source: string
  ): GraphDefinition {
    GraphLoader.normalize(parsed);

    if (!parsed.id || typeof parsed.id !== "string") {
      throw new Error(`Graph validation failed: missing or invalid "id" field`);
    }
    if (!parsed.version || typeof parsed.version !== "string") {
      throw new Error(
        `Graph validation failed: missing or invalid "version" field`
      );
    }

    const nodes = parsed.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error(
        `Graph validation failed: "nodes" must be a non-empty array`
      );
    }

    const edges = parsed.edges;
    if (!Array.isArray(edges)) {
      throw new Error(`Graph validation failed: "edges" must be an array`);
    }

    const nodeIds = new Set<string>();
    const VALID_BACKENDS = new Set([
      "shell",
      "internal",
      "codex",
      "claude",
      "git",
    ]);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as Record<string, unknown>;
      const id = node.id;
      if (!id || typeof id !== "string") {
        throw new Error(
          `Graph validation failed: node at index ${i} missing "id"`
        );
      }
      if (nodeIds.has(id)) {
        throw new Error(
          `Graph validation failed: duplicate node id "${id}"`
        );
      }
      nodeIds.add(id);

      const nodeType = node.type as string;
      if (nodeType === "execute") {
        const backend = node.backend as string;
        if (!VALID_BACKENDS.has(backend)) {
          throw new Error(
            `Graph validation failed: node "${id}" has unsupported backend "${backend}". ` +
            `Supported: ${[...VALID_BACKENDS].join(", ")}`
          );
        }
        if ((backend === "shell" || backend === "git") && !node.command) {
          throw new Error(
            `Graph validation failed: ${backend} node "${id}" missing "command"`
          );
        }
      } else if (nodeType === "controller") {
        GraphLoader.validateControllerNode(node, id);
      } else {
        throw new Error(
          `Graph validation failed: node "${id}" has unsupported type "${nodeType}". ` +
          `Supported: "execute", "controller"`
        );
      }
    }

    // Validate edges
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i] as Record<string, unknown>;
      if (!edge.from || typeof edge.from !== "string") {
        throw new Error(
          `Graph validation failed: edge at index ${i} missing "from"`
        );
      }
      if (!edge.to || typeof edge.to !== "string") {
        throw new Error(
          `Graph validation failed: edge at index ${i} missing "to"`
        );
      }

      const fromResolved = resolveEdgeRef(edge.from, nodeIds);
      const toResolved = resolveEdgeRef(edge.to, nodeIds);

      if (fromResolved !== "graph.start" && !nodeIds.has(fromResolved)) {
        throw new Error(
          `Graph validation failed: edge from "${edge.from}" references unknown node "${fromResolved}"`
        );
      }
      if (!nodeIds.has(toResolved)) {
        throw new Error(
          `Graph validation failed: edge to "${edge.to}" references unknown node "${toResolved}"`
        );
      }
    }

    // Check that graph.start edges exist
    const startEdges = edges.filter(
      (e) => (e as Record<string, unknown>).from === "graph.start"
    );
    if (startEdges.length === 0) {
      throw new Error(
        `Graph validation failed: no edges from "graph.start" — graph has no entry point`
      );
    }

    // Validate workspace config
    const runtime = parsed.runtime as Record<string, unknown> | undefined;
    const workspace = runtime?.workspace as
      | Record<string, unknown>
      | undefined;
    if (workspace?.mode) {
      const mode = workspace.mode as string;
      if (mode !== "worktree" && mode !== "local") {
        throw new Error(
          `Graph validation failed: workspace.mode must be "worktree" or "local", got "${mode}"`
        );
      }
    }

    // Validate controller node routing
    GraphLoader.validateControllerRouting(
      nodes as GraphNode[],
      edges as Edge[],
      nodeIds
    );

    return parsed as unknown as GraphDefinition;
  }

  private static validateControllerNode(
    node: Record<string, unknown>,
    id: string
  ): void {
    if (!node.model || typeof node.model !== "string") {
      throw new Error(
        `Graph validation failed: controller node "${id}" missing "model"`
      );
    }
    if (!node.promptTemplate || typeof node.promptTemplate !== "string") {
      throw new Error(
        `Graph validation failed: controller node "${id}" missing "promptTemplate"`
      );
    }
    const outputs = node.outputs as Record<string, unknown> | undefined;
    if (!outputs || Object.keys(outputs).length === 0) {
      throw new Error(
        `Graph validation failed: controller node "${id}" must have at least one output`
      );
    }
    const readiness = node.readiness as Record<string, unknown> | undefined;
    if (!readiness || readiness.mode !== "all_required") {
      throw new Error(
        `Graph validation failed: controller node "${id}" must have readiness.mode = "all_required"`
      );
    }
  }

  private static normalize(parsed: Record<string, unknown>): void {
    const runtime = parsed.runtime as Record<string, unknown> | undefined;
    if (runtime) {
      copyAlias(runtime, "max_total_steps", "maxTotalSteps");
      copyAlias(runtime, "max_fix_attempts", "maxFixAttempts");
    }

    const nodes = parsed.nodes;
    if (!Array.isArray(nodes)) return;

    for (const node of nodes as Array<Record<string, unknown>>) {
      copyAlias(node, "prompt_template", "promptTemplate");
      copyAlias(node, "api_key", "apiKey");

      const execution = node.execution as Record<string, unknown> | undefined;
      if (execution) {
        copyAlias(execution, "timeout_ms", "timeoutMs");
        copyAlias(execution, "workspace_access", "workspaceAccess");
        copyAlias(execution, "reasoning_effort", "reasoningEffort");
      }

      const outputs = node.outputs as Record<
        string,
        Record<string, unknown>
      > | undefined;
      if (outputs) {
        for (const output of Object.values(outputs)) {
          copyAlias(output, "payload_schema", "payloadSchema");
        }
      }

      copyAlias(node, "decision_schema", "decisionSchema");
      copyAlias(node, "output_guards", "outputGuards");

      const limits = node.limits as Record<string, unknown> | undefined;
      if (limits) {
        copyAlias(limits, "min_confidence", "minConfidence");
        copyAlias(limits, "max_evaluations", "maxEvaluations");
      }
    }
  }

  private static validateControllerRouting(
    nodes: GraphNode[],
    edges: Edge[],
    nodeIds: Set<string>
  ): void {
    const controllerNodes = nodes.filter(
      (n) => n.type === "controller"
    );

    for (const ctrl of controllerNodes) {
      // Each controller output should have at least one outgoing edge
      const outputNames = Object.keys(ctrl.outputs || {});
      for (const outName of outputNames) {
        const hasEdge = edges.some((e) => {
          const parsed = parseEdgeRef(e.from);
          return (
            parsed &&
            parsed.nodeId === ctrl.id &&
            parsed.port === outName
          );
        });
        if (!hasEdge) {
          console.warn(
            `Warning: controller "${ctrl.id}" output "${outName}" has no outgoing edge`
          );
        }
      }

      // Check required inputs have incoming edges
      const inputNames = Object.keys(ctrl.inputs || {});
      for (const inName of inputNames) {
        const inputSpec = ctrl.inputs[inName];
        if (inputSpec?.required) {
          const hasIncomingEdge = edges.some((e) => {
            const parsed = parseEdgeRef(e.to);
            return (
              parsed &&
              parsed.nodeId === ctrl.id &&
              parsed.port === inName
            );
          });
          if (!hasIncomingEdge) {
            throw new Error(
              `Graph validation failed: controller "${ctrl.id}" required input "${inName}" has no incoming edge`
            );
          }
        }
      }

      GraphLoader.validateRequiredInputsDoNotJoinMutuallyExclusiveOutputs(
        ctrl,
        edges,
        nodes
      );
    }
  }

  private static validateRequiredInputsDoNotJoinMutuallyExclusiveOutputs(
    ctrl: GraphNode,
    edges: Edge[],
    nodes: GraphNode[]
  ): void {
    if (ctrl.type !== "controller") return;

    const requiredInputNames = new Set(
      Object.entries(ctrl.inputs || {})
        .filter(([, spec]) => spec?.required)
        .map(([name]) => name)
    );
    if (requiredInputNames.size < 2) return;

    const sourcePortsByController = new Map<string, Set<string>>();
    for (const edge of edges) {
      const target = parseEdgeRef(edge.to);
      if (
        !target ||
        target.nodeId !== ctrl.id ||
        target.direction !== "inputs" ||
        !requiredInputNames.has(target.port)
      ) {
        continue;
      }

      const source = parseEdgeRef(edge.from);
      if (!source || source.direction !== "outputs") continue;

      const sourceNode = nodes.find((node) => node.id === source.nodeId);
      if (sourceNode?.type !== "controller") continue;

      const ports =
        sourcePortsByController.get(source.nodeId) ?? new Set<string>();
      ports.add(source.port);
      sourcePortsByController.set(source.nodeId, ports);
    }

    for (const [sourceNodeId, ports] of sourcePortsByController) {
      if (ports.size < 2) continue;
      throw new Error(
        `Graph validation failed: controller "${ctrl.id}" may deadlock because required inputs come from mutually exclusive paths. ` +
        `Controller "${sourceNodeId}" can select only one of these outputs per evaluation: ${[...ports].join(", ")}. ` +
        `Use optional input, split the controller, or wait for all_active readiness support.`
      );
    }
  }
}

function copyAlias(
  target: Record<string, unknown>,
  from: string,
  to: string
): void {
  if (target[to] === undefined && target[from] !== undefined) {
    target[to] = target[from];
  }
}

// ─── Edge ref utilities ────────────────────────────────────────────

export interface EdgeRef {
  nodeId: string;
  direction: string;
  port: string;
}

/** Extract the node ID from an edge reference like "nodeId.inputs.port" or "nodeId.outputs.port" */
export function resolveEdgeRef(
  ref: string,
  nodeIds: Set<string>
): string {
  if (ref === "graph.start") return ref;

  const parts = ref.split(".");
  if (parts.length >= 1 && nodeIds.has(parts[0])) {
    return parts[0];
  }
  return parts[0] ?? ref;
}

/** Parse a full edge ref into its components */
export function parseEdgeRef(ref: string): EdgeRef | null {
  if (ref === "graph.start") {
    return {
      nodeId: "graph.start",
      direction: "start",
      port: "start",
    };
  }

  const parts = ref.split(".");
  if (parts.length >= 3) {
    return {
      nodeId: parts[0],
      direction: parts[1],
      port: parts[2],
    };
  }
  return null;
}

// Re-export Edge type for convenience
import type { Edge } from "./types.js";
