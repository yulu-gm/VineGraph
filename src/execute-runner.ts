import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTerminalStreamFormatter } from "./agent-terminal-presentation.js";
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
  terminalSessionId: string;
  agentSessionId?: string;
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

// Exported for focused runtime argument tests.
export function buildCodexExecArgsForSession(options: {
  reuseSession?: boolean;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: string;
  finalMessagePath?: string | null;
}): string[] {
  const reuseSession = options.reuseSession !== false;
  const reasoningEffort = normalizeCodexReasoningEffort(options.reasoningEffort);
  const args =
    reuseSession && options.sessionId
      ? ["exec", "resume", options.sessionId]
      : ["exec"];

  if (options.model) {
    args.push("-m", options.model);
  }
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  args.push("--skip-git-repo-check");
  if (!reuseSession) {
    args.push("--ephemeral");
  }
  if (options.finalMessagePath) {
    args.push("--output-last-message", options.finalMessagePath);
  }

  return args;
}

function normalizeCodexReasoningEffort(value?: string): string | undefined {
  if (!value) return undefined;
  return value.trim().toLowerCase() === "minimal" ? "low" : value;
}

// Exported for focused runtime argument tests.
export function buildClaudeArgs(
  prompt: string,
  outputFormat: "text" | "stream-json",
  sessionId?: string,
  resume = false
): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    outputFormat,
  ];

  if (resume && sessionId) {
    args.push("--resume", sessionId);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  } else {
    args.push("--no-session-persistence");
  }

  args.push(
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    "10"
  );

  if (outputFormat === "stream-json") {
    args.push("--verbose", "--include-partial-messages");
  }

  return args;
}

function uuidFromRunNode(runId: string | undefined, nodeId: string): string {
  const hash = createHash("sha1")
    .update(`${runId ?? "run"}:${nodeId}`)
    .digest("hex");
  const variant = (
    (Number.parseInt(hash.slice(16, 18), 16) & 0x3f) |
    0x80
  )
    .toString(16)
    .padStart(2, "0");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function extractCodexSessionIdFromRecord(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : {};
  return firstNonEmptyString([
    record.session_id,
    record.sessionId,
    record.conversation_id,
    record.conversationId,
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
  ]);
}

function extractClaudeSessionIdFromRecord(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return firstNonEmptyString([
    record.session_id,
    record.sessionId,
    record.conversation_id,
    record.conversationId,
  ]);
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function shouldReuseCliSession(options: ExecuteRunOptions): boolean {
  return (
    options.terminal?.reuseSession !== false &&
    Boolean(options.terminal?.agentSession)
  );
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
  const terminalSessionId =
    opts.terminal.terminalSessionId ?? `term_${randomUUID()}`;
  const abort = terminalAbortSignal(opts.signal, opts.timeoutMs);
  const sessionInfo = {
    terminalSessionId,
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
      terminalSessionId,
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
        terminalSessionId,
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

async function spawnTerminalStreamCommand(
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
  const terminalSessionId =
    opts.terminal.terminalSessionId ?? `term_${randomUUID()}`;
  let terminalTranscript = "";

  opts.terminal.onStart?.({ cols, rows });
  try {
    const result = await spawnProcess(program, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      backend: opts.backend,
      signal: opts.signal,
      input: opts.input,
      onOutput: (event) => {
        terminalTranscript = boundedTerminalTranscript(
          terminalTranscript,
          event.chunk
        );
        opts.terminal.onOutput?.(event.chunk);
        opts.onOutput?.({
          ...event,
          stream: "stdout",
        });
      },
    });

    opts.terminal.onEnd?.({ exitCode: result.exitCode });
    return {
      terminalSessionId,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      aborted: result.aborted,
      terminalTranscript,
      terminalMode: "stream",
    };
  } catch (error) {
    opts.terminal.onEnd?.({ exitCode: -1 });
    throw error;
  }
}

async function spawnClaudeTerminalStreamCommand(
  program: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    activationId: string;
    nodeId: string;
    signal?: AbortSignal;
    terminal: NonNullable<ExecuteRunOptions["terminal"]>;
    onOutput?: ExecuteRunOptions["onOutput"];
  }
): Promise<TerminalCommandResult> {
  const cols = opts.terminal.cols ?? 80;
  const rows = opts.terminal.rows ?? 24;
  const terminalSessionId =
    opts.terminal.terminalSessionId ?? `term_${randomUUID()}`;
  let terminalTranscript = "";
  let jsonLineBuffer = "";
  let resultText = "";
  let agentSessionId: string | undefined;
  const formatter = createAgentTerminalStreamFormatter("claude");

  const emit = (
    chunk: string,
    stream: "stdout" | "stderr" = "stdout"
  ) => {
    if (!chunk) return;
    terminalTranscript = boundedTerminalTranscript(terminalTranscript, chunk);
    opts.terminal.onOutput?.(chunk);
    opts.onOutput?.({
      backend: "claude",
      stream,
      chunk,
    });
  };

  const handleStdoutChunk = (chunk: string) => {
    jsonLineBuffer += chunk;
    const lines = jsonLineBuffer.split(/\r?\n/);
    jsonLineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const record = safeJsonParse(line);
      const sessionId = extractClaudeSessionIdFromRecord(record);
      if (sessionId) agentSessionId = sessionId;
      const formatted = formatter.acceptChunk(`${line}\n`);
      if (formatted.finalText !== undefined) {
        resultText = formatted.finalText;
      }
      emit(formatted.visibleChunk);
    }
  };

  opts.terminal.onStart?.({ cols, rows });
  try {
    const result = await spawnProcess(program, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      backend: "claude",
      signal: opts.signal,
      onOutput: (event) => {
        if (event.stream === "stderr") {
          emit(event.chunk, "stderr");
          return;
        }
        handleStdoutChunk(event.chunk);
      },
    });

    if (jsonLineBuffer.trim()) {
      const record = safeJsonParse(jsonLineBuffer);
      const sessionId = extractClaudeSessionIdFromRecord(record);
      if (sessionId) agentSessionId = sessionId;
      formatter.acceptChunk(jsonLineBuffer);
      const formatted = formatter.flush();
      if (formatted.finalText !== undefined) {
        resultText = formatted.finalText;
      }
      emit(formatted.visibleChunk);
      jsonLineBuffer = "";
    }

    opts.terminal.onEnd?.({ exitCode: result.exitCode });
    return {
      terminalSessionId,
      agentSessionId,
      stdout: (
        resultText ||
        formatter.finalText ||
        result.stdout
      ).trimEnd(),
      stderr: result.stderr,
      exitCode: result.exitCode,
      aborted: result.aborted,
      terminalTranscript,
      terminalMode: "stream",
    };
  } catch (error) {
    opts.terminal.onEnd?.({ exitCode: -1 });
    throw error;
  }
}

