import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Scheduler } from "../src/scheduler.js";
import type { GraphDefinition } from "../src/types.js";

function tempDir(prefix: string): string {
  const dir = resolve(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function comparablePath(path: string): string {
  return realpathSync.native(path).replace(/\\/g, "/");
}

test("scheduler runs shell nodes in the explicit workspace target", async () => {
  const processRoot = tempDir("vinegraph-scheduler-process");
  const projectRoot = tempDir("vinegraph-scheduler-project");
  const workspacePath = tempDir("vinegraph-scheduler-workspace");
  const originalCwd = process.cwd();

  try {
    process.chdir(processRoot);

    const graph: GraphDefinition = {
      id: "selected_workspace_target_graph",
      version: "0.1.0",
      runtime: {
        maxTotalSteps: 3,
        workspace: { mode: "worktree" },
      },
      nodes: [
        {
          id: "write_selected_file",
          type: "execute",
          backend: "shell",
          command: {
            program: "node",
            args: [
              "-e",
              "require('fs').writeFileSync('selected-workspace.txt', process.cwd())",
            ],
          },
        },
        {
          id: "end_success",
          type: "execute",
          backend: "internal",
          command: { program: "internal", args: ["finish_success"] },
        },
      ],
      edges: [
        { from: "graph.start", to: "write_selected_file.inputs.trigger" },
        { from: "write_selected_file.outputs.done", to: "end_success.inputs.trigger" },
      ],
    };

    const result = await Scheduler.run(
      graph,
      resolve(projectRoot, "selected-workspace.yaml"),
      {
        runId: "selected-workspace-run",
        projectId: "project-selected-workspace",
        projectRoot,
        workspacePath,
        workspaceMode: "directory",
        workspaceGitEnabled: false,
      }
    );

    const runRecordPath = resolve(
      projectRoot,
      ".agentgraph",
      "runs",
      "selected-workspace-run.json"
    );
    const indexPath = resolve(projectRoot, ".agentgraph", "runs", "index.jsonl");
    const processRunRecordPath = resolve(
      processRoot,
      ".agentgraph",
      "runs",
      "selected-workspace-run.json"
    );

    assert.equal(result.status, "success");
    assert.equal(result.projectId, "project-selected-workspace");
    assert.equal(comparablePath(result.projectRoot ?? ""), comparablePath(projectRoot));
    assert.equal(result.workspace?.mode, "directory");
    assert.equal(comparablePath(result.workspace?.path ?? ""), comparablePath(workspacePath));
    assert.equal(result.workspace?.gitEnabled, false);
    assert.equal(
      comparablePath(readFileSync(resolve(workspacePath, "selected-workspace.txt"), "utf-8")),
      comparablePath(workspacePath)
    );
    assert.equal(existsSync(resolve(projectRoot, "selected-workspace.txt")), false);
    assert.equal(existsSync(resolve(processRoot, "selected-workspace.txt")), false);
    assert.equal(existsSync(runRecordPath), true);
    assert.equal(existsSync(processRunRecordPath), false);

    const indexRow = JSON.parse(readFileSync(indexPath, "utf-8").trim());
    assert.equal(indexRow.projectId, "project-selected-workspace");
    assert.equal(indexRow.graphPath, resolve(projectRoot, "selected-workspace.yaml"));
  } finally {
    process.chdir(originalCwd);
    rmSync(processRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
