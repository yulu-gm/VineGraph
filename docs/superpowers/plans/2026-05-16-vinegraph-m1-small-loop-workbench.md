# VineGraph M1 Small Loop Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M1 production-grade local workbench for opening project directories, managing `.vg.yaml` graph assets, editing node configuration, choosing a workspace target, running graphs, and observing output in a real runtime dock.

**Architecture:** Add focused product modules for app config, projects, graph assets, and workspace targets, then route server APIs and scheduler runs through explicit `projectRoot` and `workspaceTarget` values instead of implicit `process.cwd()`. Replace the UI's demo graph selector path with a real repo explorer, automatic graph layout, editable inspector, settings surface, bottom workspace bar, and resizable runtime dock while keeping legacy CLI/example behavior working.

**Tech Stack:** TypeScript ESM, Node HTTP server, `js-yaml`, native HTML/CSS/JS UI, Node built-in test runner, Tauri shell.

---

## Scope And Sequencing

This plan implements M1 from the approved PRD:

- Project directory model for git and non-git folders.
- `.vg.yaml` and `.vg.yml` graph assets.
- App settings for API key, CLI paths, defaults, and theme.
- Explicit workspace targets.
- Scheduler execution in the selected workspace.
- Real repo explorer and graph asset opening.
- Automatic graph canvas layout from YAML.
- Editable inspector save back to graph assets.
- Resizable runtime dock with improved terminal behavior.
- Bottom workspace/status bar.
- Light, dark, and system themes.

The plan deliberately leaves these for later milestones:

- Manual graph canvas authoring.
- Interactive PTY shell.
- Commit, push, and PR helpers.
- Cloud, remote runners, or collaboration.

## File Structure

Create focused product modules:

- `src/product-types.ts`: Product-facing AppConfig, Project, GraphAsset, WorkspaceTarget, and API response types.
- `src/app-config.ts`: Read/write app-level config from local storage, with test override support.
- `src/projects.ts`: Register/open local project directories and detect git capabilities.
- `src/graph-assets.ts`: Scan, read, write, validate, create, copy, rename, delete, and import `.vg.yaml` graph assets.
- `src/workspace-targets.ts`: List workspace targets for git/non-git projects and create git worktrees when supported.

Modify existing runtime modules:

- `src/types.ts`: Add selected workspace metadata to run options and records.
- `src/scheduler.ts`: Execute against explicit selected workspace.
- `src/run-history.ts`: Save run records under the selected project root.
- `src/workspace-manager.ts`: Reuse git helpers for selected targets without forcing automatic cleanup.
- `src/server.ts`: Add product APIs and update run startup to accept project/graph/workspace.
- `src/readiness.ts`: Treat git as a capability instead of a hard requirement.

Modify UI:

- `src/ui/index.html`: Replace graph dropdown/sidebar demo rows with repo explorer, settings shell, bottom status bar, and resizable runtime dock structure.
- `src/ui/app.js`: Add product state, project loading, graph asset loading, workspace selection, auto layout, inspector editing, settings, theme, and terminal state.
- `src/ui/style.css`: Add light/dark tokens, repo explorer styles, inspector form styles, terminal dock resize styles, and workspace bar styles.

Tests:

- `tests/app-config.test.ts`
- `tests/project-graph-assets.test.ts`
- `tests/workspace-targets.test.ts`
- `tests/scheduler-workspace-target.test.ts`
- `tests/server-product-api.test.ts`
- `tests/ui-product-workbench.test.ts`
- `tests/ui-terminal-dock.test.ts`
- Existing tests remain valid or are intentionally updated when old graph dropdown assumptions are removed.

---

### Task 1: Product Types And App Config Store

**Files:**
- Create: `src/product-types.ts`
- Create: `src/app-config.ts`
- Test: `tests/app-config.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write product type definitions**

Create `src/product-types.ts`:

```ts
export type ProjectKind = "git" | "directory";
export type ThemeMode = "system" | "dark" | "light";
export type WorkspaceTargetKind = "main" | "worktree" | "directory";

export interface AppConfig {
  version: 1;
  controllerApiKey?: string;
  codexCliPath?: string;
  claudeCliPath?: string;
  defaultCodexModel?: string;
  defaultClaudeModel?: string;
  defaultControllerModel?: string;
  defaultReasoningEffort?: string;
  themeMode: ThemeMode;
  graphAssetGlobs: string[];
  recentProjects: ProjectRecord[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  kind: ProjectKind;
  graphAssetGlobs: string[];
  defaultVerificationCommand?: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface ProjectCapabilities {
  git: boolean;
  worktrees: boolean;
  diff: boolean;
  changedFiles: boolean;
}

export interface ProjectDetails extends ProjectRecord {
  capabilities: ProjectCapabilities;
  branch?: string | null;
  dirty?: boolean;
}

export interface GraphAsset {
  projectId: string;
  absolutePath: string;
  relativePath: string;
  name: string;
  graphId?: string;
  version?: string;
  updatedAt?: number;
}

export interface WorkspaceTarget {
  id: string;
  kind: WorkspaceTargetKind;
  label: string;
  path: string;
  branch?: string | null;
  detached?: boolean;
  current?: boolean;
  dirty?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  label: string;
  message: string;
  details?: Record<string, unknown>;
}
```

- [ ] **Step 2: Extend runtime run options**

Modify `src/types.ts` so `WorkspaceMode` and `SchedulerRunOptions` can represent explicit product runs:

```ts
export type WorkspaceMode = "worktree" | "local" | "directory";

export interface WorkspaceInfo {
  mode: WorkspaceMode;
  path: string;
  worktreeName?: string;
  diff?: string;
  changedFiles?: string[];
  patchPath?: string;
  gitEnabled?: boolean;
}

export interface RunRecord {
  runId: string;
  graphId: string;
  graphPath: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  totalDurationMs?: number;
  activations: NodeActivation[];
  controllerDecisions?: ControllerDecision[];
  workspace?: WorkspaceInfo;
  projectId?: string;
  projectRoot?: string;
  fixAttempts?: number;
  error?: string;
}

export interface SchedulerRunOptions {
  runId?: string;
  signal?: AbortSignal;
  onEvent?: (event: SchedulerEvent) => void;
  projectId?: string;
  projectRoot?: string;
  workspacePath?: string;
  workspaceMode?: WorkspaceMode;
  workspaceGitEnabled?: boolean;
}
```

- [ ] **Step 3: Write failing app config tests**

Create `tests/app-config.test.ts`:

```ts
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
  const dir = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
```

- [ ] **Step 4: Run failing config tests**

Run:

```bash
npm test -- tests/app-config.test.ts
```

Expected: FAIL because `src/app-config.ts` does not exist yet.

- [ ] **Step 5: Implement app config store**

Create `src/app-config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
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
    input.themeMode === "dark" || input.themeMode === "light" || input.themeMode === "system"
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
```

- [ ] **Step 6: Verify config tests pass**

Run:

```bash
npm test -- tests/app-config.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 7: Commit**

```bash
git add src/product-types.ts src/app-config.ts src/types.ts tests/app-config.test.ts
git commit -m "feat: add product config model"
```

---

### Task 2: Project Directory And Graph Asset Services

**Files:**
- Create: `src/projects.ts`
- Create: `src/graph-assets.ts`
- Test: `tests/project-graph-assets.test.ts`

- [ ] **Step 1: Write failing project and graph asset tests**

Create `tests/project-graph-assets.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openProjectDirectory } from "../src/projects.js";
import {
  createGraphAssetFromTemplate,
  importLegacyGraphAsset,
  readGraphAsset,
  renameGraphAsset,
  scanGraphAssets,
  writeGraphAsset,
} from "../src/graph-assets.js";

function tempDir(prefix: string): string {
  const dir = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeGraph(path: string, id: string): void {
  writeFileSync(
    path,
    [
      `id: ${id}`,
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
    ].join("\n"),
    "utf-8"
  );
}

test("openProjectDirectory accepts non-git directories with limited capabilities", async () => {
  const root = tempDir("vinegraph-plain-project");
  try {
    const project = await openProjectDirectory(root, 1000);

    assert.equal(project.kind, "directory");
    assert.equal(project.capabilities.git, false);
    assert.equal(project.capabilities.worktrees, false);
    assert.equal(project.rootPath, root);
    assert.equal(project.name.startsWith("vinegraph-plain-project"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openProjectDirectory detects git projects", async () => {
  const root = tempDir("vinegraph-git-project");
  try {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });

    const project = await openProjectDirectory(root, 1000);

    assert.equal(project.kind, "git");
    assert.equal(project.capabilities.git, true);
    assert.equal(project.capabilities.worktrees, true);
    assert.equal(project.branch, "master");
    assert.equal(project.dirty, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph asset scanner only includes VineGraph graph extensions", () => {
  const root = tempDir("vinegraph-assets");
  try {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "loop.vg.yaml"), "loop_graph");
    writeGraph(join(root, "graphs", "other.vg.yml"), "other_graph");
    writeGraph(join(root, "graphs", "legacy.yaml"), "legacy_graph");
    writeFileSync(join(root, "graphs", "not-yaml.txt"), "text\n", "utf-8");

    const project = {
      id: "project-1",
      name: "Assets",
      rootPath: root,
      kind: "directory" as const,
      graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
      createdAt: 1,
      lastOpenedAt: 1,
    };

    const assets = scanGraphAssets(project);

    assert.deepEqual(
      assets.map((asset) => asset.relativePath).sort(),
      ["graphs/loop.vg.yaml", "graphs/other.vg.yml"]
    );
    assert.equal(assets.find((asset) => asset.relativePath === "graphs/loop.vg.yaml")?.graphId, "loop_graph");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph asset read, save, rename, create, and import stay inside project root", () => {
  const root = tempDir("vinegraph-asset-ops");
  try {
    const project = {
      id: "project-1",
      name: "Assets",
      rootPath: root,
      kind: "directory" as const,
      graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
      createdAt: 1,
      lastOpenedAt: 1,
    };
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "loop.vg.yaml"), "loop_graph");
    writeGraph(join(root, "legacy.yaml"), "legacy_graph");

    const read = readGraphAsset(project, "graphs/loop.vg.yaml");
    assert.equal(read.graph.id, "loop_graph");

    writeGraphAsset(project, "graphs/loop.vg.yaml", read.raw.replace("loop_graph", "saved_graph"));
    assert.match(readFileSync(join(root, "graphs", "loop.vg.yaml"), "utf-8"), /saved_graph/);

    const renamed = renameGraphAsset(project, "graphs/loop.vg.yaml", "graphs/renamed.vg.yaml");
    assert.equal(renamed.relativePath, "graphs/renamed.vg.yaml");

    const created = createGraphAssetFromTemplate(project, "graphs/new-flow.vg.yaml", "new_flow");
    assert.equal(created.relativePath, "graphs/new-flow.vg.yaml");

    const imported = importLegacyGraphAsset(project, "legacy.yaml", "graphs/imported.vg.yaml");
    assert.equal(imported.relativePath, "graphs/imported.vg.yaml");

    assert.throws(
      () => readGraphAsset(project, "../outside.vg.yaml"),
      /inside project root/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing project graph asset tests**

Run:

```bash
npm test -- tests/project-graph-assets.test.ts
```

Expected: FAIL because `src/projects.ts` and `src/graph-assets.ts` do not exist.

- [ ] **Step 3: Implement project service**

Create `src/projects.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ProjectCapabilities, ProjectDetails, ProjectKind, ProjectRecord } from "./product-types.js";

export async function openProjectDirectory(
  rootPath: string,
  now = Date.now()
): Promise<ProjectDetails> {
  const resolved = resolve(rootPath);
  if (!existsSync(resolved)) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }

