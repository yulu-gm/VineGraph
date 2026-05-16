import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function writeShellReadGraph(path: string, id: string): void {
  const shell = process.platform === "win32"
    ? {
        program: "cmd.exe",
        args: ["/c", "set /p x=&echo GOT:%x%"],
      }
    : {
        program: "sh",
        args: ["-lc", "read line; printf 'GOT:%s\\n' \"$line\""],
      };
  writeFileSync(path, shellGraphSource(id, "prompt", shell), "utf-8");
}

function writeShellSleepGraph(path: string, id: string): void {
  const shell = process.platform === "win32"
    ? {
        program: "powershell",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Start-Sleep -Seconds 8; Write-Output SHOULD_NOT_REACH",
        ],
      }
    : {
        program: "sh",
        args: ["-lc", "sleep 8; printf 'SHOULD_NOT_REACH\\n'"],
      };
  writeFileSync(path, shellGraphSource(id, "slow", shell), "utf-8");
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

function shellGraphSource(
  id: string,
  nodeId: string,
  command: { program: string; args: string[] }
): string {
  return [
    `id: ${id}`,
    'version: "0.1.0"',
    "nodes:",
    `  - id: ${nodeId}`,
    "    type: execute",
    "    backend: shell",
    "    command:",
    `      program: ${JSON.stringify(command.program)}`,
    "      args:",
    ...command.args.map((arg) => `        - ${JSON.stringify(arg)}`),
    "edges:",
    `  - from: graph.start`,
    `    to: ${nodeId}.inputs.trigger`,
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
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(
      `${baseUrl}/api/runs/${runId}?projectId=${projectId}`
    );
    if (response.status === 200) {
      const run = await response.json() as Record<string, unknown>;
      if (run.status !== "running") return run;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  }
  throw new Error(`Run ${runId} did not finish`);
}

async function startProjectRun(
  baseUrl: string,
  projectId: string,
  graphPath: string,
  root: string
): Promise<{ runId: string }> {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      graphPath,
      workspaceTarget: {
        kind: "directory",
        path: root,
      },
    }),
  });
  const started = await response.json() as { runId: string };
  assert.equal(response.status, 202);
  return started;
}

async function postTerminalUntilReady(
  baseUrl: string,
  runId: string,
  action: "input" | "resize" | "interrupt",
  body?: unknown
): Promise<Response> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(
      `${baseUrl}/api/runs/${runId}/terminal/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }
    );
    if (response.status !== 404) return response;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  throw new Error(`Terminal ${action} endpoint did not become ready`);
}

async function cancelRun(baseUrl: string, runId: string): Promise<void> {
  await fetch(`${baseUrl}/api/runs/${runId}`, { method: "POST" }).catch(() => undefined);
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

test("product server serves xterm vendor modules and CSS", async () => {
  await withServer(async (baseUrl) => {
    const moduleResponse = await fetch(`${baseUrl}/vendor/@xterm/xterm/lib/xterm.mjs`);
    const moduleText = await moduleResponse.text();
    assert.equal(moduleResponse.status, 200);
    assert.match(moduleResponse.headers.get("content-type") ?? "", /text\/javascript|application\/javascript/);
    assert.match(moduleText, /Terminal/);

    const cssResponse = await fetch(`${baseUrl}/vendor/@xterm/xterm/css/xterm.css`);
    const cssText = await cssResponse.text();
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get("content-type") ?? "", /text\/css/);
    assert.match(cssText, /xterm/);

    const metadataResponse = await fetch(`${baseUrl}/vendor/@xterm/xterm/package.json`);
    assert.equal(metadataResponse.status, 404);

    const mapResponse = await fetch(`${baseUrl}/vendor/@xterm/xterm/lib/xterm.mjs.map`);
    assert.equal(mapResponse.status, 404);

    const unsupportedPackageResponse = await fetch(`${baseUrl}/vendor/js-yaml/index.js`);
    assert.equal(unsupportedPackageResponse.status, 404);

    const traversalResponse = await fetch(`${baseUrl}/vendor/@xterm/xterm/lib/%2e%2e/package.json`);
    assert.equal(traversalResponse.status, 404);
  });
});

test("product server creates a directory project with a default graph asset", async () => {
  await withServer(async (baseUrl, root) => {
    const projectRoot = join(root, "new-agent-project");
    const response = await fetch(`${baseUrl}/api/projects/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: projectRoot }),
    });
    const payload = await response.json() as {
      project: { id: string; rootPath: string; kind: string };
      asset: { relativePath: string; graphId: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.project.rootPath, projectRoot);
    assert.equal(payload.project.kind, "directory");
    assert.equal(payload.asset.relativePath, "main.vg.yaml");
    assert.equal(payload.asset.graphId, "main");
    assert.match(readFileSync(join(projectRoot, "main.vg.yaml"), "utf-8"), /id: main/);

    const assetsResponse = await fetch(
      `${baseUrl}/api/projects/${payload.project.id}/graph-assets`
    );
    const assets = await assetsResponse.json() as Array<{ relativePath: string }>;
    assert.equal(assetsResponse.status, 200);
    assert.deepEqual(assets.map((asset) => asset.relativePath), ["main.vg.yaml"]);
  });
});

