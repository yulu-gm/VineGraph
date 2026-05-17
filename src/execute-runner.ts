import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  terminalSessionId: string;
  terminalTranscript: string;
  terminalMode: "pty" | "stream";
}

interface ClaudeStreamFormatResult {
  terminalChunk: string;
  resultText?: string;
}

interface CodexStreamFormatResult {
  terminalChunk: string;
  resultText?: string;
}

const ANSI_RESET = "\u001B[0m";
const ANSI_BOLD = "\u001B[1m";
const ANSI_DIM = "\u001B[2m";
const ANSI_RED = "\u001B[91m";
const ANSI_GREEN = "\u001B[92m";
const ANSI_AMBER = "\u001B[93m";
const ANSI_BLUE = "\u001B[94m";
const ANSI_CYAN = "\u001B[96m";
const ANSI_WHITE = "\u001B[97m";

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

function ansi(text: string, ...styles: string[]): string {
  if (!text) return "";
  return `${styles.join("")}${text}${ANSI_RESET}`;
}

function claudeLabel(label: string, color = ANSI_BLUE): string {
  return `${ansi("Claude", ANSI_BOLD, color)} ${ansi(label, ANSI_BOLD)}`;
}

function claudeMetaLine(
  label: string,
  detail = "",
  color = ANSI_BLUE
): string {
  return `${claudeLabel(label, color)}${detail ? ` ${ansi(detail, ANSI_DIM)}` : ""}\n`;
}

function codexLabel(label: string, color = ANSI_BLUE): string {
  return `${ansi("Codex", ANSI_BOLD, color)} ${ansi(label, ANSI_BOLD)}`;
}

function codexMetaLine(
  label: string,
  detail = "",
  color = ANSI_BLUE
): string {
  return `${codexLabel(label, color)}${detail ? ` ${ansi(detail, ANSI_DIM)}` : ""}\n`;
}