  const git = await isGitRepo(resolved);
  const kind: ProjectKind = git ? "git" : "directory";
  const capabilities: ProjectCapabilities = {
    git,
    worktrees: git,
    diff: git,
    changedFiles: git,
  };

  const base: ProjectRecord = {
    id: projectIdForPath(resolved),
    name: basename(resolved) || resolved,
    rootPath: resolved,
    kind,
    graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
    createdAt: now,
    lastOpenedAt: now,
  };

  if (!git) {
    return { ...base, capabilities };
  }

  return {
    ...base,
    capabilities,
    branch: await gitOutput(["branch", "--show-current"], resolved),
    dirty: Boolean(await gitOutput(["status", "--porcelain"], resolved)),
  };
}

export function projectIdForPath(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], dir);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function gitOutput(args: string[], cwd: string): Promise<string> {
  const result = await runCommand("git", args, cwd);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", () => resolve({ stdout, stderr, exitCode: -1 }));
    child.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}
```

- [ ] **Step 4: Implement graph asset service**

Create `src/graph-assets.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { GraphLoader } from "./graph-loader.js";
import type { GraphDefinition } from "./types.js";
import type { GraphAsset, ProjectRecord } from "./product-types.js";

const GRAPH_EXTENSIONS = [".vg.yaml", ".vg.yml"];
const SKIP_DIRS = new Set([".git", ".agentgraph", "node_modules", "dist", "build", "out", "target"]);

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
  if (!isGraphAssetPath(to)) throw new Error("Graph asset must use .vg.yaml or .vg.yml");
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
  if (!isGraphAssetPath(to)) throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return toAsset(project, to);
}

export function deleteGraphAsset(project: ProjectRecord, relativePath: string): void {
  const absolutePath = resolveProjectPath(project.rootPath, relativePath);
  if (!isGraphAssetPath(absolutePath)) throw new Error("Graph asset must use .vg.yaml or .vg.yml");
  rmSync(absolutePath, { force: true });
}