test("product server creates a graph asset from the project asset collection", async () => {
  await withServer(async (baseUrl, root) => {
    const project = await openProject(baseUrl, root);
    const response = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relativePath: "review-loop.vg.yaml",
          graphId: "review_loop",
        }),
      }
    );
    const asset = await response.json() as { relativePath: string; graphId: string };

    assert.equal(response.status, 201);
    assert.equal(asset.relativePath, "review-loop.vg.yaml");
    assert.equal(asset.graphId, "review_loop");
    assert.match(readFileSync(join(root, "review-loop.vg.yaml"), "utf-8"), /id: review_loop/);

    const duplicateResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relativePath: "review-loop.vg.yaml",
          graphId: "review_loop",
        }),
      }
    );
    assert.equal(duplicateResponse.status, 409);
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

test("product graph asset routes save graph objects as YAML", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "editable.vg.yaml"), "editable_graph");
    const project = await openProject(baseUrl, root);
    const assetPath = encodeURIComponent("graphs/editable.vg.yaml");

    const saveResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets/${assetPath}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: {
            id: "saved_from_object",
            version: "0.1.0",
            nodes: [
              {
                id: "finish",
                type: "execute",
                backend: "internal",
                command: {
                  program: "internal",
                  args: ["finish_success"],
                },
              },
            ],
            edges: [
              {
                from: "graph.start",
                to: "finish.inputs.trigger",
              },
            ],
          },
        }),
      }
    );
    const saved = await saveResponse.json() as {
      graphId: string;
      relativePath: string;
    };

    assert.equal(saveResponse.status, 200);
    assert.equal(saved.graphId, "saved_from_object");
    assert.equal(saved.relativePath, "graphs/editable.vg.yaml");
    assert.match(
      readFileSync(join(root, "graphs", "editable.vg.yaml"), "utf-8"),
      /id: saved_from_object/
    );
  });
});

test("product graph asset save returns 400 when graph object validation fails", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "invalid-save.vg.yaml"), "valid_graph");
    const project = await openProject(baseUrl, root);
    const assetPath = encodeURIComponent("graphs/invalid-save.vg.yaml");

    const saveResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets/${assetPath}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: {
            id: "invalid_graph",
            version: "0.1.0",
            nodes: [],
            edges: [],
          },
        }),
      }
    );
    const error = await saveResponse.json() as { error: string };

    assert.equal(saveResponse.status, 400);
    assert.match(error.error, /Graph validation failed/);
    assert.match(
      readFileSync(join(root, "graphs", "invalid-save.vg.yaml"), "utf-8"),
      /id: valid_graph/
    );
  });
});

