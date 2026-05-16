import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  RuntimeConfig,
  WorkspaceInfo,
  WorkspaceMode,
  WorktreeListItem,
} from "./types.js";

const WORKTREES_DIR = ".agentgraph/worktrees";
const PATCHES_DIR = ".agentgraph/patches";

export class WorktreeConflictError extends Error {
  constructor(path: string) {
    super(`Worktree already exists at ${path}`);
    this.name = "WorktreeConflictError";
  }
}

function runGit(
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("git", args, {
      cwd: cwd ?? process.cwd(),
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? -1,
      });
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({
        stdout: stdout.trimEnd(),
        stderr: (stderr + "\ngit: command not found").trimEnd(),
        exitCode: -1,
      });
    });
  });
}

function isGitRepo(dir: string): Promise<boolean> {
  return runGit(["rev-parse", "--git-dir"], dir).then(
    (r) => r.exitCode === 0
  );
}

function normalizeGitPath(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

function parseGitPathList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map(normalizeGitPath)
    .filter(Boolean);
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files)];
}

function normalizeWorktreePath(path: string): string {
  const normalized = existsSync(path) ? realpathSync.native(path) : resolve(path);
  return normalized.replace(/\\/g, "/").toLowerCase();
}

function parseWorktreeBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function parseWorktreePorcelain(
  stdout: string,
  repoRoot: string
): WorktreeListItem[] {
  const items: WorktreeListItem[] = [];
  let current: Partial<WorktreeListItem> | null = null;
  const normalizedRepoRoot = normalizeWorktreePath(repoRoot);

  function pushCurrent(): void {
    if (!current?.path) return;
    items.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      current: normalizeWorktreePath(current.path) === normalizedRepoRoot,
    });
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      pushCurrent();
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");

    if (key === "worktree") {
      pushCurrent();
      current = { path: value, branch: null, detached: false };
      continue;
    }

    if (!current) continue;

    if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = parseWorktreeBranch(value);
      current.detached = false;
    } else if (key === "detached") {
      current.branch = null;
      current.detached = true;
    }
  }

  pushCurrent();
  return items;
}

function slugifyWorktreeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function manualWorktreeSlug(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.includes("..") ||
    /[\\/:*?"<>|\x00-\x1f]/.test(trimmed)
  ) {
    throw new Error("Invalid worktree name");
  }

  const slug = slugifyWorktreeName(trimmed);
  if (!slug) {
    throw new Error("Invalid worktree name");
  }
  return slug;
}

