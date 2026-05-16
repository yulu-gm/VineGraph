import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GraphLoader } from "./graph-loader.js";
import type { ReadinessCheck, ReadinessResult } from "./types.js";

export interface ReadinessOptions {
  graphPath: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  commandExists?: (program: string) => boolean;
}

function defaultCommandExists(program: string): boolean {
  const result = spawnSync(program, ["--version"], {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function pass(id: string, label: string, message: string): ReadinessCheck {
  return { id, label, status: "pass", message };
}

function fail(id: string, label: string, message: string): ReadinessCheck {
  return { id, label, status: "fail", message };
}

function runGitCheck(args: string[], cwd: string): boolean {
  const result = spawnSync("git", args, {
    cwd,
    shell: false,
    stdio: "ignore",
  });
  return result.status === 0;
}

export async function checkSelfIterationReadiness(
  options: ReadinessOptions
): Promise<ReadinessResult> {
  const env = options.env ?? process.env;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const graphPath = resolve(options.graphPath);
  const checks: ReadinessCheck[] = [];

  const graph = GraphLoader.load(graphPath);
  checks.push(pass("graph_load", "Graph loads", `Loaded ${graph.id}`));

  if (graph.runtime?.workspace?.mode === "worktree") {
    checks.push(pass("workspace_mode", "Workspace mode", "Graph uses worktree mode"));
  } else {
    checks.push(
      fail("workspace_mode", "Workspace mode", "Graph must use runtime.workspace.mode = worktree")
    );
  }

  if (runGitCheck(["rev-parse", "--git-dir"], options.projectRoot)) {
    checks.push(pass("git_repo", "Git repository", "Project root is a Git repository"));
  } else {
    checks.push(fail("git_repo", "Git repository", "Project root is not a Git repository"));
  }

  if (runGitCheck(["worktree", "list"], options.projectRoot)) {
    checks.push(pass("git_worktree", "Git worktree", "git worktree is available"));
  } else {
    checks.push(fail("git_worktree", "Git worktree", "git worktree list failed"));
  }

  const codexPath = env.AGENTGRAPH_CODEX_PATH;
  if (
    (codexPath && existsSync(codexPath)) ||
    commandExists("codex.cmd") ||
    commandExists("codex")
  ) {
    checks.push(pass("codex_cli", "Codex CLI", "Codex CLI is available"));
  } else {
    checks.push(fail("codex_cli", "Codex CLI", "Install Codex CLI or set AGENTGRAPH_CODEX_PATH"));
  }

  if (env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY) {
    checks.push(pass("controller_key", "Controller API key", "Controller API key is configured"));
  } else {
    checks.push(
      fail(
        "controller_key",
        "Controller API key",
        "Set DEEPSEEK_API_KEY or OPENAI_API_KEY before running controller nodes"
      )
    );
  }

  return {
    ok: checks.every((item) => item.status === "pass"),
    graphPath,
    checks,
  };
}
