import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliPath } from "./cli-path.js";
import { spawnTerminalSession } from "./terminal-session.js";
import { render } from "./template.js";
import type {
  Backend,
  ExecuteRunOptions,
  ExecuteNode,
  RawExecutionResult,
  TemplateContext,
  TerminalSessionHandle,
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
  timedOut?: boolean;
}

interface TerminalCommandResult extends SpawnResult {
  terminalTranscript: string;
  terminalMode: "pty" | "stream";
}

function plainTerminalOutput(value: string): string {
  return takePlainTerminalOutput(value).output;
}

function takePlainTerminalOutput(value: string): {
  output: string;
  pending: string;
} {
  let output = "";

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const code = char.charCodeAt(0);

    if (char === "\u001B" || char === "\u009B") {
      const sequence = consumeControlSequence(value, index);
      if (sequence === null) {
        return { output, pending: value.slice(index) };
      }
      index = sequence;
      continue;
    }

    if (char === "\r") {
      output += "\n";
      if (value[index + 1] === "\n") index++;
      continue;
    }

    if (code >= 0 && code < 32 && char !== "\n" && char !== "\t") {
      continue;
    }

    output += char;
  }

  return { output, pending: "" };
}

function consumeControlSequence(value: string, start: number): number | null {
  const first = value[start];
  if (first === "\u009B") {
    return consumeUntilFinalByte(value, start + 1);
  }

  const next = value[start + 1];
  if (next === undefined) return null;

  if (next === "[") {
    return consumeUntilFinalByte(value, start + 2);
  }

  if (next === "]") {
    for (let index = start + 2; index < value.length; index++) {
      if (value[index] === "\u0007") return index;
      if (value[index] === "\u001B" && value[index + 1] === "\\") {
        return index + 1;
      }
    }
    return null;
  }

  if ("()#%*+-./ ".includes(next)) {
    return value[start + 2] === undefined ? null : start + 2;
  }

  return start + 1;
}

