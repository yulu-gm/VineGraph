import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { render } from "./template.js";
import type {
  ExecuteNode,
  RawExecutionResult,
  TemplateContext,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

// ─── CLI path resolution ──────────────────────────────────────────

function resolveCli(
  name: string,
  envVar: string,
  knownPaths: string[]
): string {
  const envPath = process.env[envVar];
  if (envPath && existsSync(envPath)) return envPath;

  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }

  // Fallback: hope it's on PATH
  return name;
}

function getCodexPath(): string {
  return resolveCli("codex.cmd", "AGENTGRAPH_CODEX_PATH", [
    "C:/Users/gsgame/AppData/Roaming/npm/codex.cmd",
    process.env.HOME + "/AppData/Roaming/npm/codex.cmd",
    process.env.USERPROFILE + "/AppData/Roaming/npm/codex.cmd",
  ]);
}

function getClaudePath(): string {
  return resolveCli("claude.cmd", "AGENTGRAPH_CLAUDE_PATH", [
    "C:/Users/gsgame/AppData/Roaming/npm/claude.cmd",
    process.env.HOME + "/AppData/Roaming/npm/claude.cmd",
    process.env.USERPROFILE + "/AppData/Roaming/npm/claude.cmd",
  ]);
}

// ─── Command builder ───────────────────────────────────────────────

function buildCommand(program: string, args: string[]): string {
  const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a));
  return `${program} ${quoted.join(" ")}`;
}

function spawnCommand(
  cmdStr: string,
  opts: { cwd: string; timeoutMs: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmdStr, [], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      process.stdout.write(d);
    });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    child.on("close", (exitCode: number | null) => {
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: exitCode ?? -1,
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(err);
    });
  });
}

// ─── Execute Runner ────────────────────────────────────────────────

export class ExecuteRunner {
  static async run(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext
  ): Promise<RawExecutionResult> {
    switch (node.backend) {
      case "internal":
        return ExecuteRunner.runInternal(node, activationId);
      case "shell":
        return ExecuteRunner.runShell(node, activationId, cwd, context);
      case "codex":
        return ExecuteRunner.runCodex(node, activationId, cwd, context);
      case "claude":
        return ExecuteRunner.runClaude(node, activationId, cwd, context);
      default:
        throw new Error(`Unknown backend: ${node.backend}`);
    }
  }

  static async runShell(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext
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
        cwd: command.cwd ?? cwd,
        timeoutMs,
      });

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "shell",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
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

  static async runCodex(
    node: ExecuteNode,
    activationId: string,
    cwd: string,
    context: TemplateContext
  ): Promise<RawExecutionResult> {
    const prompt = node.promptTemplate
      ? render(node.promptTemplate, context)
      : "Complete the task.";

    const codexPath = getCodexPath();
    const timeoutMs = node.execution?.timeoutMs ?? 600_000;
    const startedAt = Date.now();

    const cmdStr = buildCommand(codexPath, [
      "exec",
      prompt,
      "--ephemeral",
      "--skip-git-repo-check",
    ]);

    try {
      const result = await spawnCommand(cmdStr, {
        cwd,
        timeoutMs,
      });

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "codex",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
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
        stderr: `codex CLI error: ${msg}. Install with: npm install -g @anthropic-ai/codex`,
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
    context: TemplateContext
  ): Promise<RawExecutionResult> {
    const prompt = node.promptTemplate
      ? render(node.promptTemplate, context)
      : "Complete the task.";

    const claudePath = getClaudePath();
    const timeoutMs = node.execution?.timeoutMs ?? 600_000;
    const startedAt = Date.now();

    const cmdStr = buildCommand(claudePath, [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--no-session-persistence",
      "--permission-mode",
      "bypassPermissions",
      "--max-budget-usd",
      "10",
    ]);

    try {
      const result = await spawnCommand(cmdStr, {
        cwd,
        timeoutMs,
      });

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "claude",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
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
