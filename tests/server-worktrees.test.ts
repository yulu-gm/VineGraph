import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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

function initGitRepo(repo: string): void {
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
}

function writeProjectGraph(repo: string): string {
  const examplesDir = join(repo, "examples");
  mkdirSync(examplesDir, { recursive: true });
  const graphPath = join(examplesDir, "project-task-loop.yaml");
  writeFileSync(
    graphPath,
    [
      "id: temp_project_loop",
      'version: "0.1.0"',
      "runtime:",
      "  workspace:",
      "    mode: worktree",
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
  return graphPath;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function withServer(
  fn: (baseUrl: string, repo: string) => Promise<void>
): Promise<void> {
  const repo = tempDir("agentgraph-server-worktrees");
  initGitRepo(repo);
  const server = createAgentGraphServer(repo);
  const baseUrl = await listen(server);

  try {
    await fn(baseUrl, repo);
  } finally {
    await close(server);
    rmSync(repo, { recursive: true, force: true });
  }
}

test("worktree create endpoint rejects non-object JSON bodies", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(body.error ?? "", /Invalid request body/);
  });
});

test("worktree create endpoint reports duplicate manual names as conflicts", async () => {
  await withServer(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Review Lane" }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${baseUrl}/api/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Review Lane" }),
    });
    const body = await second.json() as { error?: string };

    assert.equal(second.status, 409);
    assert.match(body.error ?? "", /Worktree already exists/);
  });
});

test("readiness endpoint validates graph paths against the configured project root", async () => {
  await withServer(async (baseUrl, repo) => {
    const graphPath = writeProjectGraph(repo);
    const response = await fetch(`${baseUrl}/api/readiness?path=${encodeURIComponent(graphPath)}`);
    const body = await response.json() as { checks?: Array<{ id: string; status: string }> };

    assert.equal(response.status, 200);
    assert.equal(body.checks?.some((item) => item.id === "graph_load" && item.status === "pass"), true);

    const outside = await fetch(`${baseUrl}/api/readiness?path=${encodeURIComponent(resolve(repo, "..", "outside.yaml"))}`);
    const outsideBody = await outside.json() as { error?: string };
    assert.equal(outside.status, 400);
    assert.match(outsideBody.error ?? "", /project root/);
  });
});
