import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type {
  ProjectDetails,
  WorkspaceTarget,
} from "./product-types.js";

const WORKTREES_DIR = ".agentgraph/worktrees";

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitWorktree {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    const child = spawn("git", args, {
      cwd,
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
      resolveResult({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? -1,
      });
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolveResult({
        stdout: stdout.trimEnd(),
        stderr: (stderr + "\ngit: command not found").trimEnd(),
        exitCode: -1,
      });
    });
  });
}

function isGitCapable(project: ProjectDetails): boolean {
  return project.kind === "git" && project.capabilities.git;
}

function normalizePath(path: string): string {
  const normalized = existsSync(path) ? realpathSync.native(path) : resolve(path);
  return normalized.replace(/\\/g, "/");
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left).toLowerCase() === normalizePath(right).toLowerCase();
}

function displayPathFromProjectRoot(path: string, projectRoot: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(projectRoot);
  const comparablePath = normalizedPath.toLowerCase();
  const comparableRoot = normalizedRoot.toLowerCase();

  if (
    comparablePath === comparableRoot ||
    comparablePath.startsWith(`${comparableRoot}/`)
  ) {
    return resolve(projectRoot, relative(normalizedRoot, normalizedPath));
  }

  return path;
}

function parseBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function parseWorktreeList(stdout: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> | null = null;

  function pushCurrent(): void {
    if (!current?.path) return;
    worktrees.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
      detached: current.detached ?? false,
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
      current.branch = parseBranch(value);
      current.detached = false;
    } else if (key === "detached") {
      current.branch = null;
      current.detached = true;
    }
  }

  pushCurrent();
  return worktrees;
}

function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function workspaceSlug(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.includes("..") ||
    /[\\/\x00-\x1f]/.test(trimmed)
  ) {
    throw new Error("Invalid workspace target name");
  }

  const slug = slugifyName(trimmed);
  if (!slug) {
    throw new Error("Invalid workspace target name");
  }
  return slug;
}

async function currentBranch(projectRoot: string): Promise<string | null> {
  const result = await runGit(["branch", "--show-current"], projectRoot);
  if (result.exitCode !== 0) return null;
  return result.stdout || null;
}

async function isDirty(projectRoot: string): Promise<boolean> {
  const result = await runGit(["status", "--porcelain"], projectRoot);
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

function directoryTarget(project: ProjectDetails): WorkspaceTarget {
  return {
    id: "directory",
    kind: "directory",
    label: "Project directory",
    path: project.rootPath,
    current: true,
  };
}

function worktreeTarget(worktree: GitWorktree, projectRoot: string): WorkspaceTarget {
  const displayPath = displayPathFromProjectRoot(worktree.path, projectRoot);
  const slug = basename(displayPath);
  return {
    id: `worktree:${slug}`,
    kind: "worktree",
    label: slug,
    path: displayPath,
    branch: worktree.branch,
    detached: worktree.detached,
    current: samePath(worktree.path, projectRoot),
  };
}

export async function listWorkspaceTargets(
  project: ProjectDetails
): Promise<WorkspaceTarget[]> {
  if (!isGitCapable(project)) {
    return [directoryTarget(project)];
  }

  const projectRoot = resolve(project.rootPath);
  const worktreeResult = await runGit(
    ["worktree", "list", "--porcelain"],
    projectRoot
  );
  if (worktreeResult.exitCode !== 0) {
    throw new Error(
      `Failed to list git worktrees:\n  ${worktreeResult.stderr || worktreeResult.stdout}`
    );
  }

  const mainTarget: WorkspaceTarget = {
    id: "main",
    kind: "main",
    label: "Main working tree",
    path: project.rootPath,
    branch: project.branch ?? (await currentBranch(projectRoot)),
    dirty: project.dirty ?? (await isDirty(projectRoot)),
    current: true,
  };

  const worktreeTargets = parseWorktreeList(worktreeResult.stdout)
    .filter((worktree) => !samePath(worktree.path, projectRoot))
    .map((worktree) => worktreeTarget(worktree, projectRoot));

  return [mainTarget, ...worktreeTargets];
}

export async function createWorkspaceTarget(
  project: ProjectDetails,
  name: string
): Promise<WorkspaceTarget> {
  if (!isGitCapable(project) || !project.capabilities.worktrees) {
    throw new Error("Creating workspace targets requires a git project");
  }

  const projectRoot = resolve(project.rootPath);
  const slug = workspaceSlug(name);
  const worktreesDir = resolve(projectRoot, WORKTREES_DIR);
  const worktreePath = resolve(worktreesDir, slug);

  mkdirSync(worktreesDir, { recursive: true });
  if (existsSync(worktreePath)) {
    throw new Error(`Workspace target already exists at ${worktreePath}`);
  }

  const result = await runGit(
    ["worktree", "add", "--detach", worktreePath, "HEAD"],
    projectRoot
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create git worktree:\n  ${result.stderr || result.stdout}`
    );
  }

  const worktreeResult = await runGit(
    ["worktree", "list", "--porcelain"],
    projectRoot
  );
  if (worktreeResult.exitCode !== 0) {
    throw new Error(
      `Failed to list git worktrees:\n  ${worktreeResult.stderr || worktreeResult.stdout}`
    );
  }

  const created = parseWorktreeList(worktreeResult.stdout).find((worktree) =>
    samePath(worktree.path, worktreePath)
  );
  if (!created) {
    throw new Error("Created workspace target was not found in git worktree list");
  }

  return worktreeTarget(created, projectRoot);
}
