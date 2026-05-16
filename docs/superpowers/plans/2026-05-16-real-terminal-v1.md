# Real Terminal v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Terminal log table with a real xterm-backed terminal stream for active graph node execution.

**Architecture:** Add a focused terminal session layer that can run commands through a PTY, stream terminal bytes through scheduler/server events, and accept input/resize/interrupt calls from the UI. Keep the existing stdout/stderr execution path as fallback and keep Timeline, Detail, Diff, and run records as structured surfaces.

**Tech Stack:** TypeScript, Node HTTP/SSE, `@xterm/xterm`, `@xterm/addon-fit`, `node-pty`, current `node:test` tests, existing Tauri/static UI.

---

## File Map

- Modify `package.json` and `package-lock.json`: add runtime dependencies `@xterm/xterm`, `@xterm/addon-fit`, and `node-pty`.
- Modify `src/types.ts`: add terminal transcript fields and scheduler terminal events.
- Create `src/terminal-session.ts`: PTY session wrapper with output, input, resize, interrupt, and fallback detection.
- Modify `src/execute-runner.ts`: run shell/git/codex/claude through PTY when terminal mode is enabled, while preserving raw results.
- Modify `src/scheduler.ts`: publish terminal events and pass terminal hooks into `ExecuteRunner`.
- Modify `src/server.ts`: keep active terminal sessions per run and expose terminal input/resize/interrupt endpoints.
- Modify `src/ui/index.html`: mount an xterm container in the Terminal tab.
- Modify `src/ui/style.css`: make the terminal fill the dock and match light/dark themes.
- Modify `src/ui/app.js`: initialize xterm, consume terminal events, send input/resize/interrupt, and keep the current log renderer as fallback.
- Add or update tests in `tests/terminal-session.test.ts`, `tests/run-control.test.ts`, `tests/server-product-api.test.ts`, `tests/ui-run-control.test.ts`, and `tests/ui-terminal-dock.test.ts`.

## Task 1: Dependencies And Terminal Types

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/types.ts`
- Test: `tests/ui-terminal-dock.test.ts`

- [ ] **Step 1: Install terminal dependencies**

Run:

```bash
npm install @xterm/xterm @xterm/addon-fit node-pty
```

Expected: `package.json` and `package-lock.json` include the three packages.

- [ ] **Step 2: Write the failing type/source test**

Add to `tests/ui-terminal-dock.test.ts`:

```ts
test("project declares real terminal dependencies", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
    dependencies?: Record<string, string>;
  };

  assert.ok(pkg.dependencies?.["@xterm/xterm"]);
  assert.ok(pkg.dependencies?.["@xterm/addon-fit"]);
  assert.ok(pkg.dependencies?.["node-pty"]);
});
```

Run:

```bash
npx tsx --test tests/ui-terminal-dock.test.ts
```

Expected before install/type changes: FAIL if dependencies are missing.

- [ ] **Step 3: Add terminal event and transcript types**

In `src/types.ts`, extend `RawExecutionResult`:

```ts
export interface RawExecutionResult {
  activationId: string;
  nodeId: string;
  backend: Backend;
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
  terminalTranscript?: string;
  terminalMode?: "pty" | "stream";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}
```

Extend `SchedulerEvent`:

```ts
  | {
      type: "terminal:started";
      runId: string;
      activationId: string;
      nodeId: string;
      backend: Backend;
      cols: number;
      rows: number;
      timestamp: number;
    }
  | {
      type: "terminal:output";
      runId: string;
      activationId: string;
      nodeId: string;
      backend: Backend;
      chunk: string;
      timestamp: number;
    }
  | {
      type: "terminal:ended";
      runId: string;
      activationId: string;
      nodeId: string;
      backend: Backend;
      exitCode: number;
      timestamp: number;
    };
```

Extend `ExecuteRunOptions`:

```ts
  terminal?: {
    enabled: boolean;
    cols?: number;
    rows?: number;
    onStart?: (event: { cols: number; rows: number }) => void;
    onOutput?: (chunk: string) => void;
    onEnd?: (event: { exitCode: number }) => void;
    registerSession?: (session: TerminalSessionHandle) => void;
    unregisterSession?: () => void;
  };
```

Add a handle type above `ExecuteRunOptions`:

```ts
export interface TerminalSessionHandle {
  write(input: string): void;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  kill(): void;
}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: Type errors identify every caller that must be wired in later tasks. Do not weaken the types to hide those errors.

