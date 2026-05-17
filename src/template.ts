import Mustache from "mustache";
import type { TemplateContext } from "./types.js";

export function render(
  template: string,
  context: TemplateContext
): string {
  return Mustache.render(template, context, {}, { escape: (v) => v });
}

export function buildContext(params: {
  graphInputs: Record<string, unknown>;
  nodeId?: string;
  nodeInputs?: Record<string, unknown>;
  nodeOutputs: Map<string, Record<string, unknown>>;
  runtimeFacts: Record<string, unknown>;
  workspacePath: string;
  controllerPayloads: Record<string, unknown>;
}): TemplateContext {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const [nodeId, outputs] of params.nodeOutputs) {
    nodes[nodeId] = outputs;
  }

  return {
    inputs: params.graphInputs,
    node: {
      id: params.nodeId,
      inputs: params.nodeInputs ?? {},
    },
    nodes,
    runtime: params.runtimeFacts,
    workspace: { path: params.workspacePath },
    controller: params.controllerPayloads,
  };
}
