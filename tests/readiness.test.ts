import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
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

function tsxBin(): string {
  return resolve(
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs"
  );
}

function fakeCliPath(root: string, name: string): string {
  return join(root, process.platform === "win32" ? `${name}.cmd` : name);
}

function writeFakeCli(path: string): void {
  if (process.platform === "win32") {
    writeFileSync(path, ["@echo off", "echo fake", "exit /b 0", ""].join("\r\n"), "utf-8");
    return;
  }

  writeFileSync(path, ["#!/bin/sh", "echo fake", "exit 0", ""].join("\n"), "utf-8");
  chmodSync(path, 0o755);
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
        AGENTGRAPH_CLAUDE_PATH: process.execPath,
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
    assert.equal(result.checks.some((item) => item.id === "claude_cli" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.id === "terminal_fallback" && item.status === "pass"), true);
    assert.match(
      result.checks.find((item) => item.id === "terminal_fallback")?.message ?? "",
      /Node terminal fallback/i
    );
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
        AGENTGRAPH_CLAUDE_PATH: process.execPath,
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

test("self-iteration doctor returns structured failure when graph cannot load", async () => {
  const repo = tempDir("agentgraph-readiness-missing-graph");

  try {
    initGitRepo(repo);

    const result = await checkSelfIterationReadiness({
      graphPath: resolve(repo, "missing.yaml"),
      projectRoot: repo,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "test-key",
        AGENTGRAPH_CODEX_PATH: process.execPath,
        AGENTGRAPH_CLAUDE_PATH: process.execPath,
      },
      commandExists: () => true,
    });

    const graphLoad = result.checks.find((item) => item.id === "graph_load");
    assert.equal(result.ok, false);
    assert.equal(graphLoad?.status, "fail");
    assert.match(graphLoad?.message ?? "", /missing\.yaml|ENOENT/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("self-iteration doctor passes command timeout into command probes", async () => {
  const repo = tempDir("agentgraph-readiness-timeout");
  const probed: Array<{ program: string; timeoutMs?: number }> = [];

  try {
    initGitRepo(repo);

    await checkSelfIterationReadiness({
      graphPath: resolve("examples/project-task-loop.yaml"),
      projectRoot: repo,
      commandTimeoutMs: 123,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "test-key",
      },
      commandExists: (program, timeoutMs) => {
        probed.push({ program, timeoutMs });
        return false;
      },
    });

    assert.ok(probed.length >= 2);
    assert.equal(probed.every((item) => item.timeoutMs === 123), true);
    assert.ok(probed.some((item) => item.program.startsWith("codex")));
    assert.ok(probed.some((item) => item.program.startsWith("claude")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("self-iteration doctor skips node_modules bin CLI shadows", async () => {
  const repo = tempDir("agentgraph-readiness-shadow");
  const shadowBin = join(repo, "node_modules", ".bin");
  const realBin = join(repo, "tools");
  const probed: string[] = [];

  try {
    initGitRepo(repo);
    mkdirSync(shadowBin, { recursive: true });
    mkdirSync(realBin, { recursive: true });
    writeFakeCli(fakeCliPath(shadowBin, "codex"));
    writeFakeCli(fakeCliPath(shadowBin, "claude"));
    const realCodex = fakeCliPath(realBin, "codex");
    const realClaude = fakeCliPath(realBin, "claude");
    writeFakeCli(realCodex);
    writeFakeCli(realClaude);

    const result = await checkSelfIterationReadiness({
      graphPath: resolve("examples/project-task-loop.yaml"),
      projectRoot: repo,
      env: {
        ...process.env,
        PATH: [shadowBin, realBin].join(delimiter),
        DEEPSEEK_API_KEY: "test-key",
        AGENTGRAPH_CODEX_PATH: "",
        AGENTGRAPH_CLAUDE_PATH: "",
      },
      commandExists: (program) => {
        probed.push(program);
        return program === realCodex || program === realClaude;
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      probed.filter((program) => program.includes("node_modules")),
      []
    );
    assert.equal(probed.includes(realCodex), true);
    assert.equal(probed.includes(realClaude), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("self-iteration doctor fails clearly when Claude CLI is missing", async () => {
  const repo = tempDir("agentgraph-readiness-missing-claude");

  try {
    initGitRepo(repo);

    const result = await checkSelfIterationReadiness({
      graphPath: resolve("examples/project-task-loop.yaml"),
      projectRoot: repo,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "test-key",
        AGENTGRAPH_CODEX_PATH: process.execPath,
        AGENTGRAPH_CLAUDE_PATH: "",
      },
      commandExists: (program) => program === process.execPath,
    });

    const claudeCli = result.checks.find((item) => item.id === "claude_cli");
    assert.equal(result.ok, false);
    assert.equal(claudeCli?.status, "fail");
    assert.match(claudeCli?.message ?? "", /Claude CLI|AGENTGRAPH_CLAUDE_PATH/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI doctor loads local .env before checking runtime capabilities", () => {
  const repo = tempDir("agentgraph-cli-env");
  const graphPath = resolve("examples/project-task-loop.yaml");

  try {
    initGitRepo(repo);
    writeFileSync(
      join(repo, ".env"),
      [
        "DEEPSEEK_API_KEY=test-key",
        `AGENTGRAPH_CODEX_PATH=${process.execPath}`,
        `AGENTGRAPH_CLAUDE_PATH=${process.execPath}`,
        "",
      ].join("\n"),
      "utf-8"
    );

    const output = execFileSync(
      process.execPath,
      [tsxBin(), resolve("src/index.ts"), "--doctor", graphPath],
      {
        cwd: repo,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "",
          OPENAI_API_KEY: "",
          AGENTGRAPH_CODEX_PATH: "",
          AGENTGRAPH_CLAUDE_PATH: "",
        },
        encoding: "utf-8",
      }
    );

    assert.match(output, /Self-iteration readiness: PASS/);
    assert.match(output, /\[PASS\] Controller API key/);
    assert.match(output, /\[PASS\] Claude CLI/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