async function markUntrackedIntentToAdd(
  cwd: string,
  files: string[]
): Promise<void> {
  if (files.length === 0) return;

  const result = await runGit(["add", "-N", "--", ...files], cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to mark untracked files as intent-to-add:\n` +
        `  ${result.stderr || result.stdout}`
    );
  }
}

export class WorkspaceManager {
  static async listWorktrees(repoRoot: string): Promise<WorktreeListItem[]> {
    const result = await runGit(["worktree", "list", "--porcelain"], repoRoot);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to list git worktrees:\n  ${result.stderr || result.stdout}`
      );
    }

    return parseWorktreePorcelain(result.stdout, repoRoot);
  }

  static async createManualWorktree(
    repoRoot: string,
    name: string,
    ref = "HEAD"
  ): Promise<WorktreeListItem> {
    const slug = manualWorktreeSlug(name);
    const trimmedRef = String(ref || "").trim();
    if (!trimmedRef || trimmedRef.startsWith("-") || /[\x00-\x1f]/.test(trimmedRef)) {
      throw new Error("Invalid worktree ref");
    }

    const worktreesDir = resolve(repoRoot, WORKTREES_DIR);
    mkdirSync(worktreesDir, { recursive: true });

    const worktreePath = resolve(worktreesDir, `manual-${slug}`);
    if (existsSync(worktreePath)) {
      throw new WorktreeConflictError(worktreePath);
    }

    const result = await runGit(
      ["worktree", "add", "--detach", worktreePath, trimmedRef],
      repoRoot
    );

    if (result.exitCode !== 0) {
      const message = result.stderr || result.stdout;
      if (/already exists|is a missing but already registered worktree|already registered/i.test(message)) {
        throw new WorktreeConflictError(worktreePath);
      }
      throw new Error(
        `Failed to create git worktree:\n  ${message}`
      );
    }

    const worktrees = await WorkspaceManager.listWorktrees(repoRoot);
    const created = worktrees.find(
      (item) => normalizeWorktreePath(item.path) === normalizeWorktreePath(worktreePath)
    );
    if (!created) {
      throw new Error("Created worktree was not found in git worktree list");
    }
    return created;
  }

  static async setup(
    config: RuntimeConfig | undefined,
    runId: string,
    repoRoot: string
  ): Promise<WorkspaceInfo> {
    const mode: WorkspaceMode = config?.workspace?.mode ?? "worktree";

    if (mode === "local") {
      return {
        mode: "local",
        path: repoRoot,
      };
    }

    // worktree mode
    // Check that repoRoot is a git repo
    const isRepo = await isGitRepo(repoRoot);
    if (!isRepo) {
      throw new Error(
        `Workspace mode "worktree" requires the project directory to be a git repository.\n` +
          `  Directory: ${repoRoot}\n` +
          `  Either initialize a git repo or use mode: "local" in the graph config.`
      );
    }

    // Ensure worktrees directory exists (in the repo root)
    const worktreesDir = resolve(repoRoot, WORKTREES_DIR);
    mkdirSync(worktreesDir, { recursive: true });

    const worktreePath = join(worktreesDir, runId);

    const result = await runGit(
      ["worktree", "add", "--detach", worktreePath, "HEAD"],
      repoRoot
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create git worktree:\n  ${result.stderr || result.stdout}`
      );
    }

    return {
      mode: "worktree",
      path: worktreePath,
      worktreeName: runId,
    };
  }

  static async captureDiff(
    ws: WorkspaceInfo
  ): Promise<void> {
    const untrackedResult = await runGit(
      ["ls-files", "--others", "--exclude-standard"],
      ws.path
    );
    const untrackedFiles = parseGitPathList(untrackedResult.stdout);

    await markUntrackedIntentToAdd(ws.path, untrackedFiles);

    const diffArgs =
      ws.mode === "worktree" ? ["diff", "HEAD"] : ["diff"];
    const nameArgs =
      ws.mode === "worktree"
        ? ["diff", "--name-only", "HEAD"]
        : ["diff", "--name-only"];

    const diff = await runGit(diffArgs, ws.path);
    ws.diff = diff.stdout;
    const changed = await runGit(nameArgs, ws.path);
    ws.changedFiles = uniqueFiles([
      ...parseGitPathList(changed.stdout),
      ...untrackedFiles,
    ]);

    if (ws.mode === "local" && untrackedFiles.length > 0) {
      await runGit(["reset", "--", ...untrackedFiles], ws.path);
    }
  }

  static async exportPatch(
    ws: WorkspaceInfo,
    runId: string,
    repoRoot: string
  ): Promise<string | null> {
    if (!ws.diff) return null;

    const patchesDir = resolve(repoRoot, PATCHES_DIR);
    mkdirSync(patchesDir, { recursive: true });

    const patchPath = join(patchesDir, `${runId}.patch`);
    writeFileSync(patchPath, ws.diff, "utf-8");
    ws.patchPath = patchPath;
    return patchPath;
  }

  static async cleanup(ws: WorkspaceInfo, repoRoot: string): Promise<void> {
    if (ws.mode !== "worktree" || !ws.worktreeName) return;

    const worktreePath = ws.path;
    await runGit(["worktree", "remove", worktreePath, "--force"], repoRoot);
    await runGit(["worktree", "prune"], repoRoot);
  }
}
