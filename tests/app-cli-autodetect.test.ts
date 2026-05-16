import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadAppConfigWithCliAutodetect } from "../src/app-cli-autodetect.js";

function tempDir(prefix: string): string {
  const dir = resolve(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFakeCli(dir: string, name: string, output: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho '${output}'\n`, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

test("loadAppConfigWithCliAutodetect persists missing CLI paths when detection succeeds", () => {
  const root = tempDir("vinegraph-cli-autodetect");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const codex = writeFakeCli(bin, "codex", "codex-cli 0.test");
  const claude = writeFakeCli(bin, "claude", "claude-code 0.test");
  const configPath = join(root, "config.json");

  try {
    const result = loadAppConfigWithCliAutodetect(configPath, {
      PATH: bin,
      Path: bin,
    });

    assert.equal(result.config.codexCliPath, codex);
    assert.equal(result.config.claudeCliPath, claude);
    assert.deepEqual(result.diagnostics.missing, []);
    assert.equal(result.diagnostics.detected.codex?.path, codex);
    assert.equal(result.diagnostics.detected.claude?.path, claude);

    const saved = JSON.parse(readFileSync(configPath, "utf-8")) as {
      codexCliPath?: string;
      claudeCliPath?: string;
    };
    assert.equal(saved.codexCliPath, codex);
    assert.equal(saved.claudeCliPath, claude);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAppConfigWithCliAutodetect reports missing CLIs without overwriting configured paths", () => {
  const root = tempDir("vinegraph-cli-autodetect-missing");
  const configPath = join(root, "config.json");
  const configuredCodex = join(root, "configured-codex");
  const failingClaude = writeFakeCli(root, "missing-claude", "claude unavailable");
  writeFileSync(failingClaude, "#!/bin/sh\nexit 1\n", "utf-8");
  chmodSync(failingClaude, 0o755);
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, codexCliPath: configuredCodex, recentProjects: [] }),
    "utf-8"
  );

  try {
    const result = loadAppConfigWithCliAutodetect(configPath, {
      PATH: "",
      Path: "",
      AGENTGRAPH_CODEX_PATH: configuredCodex,
      AGENTGRAPH_CLAUDE_PATH: failingClaude,
    });

    assert.equal(result.config.codexCliPath, configuredCodex);
    assert.equal(result.diagnostics.missing.length > 0, true);
    assert.equal(result.diagnostics.missing.some((item) => item.name === "claude"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
