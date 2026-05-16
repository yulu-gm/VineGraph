import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute, resolve } from "node:path";
import { listGraphPaths, loadGraphDetails } from "../src/server.js";

test("graph listing is rooted at the project directory even when cwd changes", () => {
  const originalCwd = process.cwd();
  process.chdir("src-tauri");
  try {
    const graphs = listGraphPaths();
    assert.ok(
      graphs.some((graphPath) =>
        graphPath.replace(/\\/g, "/").endsWith("examples/project-task-loop.yaml")
      )
    );
    assert.ok(graphs.every((graphPath) => isAbsolute(graphPath)));
  } finally {
    process.chdir(originalCwd);
  }
});

test("loadGraphDetails returns the real graph definition", () => {
  const graph = loadGraphDetails(resolve("examples/project-task-loop.yaml"));
  assert.equal(graph.id, "project_remaining_tasks_loop");

  const implementFeature = graph.nodes.find(
    (node) => node.id === "implement_feature"
  );
  assert.equal(implementFeature?.type, "execute");
  assert.match(
    implementFeature?.promptTemplate ?? "",
    /You are implementing the next unfinished VineGraph task/
  );
});
