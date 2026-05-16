import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeConfig, WorkspaceInfo, WorkspaceMode } from "./types.js";

const WORKTREES_DIR = ".agentgraph/worktrees";
const PATCHES_DIR = ".agentgraph/patches";

function buildGitCmd(args: string[]): string {
  const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a));
  return `git ${quoted.join(" ")}`;
}

function runGit(
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(buildGitCmd(args), [], {
      cwd: cwd ?? process.cwd(),
      shell: true,
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
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? -1,
      });
    });

    child.on("error", () => {
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

export class WorkspaceManager {
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

    if (untrackedFiles.length > 0) {
      await runGit(["add", "-N", "--", ...untrackedFiles], ws.path);
    }

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