test("product graph asset routes return canonical relative paths for traversal-equivalent URLs", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs", "nested"), { recursive: true });
    writeGraph(join(root, "graphs", "nested", "loop.vg.yaml"), "loop_graph");
    const project = await openProject(baseUrl, root);
    const traversalPath = encodeURIComponent(
      "graphs/nested/../nested/loop.vg.yaml"
    );

    const detailResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets/${traversalPath}`
    );
    const detail = await detailResponse.json() as {
      asset: { relativePath: string };
      raw: string;
    };

    assert.equal(detailResponse.status, 200);
    assert.equal(detail.asset.relativePath, "graphs/nested/loop.vg.yaml");

    const saveResponse = await fetch(
      `${baseUrl}/api/projects/${project.id}/graph-assets/${traversalPath}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw: detail.raw.replace("loop_graph", "saved_graph"),
        }),
      }
    );
    const saved = await saveResponse.json() as { relativePath: string };

    assert.equal(saveResponse.status, 200);
    assert.equal(saved.relativePath, "graphs/nested/loop.vg.yaml");
  });
});

test("product runs use explicit project graph and workspace and can be read from project history", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
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
          path: root,
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
    assert.equal(runWorkspace.path, root);
    assert.equal(runWorkspace.gitEnabled, false);

    const listResponse = await fetch(
      `${baseUrl}/api/runs?projectId=${project.id}`
    );
    const runs = await listResponse.json() as Array<{ runId: string }>;

    assert.equal(listResponse.status, 200);
    assert.equal(runs.some((item) => item.runId === started.runId), true);
  });
});

test("product run terminal input reaches the active shell PTY", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeShellReadGraph(join(root, "graphs", "terminal-input.vg.yaml"), "terminal_input_graph");
    const project = await openProject(baseUrl, root);
    const started = await startProjectRun(
      baseUrl,
      project.id,
      "graphs/terminal-input.vg.yaml",
      root
    );

    try {
      const inputResponse = await postTerminalUntilReady(
        baseUrl,
        started.runId,
        "input",
        { input: "hello\n" }
      );
      assert.equal(inputResponse.status, 204);

      const run = await waitForRun(baseUrl, started.runId, project.id);
      const activation = (run.activations as Array<{
        rawResult?: { stdout?: string; terminalTranscript?: string };
      }>).find((item) => item.rawResult);
      const terminalOutput = [
        activation?.rawResult?.stdout,
        activation?.rawResult?.terminalTranscript,
      ].join("\n");

      assert.equal(run.status, "success");
      assert.match(terminalOutput, /GOT:hello/);
    } finally {
      await cancelRun(baseUrl, started.runId);
    }
  });
});

