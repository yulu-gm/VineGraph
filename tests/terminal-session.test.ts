import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnTerminalSession } from "../src/terminal-session.js";
import type { TerminalSessionHandle } from "../src/types.js";

const macSpawnHelperPath = join(
  process.cwd(),
  "node_modules",
  "node-pty",
  "prebuilds",
  `darwin-${process.arch}`,
  "spawn-helper"
);

function shellEchoCommand(): { program: string; args: string[] } {
  return process.platform === "win32"
    ? { program: "cmd.exe", args: ["/c", "echo PTY_OK"] }
    : { program: "sh", args: ["-lc", "printf 'PTY_OK\\n'"] };
}

function shellReadCommand(): { program: string; args: string[] } {
  return process.platform === "win32"
    ? { program: "cmd.exe", args: ["/c", "set /p x=&echo INPUT:%x%"] }
    : {
        program: "sh",
        args: ["-lc", "read line; printf 'INPUT:%s\\n' \"$line\""],
      };
}

function terminalInputLine(value: string): string {
  return process.platform === "win32" ? `${value}\r\n` : `${value}\n`;
}

function shellWriteFileCommand(path: string): { program: string; args: string[] } {
  return process.platform === "win32"
    ? { program: "cmd.exe", args: ["/c", `echo ran> "${path}"`] }
    : { program: "sh", args: ["-lc", `printf ran > ${shellQuote(path)}`] };
}

function shellAppendFileCommand(path: string): { program: string; args: string[] } {
  return process.platform === "win32"
    ? { program: "cmd.exe", args: ["/c", `echo run>> "${path}"`] }
    : { program: "sh", args: ["-lc", `printf 'run\\n' >> ${shellQuote(path)}`] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, ms);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("terminal session captures terminal output and exit code", async () => {
  let output = "";

  const result = await spawnTerminalSession({
    ...shellEchoCommand(),
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    onOutput: (chunk) => {
      output += chunk;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(output, /PTY_OK/);
  assert.match(result.transcript, /PTY_OK/);
  assert.match(result.terminalMode, /^(pty|stream)$/);
});

test("terminal session writes input to an active session", async () => {
  let output = "";
  let resolveSession!: (session: TerminalSessionHandle) => void;
  const sessionPromise = new Promise<TerminalSessionHandle>((resolve) => {
    resolveSession = resolve;
  });

  const resultPromise = spawnTerminalSession({
    ...shellReadCommand(),
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    onOutput: (chunk) => {
      output += chunk;
    },
    onSession: (session) => {
      resolveSession(session);
    },
  });

  const session = await withTimeout(sessionPromise, 1000, "terminal session");
  session.write(terminalInputLine("hello"));
  const result = await withTimeout(resultPromise, 5000, "terminal read result");

  assert.equal(result.exitCode, 0);
  assert.match(output, /INPUT:hello/);
  assert.match(result.transcript, /INPUT:hello/);
});

test("pre-aborted terminal session does not execute the command", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "terminal-preabort-"));
  const sideEffectPath = join(tempRoot, "side-effect.txt");
  const controller = new AbortController();
  let sessionCalled = false;
  controller.abort();

  try {
    const result = await spawnTerminalSession({
      ...shellWriteFileCommand(sideEffectPath),
      cwd: process.cwd(),
      signal: controller.signal,
      onSession: () => {
        sessionCalled = true;
      },
    });

    assert.equal(result.exitCode, -1);
    assert.equal(result.aborted, true);
    assert.equal(result.transcript, "");
    assert.equal(result.terminalMode, "stream");
    assert.equal(sessionCalled, false);
    assert.equal(existsSync(sideEffectPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("onSession errors do not trigger fallback double-spawn", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "terminal-session-throw-"));
  const runLogPath = join(tempRoot, "runs.txt");

  try {
    const result = await spawnTerminalSession({
      ...shellAppendFileCommand(runLogPath),
      cwd: process.cwd(),
      onSession: () => {
        throw new Error("consumer callback failed");
      },
    });

    const runs = readFileSync(runLogPath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(runs, ["run"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(
  "terminal session repairs non-executable macOS node-pty spawn helper",
  {
    concurrency: false,
    skip:
      process.platform !== "darwin" || !existsSync(macSpawnHelperPath)
        ? "macOS node-pty spawn-helper is not present"
        : false,
  },
  async () => {
    const originalMode = statSync(macSpawnHelperPath).mode;
    chmodSync(macSpawnHelperPath, originalMode);

    try {
      chmodSync(macSpawnHelperPath, originalMode & ~0o111);

      const result = await spawnTerminalSession({
        ...shellEchoCommand(),
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminalMode, "pty");
      assert.match(result.transcript, /PTY_OK/);
    } finally {
      chmodSync(macSpawnHelperPath, originalMode);
    }
  }
);