function consumeUntilFinalByte(value: string, start: number): number | null {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return null;
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

function terminalAbortSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  timeout?.unref?.();

  const abort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

async function spawnTerminalCommand(
  program: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    backend: Backend;
    activationId: string;
    nodeId: string;
    signal?: AbortSignal;
    input?: string;
    terminal: NonNullable<ExecuteRunOptions["terminal"]>;
    onOutput?: ExecuteRunOptions["onOutput"];
  }
): Promise<TerminalCommandResult> {
  const cols = opts.terminal.cols ?? 80;
  const rows = opts.terminal.rows ?? 24;
  const abort = terminalAbortSignal(opts.signal, opts.timeoutMs);
  const sessionInfo = {
    runId: opts.terminal.runId,
    activationId: opts.activationId,
    nodeId: opts.nodeId,
  };
  let registeredSession: TerminalSessionHandle | undefined;
  let pendingLegacyOutput = "";

  const emitLegacyOutput = (chunk: string): void => {
    pendingLegacyOutput += chunk;
    const plain = takePlainTerminalOutput(pendingLegacyOutput);
    pendingLegacyOutput = plain.pending;
    if (plain.output) {
      opts.onOutput?.({
        backend: opts.backend,
        stream: "stdout",
        chunk: plain.output,
      });
    }
  };

  opts.terminal.onStart?.({ cols, rows });

  try {
    const result = await spawnTerminalSession({
      program,
      args,
      cwd: opts.cwd,
      cols,
      rows,
      signal: abort.signal,
      onOutput: (chunk) => {
        opts.terminal.onOutput?.(chunk);
        emitLegacyOutput(chunk);
      },
      onSession: (session) => {
        registeredSession = session;
        try {
          opts.terminal.registerSession?.(session, sessionInfo);
        } catch {
          // Terminal registry hooks should not change the command outcome.
        }
        if (opts.input !== undefined) {
          session.write(opts.input);
          if (!opts.input.endsWith("\n")) {
            session.write(process.platform === "win32" ? "\r\n" : "\r");
          }
          session.write(process.platform === "win32" ? "\u001A\r\n" : "\u0004");
        }
      },
    });
    const timedOut = abort.timedOut();
    const exitCode = timedOut ? -1 : result.exitCode;
    const stderr = timedOut ? `Timed out after ${opts.timeoutMs}ms` : "";

    const stdout = plainTerminalOutput(result.transcript);

    opts.terminal.onEnd?.({ exitCode });
    return {
      stdout,
      stderr,
      exitCode,
      aborted: timedOut ? false : result.aborted,
      timedOut: timedOut || undefined,
      terminalTranscript: result.transcript,
      terminalMode: result.terminalMode,
    };
  } catch (error) {
    opts.terminal.onEnd?.({ exitCode: -1 });
    if (abort.timedOut()) {
      return {
        stdout: "",
        stderr: `Timed out after ${opts.timeoutMs}ms`,
        exitCode: -1,
        aborted: false,
        timedOut: true,
        terminalTranscript: "",
        terminalMode: "stream",
      };
    }
    throw error;
  } finally {
    abort.cleanup();
    if (registeredSession) {
      try {
        opts.terminal.unregisterSession?.(registeredSession, sessionInfo);
      } catch {
        // Terminal registry hooks should not change the command outcome.
      }
    }
  }
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
    const commandCwd = command.cwd ? render(command.cwd, context) : cwd;

    try {
      if (options.terminal?.enabled) {
        const result = await spawnTerminalCommand(
          command.program,
          renderedArgs,
          {
            cwd: commandCwd,
            timeoutMs,
            backend: "shell",
            activationId,
            nodeId: node.id,
            signal: options.signal,
            terminal: options.terminal,
            onOutput: options.onOutput,
          }
        );

        const finishedAt = Date.now();
        return {
          activationId,
          nodeId: node.id,
          backend: "shell",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          aborted: result.aborted,
          timedOut: result.timedOut,
          terminalTranscript: result.terminalTranscript,
          terminalMode: result.terminalMode,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        };
      }

      const cmdStr = buildCommand(command.program, renderedArgs);
      const result = await spawnCommand(cmdStr, {
        cwd: commandCwd,
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
    const commandCwd = command.cwd ? render(command.cwd, context) : cwd;

    try {
      if (options.terminal?.enabled) {
        const result = await spawnTerminalCommand(
          command.program,
          renderedArgs,
          {
            cwd: commandCwd,
            timeoutMs,
            backend: "git",
            activationId,
            nodeId: node.id,
            signal: options.signal,
            terminal: options.terminal,
            onOutput: options.onOutput,
          }
        );

        const finishedAt = Date.now();
        return {
          activationId,
          nodeId: node.id,
          backend: "git",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          aborted: result.aborted,
          timedOut: result.timedOut,
          terminalTranscript: result.terminalTranscript,
          terminalMode: result.terminalMode,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        };
      }

      const cmdStr = buildCommand(command.program, renderedArgs);
      const result = await spawnCommand(cmdStr, {
        cwd: commandCwd,
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
    const finalMessagePath = options.terminal?.enabled
      ? join(
          tmpdir(),
          `agentgraph-codex-${activationId.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${Date.now()}.txt`
        )
      : null;
    if (model) {
      args.push("-m", model);
    }
    if (reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (sandbox) {
      args.push("--sandbox", sandbox);
    }
    args.push("--ephemeral", "--skip-git-repo-check");
    if (finalMessagePath) {
      args.push("--output-last-message", finalMessagePath);
    }
    args.push("-");

    try {
      const result = options.terminal?.enabled
        ? await spawnTerminalCommand(codexPath, args, {
            cwd,
            timeoutMs,
            backend: "codex",
            activationId,
            nodeId: node.id,
            signal: options.signal,
            input: prompt,
            terminal: options.terminal,
            onOutput: options.onOutput,
          })
        : await spawnProcess(codexPath, args, {
            cwd,
            timeoutMs,
            backend: "codex",
            input: prompt,
            signal: options.signal,
            onOutput: options.onOutput,
          });
      const stdout = finalMessagePath && existsSync(finalMessagePath)
        ? readFileSync(finalMessagePath, "utf-8").trimEnd()
        : result.stdout;
      const terminalResult = result as Partial<TerminalCommandResult>;

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "codex",
        stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        aborted: result.aborted,
        timedOut: result.timedOut,
        terminalTranscript: terminalResult.terminalTranscript,
        terminalMode: terminalResult.terminalMode,
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
    } finally {
      if (finalMessagePath) {
        rmSync(finalMessagePath, { force: true });
      }
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
