import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { GraphLoader } from "./graph-loader.js";
import type { GraphDefinition } from "./types.js";
import type { GraphAsset, ProjectRecord } from "./product-types.js";

const GRAPH_EXTENSIONS = [".vg.yaml", ".vg.yml"];
const SKIP_DIRS = new Set([
  ".git",
  ".agentgraph",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
]);

export function isGraphAssetPath(path: string): boolean {
  return GRAPH_EXTENSIONS.some((suffix) => path.endsWith(suffix));
}

export function scanGraphAssets(project: ProjectRecord): GraphAsset[] {
  const root = resolve(project.rootPath);
  const files: string[] = [];
  walk(root, files);

  return files
    .filter(isGraphAssetPath)
    .map((absolutePath) => toAsset(project, absolutePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function readGraphAsset(
  project: ProjectRecord,
  relativePath: string
): { asset: GraphAsset; raw: string; graph: GraphDefinition } {
  const absolutePath = resolveProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  const raw = readFileSync(absolutePath, "utf-8");
  const graph = GraphLoader.validate(yaml.load(raw) as Record<string, unknown>, absolutePath);
  return { asset: toAsset(project, absolutePath), raw, graph };
}

export function writeGraphAsset(
  project: ProjectRecord,
  relativePath: string,
  raw: string
): GraphAsset {
  const absolutePath = resolveProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  GraphLoader.validate(yaml.load(raw) as Record<string, unknown>, absolutePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, raw, "utf-8");
  return toAsset(project, absolutePath);
}

export function createGraphAssetFromTemplate(
  project: ProjectRecord,
  relativePath: string,
  graphId: string
): GraphAsset {
  const raw = [
    `id: ${graphId}`,
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
  return writeGraphAsset(project, relativePath, raw);
}

export function renameGraphAsset(
  project: ProjectRecord,
  fromRelativePath: string,
  toRelativePath: string
): GraphAsset {
  const from = resolveProjectPath(project.rootPath, fromRelativePath);
  const to = resolveProjectPath(project.rootPath, toRelativePath);
  if (!isGraphAssetPath(to)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return toAsset(project, to);
}

export function copyGraphAsset(
  project: ProjectRecord,
  fromRelativePath: string,
  toRelativePath: string
): GraphAsset {
  const from = resolveProjectPath(project.rootPath, fromRelativePath);
  const to = resolveProjectPath(project.rootPath, toRelativePath);
  if (!isGraphAssetPath(to)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return toAsset(project, to);
}

export function deleteGraphAsset(project: ProjectRecord, relativePath: string): void {
  const absolutePath = resolveProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  rmSync(absolutePath, { force: true });
}

export function importLegacyGraphAsset(
  project: ProjectRecord,
  legacyRelativePath: string,
  targetRelativePath: string
): GraphAsset {
  const from = resolveProjectPath(project.rootPath, legacyRelativePath);
  const to = resolveProjectPath(project.rootPath, targetRelativePath);
  if (!isGraphAssetPath(to)) {
    throw new Error("Imported graph asset must use .vg.yaml or .vg.yml");
  }
  const raw = readFileSync(from, "utf-8");
  GraphLoader.validate(yaml.load(raw) as Record<string, unknown>, from);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, raw, "utf-8");
  return toAsset(project, to);
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(fullPath, files);
      }
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function toAsset(project: ProjectRecord, absolutePath: string): GraphAsset {
  const raw = existsSync(absolutePath) ? readFileSync(absolutePath, "utf-8") : "";
  let graphId: string | undefined;
  let version: string | undefined;
  try {
    const parsed = yaml.load(raw) as Record<string, unknown>;
    graphId = typeof parsed?.id === "string" ? parsed.id : undefined;
    version = typeof parsed?.version === "string" ? parsed.version : undefined;
  } catch {
    graphId = undefined;
    version = undefined;
  }
  const relativePath = relative(project.rootPath, absolutePath).replace(/\\/g, "/");
  return {
    projectId: project.id,
    absolutePath,
    relativePath,
    name: relativePath.split("/").pop() ?? absolutePath,
    graphId,
    version,
    updatedAt: existsSync(absolutePath) ? statSync(absolutePath).mtimeMs : undefined,
  };
}

function resolveProjectPath(projectRoot: string, path: string): string {
  const resolved = resolve(projectRoot, path);
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Graph asset path must stay inside project root");
  }
  return resolved;
}
