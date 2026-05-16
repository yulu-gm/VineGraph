import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkSelfIterationReadiness } from "../src/readiness.js";

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

test("self-iteration doctor reports required runtime capabilities", async () => {
  const repo = tempDir("agentgraph-readiness");

  try {
    initGitRepo(repo);

    const result = await checkSelfIterationReadiness({
      graphPath: resolve("examples/project-task-loop.yaml"),
      projectRoot: repo,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "test-key",
        AGENTGRAPH_CODEX_PATH: process.execPath,
      },
      commandExists: (program) => {
        if (program === process.execPath) return true;
        const found = spawnSync(program, ["--version"], { shell: true });
        return found.status === 0;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.some((item) => item.id === "graph_load" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.id === "workspace_mode" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.id === "git_worktree" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.id === "controller_key" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.id === "codex_cli" && item.status === "pass"), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("self-iteration doctor fails clearly when controller key is missing", async () => {
  const repo = tempDir("agentgraph-readiness-missing-key");

  try {
    initGitRepo(repo);

    const result = await checkSelfIterationReadiness({
      graphPath: resolve("examples/project-task-loop.yaml"),
      projectRoot: repo,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "",
        OPENAI_API_KEY: "",
        AGENTGRAPH_CODEX_PATH: process.execPath,
      },
      commandExists: () => true,
    });

    const controllerKey = result.checks.find((item) => item.id === "controller_key");
    assert.equal(result.ok, false);
    assert.equal(controllerKey?.status, "fail");
    assert.match(controllerKey?.message ?? "", /DEEPSEEK_API_KEY|OPENAI_API_KEY/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
