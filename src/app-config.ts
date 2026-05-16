import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig, ProjectRecord } from "./product-types.js";

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
  const graphAssetGlobs = normalizeStringList(input.graphAssetGlobs);

  return {
    version: 1,
    ...normalizeOptionalStringFields(input),
    themeMode,
    graphAssetGlobs:
      graphAssetGlobs.length > 0 ? graphAssetGlobs : base.graphAssetGlobs,
    recentProjects: normalizeRecentProjects(input.recentProjects),
  };
}

function normalizeOptionalStringFields(
  input: Partial<AppConfig>
): Partial<AppConfig> {
  const output: Partial<AppConfig> = {};
  const fields = [
    "controllerApiKey",
    "codexCliPath",
    "claudeCliPath",
    "defaultCodexModel",
    "defaultClaudeModel",
    "defaultControllerModel",
    "defaultReasoningEffort",
  ] as const;

  for (const field of fields) {
    const value = normalizeOptionalString(input[field]);
    if (value) {
      output[field] = value;
    }
  }

  return output;
}

function normalizeRecentProjects(input: unknown): ProjectRecord[] {
  if (!Array.isArray(input)) return [];

  const projects: ProjectRecord[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;

    const id = normalizeOptionalString(item.id);
    const name = normalizeOptionalString(item.name);
    const rootPath = normalizeOptionalString(item.rootPath);
    const kind = item.kind;
    const graphAssetGlobs = normalizeStringList(item.graphAssetGlobs);
    const createdAt = item.createdAt;
    const lastOpenedAt = item.lastOpenedAt;

    if (
      !id ||
      !name ||
      !rootPath ||
      (kind !== "git" && kind !== "directory") ||
      graphAssetGlobs.length === 0 ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      typeof lastOpenedAt !== "number" ||
      !Number.isFinite(lastOpenedAt)
    ) {
      continue;
    }

    const project: ProjectRecord = {
      id,
      name,
      rootPath,
      kind,
      graphAssetGlobs,
      createdAt,
      lastOpenedAt,
    };
    const defaultVerificationCommand = normalizeOptionalString(
      item.defaultVerificationCommand
    );
    if (defaultVerificationCommand) {
      project.defaultVerificationCommand = defaultVerificationCommand;
    }
    projects.push(project);
  }

  return projects;
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
