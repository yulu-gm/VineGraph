import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./product-types.js";

const DEFAULT_GRAPH_ASSET_GLOBS = ["**/*.vg.yaml", "**/*.vg.yml"];

export function defaultAppConfig(): AppConfig {
  return {
    version: 1,
    themeMode: "system",
    graphAssetGlobs: [...DEFAULT_GRAPH_ASSET_GLOBS],
    recentProjects: [],
  };
}

export function defaultAppConfigPath(): string {
  return (
    process.env.AGENTGRAPH_APP_CONFIG_PATH ??
    join(homedir(), ".vinegraph", "config.json")
  );
}

export function loadAppConfig(path = defaultAppConfigPath()): AppConfig {
  if (!existsSync(path)) {
    return defaultAppConfig();
  }

  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AppConfig>;
  return normalizeAppConfig(parsed);
}

export function saveAppConfig(
  config: AppConfig,
  path = defaultAppConfigPath()
): AppConfig {
  const normalized = normalizeAppConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
}

function normalizeAppConfig(input: Partial<AppConfig>): AppConfig {
  const base = defaultAppConfig();
  const themeMode =
    input.themeMode === "dark" ||
    input.themeMode === "light" ||
    input.themeMode === "system"
      ? input.themeMode
      : base.themeMode;

  return {
    ...base,
    ...input,
    version: 1,
    themeMode,
    graphAssetGlobs:
      Array.isArray(input.graphAssetGlobs) && input.graphAssetGlobs.length > 0
        ? input.graphAssetGlobs.filter((item) => typeof item === "string")
        : base.graphAssetGlobs,
    recentProjects: Array.isArray(input.recentProjects)
      ? input.recentProjects
      : [],
  };
}