async function spawnCodexTerminalJsonCommand(
  program: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
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
  const terminalSessionId =
    opts.terminal.terminalSessionId ?? `term_${randomUUID()}`;
  let terminalTranscript = "";
  let jsonLineBuffer = "";
  let resultText = "";
  let agentSessionId: string | undefined;
  const formatter = createAgentTerminalStreamFormatter("codex");

  const emit = (
    chunk: string,
    stream: "stdout" | "stderr" = "stdout"
  ) => {
    if (!chunk) return;
    terminalTranscript = boundedTerminalTranscript(terminalTranscript, chunk);
    opts.terminal.onOutput?.(chunk);
    opts.onOutput?.({
      backend: "codex",
      stream,
      chunk,
    });
  };

  const handleStdoutChunk = (chunk: string) => {
    jsonLineBuffer += chunk;
    const lines = jsonLineBuffer.split(/\r?\n/);
    jsonLineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const record = safeJsonParse(line);
      const sessionId = extractCodexSessionIdFromRecord(record);
      if (sessionId) agentSessionId = sessionId;
      const formatted = formatter.acceptChunk(`${line}\n`);
      if (formatted.finalText !== undefined) {
        resultText = formatted.finalText;
      }
      emit(formatted.visibleChunk);
    }
  };

  opts.terminal.onStart?.({ cols, rows });
  try {
    const result = await spawnProcess(program, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      backend: "codex",
      signal: opts.signal,
      input: opts.input,
      onOutput: (event) => {
        if (event.stream === "stderr") {
          emit(event.chunk, "stderr");
          return;
        }
        handleStdoutChunk(event.chunk);
      },
    });

    if (jsonLineBuffer.trim()) {
      const record = safeJsonParse(jsonLineBuffer);
      const sessionId = extractCodexSessionIdFromRecord(record);
      if (sessionId) agentSessionId = sessionId;
      formatter.acceptChunk(jsonLineBuffer);
      const formatted = formatter.flush();
      if (formatted.finalText !== undefined) {
        resultText = formatted.finalText;
      }
      emit(formatted.visibleChunk);
      jsonLineBuffer = "";
    }

    opts.terminal.onEnd?.({ exitCode: result.exitCode });
    return {
      terminalSessionId,
      agentSessionId,
      stdout: (
        resultText ||
        formatter.finalText ||
        result.stdout
      ).trimEnd(),
      stderr: result.stderr,
      exitCode: result.exitCode,
      aborted: result.aborted,
      terminalTranscript,
      terminalMode: "stream",
    };
  } catch (error) {
    opts.terminal.onEnd?.({ exitCode: -1 });
    throw error;
  }
}

