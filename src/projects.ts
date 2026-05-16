import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  ProjectCapabilities,
  ProjectDetails,
  ProjectKind,
  ProjectRecord,
} from "./product-types.js";

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
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolveCommand({ stdout, stderr, exitCode: -1 }));
    child.on("close", (code: number | null) =>
      resolveCommand({ stdout, stderr, exitCode: code ?? -1 })
    );
  });
}