## Task 2: PTY Session Adapter

**Files:**
- Create: `src/terminal-session.ts`
- Test: `tests/terminal-session.test.ts`

- [ ] **Step 1: Write the failing PTY adapter tests**

Create `tests/terminal-session.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { spawnTerminalSession } from "../src/terminal-session.js";

function shellEchoCommand(): { program: string; args: string[] } {
  return process.platform === "win32"
    ? { program: "cmd.exe", args: ["/c", "echo PTY_OK"] }
    : { program: "sh", args: ["-lc", "printf 'PTY_OK\\n'"] };
}

test("terminal session captures PTY output and exit code", async () => {
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
  assert.equal(result.terminalMode, "pty");
});

test("terminal session writes input to an active PTY", async () => {
  let output = "";
  let handle: { write(input: string): void } | null = null;
  const command = process.platform === "win32"
    ? { program: "cmd.exe", args: ["/c", "set /p x=&echo INPUT:%x%"] }
    : { program: "sh", args: ["-lc", "read line; printf 'INPUT:%s\\n' \"$line\""] };

  const resultPromise = spawnTerminalSession({
    ...command,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    onOutput: (chunk) => {
      output += chunk;
    },
    onSession: (session) => {
      handle = session;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  handle?.write("hello\\n");
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.match(output, /INPUT:hello/);
});
```

Run:

```bash
npx tsx --test tests/terminal-session.test.ts
```

Expected: FAIL because `src/terminal-session.ts` does not exist.

- [ ] **Step 2: Implement the PTY adapter**

Create `src/terminal-session.ts`:

```ts
import { spawn as spawnChild } from "node:child_process";
import type { TerminalSessionHandle } from "./types.js";

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

export async function spawnTerminalSession(
  options: TerminalSessionOptions
): Promise<TerminalSessionResult> {
  const pty = await import("node-pty").catch(() => null);
  if (!pty) return spawnStreamFallback(options);

  return new Promise((resolve) => {
    let transcript = "";
    let aborted = false;
    const child = pty.spawn(options.program, options.args, {
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
      aborted = true;
      handle.interrupt();
      setTimeout(() => handle.kill(), 750).unref?.();
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    options.onSession?.(handle);
    child.onData((chunk) => {
      transcript += chunk;
      options.onOutput?.(chunk);
    });
    child.onExit(({ exitCode }) => {
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: aborted ? -1 : exitCode,
        aborted,
        transcript: transcript.trimEnd(),
        terminalMode: "pty",
      });
    });
  });
}

function spawnStreamFallback(
  options: TerminalSessionOptions
): Promise<TerminalSessionResult> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(options.program, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let transcript = "";
    let aborted = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      transcript += text;
      options.onOutput?.(text);
    };
    const handle: TerminalSessionHandle = {
      write: (input) => child.stdin?.write(input),
      resize: () => {},
      interrupt: () => child.kill("SIGINT"),
      kill: () => child.kill(),
    };
    const abort = () => {
      aborted = true;
      handle.interrupt();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    options.onSession?.(handle);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", reject);
    child.on("close", (exitCode) => {
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: aborted ? -1 : exitCode ?? -1,
        aborted,
        transcript: transcript.trimEnd(),
        terminalMode: "stream",
      });
    });
  });
}
```

- [ ] **Step 3: Verify the adapter**

Run:

```bash
npx tsx --test tests/terminal-session.test.ts
```

Expected: PASS. If `node-pty` cannot load, the first test still passes with `terminalMode: "stream"` only after updating the assertion to accept fallback:

```ts
assert.match(result.terminalMode, /^(pty|stream)$/);
```

Do not remove the PTY implementation because fallback passed.

## Task 3: Wire PTY Into ExecuteRunner And Scheduler Events

**Files:**
- Modify: `src/execute-runner.ts`
- Modify: `src/scheduler.ts`
- Test: `tests/run-control.test.ts`

- [ ] **Step 1: Write failing scheduler event test**

Add to `tests/run-control.test.ts`:

