import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  ProjectCapabilities,
  ProjectDetails,
  ProjectKind,
  ProjectRecord,
} from "./product-types.js";

export function openProjectDirectory(
  rootPath: string,
  now = Date.now()
): ProjectDetails {
  const resolved = resolve(rootPath);
  if (!existsSync(resolved)) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolved}`);
  }

  const git = isGitRepo(resolved);
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
    branch: gitOutput(["branch", "--show-current"], resolved),
    dirty: Boolean(gitOutput(["status", "--porcelain"], resolved)),
  };
}

export function projectIdForPath(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
}

export function isGitRepo(dir: string): boolean {
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], dir);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export function gitOutput(args: string[], cwd: string): string {
  const result = runCommand("git", args, cwd);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

function runCommand(
  command: string,
  args: string[],
  cwd: string
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}