export function importLegacyGraphAsset(
  project: ProjectRecord,
  legacyRelativePath: string,
  targetRelativePath: string
): GraphAsset {
  const from = resolveProjectPath(project.rootPath, legacyRelativePath);
  const to = resolveProjectPath(project.rootPath, targetRelativePath);
  if (!isGraphAssetPath(to)) throw new Error("Imported graph asset must use .vg.yaml or .vg.yml");
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
      if (!SKIP_DIRS.has(entry.name)) walk(fullPath, files);
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
  return {
    projectId: project.id,
    absolutePath,
    relativePath: relative(project.rootPath, absolutePath).replace(/\\/g, "/"),
    name: relative(project.rootPath, absolutePath).replace(/\\/g, "/").split("/").pop() ?? absolutePath,
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
```

- [ ] **Step 5: Verify graph asset tests pass**

Run:

```bash
npm test -- tests/project-graph-assets.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/projects.ts src/graph-assets.ts tests/project-graph-assets.test.ts
git commit -m "feat: add project graph asset services"
```

---

### Task 3: Workspace Targets And Scheduler CWD

**Files:**
- Create: `src/workspace-targets.ts`
- Modify: `src/workspace-manager.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/run-history.ts`
- Test: `tests/workspace-targets.test.ts`
- Test: `tests/scheduler-workspace-target.test.ts`

- [ ] **Step 1: Write workspace target tests**

Create `tests/workspace-targets.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceTarget, listWorkspaceTargets } from "../src/workspace-targets.js";
import type { ProjectDetails } from "../src/product-types.js";

function tempDir(prefix: string): string {
  const dir = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function gitProject(root: string): ProjectDetails {
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "agentgraph@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "AgentGraph Test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  return {
    id: "git-project",
    name: "Git Project",
    rootPath: root,
    kind: "git",
    capabilities: { git: true, worktrees: true, diff: true, changedFiles: true },
    graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

test("plain directory exposes exactly one directory workspace target", async () => {
  const root = tempDir("vinegraph-directory-target");
  try {
    const targets = await listWorkspaceTargets({
      id: "plain-project",
      name: "Plain",
      rootPath: root,
      kind: "directory",
      capabilities: { git: false, worktrees: false, diff: false, changedFiles: false },
      graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
      createdAt: 1,
      lastOpenedAt: 1,
    });

    assert.deepEqual(targets.map((target) => target.kind), ["directory"]);
    assert.equal(targets[0]?.path, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git project lists main workspace and created worktree target", async () => {
  const root = tempDir("vinegraph-git-target");
  try {
    const project = gitProject(root);
    const created = await createWorkspaceTarget(project, "review-lane");
    const targets = await listWorkspaceTargets(project);

    assert.equal(created.kind, "worktree");
    assert.match(created.path.replace(/\\/g, "/"), /\/\.agentgraph\/worktrees\/review-lane$/);
    assert.equal(targets.some((target) => target.kind === "main" && target.path === root), true);
    assert.equal(targets.some((target) => target.path === created.path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write scheduler selected workspace test**

Create `tests/scheduler-workspace-target.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../src/scheduler.js";
import type { GraphDefinition } from "../src/types.js";

function tempDir(prefix: string): string {
  const dir = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("scheduler executes write nodes in explicit workspace target", async () => {
  const projectRoot = tempDir("vinegraph-project-root");
  const workspaceRoot = tempDir("vinegraph-selected-workspace");
  const command =
    process.platform === "win32"
      ? {
          program: "cmd",
          args: ["/c", "echo selected-workspace> selected.txt"],
        }
      : {
          program: "sh",
          args: ["-lc", "printf selected-workspace > selected.txt"],
        };

  const graph: GraphDefinition = {
    id: "selected_workspace_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 3, workspace: { mode: "local" } },
    nodes: [
      { id: "write_file", type: "execute", backend: "shell", command },
      {
        id: "end_success",
        type: "execute",
        backend: "internal",
        command: { program: "internal", args: ["finish_success"] },
      },
    ],
    edges: [
      { from: "graph.start", to: "write_file.inputs.trigger" },
      { from: "write_file.outputs.done", to: "end_success.inputs.trigger" },
    ],
  };

  try {
    const result = await Scheduler.run(graph, join(projectRoot, "graph.vg.yaml"), {
      projectId: "project-1",
      projectRoot,
      workspacePath: workspaceRoot,
      workspaceMode: "directory",
      workspaceGitEnabled: false,
    });

    assert.equal(result.status, "success");
    assert.equal(result.projectRoot, projectRoot);
    assert.equal(result.workspace?.path, workspaceRoot);
    assert.equal(result.workspace?.mode, "directory");
    assert.equal(readFileSync(join(workspaceRoot, "selected.txt"), "utf-8"), "selected-workspace");
    assert.equal(existsSync(join(projectRoot, "selected.txt")), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run failing workspace tests**

Run:

```bash
npm test -- tests/workspace-targets.test.ts tests/scheduler-workspace-target.test.ts
```

Expected: FAIL because `src/workspace-targets.ts` does not exist and `Scheduler.run` ignores explicit workspace options.

- [ ] **Step 4: Implement workspace target service**

Create `src/workspace-targets.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ProjectDetails, WorkspaceTarget } from "./product-types.js";

export async function listWorkspaceTargets(project: ProjectDetails): Promise<WorkspaceTarget[]> {
  if (!project.capabilities.git) {
    return [
      {
        id: "directory",
        kind: "directory",
        label: "Project directory",
        path: project.rootPath,
        current: true,
      },
    ];
  }

  const targets: WorkspaceTarget[] = [
    {
      id: "main",
      kind: "main",
      label: "Main working tree",
      path: project.rootPath,
      branch: await gitOutput(["branch", "--show-current"], project.rootPath),
      current: true,
      dirty: Boolean(await gitOutput(["status", "--porcelain"], project.rootPath)),
    },
  ];

  const porcelain = await gitOutput(["worktree", "list", "--porcelain"], project.rootPath);
  for (const item of parseWorktreeList(porcelain, project.rootPath)) {
    if (item.path === project.rootPath) continue;
    targets.push(item);
  }

  return targets;
}

export async function createWorkspaceTarget(
  project: ProjectDetails,
  name: string
): Promise<WorkspaceTarget> {
  if (!project.capabilities.git) {
    throw new Error("Worktrees require a git project");
  }

  const slug = slugify(name);
  if (!slug) throw new Error("Invalid worktree name");

  const worktreeDir = resolve(project.rootPath, ".agentgraph", "worktrees");
  mkdirSync(worktreeDir, { recursive: true });
  const path = join(worktreeDir, slug);
  const result = await runGit(["worktree", "add", "--detach", path, "HEAD"], project.rootPath);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr || result.stdout}`);
  }

  return {
    id: `worktree:${path}`,
    kind: "worktree",
    label: slug,
    path,
    detached: true,
    current: false,
  };
}

function parseWorktreeList(stdout: string, projectRoot: string): WorkspaceTarget[] {
  const targets: WorkspaceTarget[] = [];
  let current: Partial<WorkspaceTarget> | null = null;

  function push(): void {
    if (!current?.path) return;
    targets.push({
      id: `worktree:${current.path}`,
      kind: "worktree",
      label: current.path.split(/[\\/]/).pop() ?? current.path,
      path: current.path,
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      current: current.path === projectRoot,
    });
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      push();
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      push();
      current = { path: value };
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "detached") {
      current.detached = true;
      current.branch = null;
    }
  }
  push();
  return targets;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

function runGit(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", () => resolve({ stdout, stderr, exitCode: -1 }));
    child.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}
```

- [ ] **Step 5: Update scheduler to respect explicit workspace**

Modify the setup section of `src/scheduler.ts` so explicit options win:

```ts
const projectRoot = resolve(options.projectRoot ?? process.cwd());
const ws =
  options.workspacePath
    ? {
        mode: options.workspaceMode ?? "directory",
        path: resolve(options.workspacePath),
        gitEnabled: options.workspaceGitEnabled ?? false,
      }
    : await WorkspaceManager.setup(graph.runtime, runId, projectRoot);
```

Update `runRecord` creation in the same file:

```ts
const runRecord: RunRecord = {
  runId,
  graphId: graph.id,
  graphPath,
  status: "running",
  startedAt: Date.now(),
  activations: [],
  controllerDecisions: [],
  workspace: ws,
  projectId: options.projectId,
  projectRoot,
  fixAttempts: 0,
};
```

- [ ] **Step 6: Update diff capture for non-git explicit directories**

Modify `WorkspaceManager.captureDiff` so non-git directory workspaces do not run git commands:

```ts
static async captureDiff(ws: WorkspaceInfo): Promise<void> {
  if (ws.gitEnabled === false || ws.mode === "directory") {
    ws.diff = "";
    ws.changedFiles = [];
    return;
  }

  const untrackedResult = await runGit(
    ["ls-files", "--others", "--exclude-standard"],
    ws.path
  );
  // keep the existing git diff logic below this guard
}
```

- [ ] **Step 7: Update run history to save under project root**

Modify `src/run-history.ts`:

```ts
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "./types.js";

const RUNS_DIR = ".agentgraph/runs";

function ensureDir(projectRoot = process.cwd()): string {
  const dir = join(projectRoot, RUNS_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveRunRecord(record: RunRecord): void {
  const dir = ensureDir(record.projectRoot);
  const filePath = join(dir, `${record.runId}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
  appendFileSync(
    join(dir, "index.jsonl"),
    JSON.stringify({
      runId: record.runId,
      graphId: record.graphId,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      totalDurationMs: record.totalDurationMs,
      projectId: record.projectId,
      graphPath: record.graphPath,
    }) + "\n",
    "utf-8"
  );
}
```

- [ ] **Step 8: Verify workspace tests pass**

Run:

```bash
npm test -- tests/workspace-targets.test.ts tests/scheduler-workspace-target.test.ts tests/runtime.test.ts tests/run-control.test.ts
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 9: Commit**

```bash
git add src/workspace-targets.ts src/workspace-manager.ts src/scheduler.ts src/run-history.ts tests/workspace-targets.test.ts tests/scheduler-workspace-target.test.ts
git commit -m "feat: run graphs in selected workspace"
```

---

### Task 4: Product Server APIs

**Files:**
- Modify: `src/server.ts`
- Modify: `src/readiness.ts`
- Test: `tests/server-product-api.test.ts`

- [ ] **Step 1: Write failing product API tests**

Create `tests/server-product-api.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgentGraphServer } from "../src/server.js";

function tempDir(prefix: string): string {
  const dir = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function writeGraph(path: string): void {
  writeFileSync(
    path,
    [
      "id: api_graph",
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
    ].join("\n"),
    "utf-8"
  );
}

test("server opens a non-git project and scans only graph assets", async () => {
  const root = tempDir("vinegraph-product-api");
  const server = createAgentGraphServer(root);
  const baseUrl = await listen(server);
  try {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "api.vg.yaml"));
    writeGraph(join(root, "graphs", "legacy.yaml"));

    const opened = await fetch(`${baseUrl}/api/projects/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: root }),
    });
    const project = await opened.json() as { id: string; kind: string; capabilities: { git: boolean } };

    assert.equal(opened.status, 200);
    assert.equal(project.kind, "directory");
    assert.equal(project.capabilities.git, false);

    const assetsResp = await fetch(`${baseUrl}/api/projects/${project.id}/graph-assets`);
    const assets = await assetsResp.json() as Array<{ relativePath: string }>;

    assert.equal(assetsResp.status, 200);
    assert.deepEqual(assets.map((asset) => asset.relativePath), ["graphs/api.vg.yaml"]);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("server starts a run with explicit project graph and workspace", async () => {
  const root = tempDir("vinegraph-product-run");
  const server = createAgentGraphServer(root);
  const baseUrl = await listen(server);
  try {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "api.vg.yaml"));

    const opened = await fetch(`${baseUrl}/api/projects/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: root }),
    });
    const project = await opened.json() as { id: string };

    const runResp = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        graphPath: "graphs/api.vg.yaml",
        workspaceTarget: { kind: "directory", path: root },
        inputs: {},
      }),
    });
    const run = await runResp.json() as { status: string; projectId: string };

    assert.equal(runResp.status, 202);
    assert.equal(run.status, "running");
    assert.equal(run.projectId, project.id);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing product API tests**

Run:

```bash
npm test -- tests/server-product-api.test.ts
```

Expected: FAIL because product project and graph asset routes do not exist.

- [ ] **Step 3: Add in-memory project registry and route helpers**

Modify `src/server.ts` imports:

```ts
import { loadAppConfig, saveAppConfig } from "./app-config.js";
import { openProjectDirectory } from "./projects.js";
import {
  createGraphAssetFromTemplate,
  deleteGraphAsset,
  importLegacyGraphAsset,
  readGraphAsset,
  renameGraphAsset,
  scanGraphAssets,
  writeGraphAsset,
} from "./graph-assets.js";
import { createWorkspaceTarget, listWorkspaceTargets } from "./workspace-targets.js";
import type { ProjectDetails } from "./product-types.js";
```

Add near the existing active run maps:

```ts
const openProjects = new Map<string, ProjectDetails>();

function getOpenProject(projectId: string): ProjectDetails {
  const project = openProjects.get(projectId);
  if (!project) {
    throw new Error(`Project not open: ${projectId}`);
  }
  return project;
}
```

- [ ] **Step 4: Add config and project API routes**

Modify `handleRequest` before legacy graph listing:

```ts
if (url.pathname === "/api/config" && method === "GET") {
  return sendJSON(res, loadAppConfig());
}

if (url.pathname === "/api/config" && method === "POST") {
  const body = await parseBody(req);
  return sendJSON(res, saveAppConfig(body as ReturnType<typeof loadAppConfig>));
}

if (url.pathname === "/api/projects/open" && method === "POST") {
  const body = await parseBody(req) as Record<string, unknown>;
  if (typeof body.rootPath !== "string") {
    return sendError(res, "Missing rootPath", 400);
  }
  const project = await openProjectDirectory(body.rootPath);
  openProjects.set(project.id, project);
  return sendJSON(res, project);
}
```

- [ ] **Step 5: Add graph asset and workspace routes**

Add route matchers in `handleRequest`:

```ts
const graphAssetsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph-assets$/);
if (graphAssetsMatch && method === "GET") {
  return sendJSON(res, scanGraphAssets(getOpenProject(graphAssetsMatch[1])));
}

const graphAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph-assets\/(.+)$/);
if (graphAssetMatch) {
  const project = getOpenProject(graphAssetMatch[1]);
  const assetPath = decodeURIComponent(graphAssetMatch[2]);
  if (method === "GET") return sendJSON(res, readGraphAsset(project, assetPath));
  if (method === "PUT") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (typeof body.raw !== "string") return sendError(res, "Missing raw graph content", 400);
    return sendJSON(res, writeGraphAsset(project, assetPath, body.raw));
  }
  if (method === "DELETE") {
    deleteGraphAsset(project, assetPath);
    return sendJSON(res, { ok: true });
  }
}

const workspaceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/workspaces$/);
if (workspaceMatch && method === "GET") {
  return sendJSON(res, await listWorkspaceTargets(getOpenProject(workspaceMatch[1])));
}
if (workspaceMatch && method === "POST") {
  const body = await parseBody(req) as Record<string, unknown>;
  if (typeof body.name !== "string") return sendError(res, "Missing workspace name", 400);
  return sendJSON(res, await createWorkspaceTarget(getOpenProject(workspaceMatch[1]), body.name), 201);
}
```

- [ ] **Step 6: Update run API to accept product run body**

Modify `handleStartRun` in `src/server.ts` so product fields are used when present:

```ts
const params = body as Record<string, unknown>;
const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
const project = projectId ? getOpenProject(projectId) : null;
const graphPathParam = params.graphPath as string;
const graphPath = project
  ? resolve(project.rootPath, graphPathParam)
  : graphPathParam;
const workspaceTarget = params.workspaceTarget as Record<string, unknown> | undefined;
```

Update the `Scheduler.run` call:

```ts
const promise = Scheduler.run(graph, graphPath, {
  runId,
  signal: controller.signal,
  projectId: project?.id,
  projectRoot: project?.rootPath,
  workspacePath:
    typeof workspaceTarget?.path === "string"
      ? workspaceTarget.path
      : undefined,
  workspaceMode:
    workspaceTarget?.kind === "directory"
      ? "directory"
      : workspaceTarget?.kind === "worktree" || workspaceTarget?.kind === "main"
        ? "local"
        : undefined,
  workspaceGitEnabled: project?.capabilities.git ?? undefined,
  onEvent: (event) => emitSSE(runId, event.type, event),
});
```

Update the accepted run response:

```ts
sendJSON(res, {
  runId,
  status: "running",
  graphId: graph.id,
  graphPath,
  projectId: project?.id,
}, 202);
```

- [ ] **Step 7: Verify product API tests pass**

Run:

```bash
npm test -- tests/server-product-api.test.ts tests/server-worktrees.test.ts tests/server-graphs.test.ts
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/readiness.ts tests/server-product-api.test.ts
git commit -m "feat: expose product workbench APIs"
```

---

### Task 5: UI Repo Explorer, Workspace Bar, And Graph Asset Opening

**Files:**
- Modify: `src/ui/index.html`
- Modify: `src/ui/app.js`
- Modify: `src/ui/style.css`
- Test: `tests/ui-product-workbench.test.ts`

- [ ] **Step 1: Write failing UI workbench tests**

Create `tests/ui-product-workbench.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const htmlSource = readFileSync("src/ui/index.html", "utf-8");
const uiSource = readFileSync("src/ui/app.js", "utf-8");
const cssSource = readFileSync("src/ui/style.css", "utf-8");

test("UI uses repo explorer and graph asset tree instead of graph dropdown as primary navigation", () => {
  assert.match(htmlSource, /id="repo-explorer"/);
  assert.match(htmlSource, /id="graph-assets"/);
  assert.match(htmlSource, /id="open-graph-path"/);
  assert.match(htmlSource, /id="workspace-status-bar"/);
  assert.doesNotMatch(htmlSource, /id="graph-select"/);
});

test("UI loads projects, graph assets, and workspaces from product APIs", () => {
  assert.match(uiSource, /async function openProject/);
  assert.match(uiSource, /async function loadGraphAssets/);
  assert.match(uiSource, /async function openGraphAsset/);
  assert.match(uiSource, /async function loadWorkspaceTargets/);
  assert.match(uiSource, /\/api\/projects\/open/);
  assert.match(uiSource, /\/graph-assets/);
  assert.match(uiSource, /\/workspaces/);
});

test("UI renders automatic graph canvas from loaded graph nodes and edges", () => {
  assert.match(uiSource, /function layoutGraphDefinition/);
  assert.match(uiSource, /currentGraphDefinition\.nodes/);
  assert.match(uiSource, /currentGraphDefinition\.edges/);
  assert.doesNotMatch(uiSource, /PRESET\s*=/);
});

test("UI has styling for repo explorer, graph assets, and workspace status bar", () => {
  assert.match(cssSource, /#repo-explorer/);
  assert.match(cssSource, /\.graph-asset-row/);
  assert.match(cssSource, /#workspace-status-bar/);
});
```

- [ ] **Step 2: Run failing UI workbench tests**

Run:

```bash
npm test -- tests/ui-product-workbench.test.ts
```

Expected: FAIL because the UI still uses the legacy graph select and preset path.

- [ ] **Step 3: Update HTML structure**

Modify `src/ui/index.html` with these product IDs:

```html
<header id="topbar">
  <div class="brand-block" aria-label="VineGraph">
    <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
    <strong>VineGraph</strong>
  </div>
  <div id="current-repo-chip" class="top-chip">No repo opened</div>
  <div id="open-graph-path" class="top-chip muted">No graph open</div>
  <div id="save-state-chip" class="top-chip muted">Saved</div>
  <div class="topbar-spacer"></div>
  <button id="btn-run" class="toolbar-button primary" type="button">Run</button>
  <button id="btn-cancel" class="toolbar-button" type="button" disabled>Stop</button>
  <button id="btn-doctor" class="toolbar-button" type="button">Doctor</button>
  <button id="btn-settings" class="toolbar-button" type="button">Settings</button>
</header>
```

Replace the left panel with:

```html
<aside id="left-panel">
  <section id="repo-explorer" class="sidebar-section">
    <div class="section-heading">
      <span>Repo Explorer</span>
      <button id="btn-open-project" class="micro-button" type="button">Open</button>
    </div>
    <div id="project-summary" class="project-summary">
      <div class="empty-state compact">Open a local directory to begin</div>
    </div>
  </section>

  <section class="sidebar-section">
    <div class="section-heading">
      <span>Graph Assets</span>
      <button id="btn-new-graph" class="micro-button" type="button">+</button>
    </div>
    <div class="search-box">
      <span class="search-icon"></span>
      <input id="graph-asset-filter" type="text" placeholder="Search graph assets">
    </div>
    <div id="graph-assets" class="graph-asset-list">
      <div class="empty-state compact">No graph assets loaded</div>
    </div>
  </section>
</aside>
```

Add the bottom status bar after the runtime dock:

```html
<footer id="workspace-status-bar">
  <button id="workspace-switcher" class="workspace-chip" type="button">No workspace selected</button>
  <span id="workspace-branch" class="status-text"></span>
  <span id="workspace-dirty" class="status-text"></span>
  <span id="run-state-text" class="status-text"></span>
</footer>
```

- [ ] **Step 4: Add product UI state and API functions**

Modify the top of `src/ui/app.js`:

```js
let currentProject = null;
let graphAssets = [];
let workspaceTargets = [];
let selectedWorkspaceTarget = null;
let currentGraphAsset = null;
let currentGraphDefinition = null;
let graphDirty = false;

const domCurrentRepoChip = $("#current-repo-chip");
const domOpenGraphPath = $("#open-graph-path");
const domSaveStateChip = $("#save-state-chip");
const domProjectSummary = $("#project-summary");
const domGraphAssets = $("#graph-assets");
const domGraphAssetFilter = $("#graph-asset-filter");
const domWorkspaceBar = $("#workspace-status-bar");
const domWorkspaceSwitcher = $("#workspace-switcher");
const domWorkspaceBranch = $("#workspace-branch");
const domWorkspaceDirty = $("#workspace-dirty");
const domRunStateText = $("#run-state-text");
```

Add API helpers:

```js
async function openProject(rootPath) {
  const resp = await fetch(apiUrl("/api/projects/open"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootPath }),
  });
  const project = await resp.json();
  if (!resp.ok) throw new Error(project.error || "Failed to open project");
  currentProject = project;
  renderProjectSummary();
  await Promise.all([loadGraphAssets(), loadWorkspaceTargets()]);
}

async function loadGraphAssets() {
  if (!currentProject) return;
  const resp = await fetch(apiUrl(`/api/projects/${currentProject.id}/graph-assets`));
  graphAssets = resp.ok ? await resp.json() : [];
  renderGraphAssets();
}

async function openGraphAsset(relativePath) {
  if (!currentProject) return;
  const resp = await fetch(apiUrl(`/api/projects/${currentProject.id}/graph-assets/${encodeURIComponent(relativePath)}`));
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.error || "Failed to open graph");
  currentGraphAsset = result.asset;
  currentGraphDefinition = result.graph;
  graphDirty = false;
  renderOpenGraphState();
  renderGraphCanvas();
  renderInspectorNode(findGraphNode(selectedGraphNodeId));
}

async function loadWorkspaceTargets() {
  if (!currentProject) return;
  const resp = await fetch(apiUrl(`/api/projects/${currentProject.id}/workspaces`));
  workspaceTargets = resp.ok ? await resp.json() : [];
  selectedWorkspaceTarget = workspaceTargets[0] ?? null;
  renderWorkspaceBar();
}
```

- [ ] **Step 5: Render repo, assets, and workspace bar**

Add render functions to `src/ui/app.js`:

```js
function renderProjectSummary() {
  if (!currentProject) {
    domProjectSummary.innerHTML = '<div class="empty-state compact">Open a local directory to begin</div>';
    domCurrentRepoChip.textContent = "No repo opened";
    return;
  }
  domCurrentRepoChip.textContent = currentProject.name;
  const capability = currentProject.capabilities?.git
    ? `${currentProject.branch || "git"} ${currentProject.dirty ? "dirty" : "clean"}`
    : "non-git directory";
  domProjectSummary.innerHTML = `<div class="project-card">
    <strong>${escapeHtml(currentProject.name)}</strong>
    <span>${escapeHtml(currentProject.rootPath)}</span>
    <small>${escapeHtml(capability)}</small>
  </div>`;
}

function renderGraphAssets() {
  const filter = (domGraphAssetFilter?.value || "").toLowerCase();
  const visible = graphAssets.filter((asset) =>
    asset.relativePath.toLowerCase().includes(filter)
  );
  domGraphAssets.innerHTML = visible.length
    ? visible.map((asset) => `<button class="graph-asset-row" type="button" data-path="${escapeAttr(asset.relativePath)}">
        <span class="file-icon graph"></span>
        <span>${escapeHtml(asset.relativePath)}</span>
      </button>`).join("")
    : '<div class="empty-state compact">No graph assets match</div>';
  domGraphAssets.querySelectorAll(".graph-asset-row").forEach((row) => {
    row.addEventListener("dblclick", () => openGraphAsset(row.dataset.path));
    row.addEventListener("click", () => {
      domGraphAssets.querySelectorAll(".graph-asset-row").forEach((item) => item.classList.remove("selected"));
      row.classList.add("selected");
    });
  });
}

function renderOpenGraphState() {
  domOpenGraphPath.textContent = currentGraphAsset?.relativePath || "No graph open";
  domSaveStateChip.textContent = graphDirty ? "Unsaved" : "Saved";
  domSaveStateChip.classList.toggle("dirty", graphDirty);
}

function renderWorkspaceBar() {
  if (!selectedWorkspaceTarget) {
    domWorkspaceSwitcher.textContent = "No workspace selected";
    domWorkspaceBranch.textContent = "";
    domWorkspaceDirty.textContent = "";
    return;
  }
  domWorkspaceSwitcher.textContent = selectedWorkspaceTarget.path;
  domWorkspaceBranch.textContent = selectedWorkspaceTarget.branch || selectedWorkspaceTarget.kind;
  domWorkspaceDirty.textContent = selectedWorkspaceTarget.dirty ? "dirty" : "clean";
}
```

- [ ] **Step 6: Add automatic graph layout**

Replace preset-based canvas source with:

```js
function layoutGraphDefinition(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    const target = edge.to.split(".")[0];
    if (incoming.has(target)) incoming.set(target, incoming.get(target) + 1);
  }
  const layers = [];
  const placed = new Set();
  let frontier = nodes.filter((node) => incoming.get(node.id) === 0);
  if (frontier.length === 0 && nodes[0]) frontier = [nodes[0]];
  for (let depth = 0; frontier.length > 0; depth++) {
    layers[depth] = frontier;
    frontier.forEach((node) => placed.add(node.id));
    const nextIds = new Set();
    for (const edge of edges) {
      const from = edge.from.split(".")[0];
      const to = edge.to.split(".")[0];
      if ((from === "graph" || placed.has(from)) && !placed.has(to)) nextIds.add(to);
    }
    frontier = nodes.filter((node) => nextIds.has(node.id));
  }
  for (const node of nodes) {
    if (!placed.has(node.id)) {
      if (!layers[layers.length]) layers[layers.length] = [];
      layers[layers.length - 1].push(node);
    }
  }
  return {
    nodes: layers.flatMap((layer, depth) =>
      layer.map((node, index) => ({
        ...node,
        x: 80 + depth * 230,
        y: 80 + index * 140,
        width: 180,
        height: 96,
        title: node.id,
        kind: node.type === "controller" ? "controller" : node.backend || "execute",
        badge: node.type === "controller" ? node.model : node.execution?.model || node.backend,
        description: node.promptTemplate ? "Prompt configured" : node.command?.program || node.type,
      }))
    ),
    connections: edges.map((edge) => ({
      from: edge.from.split(".")[0],
      to: edge.to.split(".")[0],
      color: edge.from.includes("failed") || edge.from.includes("fix") ? "red" : "blue",
    })),
  };
}
```

- [ ] **Step 7: Add CSS for workbench shell**

Add to `src/ui/style.css`:

```css
.top-chip {
  min-width: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(11, 25, 42, 0.85);
  color: var(--text);
}

.top-chip.muted {
  color: var(--muted);
}

.top-chip.dirty {
  color: var(--amber);
  border-color: rgba(233, 165, 87, 0.45);
}

#repo-explorer,
.graph-asset-list {
  min-width: 0;
}

.project-card {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: rgba(9, 20, 34, 0.78);
}

.project-card span,
.project-card small {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
}

.graph-asset-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
}

