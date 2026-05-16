import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAgentGraphServer } from "../src/server.js";

function tempDir(prefix: string): string {
  const dir = resolve(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeGraph(path: string, id: string): void {
  writeFileSync(path, graphSource(id), "utf-8");
}

function graphSource(id: string): string {
  return [
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
  ].join("\n");
}

function listen(server: Server): Promise<string> {
  return new Promise((resolveUrl) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolveUrl(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });
}

async function withServer(
  fn: (baseUrl: string, root: string) => Promise<void>
): Promise<void> {
  const root = tempDir("vinegraph-server-product");
  const server = createAgentGraphServer(root);
  const baseUrl = await listen(server);

  try {
    await fn(baseUrl, root);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
}

async function openProject(baseUrl: string, rootPath: string): Promise<{
  id: string;
  rootPath: string;
  kind: string;
  capabilities: { git: boolean };
}> {
  const response = await fetch(`${baseUrl}/api/projects/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootPath }),
  });
  const project = await response.json() as {
    id: string;
    rootPath: string;
    kind: string;
    capabilities: { git: boolean };
  };

  assert.equal(response.status, 200);
  return project;
}

async function waitForRun(
  baseUrl: string,
  runId: string,
  projectId: string
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(
      `${baseUrl}/api/runs/${runId}?projectId=${projectId}`
    );
    if (response.status === 200) {
      const run = await response.json() as Record<string, unknown>;
      if (run.status !== "running") return run;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  throw new Error(`Run ${runId} did not finish`);
}

test("product server opens a non-git project and lists only VineGraph assets", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "loop.vg.yaml"), "loop_graph");
    writeGraph(join(root, "graphs", "other.vg.yml"), "other_graph");
    writeGraph(join(root, "graphs", "legacy.yaml"), "legacy_graph");
    writeFileSync(join(root, "graphs", "generic.yml"), "id: generic\n", "utf-8");

    const project = await openProject(baseUrl, root);

    assert.equal(project.kind, "directory");
    assert.equal(project.capabilities.git, false);

    const assetsResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets`
    );
    const assets = await assetsResponse.json() as Array<{ relativePath: string }>;

    assert.equal(assetsResponse.status, 200);
    assert.deepEqual(
      assets.map((asset) => asset.relativePath),
      ["graphs/loop.vg.yaml", "graphs/other.vg.yml"]
    );

    const workspacesResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/workspaces`
    );
    const workspaces = await workspacesResponse.json() as Array<{
      kind: string;
      path: string;
    }>;

    assert.equal(workspacesResponse.status, 200);
    assert.deepEqual(workspaces, [
      {
        id: "directory",
        kind: "directory",
        label: "Project directory",
        path: root,
        current: true,
      },
    ]);
  });
});

test("product graph asset routes read and save URL-encoded nested paths", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs", "nested"), { recursive: true });
    writeGraph(join(root, "graphs", "nested", "loop.vg.yaml"), "loop_graph");
    const project = await openProject(baseUrl, root);
    const assetPath = encodeURIComponent("graphs/nested/loop.vg.yaml");

    const detailResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets/${assetPath}`
    );
    const detail = await detailResponse.json() as {
      asset: { relativePath: string };
      raw: string;
      graph: { id: string };
    };

    assert.equal(detailResponse.status, 200);
    assert.equal(detail.asset.relativePath, "graphs/nested/loop.vg.yaml");
    assert.equal(detail.graph.id, "loop_graph");

    const savedRaw = detail.raw.replace("loop_graph", "saved_graph");
    const saveResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets/${assetPath}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: savedRaw }),
      }
    );
    const saved = await saveResponse.json() as { graphId: string };

    assert.equal(saveResponse.status, 200);
    assert.equal(saved.graphId, "saved_graph");
    assert.match(
      readFileSync(join(root, "graphs", "nested", "loop.vg.yaml"), "utf-8"),
      /saved_graph/
    );
  });
});

test("product runs use explicit project graph and workspace and can be read from project history", async () => {
  await withServer(async (baseUrl, root) => {
    const workspace = join(root, "manual-workspace");
    mkdirSync(join(root, "graphs"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeGraph(join(root, "graphs", "run.vg.yaml"), "product_run_graph");
    const project = await openProject(baseUrl, root);

    const startResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        graphPath: "graphs/run.vg.yaml",
        workspaceTarget: {
          kind: "directory",
          path: workspace,
        },
      }),
    });
    const started = await startResponse.json() as {
      runId: string;
      status: string;
      graphId: string;
      graphPath: string;
      projectId: string;
    };

    assert.equal(startResponse.status, 202);
    assert.equal(started.status, "running");
    assert.equal(started.graphId, "product_run_graph");
    assert.equal(started.projectId, project.id);
    assert.equal(started.graphPath, resolve(root, "graphs", "run.vg.yaml"));

    const run = await waitForRun(baseUrl, started.runId, project.id);
    assert.equal(run.status, "success");
    assert.equal(run.projectId, project.id);
    assert.equal(run.projectRoot, root);
    const runWorkspace = run.workspace as {
      mode?: string;
      path?: string;
      gitEnabled?: boolean;
    };
    assert.equal(runWorkspace.mode, "directory");
    assert.equal(runWorkspace.path, workspace);
    assert.equal(runWorkspace.gitEnabled, false);

    const listResponse = await fetch(
      `${baseUrl}/api/runs?projectId=${project.id}`
    );
    const runs = await listResponse.json() as Array<{ runId: string }>;

    assert.equal(listResponse.status, 200);
    assert.equal(runs.some((item) => item.runId === started.runId), true);
  });
});

test("product config routes load and save normalized app config", async () => {
  const configRoot = tempDir("vinegraph-server-config");
  const previousConfigPath = process.env.AGENTGRAPH_APP_CONFIG_PATH;
  process.env.AGENTGRAPH_APP_CONFIG_PATH = join(configRoot, "config.json");

  try {
    await withServer(async (baseUrl) => {
      const initialResponse = await fetch(`${baseUrl}/api/config`);
      const initial = await initialResponse.json() as { themeMode: string };

      assert.equal(initialResponse.status, 200);
      assert.equal(initial.themeMode, "system");

      const saveResponse = await fetch(`${baseUrl}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          themeMode: "dark",
          graphAssetGlobs: [],
          recentProjects: [],
          codexCliPath: "  /usr/local/bin/codex  ",
        }),
      });
      const saved = await saveResponse.json() as {
        themeMode: string;
        graphAssetGlobs: string[];
        codexCliPath: string;
      };

      assert.equal(saveResponse.status, 200);
      assert.equal(saved.themeMode, "dark");
      assert.deepEqual(saved.graphAssetGlobs, ["**/*.vg.yaml", "**/*.vg.yml"]);
      assert.equal(saved.codexCliPath, "/usr/local/bin/codex");
    });
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.AGENTGRAPH_APP_CONFIG_PATH;
    } else {
      process.env.AGENTGRAPH_APP_CONFIG_PATH = previousConfigPath;
    }
    rmSync(configRoot, { recursive: true, force: true });
  }
});
