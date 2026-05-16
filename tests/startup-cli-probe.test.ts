import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { initializeAgentCliEnvironment } from "../src/startup-cli-probe.js";

function fakeCliPath(root: string, name: string): string {
  return join(root, process.platform === "win32" ? `${name}.cmd` : name);
}

function writeFakeCli(path: string, label: string): void {
  if (process.platform === "win32") {
    writeFileSync(
      path,
      ["@echo off", `echo ${label} 1.0.0`, "exit /b 0", ""].join("\r\n"),
      "utf-8"
    );
    return;
  }

  writeFileSync(
    path,
    ["#!/bin/sh", `echo ${label} 1.0.0`, "exit 0", ""].join("\n"),
    "utf-8"
  );
  chmodSync(path, 0o755);
}

test("startup probe resolves real agent CLIs and records invocation style", () => {
  const tempRoot = join(tmpdir(), `agentgraph-startup-cli-${Date.now()}`);
  const shadowBin = join(tempRoot, "node_modules", ".bin");
  const realBin = join(tempRoot, "tools");
  mkdirSync(shadowBin, { recursive: true });
  mkdirSync(realBin, { recursive: true });

  writeFakeCli(fakeCliPath(shadowBin, "codex"), "shadow-codex");
  writeFakeCli(fakeCliPath(shadowBin, "claude"), "shadow-claude");
  const realCodex = fakeCliPath(realBin, "codex");
  const realClaude = fakeCliPath(realBin, "claude");
  writeFakeCli(realCodex, "real-codex");
  writeFakeCli(realClaude, "real-claude");

  const env: NodeJS.ProcessEnv = {
    PATH: [shadowBin, realBin].join(delimiter),
    AGENTGRAPH_CODEX_PATH: "",
    AGENTGRAPH_CLAUDE_PATH: "",
  };

  try {
    const report = initializeAgentCliEnvironment({ env });

    assert.equal(env.AGENTGRAPH_CODEX_PATH, realCodex);
    assert.equal(env.AGENTGRAPH_CLAUDE_PATH, realClaude);
    assert.equal(report.codex.available, true);
    assert.equal(report.claude.available, true);
    assert.equal(report.codex.path, realCodex);
    assert.equal(report.claude.path, realClaude);
    assert.match(report.codex.version ?? "", /real-codex 1\.0\.0/);
    assert.match(report.claude.version ?? "", /real-claude 1\.0\.0/);
    assert.match(report.codex.invocation, /exec .*--ephemeral .*--skip-git-repo-check -/);
    assert.match(report.codex.promptInput, /stdin/);
    assert.match(report.claude.invocation, /-p <prompt> --output-format text/);
    assert.match(report.claude.promptInput, /argument/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startup probe keeps explicit configured CLI paths", () => {
  const tempRoot = join(tmpdir(), `agentgraph-startup-cli-env-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const codexPath = fakeCliPath(tempRoot, "codex");
  const claudePath = fakeCliPath(tempRoot, "claude");
  writeFakeCli(codexPath, "env-codex");
  writeFakeCli(claudePath, "env-claude");

  const env: NodeJS.ProcessEnv = {
    PATH: "",
    AGENTGRAPH_CODEX_PATH: codexPath,
    AGENTGRAPH_CLAUDE_PATH: claudePath,
  };

  try {
    const report = initializeAgentCliEnvironment({ env });

    assert.equal(env.AGENTGRAPH_CODEX_PATH, codexPath);
    assert.equal(env.AGENTGRAPH_CLAUDE_PATH, claudePath);
    assert.equal(report.codex.source, "env");
    assert.equal(report.claude.source, "env");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startup probe replaces missing configured CLI paths with detected paths", () => {
  const tempRoot = join(tmpdir(), `agentgraph-startup-cli-repair-${Date.now()}`);
  const realBin = join(tempRoot, "tools");
  mkdirSync(realBin, { recursive: true });
  const codexPath = fakeCliPath(realBin, "codex");
  const claudePath = fakeCliPath(realBin, "claude");
  writeFakeCli(codexPath, "repair-codex");
  writeFakeCli(claudePath, "repair-claude");

  const env: NodeJS.ProcessEnv = {
    PATH: realBin,
    AGENTGRAPH_CODEX_PATH: join(tempRoot, "missing-codex"),
    AGENTGRAPH_CLAUDE_PATH: join(tempRoot, "missing-claude"),
  };

  try {
    const report = initializeAgentCliEnvironment({ env });

    assert.equal(env.AGENTGRAPH_CODEX_PATH, codexPath);
    assert.equal(env.AGENTGRAPH_CLAUDE_PATH, claudePath);
    assert.equal(report.codex.source, "detected");
    assert.equal(report.claude.source, "detected");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
