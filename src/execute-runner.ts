import { spawn } from "node:child_process";
import { resolveCliPath } from "./cli-path.js";
import { render } from "./template.js";
import type {
  Backend,
  ExecuteRunOptions,
  ExecuteNode,
  RawExecutionResult,
  TemplateContext,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

// ─── CLI path resolution ──────────────────────────────────────────

function getCodexPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  return resolveCliPath("codex", "AGENTGRAPH_CODEX_PATH", [
    ...(localAppData
      ? [`${localAppData}/OpenAI/Codex/bin/codex.exe`]
      : []),
    ...(userProfile
      ? [`${userProfile}/AppData/Roaming/npm/codex.cmd`]
      : []),
    ...(process.env.HOME
      ? [`${process.env.HOME}/AppData/Roaming/npm/codex.cmd`]
      : []),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ]);
}

function getClaudePath(): string {
  const userProfile = process.env.USERPROFILE;
  return resolveCliPath("claude", "AGENTGRAPH_CLAUDE_PATH", [
    ...(userProfile
      ? [`${userProfile}/AppData/Roaming/npm/claude.cmd`]
      : []),
    ...(process.env.HOME
      ? [`${process.env.HOME}/AppData/Roaming/npm/claude.cmd`]
      : []),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]);
}

// ─── Command builder ───────────────────────────────────────────────

function buildCommand(program: string, args: string[]): string {
  const quotedProgram = program.includes(" ") ? `"${program}"` : program;
  const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a));
  return `${quotedProgram} ${quoted.join(" ")}`;
}

export function renderExecutePrompt(
  node: ExecuteNode,
  context: TemplateContext
): string | undefined {
  if (node.promptTemplate) return render(node.promptTemplate, context);
  if (node.backend === "codex" || node.backend === "claude") {
    return "Complete the task.";
  }
  return undefined;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
    });
    killer.on("error", () => {});
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

function spawnCommand(
  cmdStr: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    backend: Backend;
    signal?: AbortSignal;
    onOutput?: ExecuteRunOptions["onOutput"];
  }
): Promise<SpawnResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({
      stdout: "",
      stderr: "Cancelled before command started",
      exitCode: -1,
      aborted: true,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmdStr, [], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      killProcessTree(child.pid);
    };

    opts.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      opts.onOutput?.({
        backend: opts.backend,
        stream: "stdout",
        chunk,
      });
    });

    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      opts.onOutput?.({
        backend: opts.backend,
        stream: "stderr",
        chunk,
      });
    });

    child.on("close", (exitCode: number | null) => {
      opts.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: (stderr + (aborted ? "\nCancelled" : "")).trimEnd(),
        exitCode: aborted ? -1 : exitCode ?? -1,
        aborted,
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener("abort", abort);
      if (aborted) {
        resolve({
          stdout: stdout.trimEnd(),
          stderr: (stderr + "\nCancelled").trimEnd(),
          exitCode: -1,
          aborted: true,
        });
        return;
      }
      reject(err);
    });
  });
}

function spawnProcess(
  program: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    backend: Backend;
    signal?: AbortSignal;
    input?: string;
    onOutput?: ExecuteRunOptions["onOutput"];
  }
): Promise<SpawnResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({
      stdout: "",
      stderr: "Cancelled before command started",
      exitCode: -1,
      aborted: true,
    });
  }

  return new Promise((resolve, reject) => {
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(program);
    const command = needsShell ? buildCommand(program, args) : program;
    const commandArgs = needsShell ? [] : args;
    const child = spawn(command, commandArgs, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      shell: needsShell,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const abort = () => {
      aborted = true;
      killProcessTree(child.pid);
    };

    opts.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      opts.onOutput?.({
        backend: opts.backend,
        stream: "stdout",
        chunk,
      });
    });

    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      opts.onOutput?.({
        backend: opts.backend,
        stream: "stderr",
        chunk,
      });
    });

    child.on("close", (exitCode: number | null) => {
      opts.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: (stderr + (aborted ? "\nCancelled" : "")).trimEnd(),
        exitCode: aborted ? -1 : exitCode ?? -1,
        aborted,
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener("abort", abort);
      if (aborted) {
        resolve({
          stdout: stdout.trimEnd(),
          stderr: (stderr + "\nCancelled").trimEnd(),
          exitCode: -1,
          aborted: true,
        });
        return;
      }
      reject(err);
    });

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

// ─── Execute Runner ────────────────────────────────────────────────

export class ExecuteRunner {
  static async run(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext,
    options: ExecuteRunOptions = {}
  ): Promise<RawExecutionResult> {
    switch (node.backend) {
      case "internal":
        return ExecuteRunner.runInternal(node, activationId);
      case "shell":
        return ExecuteRunner.runShell(node, activationId, cwd, context, options);
      case "git":
        return ExecuteRunner.runGit(node, activationId, cwd, context, options);
      case "codex":
        return ExecuteRunner.runCodex(node, activationId, cwd, context, options);
      case "claude":
        return ExecuteRunner.runClaude(node, activationId, cwd, context, options);
      default:
        throw new Error(`Unknown backend: ${node.backend}`);
    }
  }

