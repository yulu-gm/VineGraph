import { spawn as spawnChild } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TerminalSessionHandle } from "./types.js";

export const MAX_TERMINAL_TRANSCRIPT_CHARS = 1_000_000;
const TERMINAL_ABORT_GRACE_MS = 750;
const requireFromHere = createRequire(import.meta.url);

export interface TerminalSessionOptions {
  program: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  onSession?: (session: TerminalSessionHandle) => void;
}

export interface TerminalSessionResult {
  exitCode: number;
  aborted?: boolean;
  transcript: string;
  terminalMode: "pty" | "stream";
}

type NodePtyModule = typeof import("node-pty");

export async function spawnTerminalSession(
  options: TerminalSessionOptions
): Promise<TerminalSessionResult> {
  if (options.signal?.aborted) {
    return {
      exitCode: -1,
      aborted: true,
      transcript: "",
      terminalMode: "stream",
    };
  }

  const pty = await loadNodePty();
  if (!pty) {
    return spawnStreamFallback(options);
  }

  try {
    return await spawnPtySession(options, pty);
  } catch (error) {
    if (shouldRepairNodePtySpawnHelper(error) && repairNodePtySpawnHelpers()) {
      try {
        return await spawnPtySession(options, pty);
      } catch {
        return spawnStreamFallback(options);
      }
    }

    return spawnStreamFallback(options);
  }
}

function spawnPtySession(
  options: TerminalSessionOptions,
  pty: NodePtyModule
): Promise<TerminalSessionResult> {
  return new Promise((resolve) => {
    let transcript = "";
    let aborted = false;
    let closed = false;
    let abortKillTimer: NodeJS.Timeout | undefined;

    const appendOutput = (chunk: string) => {
      transcript = appendTranscript(transcript, chunk);
      notifyOutput(options.onOutput, chunk);
    };

    const command = normalizePtyCommand(options.program, options.args);
    const child = pty.spawn(command.program, command.args, {
      name: "xterm-256color",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });

    const handle: TerminalSessionHandle = {
      write: (input) => child.write(input),
      resize: (cols, rows) => child.resize(cols, rows),
      interrupt: () => child.write("\u0003"),
      kill: () => child.kill(),
    };

    const abort = () => {
      if (closed) return;
      aborted = true;
      handle.interrupt();
      abortKillTimer = setTimeout(() => {
        if (!closed) handle.kill();
      }, TERMINAL_ABORT_GRACE_MS);
      abortKillTimer.unref?.();
    };

    child.onData(appendOutput);
    child.onExit(({ exitCode }) => {
      closed = true;
      if (abortKillTimer) clearTimeout(abortKillTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: aborted ? -1 : exitCode,
        aborted: aborted || undefined,
        transcript,
        terminalMode: "pty",
      });
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }

    notifySession(options.onSession, handle);
  });
}

function normalizePtyCommand(program: string, args: string[]): {
  program: string;
  args: string[];
} {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(program)) {
    return { program, args };
  }

  return {
    program: "cmd.exe",
    args: ["/d", "/s", "/c", buildWindowsCommandLine(program, args)],
  };
}

function buildWindowsCommandLine(program: string, args: string[]): string {
  return [program, ...args].map(quoteWindowsCommandArg).join(" ");
}

function quoteWindowsCommandArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

async function loadNodePty(): Promise<NodePtyModule | null> {
  try {
    return await import("node-pty");
  } catch {
    return null;
  }
}

function spawnStreamFallback(
  options: TerminalSessionOptions
): Promise<TerminalSessionResult> {
  return new Promise((resolve, reject) => {
    let transcript = "";
    let aborted = false;
    let closed = false;
    let abortKillTimer: NodeJS.Timeout | undefined;

    const child = spawnChild(options.program, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const appendOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      transcript = appendTranscript(transcript, text);
      notifyOutput(options.onOutput, text);
    };

    const handle = createStreamHandle(child);
    const abort = () => {
      if (closed) return;
      aborted = true;
      handle.interrupt();
      abortKillTimer = setTimeout(() => {
        if (!closed) handle.kill();
      }, TERMINAL_ABORT_GRACE_MS);
      abortKillTimer.unref?.();
    };

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error) => {
      closed = true;
      if (abortKillTimer) clearTimeout(abortKillTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      closed = true;
      if (abortKillTimer) clearTimeout(abortKillTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: aborted ? -1 : exitCode ?? -1,
        aborted: aborted || undefined,
        transcript,
        terminalMode: "stream",
      });
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }

    notifySession(options.onSession, handle);
  });
}

function createStreamHandle(
  child: ChildProcessWithoutNullStreams
): TerminalSessionHandle {
  return {
    write: (input) => {
      child.stdin.write(input);
    },
    resize: () => {},
    interrupt: () => {
      if (process.platform === "win32") {
        child.kill();
        return;
      }

      child.kill("SIGINT");
    },
    kill: () => {
      child.kill();
    },
  };
}

function appendTranscript(transcript: string, chunk: string): string {
  const next = transcript + chunk;
  if (next.length <= MAX_TERMINAL_TRANSCRIPT_CHARS) {
    return next;
  }

  return next.slice(-MAX_TERMINAL_TRANSCRIPT_CHARS);
}

function notifyOutput(
  onOutput: TerminalSessionOptions["onOutput"],
  chunk: string
): void {
  try {
    onOutput?.(chunk);
  } catch {
    // Consumer callbacks must not alter process lifecycle or fallback behavior.
  }
}

function notifySession(
  onSession: TerminalSessionOptions["onSession"],
  session: TerminalSessionHandle
): void {
  try {
    onSession?.(session);
  } catch {
    // Consumer callbacks must not alter process lifecycle or fallback behavior.
  }
}

function shouldRepairNodePtySpawnHelper(error: unknown): boolean {
  return (
    process.platform === "darwin" &&
    error instanceof Error &&
    error.message.includes("posix_spawnp failed")
  );
}

function repairNodePtySpawnHelpers(): boolean {
  let repaired = false;

  for (const helperPath of findNodePtySpawnHelperCandidates()) {
    try {
      const stats = statSync(helperPath);
      if (!stats.isFile()) continue;

      chmodSync(helperPath, stats.mode | readableToExecutableBits(stats.mode));
      repaired = true;
    } catch {
      // Missing or inaccessible candidates should not block stream fallback.
    }
  }

  return repaired;
}

function findNodePtySpawnHelperCandidates(): string[] {
  const nodePtyRoot = resolveNodePtyRoot();
  if (!nodePtyRoot) {
    return [];
  }

  const candidates = new Set<string>();
  const prebuildsRoot = join(nodePtyRoot, "prebuilds");

  try {
    for (const item of readdirSync(prebuildsRoot, { withFileTypes: true })) {
      if (item.isDirectory() && item.name.startsWith("darwin-")) {
        candidates.add(join(prebuildsRoot, item.name, "spawn-helper"));
      }
    }
  } catch {
    // Source builds or broken installs may not have prebuilds.
  }

  candidates.add(join(nodePtyRoot, "build", "Release", "spawn-helper"));
  return [...candidates];
}

function resolveNodePtyRoot(): string | null {
  try {
    return dirname(requireFromHere.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

function readableToExecutableBits(mode: number): number {
  return (mode & 0o444) >> 2;
}