test("product run terminal resize accepts valid dimensions and rejects invalid dimensions", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeShellReadGraph(join(root, "graphs", "terminal-resize.vg.yaml"), "terminal_resize_graph");
    const project = await openProject(baseUrl, root);
    const started = await startProjectRun(
      baseUrl,
      project.id,
      "graphs/terminal-resize.vg.yaml",
      root
    );

    try {
      const resizeResponse = await postTerminalUntilReady(
        baseUrl,
        started.runId,
        "resize",
        { cols: 120, rows: 32 }
      );
      assert.equal(resizeResponse.status, 204);

      const invalidResponse = await fetch(
        `${baseUrl}/api/runs/${started.runId}/terminal/resize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols: 0, rows: 32 }),
        }
      );
      assert.equal(invalidResponse.status, 400);

      const inputResponse = await postTerminalUntilReady(
        baseUrl,
        started.runId,
        "input",
        { data: "done\n" }
      );
      assert.equal(inputResponse.status, 204);
      const run = await waitForRun(baseUrl, started.runId, project.id);
      assert.equal(run.status, "success");
    } finally {
      await cancelRun(baseUrl, started.runId);
    }
  });
});

test("product run terminal interrupt succeeds for an active shell PTY", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeShellSleepGraph(join(root, "graphs", "terminal-interrupt.vg.yaml"), "terminal_interrupt_graph");
    const project = await openProject(baseUrl, root);
    const started = await startProjectRun(
      baseUrl,
      project.id,
      "graphs/terminal-interrupt.vg.yaml",
      root
    );

    try {
      const interruptResponse = await postTerminalUntilReady(
        baseUrl,
        started.runId,
        "interrupt"
      );
      assert.equal(interruptResponse.status, 204);
    } finally {
      await cancelRun(baseUrl, started.runId);
    }
  });
});

test("product run terminal input returns conflict after the run is complete", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "complete.vg.yaml"), "complete_graph");
    const project = await openProject(baseUrl, root);
    const started = await startProjectRun(
      baseUrl,
      project.id,
      "graphs/complete.vg.yaml",
      root
    );

    const run = await waitForRun(baseUrl, started.runId, project.id);
    assert.equal(run.status, "success");

    const response = await fetch(
      `${baseUrl}/api/runs/${started.runId}/terminal/input`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "too late\n" }),
      }
    );
    assert.equal(response.status, 409);
  });
});

test("product run rejects symlink graph paths that escape the opened project", async () => {
  const outside = tempDir("vinegraph-outside-graph");
  try {
    await withServer(async (baseUrl, root) => {
      mkdirSync(join(root, "graphs"), { recursive: true });
      writeGraph(join(outside, "escape.vg.yaml"), "outside_graph");
      symlinkSync(join(outside, "escape.vg.yaml"), join(root, "graphs", "escape.vg.yaml"));
      const project = await openProject(baseUrl, root);

      const response = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          graphPath: "graphs/escape.vg.yaml",
        }),
      });
      const body = await response.json() as { error?: string };

      assert.equal(response.status, 400);
      assert.match(body.error ?? "", /inside the project root/);

      const runsResponse = await fetch(
        `${baseUrl}/api/runs?projectId=${project.id}`
      );
      const runs = await runsResponse.json() as unknown[];
      assert.deepEqual(runs, []);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product readiness resolves relative graph paths inside opened project root", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "doctor.vg.yaml"), "product_doctor_graph");
    const project = await openProject(baseUrl, root);

    const response = await fetch(
      `${baseUrl}/api/readiness?projectId=${project.id}&path=${encodeURIComponent("graphs/doctor.vg.yaml")}`
    );
    const result = await response.json() as {
      graphPath?: string;
      checks?: Array<{ id: string; message: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(result.graphPath, resolve(root, "graphs", "doctor.vg.yaml"));
    assert.equal(
      result.checks?.some((item) => item.id === "graph_load" && item.message.includes("product_doctor_graph")),
      true
    );

    const escapeResponse = await fetch(
      `${baseUrl}/api/readiness?projectId=${project.id}&path=${encodeURIComponent("../outside.vg.yaml")}`
    );
    const escapeBody = await escapeResponse.json() as { error?: string };

    assert.equal(escapeResponse.status, 400);
    assert.match(escapeBody.error ?? "", /inside the project root/);
  });
});

test("product readiness rejects symlink graph paths that escape the opened project", async () => {
  const outside = tempDir("vinegraph-outside-readiness");
  try {
    await withServer(async (baseUrl, root) => {
      mkdirSync(join(root, "graphs"), { recursive: true });
      writeGraph(join(outside, "doctor.vg.yaml"), "outside_doctor_graph");
      symlinkSync(join(outside, "doctor.vg.yaml"), join(root, "graphs", "doctor.vg.yaml"));
      const project = await openProject(baseUrl, root);

      const response = await fetch(
        `${baseUrl}/api/readiness?projectId=${project.id}&path=${encodeURIComponent("graphs/doctor.vg.yaml")}`
      );
      const body = await response.json() as { error?: string };

      assert.equal(response.status, 400);
      assert.match(body.error ?? "", /inside the project root/);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product run rejects workspaceTarget path outside opened project", async () => {
  const outside = tempDir("vinegraph-outside-workspace");
  try {
    await withServer(async (baseUrl, root) => {
      mkdirSync(join(root, "graphs"), { recursive: true });
      writeGraph(join(root, "graphs", "run.vg.yaml"), "product_run_graph");
      const project = await openProject(baseUrl, root);

      const response = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          graphPath: "graphs/run.vg.yaml",
          workspaceTarget: {
            kind: "directory",
            path: outside,
          },
        }),
      });
      const body = await response.json() as { error?: string };

      assert.equal(response.status, 400);
      assert.match(body.error ?? "", /workspaceTarget/i);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product patch download reads patches from the opened project when projectId is provided", async () => {
  await withServer(async (baseUrl, root) => {
    const project = await openProject(baseUrl, root);
    mkdirSync(join(root, ".agentgraph", "patches"), { recursive: true });
    writeFileSync(
      join(root, ".agentgraph", "patches", "run-project.patch"),
      "project patch\n",
      "utf-8"
    );

    const response = await fetch(
      `${baseUrl}/api/runs/run-project/patch?projectId=${project.id}`
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body, "project patch\n");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="run-project.patch"'
    );
  });
});

test("product run rejects malformed workspaceTarget instead of starting default workspace", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "run.vg.yaml"), "product_run_graph");
    const project = await openProject(baseUrl, root);

    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        graphPath: "graphs/run.vg.yaml",
        workspaceTarget: {
          kind: "unsupported",
          path: "",
        },
      }),
    });
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /workspaceTarget/i);

    const runsResponse = await fetch(
      `${baseUrl}/api/runs?projectId=${project.id}`
    );
    const runs = await runsResponse.json() as unknown[];
    assert.deepEqual(runs, []);
  });
});

test("product run accepts valid directory target for non-git project", async () => {
  await withServer(async (baseUrl, root) => {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "run.vg.yaml"), "product_run_graph");
    const project = await openProject(baseUrl, root);

    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        graphPath: "graphs/run.vg.yaml",
        workspaceTarget: {
          kind: "directory",
          path: root,
        },
      }),
    });
    const started = await response.json() as { runId: string };

    assert.equal(response.status, 202);
    const run = await waitForRun(baseUrl, started.runId, project.id);
    const workspace = run.workspace as {
      mode?: string;
      path?: string;
      gitEnabled?: boolean;
    };
    assert.equal(workspace.mode, "directory");
    assert.equal(workspace.path, root);
    assert.equal(workspace.gitEnabled, false);
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
          controllerApiKey: "  vg-secret  ",
          themeMode: "light",
          graphAssetGlobs: [],
          recentProjects: [],
          codexCliPath: "  /usr/local/bin/codex  ",
        }),
      });
      const saved = await saveResponse.json() as {
        controllerApiKey: string;
        controllerApiKeyConfigured: boolean;
        controllerApiKeyMasked?: string;
        themeMode: string;
        graphAssetGlobs: string[];
        codexCliPath: string;
      };

      assert.equal(saveResponse.status, 200);
      assert.equal(saved.controllerApiKey, "");
      assert.equal(saved.controllerApiKeyConfigured, true);
      assert.equal(saved.controllerApiKeyMasked, "••••••••••");
      assert.equal(saved.themeMode, "light");
      assert.deepEqual(saved.graphAssetGlobs, ["**/*.vg.yaml", "**/*.vg.yml"]);
      assert.equal(saved.codexCliPath, "/usr/local/bin/codex");

      const readResponse = await fetch(`${baseUrl}/api/config`);
      const read = await readResponse.json() as {
        controllerApiKey: string;
        controllerApiKeyConfigured: boolean;
        controllerApiKeyMasked?: string;
        themeMode: string;
      };

      assert.equal(readResponse.status, 200);
      assert.equal(read.controllerApiKey, "");
      assert.equal(read.controllerApiKeyConfigured, true);
      assert.equal(read.controllerApiKeyMasked, "••••••••••");
      assert.equal(read.themeMode, "light");

      const preserveResponse = await fetch(`${baseUrl}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controllerApiKey: "",
          themeMode: "dark",
          graphAssetGlobs: ["**/*.vg.yaml"],
          recentProjects: [],
        }),
      });
      const preserved = await preserveResponse.json() as {
        controllerApiKey: string;
        controllerApiKeyConfigured: boolean;
        themeMode: string;
      };

      assert.equal(preserveResponse.status, 200);
      assert.equal(preserved.controllerApiKey, "");
      assert.equal(preserved.controllerApiKeyConfigured, true);
      assert.equal(preserved.themeMode, "dark");
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
