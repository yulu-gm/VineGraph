import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openProjectDirectory } from "../src/projects.js";
import {
  createGraphAssetFromTemplate,
  importLegacyGraphAsset,
  readGraphAsset,
  renameGraphAsset,
  scanGraphAssets,
  writeGraphAsset,
} from "../src/graph-assets.js";

function tempDir(prefix: string): string {
  const dir = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeGraph(path: string, id: string): void {
  writeFileSync(
    path,
    [
      `id: ${id}`,
      'version: "0.1.0"',
      "nodes:",
      "  - id: finish",
      "    type: execute",
      "    backend: internal",
      "    command:",
      "      program: internal",
      "      args: [finish_success]",
      "edges:",
      "  - from: graph.start",
      "    to: finish.inputs.trigger",
      "",
    ].join("\n"),
    "utf-8"
  );
}

test("openProjectDirectory accepts non-git directories with limited capabilities", async () => {
  const root = tempDir("vinegraph-plain-project");
  try {
    const project = await openProjectDirectory(root, 1000);

    assert.equal(project.kind, "directory");
    assert.equal(project.capabilities.git, false);
    assert.equal(project.capabilities.worktrees, false);
    assert.equal(project.rootPath, root);
    assert.equal(project.name.startsWith("vinegraph-plain-project"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openProjectDirectory detects git projects", async () => {
  const root = tempDir("vinegraph-git-project");
  try {
    execFileSync("git", ["init", "-b", "master"], { cwd: root });
    execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });

    const project = await openProjectDirectory(root, 1000);

    assert.equal(project.kind, "git");
    assert.equal(project.capabilities.git, true);
    assert.equal(project.capabilities.worktrees, true);
    assert.equal(project.branch, "master");
    assert.equal(project.dirty, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph asset scanner only includes VineGraph graph extensions", () => {
  const root = tempDir("vinegraph-assets");
  try {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "loop.vg.yaml"), "loop_graph");
    writeGraph(join(root, "graphs", "other.vg.yml"), "other_graph");
    writeGraph(join(root, "graphs", "legacy.yaml"), "legacy_graph");
    writeFileSync(join(root, "graphs", "not-yaml.txt"), "text\n", "utf-8");

    const project = {
      id: "project-1",
      name: "Assets",
      rootPath: root,
      kind: "directory" as const,
      graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
      createdAt: 1,
      lastOpenedAt: 1,
    };

    const assets = scanGraphAssets(project);

    assert.deepEqual(
      assets.map((asset) => asset.relativePath).sort(),
      ["graphs/loop.vg.yaml", "graphs/other.vg.yml"]
    );
    assert.equal(assets.find((asset) => asset.relativePath === "graphs/loop.vg.yaml")?.graphId, "loop_graph");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph asset read, save, rename, create, and import stay inside project root", () => {
  const root = tempDir("vinegraph-asset-ops");
  try {
    const project = {
      id: "project-1",
      name: "Assets",
      rootPath: root,
      kind: "directory" as const,
      graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
      createdAt: 1,
      lastOpenedAt: 1,
    };
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "loop.vg.yaml"), "loop_graph");
    writeGraph(join(root, "legacy.yaml"), "legacy_graph");

    const read = readGraphAsset(project, "graphs/loop.vg.yaml");
    assert.equal(read.graph.id, "loop_graph");

    writeGraphAsset(project, "graphs/loop.vg.yaml", read.raw.replace("loop_graph", "saved_graph"));
    assert.match(readFileSync(join(root, "graphs", "loop.vg.yaml"), "utf-8"), /saved_graph/);

    const renamed = renameGraphAsset(project, "graphs/loop.vg.yaml", "graphs/renamed.vg.yaml");
    assert.equal(renamed.relativePath, "graphs/renamed.vg.yaml");

    const created = createGraphAssetFromTemplate(project, "graphs/new-flow.vg.yaml", "new_flow");
    assert.equal(created.relativePath, "graphs/new-flow.vg.yaml");

    const imported = importLegacyGraphAsset(project, "legacy.yaml", "graphs/imported.vg.yaml");
    assert.equal(imported.relativePath, "graphs/imported.vg.yaml");

    assert.throws(
      () => readGraphAsset(project, "../outside.vg.yaml"),
      /inside project root/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
