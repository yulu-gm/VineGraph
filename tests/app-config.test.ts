import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultAppConfig,
  loadAppConfig,
  saveAppConfig,
} from "../src/app-config.js";

function tempDir(prefix: string): string {
  const dir = resolve(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("app config defaults are product-safe", () => {
  const config = defaultAppConfig();

  assert.equal(config.version, 1);
  assert.equal(config.themeMode, "system");
  assert.deepEqual(config.graphAssetGlobs, ["**/*.vg.yaml", "**/*.vg.yml"]);
  assert.deepEqual(config.recentProjects, []);
});

test("app config saves API keys, CLI paths, theme, and recent projects", () => {
  const root = tempDir("vinegraph-config");
  const configPath = join(root, "config.json");

  try {
    saveAppConfig(
      {
        ...defaultAppConfig(),
        controllerApiKey: "secret-key",
        codexCliPath: "/opt/homebrew/bin/codex",
        claudeCliPath: "/opt/homebrew/bin/claude",
        defaultCodexModel: "gpt-5.5",
        defaultReasoningEffort: "high",
        themeMode: "dark",
        recentProjects: [
          {
            id: "project-1",
            name: "Project One",
            rootPath: "/tmp/project-one",
            kind: "directory",
            graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
            createdAt: 10,
            lastOpenedAt: 20,
          },
        ],
      },
      configPath
    );

    const loaded = loadAppConfig(configPath);

    assert.equal(loaded.controllerApiKey, "secret-key");
    assert.equal(loaded.codexCliPath, "/opt/homebrew/bin/codex");
    assert.equal(loaded.claudeCliPath, "/opt/homebrew/bin/claude");
    assert.equal(loaded.defaultCodexModel, "gpt-5.5");
    assert.equal(loaded.defaultReasoningEffort, "high");
    assert.equal(loaded.themeMode, "dark");
    assert.equal(loaded.recentProjects[0]?.id, "project-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
