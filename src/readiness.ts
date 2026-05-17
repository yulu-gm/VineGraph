import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { cliProbeCandidates } from "./cli-path.js";
import { GraphLoader } from "./graph-loader.js";
import type { ReadinessCheck, ReadinessResult } from "./types.js";

export interface ReadinessOptions {
  graphPath: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  commandExists?: (program: string, timeoutMs?: number) => boolean;
  commandTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

function defaultCommandExists(program: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): boolean {
  const result = spawnSync(program, ["--version"], {
    shell: shouldProbeCommandWithShell(program),
    stdio: "ignore",
    timeout: timeoutMs,
  });
  return result.status === 0;
}

function shouldProbeCommandWithShell(program: string): boolean {
  if (process.platform !== "win32") return false;
  if (/[\\/]/.test(program) && /\.exe$/i.test(program)) return false;
  return true;
}

function pass(id: string, label: string, message: string): ReadinessCheck {
  return { id, label, status: "pass", message };
}

function fail(id: string, label: string, message: string): ReadinessCheck {
  return { id, label, status: "fail", message };
}

function runGitCheck(args: string[], cwd: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): boolean {
  const result = spawnSync("git", args, {
    cwd,
    shell: false,
    stdio: "ignore",
    timeout: timeoutMs,
  });
  return result.status === 0;
}

function cliAvailable(
  name: string,
  envVar: string,
  knownPaths: string[],
  env: NodeJS.ProcessEnv,
  commandExists: (program: string, timeoutMs?: number) => boolean,
  timeoutMs: number
): boolean {
  return cliProbeCandidates(name, envVar, knownPaths, env)
    .some((program) => commandExists(program, timeoutMs));
}

function codexKnownPaths(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(env.LOCALAPPDATA
      ? [`${env.LOCALAPPDATA}/OpenAI/Codex/bin/codex.exe`]
      : []),
    ...(env.USERPROFILE
      ? [`${env.USERPROFILE}/AppData/Roaming/npm/codex.cmd`]
      : []),
    ...(env.HOME
      ? [`${env.HOME}/AppData/Roaming/npm/codex.cmd`]
      : []),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
}

function claudeKnownPaths(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(env.USERPROFILE
      ? [`${env.USERPROFILE}/AppData/Roaming/npm/claude.cmd`]
      : []),
    ...(env.HOME
      ? [`${env.HOME}/AppData/Roaming/npm/claude.cmd`]
      : []),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

export async function checkSelfIterationReadiness(
  options: ReadinessOptions
): Promise<ReadinessResult> {
  const env = options.env ?? process.env;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const graphPath = resolve(options.graphPath);
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const checks: ReadinessCheck[] = [];

  try {
    const graph = GraphLoader.load(graphPath);
    checks.push(pass("graph_load", "Graph loads", `Loaded ${graph.id}`));

    if (graph.runtime?.workspace?.mode === "worktree") {
      checks.push(pass("workspace_mode", "Workspace mode", "Graph uses worktree mode"));
    } else {
      checks.push(
        fail("workspace_mode", "Workspace mode", "Graph must use runtime.workspace.mode = worktree")
      );
    }
  } catch (err) {
    checks.push(
      fail("graph_load", "Graph loads", err instanceof Error ? err.message : String(err))
    );
  }

  if (runGitCheck(["rev-parse", "--git-dir"], options.projectRoot, commandTimeoutMs)) {
    checks.push(pass("git_repo", "Git repository", "Project root is a Git repository"));
  } else {
    checks.push(fail("git_repo", "Git repository", "Project root is not a Git repository"));
  }

  if (runGitCheck(["worktree", "list"], options.projectRoot, commandTimeoutMs)) {
    checks.push(pass("git_worktree", "Git worktree", "git worktree is available"));
  } else {
    checks.push(fail("git_worktree", "Git worktree", "git worktree list failed"));
  }

  if (cliAvailable("codex", "AGENTGRAPH_CODEX_PATH", codexKnownPaths(env), env, commandExists, commandTimeoutMs)) {
    checks.push(pass("codex_cli", "Codex CLI", "Codex CLI is available"));
  } else {
    checks.push(fail("codex_cli", "Codex CLI", "Install Codex CLI or set AGENTGRAPH_CODEX_PATH"));
  }

  if (cliAvailable("claude", "AGENTGRAPH_CLAUDE_PATH", claudeKnownPaths(env), env, commandExists, commandTimeoutMs)) {
    checks.push(pass("claude_cli", "Claude CLI", "Claude CLI is available"));
  } else {
    checks.push(fail("claude_cli", "Claude CLI", "Install Claude CLI or set AGENTGRAPH_CLAUDE_PATH"));
  }

  checks.push(
    pass(
      "terminal_fallback",
      "Terminal fallback",
      "Node terminal fallback is available; Tauri terminal invoke is optional in browser/dev mode"
    )
  );

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