function buildClaudeArgs(prompt: string, outputFormat: "text" | "stream-json"): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    outputFormat,
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    "10",
  ];

  if (outputFormat === "stream-json") {
    args.push("--verbose", "--include-partial-messages");
  }

  return args;
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
      const formatted = formatClaudeStreamLine(line);
      if (formatted.resultText !== undefined) {
        resultText = formatted.resultText;
      }
      emit(formatted.terminalChunk);
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
      const formatted = formatClaudeStreamLine(jsonLineBuffer);
      if (formatted.resultText !== undefined) {
        resultText = formatted.resultText;
      }
      emit(formatted.terminalChunk);
      jsonLineBuffer = "";
    }

    opts.terminal.onEnd?.({ exitCode: result.exitCode });
    return {
      terminalSessionId,
      stdout: (
        resultText ||
        extractClaudeResultText(result.stdout) ||
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
      const formatted = formatCodexStreamLine(line);
      if (formatted.resultText !== undefined) {
        resultText = formatted.resultText;
      }
      emit(formatted.terminalChunk);
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
      const formatted = formatCodexStreamLine(jsonLineBuffer);
      if (formatted.resultText !== undefined) {
        resultText = formatted.resultText;
      }
      emit(formatted.terminalChunk);
      jsonLineBuffer = "";
    }

    opts.terminal.onEnd?.({ exitCode: result.exitCode });
    return {
      terminalSessionId,
      stdout: (
        resultText ||
        extractCodexResultText(result.stdout) ||
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

function formatCodexStreamLine(line: string): CodexStreamFormatResult {
  try {
    return formatCodexStreamEvent(JSON.parse(line));
  } catch {
    return { terminalChunk: `${line}\n` };
  }
}

function formatCodexStreamEvent(event: unknown): CodexStreamFormatResult {
  if (!event || typeof event !== "object") return { terminalChunk: "" };
  const outer = event as Record<string, unknown>;
  const payload =
    outer.payload && typeof outer.payload === "object"
      ? (outer.payload as Record<string, unknown>)
      : outer;
  const item =
    payload.item && typeof payload.item === "object"
      ? (payload.item as Record<string, unknown>)
      : undefined;
  const type =
    stringValue(payload.type) ??
    stringValue(outer.type) ??
    stringValue(item?.type) ??
    "";

  if (type.includes("session")) {
    const model = stringValue(payload.model) ?? stringValue(payload.model_provider);
    const sessionId =
      stringValue(payload.session_id) ??
      stringValue(payload.id) ??
      stringValue(payload.conversation_id);
    return {
      terminalChunk: codexMetaLine(
        "session",
        `${sessionId ? `#${sessionId.slice(0, 8)} ` : ""}${model ?? ""}`.trim(),
        ANSI_CYAN
      ),
    };
  }

  if (type.includes("reasoning")) {
    const text = codexTextFromRecord(payload) || codexTextFromRecord(item);
    return {
      terminalChunk: text
        ? codexMetaLine("reasoning", truncateSingleLine(text, 180), ANSI_BLUE)
        : codexMetaLine("reasoning", "", ANSI_BLUE),
    };
  }

  if (type.includes("message") || type.includes("assistant")) {
    const text =
      codexTextFromRecord(payload) ||
      codexTextFromRecord(item) ||
      codexTextFromContent(item?.content ?? payload.content);
    return {
      terminalChunk: text ? ansi(text, ANSI_WHITE) : "",
      resultText: type.includes("agent_message") ? text : undefined,
    };
  }

  if (type.includes("exec_command_begin") || type.includes("command_begin")) {
    return {
      terminalChunk: codexMetaLine(
        "command",
        formatCodexCommand(payload),
        ANSI_AMBER
      ),
    };
  }

  if (type.includes("exec_command_end") || type.includes("command_end")) {
    const exitCode =
      numberValue(payload.exit_code) ??
      numberValue(payload.exitCode) ??
      numberValue(payload.code);
    const duration = formatCodexDuration(
      payload.duration_ms ?? payload.duration,
      payload.duration_ms !== undefined ? "ms" : "auto"
    );
    const stdout = stringValue(payload.stdout);
    const stderr = stringValue(payload.stderr);
    const ok = exitCode === undefined || exitCode === 0;
    return {
      terminalChunk:
        codexMetaLine(
          ok ? "command ok" : "command failed",
          `${exitCode !== undefined ? `exit ${exitCode}` : ""}${duration ? ` ${duration}` : ""}`.trim(),
          ok ? ANSI_GREEN : ANSI_RED
        ) +
        (stdout ? `${ansi(stdout.slice(0, 4000), ANSI_DIM)}\n` : "") +
        (stderr ? `${ansi(stderr.slice(0, 4000), ANSI_RED)}\n` : ""),
    };
  }

  if (type.includes("tool") || type.includes("function_call")) {
    return {
      terminalChunk: codexMetaLine(
        "tool",
        formatCodexTool(payload, item),
        ANSI_AMBER
      ),
    };
  }

  if (type.includes("error") || type.includes("failed")) {
    const text = codexTextFromRecord(payload) || stringValue(payload.error) || type;
    return { terminalChunk: codexMetaLine("error", text, ANSI_RED) };
  }

  if (type.includes("turn") || type.includes("task") || type.includes("started")) {
    return {
      terminalChunk: codexMetaLine(
        type.replace(/_/g, " "),
        codexTextFromRecord(payload),
        ANSI_BLUE
      ),
    };
  }

  if (type.includes("result") || type.includes("completed") || type.includes("end")) {
    const text = codexTextFromRecord(payload) || codexTextFromRecord(item);
    return {
      terminalChunk: codexMetaLine("done", truncateSingleLine(text, 160), ANSI_GREEN),
      resultText: text || undefined,
    };
  }

  const text = codexTextFromRecord(payload) || codexTextFromRecord(item);
  return {
    terminalChunk: text
      ? codexMetaLine(type || "event", truncateSingleLine(text, 180), ANSI_BLUE)
      : "",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function codexTextFromRecord(
  record: Record<string, unknown> | undefined
): string {
  if (!record) return "";
  for (const key of [
    "message",
    "text",
    "delta",
    "output",
    "output_text",
    "summary",
    "reason",
    "result",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return codexTextFromContent(record.content);
}

function codexTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return (
        stringValue(record.text) ??
        stringValue(record.output_text) ??
        stringValue(record.summary) ??
        ""
      );
    })
    .filter(Boolean)
    .join("");
}

function formatCodexCommand(record: Record<string, unknown>): string {
  const command = record.command;
  const cwd = stringValue(record.cwd);
  const rendered = Array.isArray(command)
    ? command.map((part) => String(part)).join(" ")
    : stringValue(command) ?? stringValue(record.cmd) ?? "";
  return `${truncateSingleLine(rendered, 160)}${cwd ? ` (${cwd})` : ""}`.trim();
}

function formatCodexTool(
  payload: Record<string, unknown>,
  item: Record<string, unknown> | undefined
): string {
  const source = item ?? payload;
  const name =
    stringValue(source.name) ??
    stringValue(source.tool_name) ??
    stringValue(source.call_id) ??
    stringValue(source.id) ??
    "tool";
  const args =
    stringValue(source.arguments) ??
    stringValue(source.input) ??
    summarizeObjectKeys(source);
  return `${name}${args ? ` ${truncateSingleLine(args, 140)}` : ""}`;
}

function formatCodexDuration(value: unknown, unit: "auto" | "ms" = "auto"): string {
  if (typeof value === "number") {
    const ms = unit === "ms" || value > 1000 ? value : value * 1000;
    return `${Math.round(ms / 1000)}s`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const secs = numberValue(record.secs) ?? numberValue(record.seconds);
    const nanos = numberValue(record.nanos);
    if (secs !== undefined) {
      return `${Math.round(secs + (nanos ?? 0) / 1_000_000_000)}s`;
    }
  }
  return "";
}

function extractCodexResultText(stdout: string): string {
  let resultText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const formatted = formatCodexStreamEvent(JSON.parse(line));
      if (formatted.resultText !== undefined) {
        resultText = formatted.resultText;
      }
    } catch {
      // Non-JSON stdout is kept as the fallback.
    }
  }
  return resultText;
}

function formatClaudeStreamLine(line: string): ClaudeStreamFormatResult {
  try {
    return formatClaudeStreamEvent(JSON.parse(line));
  } catch {
    return { terminalChunk: `${line}\n` };
  }
}

function formatClaudeStreamEvent(event: unknown): ClaudeStreamFormatResult {
  if (!event || typeof event !== "object") return { terminalChunk: "" };
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";

  if (type === "system") {
    const subtype = typeof record.subtype === "string" ? record.subtype : "";
    if (subtype === "init") {
      const model = typeof record.model === "string" ? record.model : "claude";
      const sessionId =
        typeof record.session_id === "string"
          ? record.session_id.slice(0, 8)
          : "";
      return {
        terminalChunk: claudeMetaLine(
          "session",
          `${sessionId ? `#${sessionId} ` : ""}${model}`,
          ANSI_CYAN
        ),
      };
    }
    return {
      terminalChunk: subtype
        ? claudeMetaLine("system", formatClaudeRecordDetail(record, subtype), ANSI_BLUE)
        : "",
    };
  }

  if (type === "assistant") {
    return {
      terminalChunk: formatClaudeMessageContent(
        (record.message as Record<string, unknown> | undefined)?.content
      ),
    };
  }

  if (type === "user") {
    return {
      terminalChunk: formatClaudeMessageContent(
        (record.message as Record<string, unknown> | undefined)?.content,
        { toolResult: true }
      ),
    };
  }

  if (type === "result") {
    const result =
      typeof record.result === "string" ? record.result : undefined;
    const subtype = typeof record.subtype === "string" ? record.subtype : "done";
    const duration =
      typeof record.duration_ms === "number"
        ? ` in ${Math.round(record.duration_ms / 1000)}s`
        : "";
    const cost =
      typeof record.total_cost_usd === "number"
        ? `, cost $${record.total_cost_usd.toFixed(4)}`
        : "";
    const isError =
      subtype.toLowerCase().includes("error") ||
      subtype.toLowerCase().includes("fail");
    return {
      terminalChunk: `\n${claudeMetaLine(
        subtype,
        `${duration}${cost}`.trim(),
        isError ? ANSI_RED : ANSI_GREEN
      )}`,
      resultText: result,
    };
  }

  return { terminalChunk: "" };
}

function formatClaudeMessageContent(
  content: unknown,
  options: { toolResult?: boolean } = {}
): string {
  if (!Array.isArray(content)) return "";

  let output = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";

    if (type === "text" && typeof item.text === "string") {
      output += ansi(item.text, ANSI_WHITE);
      continue;
    }

    if (type === "tool_use") {
      const name = typeof item.name === "string" ? item.name : "tool";
      output += `\n${claudeMetaLine(
        "tool",
        `${name}${formatClaudeToolInput(item.input)}`,
        ANSI_AMBER
      )}`;
      continue;
    }

    if (type === "tool_result") {
      output += options.toolResult
        ? `\n${claudeMetaLine(
            "tool result",
            "",
            ANSI_GREEN
          )}${ansi(formatClaudeToolResult(item.content), ANSI_DIM)}\n`
        : "";
    }
  }

  return output;
}

function formatClaudeRecordDetail(
  record: Record<string, unknown>,
  fallback: string
): string {
  for (const key of ["message", "status", "reason", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return `${fallback}: ${value.trim()}`;
    }
  }
  return fallback;
}

function formatClaudeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const value =
    firstString(record, ["file_path", "path", "command", "description"]) ??
    summarizeObjectKeys(record);
  return value ? ` ${value}` : "";
}

function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncateSingleLine(value.trim(), 120);
    }
  }
  return undefined;
}

function summarizeObjectKeys(record: Record<string, unknown>): string {
  return Object.keys(record).slice(0, 4).join(", ");
}

function truncateSingleLine(value: string, maxLength: number): string {
  const line = value.replace(/\s+/g, " ");
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}...`;
}

function formatClaudeToolResult(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 2000);
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

function extractClaudeResultText(stdout: string): string {
  let resultText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === "result" && typeof record.result === "string") {
        resultText = record.result;
      }
    } catch {
      // Non-JSON stdout is kept as the fallback.
    }
  }
  return resultText;
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
          terminalSessionId: result.terminalSessionId,
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
          terminalSessionId: result.terminalSessionId,
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

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "codex",
        terminalSessionId: terminalResult.terminalSessionId,
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

    const args = buildClaudeArgs(
      prompt,
      options.terminal?.enabled ? "stream-json" : "text"
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

      const finishedAt = Date.now();
      return {
        activationId,
        nodeId: node.id,
        backend: "claude",
        terminalSessionId: terminalResult.terminalSessionId,
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