.graph-asset-row:hover,
.graph-asset-row.selected {
  background: rgba(93, 141, 255, 0.14);
  color: var(--text);
}

#workspace-status-bar {
  grid-column: 2 / 5;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-top: 1px solid var(--line);
  background: rgba(6, 14, 24, 0.96);
  color: var(--muted);
  font-size: 12px;
}

.workspace-chip {
  min-width: 0;
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 9px;
  background: rgba(12, 27, 44, 0.9);
  color: var(--text);
}
```

- [ ] **Step 8: Verify UI workbench tests pass**

Run:

```bash
npm test -- tests/ui-product-workbench.test.ts tests/ui-run-control.test.ts
npm run typecheck
```

Expected: all commands PASS after updating old tests that explicitly asserted `#graph-select`.

- [ ] **Step 9: Commit**

```bash
git add src/ui/index.html src/ui/app.js src/ui/style.css tests/ui-product-workbench.test.ts tests/ui-run-control.test.ts
git commit -m "feat: add repo graph asset workbench UI"
```

---

### Task 6: Editable Inspector And Graph Asset Save

**Files:**
- Modify: `src/ui/app.js`
- Modify: `src/ui/style.css`
- Modify: `src/server.ts`
- Test: `tests/ui-product-workbench.test.ts`
- Test: `tests/server-product-api.test.ts`