```ts
test("scheduler streams terminal PTY output events for execute nodes", async () => {
  const graph: GraphDefinition = {
    id: "terminal_event_graph",
    version: "0.1.0",
    runtime: { maxTotalSteps: 2, workspace: { mode: "local" } },
    nodes: [
      {
        id: "shell_node",
        type: "execute",
        backend: "shell",
        command: shellCommand("printf 'TERM_EVENT\\n'"),
      },
    ],
    edges: [{ from: "graph.start", to: "shell_node.inputs.trigger" }],
  };
  const events: SchedulerEvent[] = [];

  const result = await Scheduler.run(graph, "terminal-event.yaml", {
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "success");
  assert.ok(events.some((event) => event.type === "terminal:started"));
  assert.ok(
    events.some(
      (event) => event.type === "terminal:output" && event.chunk.includes("TERM_EVENT")
    )
  );
  assert.ok(events.some((event) => event.type === "terminal:ended"));
  assert.match(
    result.activations.find((item) => item.nodeId === "shell_node")?.rawResult?.terminalTranscript ?? "",
    /TERM_EVENT/
  );
});
```

Run:

```bash
npx tsx --test tests/run-control.test.ts
```

Expected: FAIL because terminal events are not published.

- [ ] **Step 2: Add terminal options to scheduler**

Inside `executeNode` in `src/scheduler.ts`, extend the `ExecuteRunner.run` options:

```ts
terminal: {
  enabled: true,
  cols: 100,
  rows: 28,
  onStart: ({ cols, rows }) =>
    publishSchedulerEvent(options, {
      type: "terminal:started",
      runId,
      activationId,
      nodeId: node.id,
      backend: node.backend,
      cols,
      rows,
      timestamp: Date.now(),
    }),
  onOutput: (chunk) =>
    publishSchedulerEvent(options, {
      type: "terminal:output",
      runId,
      activationId,
      nodeId: node.id,
      backend: node.backend,
      chunk,
      timestamp: Date.now(),
    }),
  onEnd: ({ exitCode }) =>
    publishSchedulerEvent(options, {
      type: "terminal:ended",
      runId,
      activationId,
      nodeId: node.id,
      backend: node.backend,
      exitCode,
      timestamp: Date.now(),
    }),
},
```

- [ ] **Step 3: Add PTY shell execution path**

In `src/execute-runner.ts`, import the adapter:

```ts
import { spawnTerminalSession } from "./terminal-session.js";
```

In `runShell`, before the existing `spawnCommand` call, add:

```ts
if (options.terminal?.enabled) {
  const result = await spawnTerminalSession({
    program: command.program,
    args: renderedArgs,
    cwd: command.cwd ? render(command.cwd, context) : cwd,
    cols: options.terminal.cols,
    rows: options.terminal.rows,
    signal: options.signal,
    onOutput: options.terminal.onOutput,
    onSession: options.terminal.registerSession,
  });
  const finishedAt = Date.now();
  options.terminal.onStart?.({ cols: options.terminal.cols ?? 80, rows: options.terminal.rows ?? 24 });
  options.terminal.onEnd?.({ exitCode: result.exitCode });
  options.terminal.unregisterSession?.();
  return {
    activationId,
    nodeId: node.id,
    backend: "shell",
    stdout: result.transcript,
    stderr: "",
    exitCode: result.exitCode,
    aborted: result.aborted,
    terminalTranscript: result.transcript,
    terminalMode: result.terminalMode,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  };
}
```

Move `options.terminal.onStart` before `spawnTerminalSession` in final code if the adapter needs the start event before output. The final behavior must emit `terminal:started` before the first output event.

- [ ] **Step 4: Verify scheduler event flow**

Run:

```bash
npx tsx --test tests/run-control.test.ts
```

Expected: PASS for the new event test and existing run-control tests.

## Task 4: Server Terminal Session Registry And Endpoints

**Files:**
- Modify: `src/server.ts`
- Modify: `src/types.ts`
- Test: `tests/server-product-api.test.ts`

- [ ] **Step 1: Write failing endpoint tests**

Add a server test that starts a long-running shell graph and posts terminal input:

```ts
test("server accepts terminal input and interrupt requests for an active run", async () => {
  const graphPath = join(project.rootPath, "input-terminal.vg.yaml");
  writeFileSync(
    graphPath,
    [
      'id: input_terminal',
      'version: "0.1.0"',
      'runtime:',
      '  workspace:',
      '    mode: local',
      'nodes:',
      '  - id: read_input',
      '    type: execute',
      '    backend: shell',
      '    command:',
      process.platform === "win32"
        ? '      program: cmd.exe\n      args: ["/c", "set /p x=&echo GOT:%x%"]'
        : '      program: sh\n      args: ["-lc", "read line; printf \\"GOT:%s\\\\n\\" \\"$line\\""]',
      'edges:',
      '  - from: graph.start',
      '    to: read_input.inputs.trigger',
      '',
    ].join("\n"),
    "utf-8"
  );

  const startResponse = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, graphAssetPath: "input-terminal.vg.yaml" }),
  });
  const started = await startResponse.json() as { runId: string };

  const inputResponse = await fetch(`${baseUrl}/api/runs/${started.runId}/terminal/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "hello\\n" }),
  });

  assert.equal(inputResponse.status, 204);
});
```

Run:

```bash
npx tsx --test tests/server-product-api.test.ts
```

Expected: FAIL with route not found.

- [ ] **Step 2: Add active terminal registry**

In `src/server.ts`, extend active run tracking:

```ts
const activeTerminals = new Map<string, TerminalSessionHandle>();
```

When starting `Scheduler.run`, pass:

```ts
registerTerminalSession: (session) => activeTerminals.set(runId, session),
unregisterTerminalSession: () => activeTerminals.delete(runId),
```

If these names are added to `SchedulerRunOptions`, update `src/types.ts` accordingly:

```ts
registerTerminalSession?: (session: TerminalSessionHandle) => void;
unregisterTerminalSession?: () => void;
```

Then forward those callbacks from `scheduler.ts` into `ExecuteRunner.run`.

- [ ] **Step 3: Add terminal routes**

In `handleRequest`, add routes before static serving:

```ts
const terminalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/terminal\/(input|resize|interrupt)$/);
if (terminalMatch && method === "POST") {
  const [, runId, action] = terminalMatch;
  const body = await parseBody(req);
  return handleTerminalAction(res, runId, action, body);
}
```

Add handler:

```ts
function handleTerminalAction(
  res: ServerResponse,
  runId: string,
  action: string,
  body: unknown
): void {
  const terminal = activeTerminals.get(runId);
  if (!terminal) {
    return sendError(res, "No active terminal for run", activeRuns.has(runId) ? 409 : 404);
  }

  if (action === "input") {
    const input = isRecord(body) && typeof body.input === "string" ? body.input : null;
    if (input === null) return sendError(res, "Invalid terminal input", 400);
    terminal.write(input);
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }

  if (action === "resize") {
    const cols = isRecord(body) ? Number(body.cols) : NaN;
    const rows = isRecord(body) ? Number(body.rows) : NaN;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 4) {
      return sendError(res, "Invalid terminal size", 400);
    }
    terminal.resize(cols, rows);
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }

  if (action === "interrupt") {
    terminal.interrupt();
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }

  sendError(res, "Unknown terminal action", 404);
}
```

- [ ] **Step 4: Verify routes**

Run:

```bash
npx tsx --test tests/server-product-api.test.ts
```

Expected: PASS for terminal endpoint tests.

## Task 5: Xterm UI Surface

**Files:**
- Modify: `src/ui/index.html`
- Modify: `src/ui/style.css`
- Modify: `src/ui/app.js`
- Test: `tests/ui-terminal-dock.test.ts`
- Test: `tests/ui-run-control.test.ts`

- [ ] **Step 1: Write failing UI source tests**

Add to `tests/ui-terminal-dock.test.ts`:

```ts
test("terminal dock mounts an xterm surface instead of only log rows", () => {
  assert.match(htmlSource, /id="terminal-xterm"/);
  assert.match(uiSource, /import\\(["']@xterm\\/xterm["']\\)/);
  assert.match(uiSource, /new Terminal\\(/);
  assert.match(uiSource, /terminal:output/);
  assert.match(uiSource, /terminal\\/resize/);
  assert.match(uiSource, /terminal\\/input/);
});
```

Run:

```bash
npx tsx --test tests/ui-terminal-dock.test.ts
```

Expected: FAIL because xterm is not mounted.

- [ ] **Step 2: Add xterm container**

In `src/ui/index.html`, inside `#terminal-content`, add:

```html
<div id="terminal-xterm" class="terminal-xterm" tabindex="0" aria-label="Active run terminal"></div>
<div id="terminal-fallback-lines" class="terminal-fallback-lines hidden"></div>
```

Keep the existing empty state only until `initTerminalSurface` runs.

- [ ] **Step 3: Add xterm CSS**

In `src/ui/style.css`, add:

```css
.terminal-content {
  min-height: 0;
  overflow: hidden;
}

.terminal-xterm {
  height: 100%;
  min-height: 160px;
  background: var(--terminal-bg);
}

.terminal-xterm .xterm {
  height: 100%;
  padding: 8px 10px;
}

.terminal-fallback-lines.hidden {
  display: none;
}
```

- [ ] **Step 4: Initialize xterm lazily**

In `src/ui/app.js`, add module-level state:

```js
let xtermTerminal = null;
let xtermFitAddon = null;
let xtermReady = false;
let terminalInputDisposable = null;
let terminalResizeObserver = null;
```

Add:

```js
async function initTerminalSurface() {
  if (xtermReady || !$("#terminal-xterm")) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  xtermTerminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    theme: terminalTheme(),
  });
  xtermFitAddon = new FitAddon();
  xtermTerminal.loadAddon(xtermFitAddon);
  xtermTerminal.open($("#terminal-xterm"));
  xtermFitAddon.fit();
  terminalInputDisposable = xtermTerminal.onData((input) => sendTerminalInput(input));
  terminalResizeObserver = new ResizeObserver(() => fitAndSendTerminalSize());
  terminalResizeObserver.observe($("#terminal-xterm"));
  xtermReady = true;
}
```

Add:

```js
function terminalTheme() {
  return {
    background: getComputedStyle(document.documentElement).getPropertyValue("--terminal-bg").trim() || "#0d1117",
    foreground: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#d8dee9",
  };
}
```

- [ ] **Step 5: Consume terminal events**

In `connectSSE`, add:

```js
eventSource.addEventListener("terminal:started", async (e) => {
  await initTerminalSurface();
  xtermTerminal?.clear();
  fitAndSendTerminalSize();
});

eventSource.addEventListener("terminal:output", async (e) => {
  const data = JSON.parse(e.data);
  await initTerminalSurface();
  xtermTerminal?.write(String(data.chunk ?? ""));
});

eventSource.addEventListener("terminal:ended", () => {
  fitAndSendTerminalSize();
});
```

Add API helpers:

```js
async function sendTerminalInput(input) {
  if (!currentRunId) return;
  await fetch(apiUrl(`/api/runs/${currentRunId}/terminal/input`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  }).catch(() => {});
}

async function fitAndSendTerminalSize() {
  if (!currentRunId || !xtermFitAddon || !xtermTerminal) return;
  xtermFitAddon.fit();
  await fetch(apiUrl(`/api/runs/${currentRunId}/terminal/resize`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cols: xtermTerminal.cols, rows: xtermTerminal.rows }),
  }).catch(() => {});
}
```

- [ ] **Step 6: Wire stop button to terminal interrupt first**

In `cancelRun`, before `DELETE /api/runs/:runId`, call:

```js
await fetch(apiUrl(`/api/runs/${currentRunId}/terminal/interrupt`), { method: "POST" }).catch(() => {});
```

Then keep the existing cancel request so the scheduler still finalizes the run.

- [ ] **Step 7: Verify UI tests**

Run:

```bash
npx tsx --test tests/ui-terminal-dock.test.ts tests/ui-run-control.test.ts
```

Expected: PASS.

## Task 6: Codex Final Output Capture

**Files:**
- Modify: `src/execute-runner.ts`
- Test: `tests/codex-runner.test.ts`

- [ ] **Step 1: Write failing Codex output file test**

Add to `tests/codex-runner.test.ts`:

```ts
test("codex backend captures final message from output-last-message file when using terminal mode", async () => {
  const tempRoot = join(tmpdir(), `agentgraph-codex-final-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const fakeCodex = fakeCliPath(tempRoot, "codex");

  writeFakeCli(
    fakeCodex,
    ["@echo off", "echo terminal noise", "echo FINAL_MESSAGE> %TEMP%\\codex-final.txt", "exit /b 0"],
    [
      "echo terminal noise >&2",
      "out=''",
      "prev=''",
      "for arg in \"$@\"; do if [ \"$prev\" = '--output-last-message' ]; then out=\"$arg\"; fi; prev=\"$arg\"; done",
      "printf 'FINAL_MESSAGE\\n' > \"$out\"",
      "exit 0",
    ]
  );

  const previousPath = process.env.AGENTGRAPH_CODEX_PATH;
  process.env.AGENTGRAPH_CODEX_PATH = fakeCodex;
  try {
    const node: ExecuteNode = {
      id: "implement_feature",
      type: "execute",
      backend: "codex",
      promptTemplate: "Implement one small task.",
      execution: { workspaceAccess: "write", timeoutMs: 5_000 },
    };

    const result = await ExecuteRunner.run(node, "activation_final", tempRoot, createContext(), {
      terminal: { enabled: true },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "FINAL_MESSAGE");
    assert.match(result.terminalTranscript ?? "", /terminal noise/);
  } finally {
    if (previousPath === undefined) delete process.env.AGENTGRAPH_CODEX_PATH;
    else process.env.AGENTGRAPH_CODEX_PATH = previousPath;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
```

Run:

```bash
npx tsx --test tests/codex-runner.test.ts
```

Expected: FAIL until Codex uses `--output-last-message`.

- [ ] **Step 2: Add output-last-message to Codex args in terminal mode**

In `runCodex`, create a temp output path:

```ts
const finalMessagePath = join(tmpdir(), `agentgraph-codex-${activationId}.txt`);
```

Add args before `"-"`:

```ts
if (options.terminal?.enabled) {
  args.push("--output-last-message", finalMessagePath);
}
```

After the process ends:

```ts
const finalMessage = options.terminal?.enabled && existsSync(finalMessagePath)
  ? readFileSync(finalMessagePath, "utf-8").trimEnd()
  : result.stdout;
```

Return `stdout: finalMessage` and `terminalTranscript: result.transcript`.

- [ ] **Step 3: Run Codex tests**

Run:

```bash
npx tsx --test tests/codex-runner.test.ts
```

Expected: PASS.

## Task 7: Browser Verification

**Files:**
- No source changes required unless verification finds a UI issue.
- Evidence: screenshot path under `.superpowers/verification/`.

- [ ] **Step 1: Start the dev server**

Run:

```bash
PORT=3456 npm start
```

Expected: `AgentGraph UI available at http://localhost:3456`.

- [ ] **Step 2: Open the UI and run a terminal smoke graph**

Use Playwright or the Browser plugin to open:

```text
http://127.0.0.1:3456
```

Create or open a graph with a shell node that prints colors:

```yaml
id: terminal_smoke
version: "0.1.0"
runtime:
  workspace:
    mode: local
nodes:
  - id: color_output
    type: execute
    backend: shell
    command:
      program: sh
      args: ["-lc", "printf '\\033[32mgreen\\033[0m\\n'; for i in 1 2 3; do printf '\\rstep %s' \"$i\"; sleep 0.1; done; printf '\\n'"]
edges:
  - from: graph.start
    to: color_output.inputs.trigger
```

Expected:

- Terminal tab shows a single terminal viewport.
- `green` renders in green.
- The `step` line behaves as terminal output, not a list of stderr/stdout rows.
- The run finishes with status success.

- [ ] **Step 3: Capture screenshot**

Save a screenshot:

```text
.superpowers/verification/real-terminal-v1.png
```

Expected: screenshot shows the xterm surface inside the bottom dock.

## Task 8: Full Verification

**Files:**
- All touched files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx tsx --test tests/terminal-session.test.ts tests/codex-runner.test.ts tests/run-control.test.ts tests/ui-terminal-dock.test.ts tests/ui-run-control.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass except existing intentional skips.

- [ ] **Step 4: Check whitespace**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

## Self-Review

Spec coverage:

- xterm UI: Task 5.
- PTY backend: Task 2 and Task 3.
- terminal events: Task 3.
- input/resize/interrupt endpoints: Task 4 and Task 5.
- Codex final output capture: Task 6.
- fallback path: Task 2 and Task 3.
- visual/manual verification: Task 7.
- full verification: Task 8.

Risk notes:

- `node-pty` is a native dependency. If install fails in the local environment, keep the fallback path working and report the build error before substituting another PTY library.
- PTY merges stdout and stderr. Graph decisions must continue to use structured outputs where available, especially Codex final output from `--output-last-message`.
- Existing uncommitted diagnostics-display changes should be preserved; do not revert them while implementing this plan.