  static async runShell(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext,
    options: ExecuteRunOptions
  ): Promise<RawExecutionResult> {
    const command = node.command;
    if (!command) {
      throw new Error(`Shell node "${node.id}" has no command configured`);
    }

    const timeoutMs = node.execution?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    const renderedArgs = command.args.map((a) => render(a, context));
    const cmdStr = buildCommand(command.program, renderedArgs);

    try {
      const result = await spawnCommand(cmdStr, {
        cwd: command.cwd ? render(command.cwd, context) : cwd,
        timeoutMs,
        backend: "shell",
        signal: options.signal,
        onOutput: options.onOutput,
      });

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "shell",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        aborted: result.aborted,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    } catch (err) {
      const finishedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      return {
        activationId,
        nodeId: node.id,
        backend: "shell",
        stdout: "",
        stderr: `Failed to execute: ${msg}`,
        exitCode: -1,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    }
  }

  static async runGit(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext,
    options: ExecuteRunOptions
  ): Promise<RawExecutionResult> {
    const command = node.command;
    if (!command) {
      throw new Error(`Git node "${node.id}" has no command configured`);
    }

    const timeoutMs = node.execution?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    const renderedArgs = command.args.map((a) => render(a, context));
    const cmdStr = buildCommand(command.program, renderedArgs);

    try {
      const result = await spawnCommand(cmdStr, {
        cwd: command.cwd ? render(command.cwd, context) : cwd,
        timeoutMs,
        backend: "git",
        signal: options.signal,
        onOutput: options.onOutput,
      });

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "git",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        aborted: result.aborted,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    } catch (err) {
      const finishedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      return {
        activationId,
        nodeId: node.id,
        backend: "git",
        stdout: "",
        stderr: `git CLI error: ${msg}`,
        exitCode: -1,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    }
  }

  static async runCodex(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext,
    options: ExecuteRunOptions
  ): Promise<RawExecutionResult> {
    const prompt = renderExecutePrompt(node, context) ?? "Complete the task.";

    const codexPath = getCodexPath();
    const timeoutMs = node.execution?.timeoutMs ?? 600_000;
    const startedAt = Date.now();
    const model = node.execution?.model ?? process.env.AGENTGRAPH_CODEX_MODEL;
    const reasoningEffort =
      node.execution?.reasoningEffort ??
      process.env.AGENTGRAPH_CODEX_REASONING_EFFORT;
    const sandbox =
      node.execution?.workspaceAccess === "read"
        ? "read-only"
        : node.execution?.workspaceAccess === "write"
          ? "workspace-write"
          : undefined;

    const args = ["exec"];
    if (model) {
      args.push("-m", model);
    }
    if (reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (sandbox) {
      args.push("--sandbox", sandbox);
    }
    args.push("--ephemeral", "--skip-git-repo-check", "-");

    try {
      const result = await spawnProcess(codexPath, args, {
        cwd,
        timeoutMs,
        backend: "codex",
        input: prompt,
        signal: options.signal,
        onOutput: options.onOutput,
      });

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "codex",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        aborted: result.aborted,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    } catch (err) {
      const finishedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      return {
        activationId,
        nodeId: node.id,
        backend: "codex",
        stdout: "",
        stderr: `codex CLI error: ${msg}. Install Codex CLI or set AGENTGRAPH_CODEX_PATH.`,
        exitCode: -1,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    }
  }

  static async runClaude(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext,
    options: ExecuteRunOptions
  ): Promise<RawExecutionResult> {
    const prompt = renderExecutePrompt(node, context) ?? "Complete the task.";

    const claudePath = getClaudePath();
    const timeoutMs = node.execution?.timeoutMs ?? 600_000;
    const startedAt = Date.now();

    const args = [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--no-session-persistence",
      "--permission-mode",
      "bypassPermissions",
      "--max-budget-usd",
      "10",
    ];

    try {
      const result = await spawnProcess(claudePath, args, {
        cwd,
        timeoutMs,
        backend: "claude",
        signal: options.signal,
        onOutput: options.onOutput,
      });

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "claude",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        aborted: result.aborted,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    } catch (err) {
      const finishedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      return {
        activationId,
        nodeId: node.id,
        backend: "claude",
        stdout: "",
        stderr: `claude CLI error: ${msg}. Install with: npm install -g @anthropic-ai/claude-code`,
        exitCode: -1,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    }
  }

  static async runInternal(
    node: ExecuteNode,
    activationId: string
  ): Promise<RawExecutionResult> {
    const startedAt = Date.now();
    return {
      activationId,
      nodeId: node.id,
      backend: "internal",
      stdout: `internal action: ${node.command?.args.join(" ") ?? "noop"}`,
      stderr: "",
      exitCode: 0,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
    };
  }
}
