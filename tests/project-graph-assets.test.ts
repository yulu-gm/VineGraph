import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openProjectDirectory } from "../src/projects.js";
import {
  copyGraphAsset,
  createGraphAssetFromTemplate,
  importLegacyGraphAsset,
  readGraphAsset,
  renameGraphAsset,
  scanGraphAssets,
  validateGraphAsset,
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

test("openProjectDirectory accepts non-git directories with limited capabilities", () => {
  const root = tempDir("vinegraph-plain-project");
  try {
    const project = openProjectDirectory(root, 1000);

    assert.equal(project instanceof Promise, false);
    assert.equal(project.kind, "directory");
    assert.equal(project.capabilities.git, false);
    assert.equal(project.capabilities.worktrees, false);
    assert.equal(project.rootPath, root);
    assert.equal(project.name.startsWith("vinegraph-plain-project"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openProjectDirectory detects git projects", () => {
  const root = tempDir("vinegraph-git-project");
  try {
    execFileSync("git", ["init", "-b", "master"], { cwd: root });
    execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });

    const project = openProjectDirectory(root, 1000);

    assert.equal(project instanceof Promise, false);
    assert.equal(project.kind, "git");
    assert.equal(project.capabilities.git, true);
    assert.equal(project.capabilities.worktrees, true);
    assert.equal(project.branch, "master");
    assert.equal(project.dirty, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openProjectDirectory rejects file paths", () => {
  const root = tempDir("vinegraph-file-project");
  try {
    const filePath = join(root, "project.txt");
    writeFileSync(filePath, "not a directory\n", "utf-8");

    assert.throws(
      () => openProjectDirectory(filePath, 1000),
      /Project path is not a directory/
    );
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
    assert.equal(validateGraphAsset(project, "graphs/loop.vg.yaml").id, "loop_graph");

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
    assert.throws(
      () => writeGraphAsset(project, "../outside.vg.yaml", read.raw),
      /inside project root/
    );
    assert.throws(
      () => renameGraphAsset(project, "graphs/renamed.vg.yaml", "../renamed.vg.yaml"),
      /inside project root/
    );
    assert.throws(
      () => createGraphAssetFromTemplate(project, "../new-flow.vg.yaml", "outside_flow"),
      /inside project root/
    );
    assert.throws(
      () => importLegacyGraphAsset(project, "legacy.yaml", "../imported.vg.yaml"),
      /inside project root/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph asset writes cannot escape project root through symlinks", () => {
  const root = tempDir("vinegraph-symlink-root");
  const outside = tempDir("vinegraph-symlink-outside");
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
    symlinkSync(outside, join(root, "linked-outside"), "dir");
    writeGraph(join(root, "graphs", "loop.vg.yaml"), "loop_graph");
    writeGraph(join(outside, "outside.vg.yaml"), "outside_graph");

    const raw = readFileSync(join(root, "graphs", "loop.vg.yaml"), "utf-8");

    assert.throws(
      () => writeGraphAsset(project, "linked-outside/outside.vg.yaml", raw),
      /inside project root/
    );
    assert.throws(
      () => writeGraphAsset(project, "linked-outside/new.vg.yaml", raw),
      /inside project root/
    );
    assert.throws(
      () => createGraphAssetFromTemplate(project, "linked-outside/created.vg.yaml", "created_graph"),
      /inside project root/
    );
    assert.throws(
      () => renameGraphAsset(project, "graphs/loop.vg.yaml", "linked-outside/renamed.vg.yaml"),
      /inside project root/
    );
    assert.throws(
      () => importLegacyGraphAsset(project, "graphs/loop.vg.yaml", "linked-outside/imported.vg.yaml"),
      /inside project root/
    );
    assert.equal(existsSync(join(outside, "new.vg.yaml")), false);
    assert.equal(existsSync(join(outside, "created.vg.yaml")), false);
    assert.equal(existsSync(join(outside, "renamed.vg.yaml")), false);
    assert.equal(existsSync(join(outside, "imported.vg.yaml")), false);
    assert.equal(existsSync(join(root, "graphs", "loop.vg.yaml")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("renameGraphAsset and copyGraphAsset require valid graph asset sources", () => {
  const root = tempDir("vinegraph-source-validation");
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
    writeGraph(join(root, "graphs", "valid.vg.yaml"), "valid_graph");
    writeGraph(join(root, "legacy.yaml"), "legacy_graph");
    writeGraph(join(root, "legacy.yml"), "legacy_yml_graph");
    writeFileSync(
      join(root, "graphs", "invalid.vg.yaml"),
      [
        "id: invalid_graph",
        'version: "0.1.0"',
        "nodes: []",
        "edges: []",
        "",
      ].join("\n"),
      "utf-8"
    );

    assert.throws(
      () => renameGraphAsset(project, "legacy.yaml", "graphs/renamed-from-yaml.vg.yaml"),
      /Graph asset must use \.vg\.yaml or \.vg\.yml/
    );
    assert.throws(
      () => renameGraphAsset(project, "legacy.yml", "graphs/renamed-from-yml.vg.yaml"),
      /Graph asset must use \.vg\.yaml or \.vg\.yml/
    );
    assert.throws(
      () => copyGraphAsset(project, "legacy.yaml", "graphs/copied-from-yaml.vg.yaml"),
      /Graph asset must use \.vg\.yaml or \.vg\.yml/
    );
    assert.throws(
      () => copyGraphAsset(project, "legacy.yml", "graphs/copied-from-yml.vg.yaml"),
      /Graph asset must use \.vg\.yaml or \.vg\.yml/
    );
    assert.throws(
      () => renameGraphAsset(project, "graphs/invalid.vg.yaml", "graphs/renamed-invalid.vg.yaml"),
      /Graph validation failed/
    );
    assert.throws(
      () => copyGraphAsset(project, "graphs/invalid.vg.yaml", "graphs/copied-invalid.vg.yaml"),
      /Graph validation failed/
    );
    assert.equal(existsSync(join(root, "graphs", "renamed-from-yaml.vg.yaml")), false);
    assert.equal(existsSync(join(root, "graphs", "renamed-from-yml.vg.yaml")), false);
    assert.equal(existsSync(join(root, "graphs", "copied-from-yaml.vg.yaml")), false);
    assert.equal(existsSync(join(root, "graphs", "copied-from-yml.vg.yaml")), false);
    assert.equal(existsSync(join(root, "graphs", "renamed-invalid.vg.yaml")), false);
    assert.equal(existsSync(join(root, "graphs", "copied-invalid.vg.yaml")), false);

    const copied = copyGraphAsset(project, "graphs/valid.vg.yaml", "graphs/copied-valid.vg.yaml");
    assert.equal(copied.relativePath, "graphs/copied-valid.vg.yaml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create, copy, rename, and import reject existing targets without overwriting", () => {
  const root = tempDir("vinegraph-no-clobber");
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
    writeGraph(join(root, "graphs", "source.vg.yaml"), "source_graph");
    writeGraph(join(root, "graphs", "rename-source.vg.yaml"), "rename_source_graph");
    writeGraph(join(root, "graphs", "target.vg.yaml"), "target_graph");
    writeGraph(join(root, "legacy.yaml"), "legacy_graph");
    const originalTarget = readFileSync(join(root, "graphs", "target.vg.yaml"), "utf-8");

    assert.throws(
      () => createGraphAssetFromTemplate(project, "graphs/target.vg.yaml", "created_graph"),
      /Graph asset target already exists/
    );
    assert.throws(
      () => copyGraphAsset(project, "graphs/source.vg.yaml", "graphs/target.vg.yaml"),
      /Graph asset target already exists/
    );
    assert.throws(
      () => renameGraphAsset(project, "graphs/rename-source.vg.yaml", "graphs/target.vg.yaml"),
      /Graph asset target already exists/
    );
    assert.throws(
      () => importLegacyGraphAsset(project, "legacy.yaml", "graphs/target.vg.yaml"),
      /Graph asset target already exists/
    );
    assert.equal(readFileSync(join(root, "graphs", "target.vg.yaml"), "utf-8"), originalTarget);
    assert.equal(existsSync(join(root, "graphs", "rename-source.vg.yaml")), true);

    const saved = originalTarget.replace("target_graph", "saved_target_graph");
    writeGraphAsset(project, "graphs/target.vg.yaml", saved);
    assert.equal(readFileSync(join(root, "graphs", "target.vg.yaml"), "utf-8"), saved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph asset operations report clear errors for empty YAML documents", () => {
  const root = tempDir("vinegraph-empty-yaml");
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
    writeFileSync(join(root, "graphs", "empty.vg.yaml"), "\n", "utf-8");

    assert.throws(
      () => validateGraphAsset(project, "graphs/empty.vg.yaml"),
      /Graph asset validation failed: YAML document must be a non-null object/
    );
    assert.throws(
      () => readGraphAsset(project, "graphs/empty.vg.yaml"),
      /Graph asset validation failed: YAML document must be a non-null object/
    );
    assert.throws(
      () => writeGraphAsset(project, "graphs/new-empty.vg.yaml", "\n"),
      /Graph asset validation failed: YAML document must be a non-null object/
    );
    assert.throws(
      () => copyGraphAsset(project, "graphs/empty.vg.yaml", "graphs/copied-empty.vg.yaml"),
      /Graph asset validation failed: YAML document must be a non-null object/
    );
    assert.equal(existsSync(join(root, "graphs", "new-empty.vg.yaml")), false);
    assert.equal(existsSync(join(root, "graphs", "copied-empty.vg.yaml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