function boundedTerminalTranscript(transcript: string, chunk: string): string {
  const next = transcript + chunk;
  return next.length <= 1_000_000 ? next : next.slice(-1_000_000);
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
      case "codex":
        return ExecuteRunner.runCodex(node, activationId, cwd, context, options);
      case "claude":
        return ExecuteRunner.runClaude(node, activationId, cwd, context, options);
      default:
        throw new Error(`Unknown backend: ${node.backend}`);
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

    const reuseSession = shouldReuseCliSession(options);
    const sessionState = reuseSession
      ? options.terminal?.agentSession?.ensure(node.id, "codex")
      : undefined;
    const existingAgentSessionId = sessionState?.agentSessionId;
    const finalMessagePath = options.terminal?.enabled
      ? join(
          tmpdir(),
          `agentgraph-codex-${activationId.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${Date.now()}.txt`
        )
      : null;
    const args = buildCodexExecArgsForSession({
      reuseSession,
      sessionId: existingAgentSessionId,
      model,
      reasoningEffort,
      sandbox,
      finalMessagePath,
    });

    try {
      const terminalArgs = options.terminal?.enabled
        ? [...args, "--json", "--color", "always"]
        : args;
      const result = options.terminal?.enabled
        ? await spawnCodexTerminalJsonCommand(codexPath, [...terminalArgs, "-"], {
            cwd,
            timeoutMs,
            activationId,
            nodeId: node.id,
            signal: options.signal,
            input: prompt,
            terminal: options.terminal,
            onOutput: options.onOutput,
          })
        : await spawnProcess(codexPath, [...args, "-"], {
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
      if (reuseSession && terminalResult.agentSessionId) {
        options.terminal?.agentSession?.updateAgentSessionId(
          node.id,
          terminalResult.agentSessionId
        );
      }

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "codex",
        terminalSessionId: terminalResult.terminalSessionId,
        agentSessionId: reuseSession
          ? terminalResult.agentSessionId ?? existingAgentSessionId
          : undefined,
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

    const reuseSession = shouldReuseCliSession(options);
    const sessionState = reuseSession
      ? options.terminal?.agentSession?.ensure(node.id, "claude")
      : undefined;
    const existingAgentSessionId = sessionState?.agentSessionId;
    const claudeSessionId = reuseSession
      ? existingAgentSessionId ?? uuidFromRunNode(options.terminal?.runId, node.id)
      : undefined;
    if (reuseSession && claudeSessionId && !existingAgentSessionId) {
      options.terminal?.agentSession?.updateAgentSessionId(
        node.id,
        claudeSessionId
      );
    }
    const args = buildClaudeArgs(
      prompt,
      options.terminal?.enabled ? "stream-json" : "text",
      claudeSessionId,
      reuseSession && Boolean(existingAgentSessionId)
    );

    try {
      const result = options.terminal?.enabled
        ? await spawnClaudeTerminalStreamCommand(claudePath, args, {
            cwd,
            timeoutMs,
            activationId,
            nodeId: node.id,
            signal: options.signal,
            terminal: options.terminal,
            onOutput: options.onOutput,
          })
        : await spawnProcess(claudePath, args, {
            cwd,
            timeoutMs,
            backend: "claude",
            signal: options.signal,
            onOutput: options.onOutput,
          });
      const terminalResult = result as Partial<TerminalCommandResult>;
      if (reuseSession && terminalResult.agentSessionId) {
        options.terminal?.agentSession?.updateAgentSessionId(
          node.id,
          terminalResult.agentSessionId
        );
      }

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "claude",
        terminalSessionId: terminalResult.terminalSessionId,
        agentSessionId: reuseSession
          ? terminalResult.agentSessionId ?? claudeSessionId
          : undefined,
        stdout: result.stdout,
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
