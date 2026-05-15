import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecuteRunner } from "../src/execute-runner.js";
import type { ExecuteNode, TemplateContext } from "../src/types.js";

function createContext(): TemplateContext {
  return {
    inputs: {},
    nodes: {},
    runtime: {},
    workspace: {},
    controller: {},
  };
}

test("codex backend forwards model, reasoning effort, and sandbox from graph execution config", async () => {
  const tempRoot = join(tmpdir(), `agentgraph-codex-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const fakeCodex = join(tempRoot, "codex.cmd");
  const captureFile = join(tempRoot, "args.txt");

  writeFileSync(
    fakeCodex,
    [
      "@echo off",
      `echo %* > "${captureFile}"`,
      "echo fake codex ok",
      "exit /b 0",
      "",
    ].join("\r\n"),
    "utf-8"
  );

  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;

  try {
    const node: ExecuteNode = {
      id: "implement_feature",
      type: "execute",
      backend: "codex",
      promptTemplate: "Implement one small task.",
      execution: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        workspaceAccess: "write",
        timeoutMs: 30_000,
      },
    };

    const result = await ExecuteRunner.run(
      node,
      "activation_1",
      tempRoot,
      createContext()
    );

    assert.equal(result.exitCode, 0);
    const args = readFileSync(captureFile, "utf-8");
    assert.match(args, /exec/);
    assert.match(args, /-m gpt-5\.5/);
    assert.match(args, /model_reasoning_effort="high"/);
    assert.match(args, /--sandbox workspace-write/);
    assert.match(args, /--ephemeral/);
    assert.match(args, /--skip-git-repo-check/);
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGENTGRAPH_CODEX_PATH;
    } else {
      process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("codex backend closes stdin so exec does not wait for additional input", async () => {
  const tempRoot = join(tmpdir(), `agentgraph-codex-stdin-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const fakeCodex = join(tempRoot, "codex.cmd");
  const stdinProbe = join(tempRoot, "stdin-probe.mjs");

  writeFileSync(
    stdinProbe,
    [
      "let data = '';",
      "const timeout = setTimeout(() => {",
      "  console.error('STDIN_STILL_OPEN');",
      "  process.exit(2);",
      "}, 500);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { data += chunk; });",
      "process.stdin.on('end', () => {",
      "  clearTimeout(timeout);",
      "  console.log(data.length > 0 ? 'STDIN_CLOSED_WITH_DATA' : 'STDIN_CLOSED_EMPTY');",
      "  process.exit(data.length > 0 ? 0 : 1);",
      "});",
      "process.stdin.resume();",
      "",
    ].join("\n"),
    "utf-8"
  );

  writeFileSync(
    fakeCodex,
    [
      "@echo off",
      "node \"%~dp0stdin-probe.mjs\" %*",
      "",
    ].join("\r\n"),
    "utf-8"
  );

  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;

  try {
    const node: ExecuteNode = {
      id: "implement_feature",
      type: "execute",
      backend: "codex",
      promptTemplate: "Implement one small task.",
      execution: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        workspaceAccess: "write",
        timeoutMs: 5_000,
      },
    };

    const result = await ExecuteRunner.run(
      node,
      "activation_2",
      tempRoot,
      createContext()
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /STDIN_CLOSED_WITH_DATA/);
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGENTGRAPH_CODEX_PATH;
    } else {
      process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("codex backend sends the rendered prompt through stdin instead of the shell command line", async () => {
  const tempRoot = join(tmpdir(), `agentgraph-codex-prompt-stdin-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const fakeCodex = join(tempRoot, "codex.cmd");
  const stdinCapture = join(tempRoot, "stdin-capture.mjs");
  const argsFile = join(tempRoot, "args.txt");
  const stdinFile = join(tempRoot, "stdin.txt");
  const prompt = [
    "Implement one small task.",
    "Keep this text out of cmd.exe arguments: && echo BAD",
    "Unicode smoke: 中文",
  ].join("\n");

  writeFileSync(
    stdinCapture,
    [
      "import { writeFileSync } from 'node:fs';",
      "let data = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { data += chunk; });",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(stdinFile)}, data, 'utf8');`,
      "  console.log('STDIN_CAPTURED');",
      "});",
      "process.stdin.resume();",
      "",
    ].join("\n"),
    "utf-8"
  );

  writeFileSync(
    fakeCodex,
    [
      "@echo off",
      `echo %* > "${argsFile}"`,
      "node \"%~dp0stdin-capture.mjs\"",
      "",
    ].join("\r\n"),
    "utf-8"
  );

  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;

  try {
    const node: ExecuteNode = {
      id: "implement_feature",
      type: "execute",
      backend: "codex",
      promptTemplate: prompt,
      execution: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        workspaceAccess: "write",
        timeoutMs: 5_000,
      },
    };

    const result = await ExecuteRunner.run(
      node,
      "activation_3",
      tempRoot,
      createContext()
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /STDIN_CAPTURED/);
    const args = readFileSync(argsFile, "utf-8");
    assert.match(args, /--skip-git-repo-check\s+-/);
    assert.doesNotMatch(args, /Implement one small task/);
    assert.doesNotMatch(args, /&& echo BAD/);
    assert.equal(readFileSync(stdinFile, "utf-8"), prompt);
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGENTGRAPH_CODEX_PATH;
    } else {
      process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
