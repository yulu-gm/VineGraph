import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute } from "node:path";
import { listGraphPaths } from "../src/server.js";

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