- [ ] **Step 1: Extend tests for inspector save**

Add to `tests/ui-product-workbench.test.ts`:

```ts
test("UI inspector exposes editable node fields and save action", () => {
  assert.match(uiSource, /function renderEditableInspectorNode/);
  assert.match(uiSource, /id="inspector-backend"/);
  assert.match(uiSource, /id="inspector-model"/);
  assert.match(uiSource, /id="inspector-prompt-template"/);
  assert.match(uiSource, /async function saveGraphAsset/);
  assert.match(uiSource, /method:\s*"PUT"/);
});
```

Add to `tests/server-product-api.test.ts`:

```ts
test("server validates graph asset saves", async () => {
  const root = tempDir("vinegraph-product-save");
  const server = createAgentGraphServer(root);
  const baseUrl = await listen(server);
  try {
    mkdirSync(join(root, "graphs"), { recursive: true });
    writeGraph(join(root, "graphs", "api.vg.yaml"));
    const opened = await fetch(`${baseUrl}/api/projects/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: root }),
    });
    const project = await opened.json() as { id: string };
    const save = await fetch(`${baseUrl}/api/projects/${project.id}/graph-assets/${encodeURIComponent("graphs/api.vg.yaml")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: "id: broken\nversion: \"0.1.0\"\nnodes: []\nedges: []\n" }),
    });
    const body = await save.json() as { error?: string };
    assert.equal(save.status, 400);
    assert.match(body.error ?? "", /nodes/);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing inspector tests**

Run:

```bash
npm test -- tests/ui-product-workbench.test.ts tests/server-product-api.test.ts
```

Expected: FAIL until editable inspector and save handling exist.

- [ ] **Step 3: Add server-side graph serialization and save validation**

Add a `js-yaml` import to `src/server.ts`:

```ts
import yaml from "js-yaml";
```

Wrap graph asset `PUT` in `src/server.ts` so it accepts either raw YAML or a graph object. The UI will send a graph object, and the server will serialize with the existing `js-yaml` dependency:

```ts
try {
  const raw =
    typeof body.raw === "string"
      ? body.raw
      : body.graph
        ? yaml.dump(body.graph, { lineWidth: 120, noRefs: true })
        : null;
  if (!raw) return sendError(res, "Missing raw graph content or graph object", 400);
  return sendJSON(res, writeGraphAsset(project, assetPath, raw));
} catch (err) {
  return sendError(res, err instanceof Error ? err.message : String(err), 400);
}
```

- [ ] **Step 4: Add editable inspector form**

Add to `src/ui/app.js`:

```js
function renderEditableInspectorNode(nodeInfo) {
  if (!nodeInfo) {
    domInspector.innerHTML = '<div class="empty-state">Select a node</div>';
    return;
  }
  const nodeType = nodeInfo.type;
  const execution = nodeInfo.execution || {};
  domInspector.innerHTML = `<div class="inspector-kicker">
      <span class="node-badge badge-${badgeClass(nodeInfo.backend || nodeInfo.model || nodeType)}">${escapeHtml(nodeType)}</span>
      <span>Editable node</span>
    </div>
    <div class="inspector-title">${escapeHtml(nodeInfo.id)}</div>
    <div class="property-group inspector-form">
      <label>Backend
        <select id="inspector-backend">
          ${["shell", "internal", "codex", "claude", "git"].map((backend) =>
            `<option value="${backend}" ${backend === nodeInfo.backend ? "selected" : ""}>${backend}</option>`
          ).join("")}
        </select>
      </label>
      <label>Model
        <input id="inspector-model" value="${escapeAttr(execution.model || nodeInfo.model || "")}">
      </label>
      <label>Reasoning Effort
        <input id="inspector-reasoning-effort" value="${escapeAttr(execution.reasoningEffort || "")}">
      </label>
      <label>Timeout MS
        <input id="inspector-timeout-ms" type="number" value="${escapeAttr(execution.timeoutMs || "")}">
      </label>
      <label>Prompt Template
        <textarea id="inspector-prompt-template" spellcheck="false">${escapeHtml(nodeInfo.promptTemplate || "")}</textarea>
      </label>
      <label>Command JSON
        <textarea id="inspector-command" spellcheck="false">${escapeHtml(JSON.stringify(nodeInfo.command || {}, null, 2))}</textarea>
      </label>
      <button id="btn-save-graph" class="toolbar-button primary" type="button">Save YAML</button>
      <div id="inspector-save-message" class="inspector-message"></div>
    </div>`;
  bindInspectorForm(nodeInfo.id);
}
```

- [ ] **Step 5: Add graph update and save functions**

Add to `src/ui/app.js`:

```js
function bindInspectorForm(nodeId) {
  ["inspector-backend", "inspector-model", "inspector-reasoning-effort", "inspector-timeout-ms", "inspector-prompt-template", "inspector-command"]
    .forEach((id) => $(`#${id}`)?.addEventListener("input", () => {
      applyInspectorForm(nodeId);
      graphDirty = true;
      renderOpenGraphState();
      renderGraphCanvas();
    }));
  $("#btn-save-graph")?.addEventListener("click", saveGraphAsset);
}

function applyInspectorForm(nodeId) {
  const node = currentGraphDefinition?.nodes?.find((item) => item.id === nodeId);
  if (!node) return;
  if (node.type === "execute") {
    node.backend = $("#inspector-backend")?.value || node.backend;
    const model = $("#inspector-model")?.value?.trim();
    const reasoningEffort = $("#inspector-reasoning-effort")?.value?.trim();
    const timeoutValue = $("#inspector-timeout-ms")?.value;
    node.execution = node.execution || {};
    if (model) node.execution.model = model; else delete node.execution.model;
    if (reasoningEffort) node.execution.reasoningEffort = reasoningEffort; else delete node.execution.reasoningEffort;
    if (timeoutValue) node.execution.timeoutMs = Number(timeoutValue); else delete node.execution.timeoutMs;
    node.promptTemplate = $("#inspector-prompt-template")?.value || undefined;
    const commandRaw = $("#inspector-command")?.value?.trim();
    if (commandRaw) node.command = JSON.parse(commandRaw);
  } else if (node.type === "controller") {
    node.model = $("#inspector-model")?.value?.trim() || node.model;
    node.promptTemplate = $("#inspector-prompt-template")?.value || node.promptTemplate;
  }
}

async function saveGraphAsset() {
  if (!currentProject || !currentGraphAsset || !currentGraphDefinition) return;
  const message = $("#inspector-save-message");
  const resp = await fetch(apiUrl(`/api/projects/${currentProject.id}/graph-assets/${encodeURIComponent(currentGraphAsset.relativePath)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph: currentGraphDefinition }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    if (message) message.textContent = result.error || "Save failed";
    return;
  }
  graphDirty = false;
  if (message) message.textContent = "Saved";
  renderOpenGraphState();
}
```

- [ ] **Step 6: Add inspector CSS**

Add to `src/ui/style.css`:

```css
.inspector-form {
  display: grid;
  gap: 10px;
}

.inspector-form label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
}

.inspector-form input,
.inspector-form select,
.inspector-form textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-strong);
  color: var(--text);
  padding: 8px;
  font: inherit;
}

.inspector-form textarea {
  min-height: 160px;
  resize: vertical;
  font-family: "Cascadia Mono", Consolas, monospace;
}

.inspector-message {
  min-height: 18px;
  color: var(--muted);
  font-size: 12px;
}
```

- [ ] **Step 7: Verify inspector tests pass**

Run:

```bash
npm test -- tests/ui-product-workbench.test.ts tests/server-product-api.test.ts
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/ui/app.js src/ui/style.css tests/ui-product-workbench.test.ts tests/server-product-api.test.ts
git commit -m "feat: edit graph nodes from inspector"
```

---

### Task 7: Settings, Doctor Probes, And Themes

**Files:**
- Modify: `src/server.ts`
- Modify: `src/ui/index.html`
- Modify: `src/ui/app.js`
- Modify: `src/ui/style.css`
- Test: `tests/ui-product-workbench.test.ts`
- Test: `tests/server-product-api.test.ts`

- [ ] **Step 1: Extend tests for settings and theme**

Add to `tests/ui-product-workbench.test.ts`:

```ts
test("UI exposes real settings fields and theme controls", () => {
  assert.match(htmlSource, /id="settings-panel"/);
  assert.match(htmlSource, /id="setting-controller-api-key"/);
  assert.match(htmlSource, /id="setting-codex-path"/);
  assert.match(htmlSource, /id="setting-claude-path"/);
  assert.match(htmlSource, /id="setting-theme-mode"/);
  assert.match(uiSource, /async function loadAppConfig/);
  assert.match(uiSource, /async function saveAppConfig/);
  assert.match(uiSource, /function applyThemeMode/);
});
```

Add to `tests/server-product-api.test.ts`:

```ts
test("server reads and saves app config", async () => {
  const root = tempDir("vinegraph-config-api");
  const server = createAgentGraphServer(root);
  const baseUrl = await listen(server);
  try {
    const save = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        themeMode: "light",
        graphAssetGlobs: ["**/*.vg.yaml", "**/*.vg.yml"],
        recentProjects: [],
        controllerApiKey: "secret",
      }),
    });
    assert.equal(save.status, 200);
    const read = await fetch(`${baseUrl}/api/config`);
    const config = await read.json() as { themeMode: string; controllerApiKey: string };
    assert.equal(config.themeMode, "light");
    assert.equal(config.controllerApiKey, "secret");
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing settings tests**

Run:

```bash
npm test -- tests/ui-product-workbench.test.ts tests/server-product-api.test.ts
```

Expected: FAIL until settings UI and config wiring exist.

- [ ] **Step 3: Add settings panel HTML**

Add to `src/ui/index.html` near the inspector or as an overlay:

```html
<aside id="settings-panel" class="settings-panel hidden" aria-label="Settings">
  <div class="settings-header">
    <strong>Settings</strong>
    <button id="btn-close-settings" class="icon-button small" type="button">×</button>
  </div>
  <label>Controller API Key
    <input id="setting-controller-api-key" type="password" autocomplete="off">
  </label>
  <label>Codex CLI Path
    <input id="setting-codex-path" type="text">
  </label>
  <label>Claude CLI Path
    <input id="setting-claude-path" type="text">
  </label>
  <label>Default Codex Model
    <input id="setting-default-codex-model" type="text">
  </label>
  <label>Default Reasoning Effort
    <input id="setting-default-reasoning-effort" type="text">
  </label>
  <label>Theme
    <select id="setting-theme-mode">
      <option value="system">System</option>
      <option value="dark">Dark</option>
      <option value="light">Light</option>
    </select>
  </label>
  <p class="settings-note">M1 stores secrets in local app config on this machine.</p>
  <button id="btn-save-settings" class="toolbar-button primary" type="button">Save Settings</button>
  <button id="btn-probe-settings" class="toolbar-button" type="button">Run Probe</button>
  <div id="settings-message" class="settings-message"></div>
</aside>
```

- [ ] **Step 4: Add settings JS**

Add to `src/ui/app.js`:

```js
let appConfig = null;

async function loadAppConfig() {
  const resp = await fetch(apiUrl("/api/config"));
  appConfig = resp.ok ? await resp.json() : { themeMode: "system" };
  renderSettings();
  applyThemeMode(appConfig.themeMode || "system");
}

function renderSettings() {
  $("#setting-controller-api-key").value = appConfig?.controllerApiKey || "";
  $("#setting-codex-path").value = appConfig?.codexCliPath || "";
  $("#setting-claude-path").value = appConfig?.claudeCliPath || "";
  $("#setting-default-codex-model").value = appConfig?.defaultCodexModel || "";
  $("#setting-default-reasoning-effort").value = appConfig?.defaultReasoningEffort || "";
  $("#setting-theme-mode").value = appConfig?.themeMode || "system";
}

async function saveAppConfig() {
  const next = {
    ...(appConfig || {}),
    version: 1,
    controllerApiKey: $("#setting-controller-api-key").value,
    codexCliPath: $("#setting-codex-path").value,
    claudeCliPath: $("#setting-claude-path").value,
    defaultCodexModel: $("#setting-default-codex-model").value,
    defaultReasoningEffort: $("#setting-default-reasoning-effort").value,
    themeMode: $("#setting-theme-mode").value,
    graphAssetGlobs: appConfig?.graphAssetGlobs || ["**/*.vg.yaml", "**/*.vg.yml"],
    recentProjects: appConfig?.recentProjects || [],
  };
  const resp = await fetch(apiUrl("/api/config"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  appConfig = await resp.json();
  applyThemeMode(appConfig.themeMode);
  $("#settings-message").textContent = resp.ok ? "Saved" : appConfig.error || "Save failed";
}

function applyThemeMode(mode) {
  document.documentElement.dataset.theme = mode === "system" ? systemTheme() : mode;
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
```

Bind buttons in `init()`:

```js
$("#btn-settings")?.addEventListener("click", () => $("#settings-panel")?.classList.remove("hidden"));
$("#btn-close-settings")?.addEventListener("click", () => $("#settings-panel")?.classList.add("hidden"));
$("#btn-save-settings")?.addEventListener("click", saveAppConfig);
$("#setting-theme-mode")?.addEventListener("change", (event) => applyThemeMode(event.target.value));
await loadAppConfig();
```

- [ ] **Step 5: Add light/dark theme CSS tokens**

Modify the `:root` color section in `src/ui/style.css`:

```css
:root,
:root[data-theme="dark"] {
  --bg: #050b14;
  --panel: #091421;
  --panel-strong: #0f2034;
  --text: #e7f0fb;
  --muted: #8fa4bc;
  --faint: #5e7086;
  --line: rgba(116, 140, 170, 0.24);
  --blue: #5d8dff;
  --green: #55d6a4;
  --amber: #e9a557;
  --red: #ef5c5c;
}

:root[data-theme="light"] {
  --bg: #f6f8fb;
  --panel: #ffffff;
  --panel-strong: #eef3f8;
  --text: #172231;
  --muted: #53657a;
  --faint: #7c8ca0;
  --line: rgba(43, 59, 78, 0.18);
  --blue: #2864d8;
  --green: #168b64;
  --amber: #b76d13;
  --red: #c93d48;
}
```

- [ ] **Step 6: Verify settings and theme tests pass**

Run:

```bash
npm test -- tests/ui-product-workbench.test.ts tests/server-product-api.test.ts
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/ui/index.html src/ui/app.js src/ui/style.css tests/ui-product-workbench.test.ts tests/server-product-api.test.ts
git commit -m "feat: add settings and themes"
```

---

### Task 8: Resizable Runtime Dock And Terminal Model

**Files:**
- Modify: `src/ui/index.html`
- Modify: `src/ui/app.js`
- Modify: `src/ui/style.css`
- Test: `tests/ui-terminal-dock.test.ts`
- Modify: `tests/ui-run-control.test.ts`

- [ ] **Step 1: Write failing terminal dock tests**

Create `tests/ui-terminal-dock.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const htmlSource = readFileSync("src/ui/index.html", "utf-8");
const uiSource = readFileSync("src/ui/app.js", "utf-8");
const cssSource = readFileSync("src/ui/style.css", "utf-8");

test("runtime dock is resizable and collapsible", () => {
  assert.match(htmlSource, /id="runtime-dock-resize-handle"/);
  assert.match(htmlSource, /id="btn-toggle-runtime-dock"/);
  assert.match(uiSource, /function bindRuntimeDockResize/);
  assert.match(uiSource, /localStorage\.setItem\("vinegraph.runtimeDockHeight"/);
  assert.match(cssSource, /#runtime-dock-resize-handle/);
});

test("terminal stores timestamped stream entries instead of only stdout stderr blobs", () => {
  assert.match(uiSource, /let terminalEntries\s*=\s*\[\]/);
  assert.match(uiSource, /function appendTerminalEntry/);
  assert.match(uiSource, /function renderTerminalEntries/);
  assert.match(uiSource, /terminal-follow/);
  assert.match(uiSource, /terminal-search/);
  assert.match(uiSource, /terminal-node-filter/);
});
```

- [ ] **Step 2: Run failing terminal dock tests**

Run:

```bash
npm test -- tests/ui-terminal-dock.test.ts
```

Expected: FAIL until dock resize and terminal entry model exist.

- [ ] **Step 3: Add dock resize HTML**

Modify runtime dock in `src/ui/index.html`:

```html
<section id="runtime-dock">
  <div id="runtime-dock-resize-handle" aria-label="Resize runtime dock"></div>
  <div class="dock-header">
    <div class="run-meta">
      <span>Runtime Output</span>
      <span id="run-id-chip" class="run-chip">No run</span>
      <span id="bar-duration"></span>
    </div>
    <button id="btn-toggle-runtime-dock" class="icon-button small" type="button">⌄</button>
  </div>
  <div class="terminal-toolbar">
    <input id="terminal-search" type="search" placeholder="Search output">
    <select id="terminal-node-filter"><option value="all">All nodes</option></select>
    <label><input id="terminal-follow" type="checkbox" checked> Follow</label>
    <button id="btn-copy-terminal" class="toolbar-button" type="button">Copy</button>
    <button id="btn-clear-terminal-view" class="toolbar-button" type="button">Clear View</button>
  </div>
  <!-- keep existing dock tabs and panes below -->
</section>
```

- [ ] **Step 4: Add terminal entry state**

Modify `src/ui/app.js`:

```js
let terminalEntries = [];
let terminalViewClearedAt = 0;

function appendTerminalEntry(data) {
  terminalEntries.push({
    activationId: data.activationId,
    nodeId: data.nodeId,
    backend: data.backend,
    stream: data.stream === "stderr" ? "stderr" : "stdout",
    chunk: data.chunk || "",
    timestamp: data.timestamp || Date.now(),
  });
  renderTerminalEntries();
}

function renderTerminalEntries() {
  const search = ($("#terminal-search")?.value || "").toLowerCase();
  const nodeFilter = $("#terminal-node-filter")?.value || "all";
  const visible = terminalEntries.filter((entry, index) => {
    if (index < terminalViewClearedAt) return false;
    if (nodeFilter !== "all" && entry.nodeId !== nodeFilter) return false;
    if (search && !entry.chunk.toLowerCase().includes(search)) return false;
    return true;
  });
  domTerminal.innerHTML = `<div class="terminal-lines">${visible.map(renderTerminalLine).join("")}</div>`;
  if ($("#terminal-follow")?.checked) {
    domTerminal.scrollTop = domTerminal.scrollHeight;
  }
}

function renderTerminalLine(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  return `<div class="terminal-line ${escapeAttr(entry.stream)}">
    <span class="terminal-time">${escapeHtml(time)}</span>
    <span class="terminal-node">${escapeHtml(entry.nodeId || "unknown")}</span>
    <span class="terminal-stream-name">${escapeHtml(entry.stream)}</span>
    <span class="terminal-text">${ansiToHtml(entry.chunk)}</span>
  </div>`;
}

function ansiToHtml(text) {
  return escapeHtml(text)
    .replace(/\u001b\[31m/g, '<span class="ansi-red">')
    .replace(/\u001b\[32m/g, '<span class="ansi-green">')
    .replace(/\u001b\[33m/g, '<span class="ansi-amber">')
    .replace(/\u001b\[34m/g, '<span class="ansi-blue">')
    .replace(/\u001b\[0m/g, "</span>");
}
```

Update `appendActivationOutput(data)` so it calls:

```js
appendTerminalEntry(data);
```

- [ ] **Step 5: Add dock resize behavior**

Add to `src/ui/app.js`:

```js
function bindRuntimeDockResize() {
  const dock = $("#runtime-dock");
  const handle = $("#runtime-dock-resize-handle");
  const saved = localStorage.getItem("vinegraph.runtimeDockHeight");
  if (saved) dock.style.height = `${Number(saved)}px`;
  let resizing = false;
  handle?.addEventListener("pointerdown", (event) => {
    resizing = true;
    handle.setPointerCapture?.(event.pointerId);
  });
  window.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    const next = Math.min(520, Math.max(180, window.innerHeight - event.clientY - 36));
    dock.style.height = `${next}px`;
    localStorage.setItem("vinegraph.runtimeDockHeight", String(next));
  });
  window.addEventListener("pointerup", () => {
    resizing = false;
  });
  $("#btn-toggle-runtime-dock")?.addEventListener("click", () => {
    dock.classList.toggle("is-collapsed");
  });
}
```

Call `bindRuntimeDockResize()` in `init()`.

- [ ] **Step 6: Add terminal and resize CSS**

Add to `src/ui/style.css`:

```css
#runtime-dock {
  height: 280px;
  min-height: 180px;
  max-height: 520px;
}

#runtime-dock.is-collapsed {
  height: 42px !important;
}

#runtime-dock-resize-handle {
  height: 6px;
  cursor: ns-resize;
  background: linear-gradient(to bottom, transparent, rgba(116, 140, 170, 0.22));
}

.terminal-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: rgba(8, 18, 30, 0.88);
}

.terminal-toolbar input,
.terminal-toolbar select {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-strong);
  color: var(--text);
  padding: 6px 8px;
}

.terminal-lines {
  display: grid;
  align-content: start;
  min-height: 100%;
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 12px;
}

.terminal-line {
  display: grid;
  grid-template-columns: 82px 180px 58px minmax(0, 1fr);
  gap: 8px;
  padding: 2px 10px;
  border-bottom: 1px solid rgba(116, 140, 170, 0.08);
}

.terminal-line.stderr .terminal-text {
  color: #ff9a9a;
}

.terminal-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ansi-red { color: var(--red); }
.ansi-green { color: var(--green); }
.ansi-amber { color: var(--amber); }
.ansi-blue { color: var(--blue); }
```

- [ ] **Step 7: Verify terminal dock tests pass**

Run:

```bash
npm test -- tests/ui-terminal-dock.test.ts tests/ui-run-control.test.ts
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/index.html src/ui/app.js src/ui/style.css tests/ui-terminal-dock.test.ts tests/ui-run-control.test.ts
git commit -m "feat: improve runtime terminal dock"
```

---

### Task 9: Integration, Visual Verification, And Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/self-iteration.md`
- Modify: `docs/ui-reference.md`
- Optional create: `examples/project-task-loop.vg.yaml`
- Test: existing test suite

- [ ] **Step 1: Add `.vg.yaml` example asset**

Copy the current project loop graph content into `examples/project-task-loop.vg.yaml` and keep `examples/project-task-loop.yaml` for legacy CLI compatibility during migration.

Run:

```bash
cp examples/project-task-loop.yaml examples/project-task-loop.vg.yaml
```

Expected: `examples/project-task-loop.vg.yaml` exists and has the same graph id as the legacy file.

- [ ] **Step 2: Update docs for M1 usage**

Modify `README.md` and `docs/self-iteration.md` so they say:

```md
VineGraph graph assets use `.vg.yaml` / `.vg.yml` in the product workbench.
Legacy `.yaml` examples can still be run from the CLI or imported into graph assets.
The product UI opens a project directory, discovers graph assets in the repo explorer,
and runs graphs against the selected workspace target shown in the bottom status bar.
```

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 4: Start local UI**

Run:

```bash
npm start -- --serve --port 3456
```

Expected: server prints `AgentGraph UI available at http://localhost:3456`.

- [ ] **Step 5: Browser visual verification**

Open `http://localhost:3456` in the Browser tool and verify:

- Dark theme screenshot shows repo explorer, graph asset list, auto-layout canvas, editable inspector, runtime dock, and workspace bar.
- Light theme screenshot shows the same structure.
- Runtime dock can be resized.
- Bottom status bar remains visible.

- [ ] **Step 6: Stop local UI**

Stop the server process that was started in Step 4.

Expected: no long-running server session remains.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/self-iteration.md docs/ui-reference.md examples/project-task-loop.vg.yaml
git commit -m "docs: document M1 workbench workflow"
```

---

## Final Verification

After all tasks are complete, run:

```bash
npm test
npm run typecheck
```

Then start the app:

```bash
npm start -- --serve --port 3456
```

Manual acceptance checklist:

- Open a non-git local directory as a project and see limited capability state.
- Open a git local directory as a project and see branch/dirty/workspace state.
- See `.vg.yaml` graph assets in the repo explorer.
- Double-click a graph asset and see the real graph render on canvas.
- Edit a Codex node model and prompt in the inspector.
- Save the graph asset and see the saved state.
- Select a workspace target from the bottom bar.
- Run the graph.
- Watch stdout/stderr stream into the terminal.
- See timeline and controller decision tabs.
- See git diff and changed files when the selected workspace is a git workspace.
- Resize and collapse the runtime dock.
- Switch between dark, light, and system theme modes.

Stop the server after verification.

## Plan Self-Review

Spec coverage:

- Project directory support is covered by Tasks 2, 4, and 5.
- Non-git capability downgrade is covered by Tasks 2, 3, and 4.
- `.vg.yaml` graph assets are covered by Tasks 2, 4, 5, and 9.
- App config and API key storage are covered by Tasks 1, 4, and 7.
- Explicit workspace target and selected cwd are covered by Tasks 3, 4, and 5.
- Automatic graph layout is covered by Task 5.
- Editable inspector save is covered by Task 6.
- Resizable runtime dock and output terminal are covered by Task 8.
- Light/dark/system theme support is covered by Task 7.
- Visual verification is covered by Task 9.

No planned task implements cloud, collaboration, interactive PTY, commit/push/PR helpers, or manual graph canvas authoring.
