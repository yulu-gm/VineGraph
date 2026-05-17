import {
  existsSync,
  closeSync,
  lstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
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
  const absolutePath = resolveExistingProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  const raw = readFileSync(absolutePath, "utf-8");
  const graph = validateGraphSource(raw, absolutePath);
  return { asset: toAsset(project, absolutePath), raw, graph };
}

export function validateGraphAsset(
  project: ProjectRecord,
  relativePath: string
): GraphDefinition {
  const absolutePath = resolveExistingProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  return validateGraphSource(readFileSync(absolutePath, "utf-8"), absolutePath);
}

export function writeGraphAsset(
  project: ProjectRecord,
  relativePath: string,
  raw: string
): GraphAsset {
  const absolutePath = resolveWritableProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  validateGraphSource(raw, absolutePath);
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
    "  - id: describe_task",
    "    type: execute",
    "    backend: codex",
    "    promptTemplate: |",
    "      用一句话说明这个 graph 的用途，不要修改文件。",
    "    execution:",
    "      workspaceAccess: read",
    "      reasoningEffort: low",
    "",
    "  - id: finish",
    "    type: execute",
    "    backend: internal",
    "    command:",
    "      program: internal",
    "      args: [finish_success]",
    "edges:",
    "  - from: graph.start",
    "    to: describe_task.inputs.trigger",
    "  - from: describe_task.outputs.done",
    "    to: finish.inputs.trigger",
    "",
  ].join("\n");
  return writeNewGraphAsset(project, relativePath, raw);
}

export function renameGraphAsset(
  project: ProjectRecord,
  fromRelativePath: string,
  toRelativePath: string
): GraphAsset {
  const from = resolveExistingProjectPath(project.rootPath, fromRelativePath);
  const to = resolveNewProjectPath(project.rootPath, toRelativePath);
  if (!isGraphAssetPath(from)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  if (!isGraphAssetPath(to)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  validateGraphSource(readFileSync(from, "utf-8"), from);
  renameWithoutOverwrite(from, to);
  return toAsset(project, to);
}

export function copyGraphAsset(
  project: ProjectRecord,
  fromRelativePath: string,
  toRelativePath: string
): GraphAsset {
  const from = resolveExistingProjectPath(project.rootPath, fromRelativePath);
  const to = resolveNewProjectPath(project.rootPath, toRelativePath);
  if (!isGraphAssetPath(from)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  if (!isGraphAssetPath(to)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  const raw = readFileSync(from, "utf-8");
  validateGraphSource(raw, from);
  writeFileExclusive(to, raw);
  return toAsset(project, to);
}

export function deleteGraphAsset(project: ProjectRecord, relativePath: string): void {
  const absolutePath = resolveExistingProjectPath(project.rootPath, relativePath);
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
  const from = resolveExistingProjectPath(project.rootPath, legacyRelativePath);
  const to = resolveNewProjectPath(project.rootPath, targetRelativePath);
  if (!isGraphAssetPath(to)) {
    throw new Error("Imported graph asset must use .vg.yaml or .vg.yml");
  }
  const raw = readFileSync(from, "utf-8");
  validateGraphSource(raw, from);
  writeFileExclusive(to, raw);
  return toAsset(project, to);
}

function writeNewGraphAsset(
  project: ProjectRecord,
  relativePath: string,
  raw: string
): GraphAsset {
  const absolutePath = resolveNewProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) {
    throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  }
  validateGraphSource(raw, absolutePath);
  writeFileExclusive(absolutePath, raw);
  return toAsset(project, absolutePath);
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

function validateGraphSource(raw: string, source: string): GraphDefinition {
  const parsed = yaml.load(raw);
  if (!isYamlObject(parsed)) {
    throw new Error(
      `Graph asset validation failed: YAML document must be a non-null object: ${source}`
    );
  }
  return GraphLoader.validate(parsed, source);
}

function resolveExistingProjectPath(projectRoot: string, path: string): string {
  const resolved = resolve(projectRoot, path);
  assertLexicallyInsideProject(projectRoot, resolved);
  return assertRealpathInsideProject(projectRoot, realpathSync(resolved));
}

function resolveWritableProjectPath(projectRoot: string, path: string): string {
  const resolved = resolve(projectRoot, path);
  assertLexicallyInsideProject(projectRoot, resolved);
  if (existsSync(resolved)) {
    return assertRealpathInsideProject(projectRoot, realpathSync(resolved));
  }

  const parent = dirname(resolved);
  if (!existsSync(parent)) {
    throw new Error("Graph asset parent directory must exist inside project root");
  }
  assertRealpathInsideProject(projectRoot, realpathSync(parent));
  return resolved;
}

function resolveNewProjectPath(projectRoot: string, path: string): string {
  const resolved = resolve(projectRoot, path);
  assertLexicallyInsideProject(projectRoot, resolved);
  if (pathExists(resolved)) {
    throw new Error(`Graph asset target already exists: ${path}`);
  }

  const parent = dirname(resolved);
  if (!existsSync(parent)) {
    throw new Error("Graph asset parent directory must exist inside project root");
  }
  assertRealpathInsideProject(projectRoot, realpathSync(parent));
  return resolved;
}

function assertLexicallyInsideProject(projectRoot: string, resolved: string): void {
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Graph asset path must stay inside project root");
  }
}

function assertRealpathInsideProject(projectRoot: string, resolvedRealpath: string): string {
  const rootRealpath = realpathSync(projectRoot);
  const rel = relative(rootRealpath, resolvedRealpath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Graph asset path must stay inside project root");
  }
  return resolvedRealpath;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isYamlObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeFileExclusive(path: string, raw: string): void {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, raw, 0, "utf-8");
  } finally {
    closeSync(fd);
  }
}

function renameWithoutOverwrite(from: string, to: string): void {
  linkSync(from, to);
  rmSync(from);
}
