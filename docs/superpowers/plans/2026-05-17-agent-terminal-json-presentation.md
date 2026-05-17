# Agent Terminal JSON Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Codex / Claude backend 的 Terminal 默认呈现 Clean CLI 输出，隐藏 session、reasoning、tool result 和成功命令完整结果，同时保留 raw agent transcript 供调试追溯。

**Architecture:** 新增一个独立 agent terminal presentation 模块，把 Codex / Claude JSON stream 先归一成 `AgentTerminalEvent`，再由 Clean CLI presenter 决定可见输出。`execute-runner.ts` 只负责 JSONL 分片、调用 formatter、发送可见 terminal chunk，并把 raw transcript、visible transcript、final stdout 分开保存。

**Tech Stack:** TypeScript ESM, Node.js `node:test`, `tsx --test`, existing Scheduler / ExecuteRunner / xterm terminal event path.

---

## File Map

- Modify `package.json`
  增加当前仓库缺失的 `test` script，使用 `tsx --test tests/*.test.ts`。

- Create `tests/agent-terminal-presentation.test.ts`
  覆盖 Codex / Claude fixture 的 Clean CLI 展示规则、raw transcript 保留、JSONL chunk 分片和 final stdout 提取。

- Create `src/agent-terminal-presentation.ts`
  定义统一事件模型、Codex adapter、Claude adapter、Clean CLI presenter、bounded transcript helper 和 streaming formatter。

- Modify `src/types.ts`
  为 `RawExecutionResult` 增加 `agentRawTranscript?: string` 和 `agentEvents?: AgentEventSummary[]`。

- Modify `src/execute-runner.ts`
  移除内联 `formatCodexStreamEvent` / `formatClaudeStreamEvent` 的展示职责，改用 `createAgentTerminalStreamFormatter()`；保持 shell / git PTY 行为不变。

- Modify `src/ui/app.js`
  在 Inspector / Detail 中显示 `agentRawTranscript` 的短入口，避免隐藏信息只能从 JSON 文件里找。Live Terminal 不需要理解 agent event 类型。

- Verify with:
  - `npm.cmd test`
  - `npm.cmd run typecheck`
  - one local graph run that exercises a Codex node when credentials are available

---

## Task 1: Add Test Script And Agent Presentation Fixtures

> **Done:** `npm.cmd test` → `ERR_MODULE_NOT_FOUND` (expected — `src/agent-terminal-presentation.ts` not yet created). All 4 red fixtures exist and import from the missing module.

**Files:**
- Modify: `package.json`
- Create: `tests/agent-terminal-presentation.test.ts`

- [x] **Step 1: Add the test script**

Edit `package.json` scripts to include:

```json
{
  "scripts": {
    "start": "tsx src/index.ts",
    "example": "tsx src/index.ts examples/simple-test.yaml",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test tests/*.test.ts",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  }
}
```

- [x] **Step 2: Create the failing fixture tests**

Create `tests/agent-terminal-presentation.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentTerminalStreamFormatter,
  presentAgentTerminalEvent,
  parseCodexTerminalEvent,
  parseClaudeTerminalEvent,
} from "../src/agent-terminal-presentation.js";

test("Codex Clean CLI hides session, reasoning, and successful command output", () => {
  const events = [
    { type: "session.started", payload: { session_id: "session-12345678", model: "gpt-5.5" } },
    { type: "response.reasoning_summary_text.delta", payload: { text: "internal chain" } },
    { type: "exec_command_begin", payload: { command: "npm.cmd test" } },
    {
      type: "exec_command_end",
      payload: {
        exit_code: 0,
        duration_ms: 1200,
        stdout: "very noisy passing output\nline 2",
      },
    },
    { type: "agent_message", payload: { text: "Implemented the parser." } },
  ];

  const visible = events
    .map((event) => presentAgentTerminalEvent(parseCodexTerminalEvent(event)))
    .join("");

  assert.doesNotMatch(visible, /session-12345678/);
  assert.doesNotMatch(visible, /internal chain/);
  assert.doesNotMatch(visible, /very noisy passing output/);
  assert.match(visible, /Codex command npm\.cmd test/);
  assert.match(visible, /Codex command ok exit 0 1s/);
  assert.match(visible, /Implemented the parser\./);
});

test("Codex Clean CLI shows failed command stderr summary", () => {
  const event = {
    type: "exec_command_end",
    payload: {
      exit_code: 2,
      duration_ms: 2400,
      stderr: "first failure line\nsecond failure line\nthird failure line",
    },
  };

  const visible = presentAgentTerminalEvent(parseCodexTerminalEvent(event));

  assert.match(visible, /Codex command failed exit 2 2s/);
  assert.match(visible, /first failure line/);
  assert.match(visible, /second failure line/);
});

test("Claude Clean CLI hides tool_result but keeps assistant text and tool summary", () => {
  const assistant = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I will run the tests." },
        { type: "tool_use", name: "Bash", input: { command: "npm.cmd test" } },
      ],
    },
  };
  const toolResult = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", content: [{ type: "text", text: "large test output" }] },
      ],
    },
  };

  const visible =
    presentAgentTerminalEvent(parseClaudeTerminalEvent(assistant)) +
    presentAgentTerminalEvent(parseClaudeTerminalEvent(toolResult));

  assert.match(visible, /I will run the tests\./);
  assert.match(visible, /Claude tool Bash npm\.cmd test/);
  assert.doesNotMatch(visible, /large test output/);
});

test("stream formatter handles split JSONL and keeps raw transcript", () => {
  const formatter = createAgentTerminalStreamFormatter("codex");
  const line = JSON.stringify({ type: "agent_message", payload: { text: "hello from codex" } }) + "\n";

  const first = formatter.acceptChunk(line.slice(0, 10));
  const second = formatter.acceptChunk(line.slice(10));

  assert.equal(first.visibleChunk, "");
  assert.match(second.visibleChunk, /hello from codex/);
  assert.equal(formatter.finalText.trim(), "hello from codex");
  assert.match(formatter.rawTranscript, /agent_message/);
  assert.match(formatter.visibleTranscript, /hello from codex/);
});
```

- [x] **Step 3: Run the failing test**

Run:

```powershell
npm.cmd test
```

Expected before implementation: FAIL because `src/agent-terminal-presentation.ts` does not exist.

- [x] **Step 4: Commit the red tests**

```powershell
git add package.json tests/agent-terminal-presentation.test.ts
git commit -m "test: cover agent terminal clean cli presentation"
```

---

## Task 2: Implement Agent Terminal Presentation Module

**Files:**
- Create: `src/agent-terminal-presentation.ts`
- Test: `tests/agent-terminal-presentation.test.ts`

- [ ] **Step 1: Add event types and helpers**

Create `src/agent-terminal-presentation.ts` with:

```ts
import type { Backend } from "./types.js";

export type AgentBackend = Extract<Backend, "codex" | "claude">;

export type AgentTerminalEventKind =
  | "session"
  | "assistant_text"
  | "reasoning"
  | "command_start"
  | "command_end"
  | "tool_start"
  | "tool_result"
  | "final_result"
  | "error"
  | "lifecycle"
  | "unknown";

export interface AgentTerminalEvent {
  backend: AgentBackend;
  kind: AgentTerminalEventKind;
  text?: string;
  command?: string;
  toolName?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  failed?: boolean;
  raw: unknown;
}

export interface AgentTerminalChunkResult {
  visibleChunk: string;
  finalText?: string;
}

export interface AgentEventSummary {
  backend: AgentBackend;
  kind: AgentTerminalEventKind;
  text?: string;
  command?: string;
  toolName?: string;
  exitCode?: number;
  durationMs?: number;
  failed?: boolean;
}

const MAX_TRANSCRIPT_CHARS = 1_000_000;
const MAX_VISIBLE_DETAIL_CHARS = 1200;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_TRANSCRIPT_CHARS
    ? next
    : next.slice(-MAX_TRANSCRIPT_CHARS);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}...`;
}

function truncateBlock(value: string, maxLength = MAX_VISIBLE_DETAIL_CHARS): string {
  const clean = value.trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}...`;
}

function durationText(durationMs: unknown): string {
  const ms = numberValue(durationMs);
  if (ms === undefined) return "";
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}
```

- [ ] **Step 2: Implement Codex adapter**

Add:

```ts
export function parseCodexTerminalEvent(event: unknown): AgentTerminalEvent {
  const outer = recordValue(event) ?? {};
  const payload = recordValue(outer.payload) ?? outer;
  const item = recordValue(payload.item);
  const source = item ?? payload;
  const type = [
    stringValue(payload.type),
    stringValue(outer.type),
    stringValue(item?.type),
  ].find(Boolean) ?? "";

  if (type.includes("session")) {
    return { backend: "codex", kind: "session", raw: event };
  }

  if (type.includes("reasoning")) {
    return { backend: "codex", kind: "reasoning", text: textFromRecord(source), raw: event };
  }

  if (type.includes("exec_command_begin") || type.includes("command_begin")) {
    return {
      backend: "codex",
      kind: "command_start",
      command: formatCommand(source),
      raw: event,
    };
  }

  if (type.includes("exec_command_end") || type.includes("command_end")) {
    const exitCode =
      numberValue(source.exit_code) ??
      numberValue(source.exitCode) ??
      numberValue(source.code);
    const failed = exitCode !== undefined && exitCode !== 0;
    return {
      backend: "codex",
      kind: "command_end",
      exitCode,
      durationMs: numberValue(source.duration_ms),
      stdout: stringValue(source.stdout),
      stderr: stringValue(source.stderr),
      failed,
      raw: event,
    };
  }

  if (type.includes("tool") || type.includes("function_call")) {
    return {
      backend: "codex",
      kind: type.includes("result") ? "tool_result" : "tool_start",
      toolName: stringValue(source.name) ?? stringValue(source.tool_name) ?? "tool",
      text: textFromRecord(source),
      raw: event,
    };
  }

  if (type.includes("message") || type.includes("assistant")) {
    return {
      backend: "codex",
      kind: "assistant_text",
      text: textFromRecord(source),
      raw: event,
    };
  }

  if (type.includes("error") || type.includes("failed")) {
    return {
      backend: "codex",
      kind: "error",
      text: textFromRecord(source) || stringValue(source.error) || type,
      raw: event,
    };
  }

  if (type.includes("result") || type.includes("completed") || type.includes("end")) {
    return {
      backend: "codex",
      kind: "final_result",
      text: textFromRecord(source),
      raw: event,
    };
  }

  return {
    backend: "codex",
    kind: textFromRecord(source) ? "unknown" : "lifecycle",
    text: textFromRecord(source),
    raw: event,
  };
}

function textFromRecord(record: Record<string, unknown> | undefined): string {
  if (!record) return "";
  for (const key of ["message", "text", "delta", "output", "output_text", "summary", "reason", "result"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return textFromContent(record.content);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = recordValue(part);
      return stringValue(record?.text) ?? stringValue(record?.output_text) ?? stringValue(record?.summary) ?? "";
    })
    .filter(Boolean)
    .join("");
}

function formatCommand(record: Record<string, unknown>): string {
  const command = record.command;
  if (Array.isArray(command)) return truncateSingleLine(command.map(String).join(" "), 180);
  return truncateSingleLine(stringValue(command) ?? stringValue(record.cmd) ?? "", 180);
}
```

- [ ] **Step 3: Implement Claude adapter**

Add:

```ts
export function parseClaudeTerminalEvent(event: unknown): AgentTerminalEvent {
  const record = recordValue(event) ?? {};
  const type = stringValue(record.type) ?? "";

  if (type === "system") {
    return { backend: "claude", kind: "session", raw: event };
  }

  if (type === "assistant") {
    return parseClaudeAssistantContent(
      recordValue(record.message)?.content,
      event
    );
  }

  if (type === "user") {
    const content = recordValue(record.message)?.content;
    if (Array.isArray(content) && content.some((item) => recordValue(item)?.type === "tool_result")) {
      return { backend: "claude", kind: "tool_result", raw: event };
    }
    return { backend: "claude", kind: "unknown", text: claudeTextFromContent(content), raw: event };
  }

  if (type === "result") {
    const subtype = stringValue(record.subtype) ?? "done";
    const isError = subtype.toLowerCase().includes("error") || subtype.toLowerCase().includes("fail");
    return {
      backend: "claude",
      kind: isError ? "error" : "final_result",
      text: stringValue(record.result) ?? subtype,
      durationMs: numberValue(record.duration_ms),
      failed: isError,
      raw: event,
    };
  }

  return { backend: "claude", kind: "lifecycle", raw: event };
}

function parseClaudeAssistantContent(content: unknown, raw: unknown): AgentTerminalEvent {
  if (!Array.isArray(content)) {
    return { backend: "claude", kind: "assistant_text", text: "", raw };
  }

  const textParts: string[] = [];
  for (const item of content) {
    const record = recordValue(item);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    }
    if (record.type === "tool_use") {
      return {
        backend: "claude",
        kind: "tool_start",
        toolName: stringValue(record.name) ?? "tool",
        command: claudeToolInputSummary(record.input),
        raw,
      };
    }
  }

  return {
    backend: "claude",
    kind: "assistant_text",
    text: textParts.join(""),
    raw,
  };
}

function claudeTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => stringValue(recordValue(item)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function claudeToolInputSummary(input: unknown): string {
  const record = recordValue(input);
  if (!record) return "";
  for (const key of ["command", "file_path", "path", "description"]) {
    const value = stringValue(record[key]);
    if (value) return truncateSingleLine(value, 160);
  }
  return Object.keys(record).slice(0, 4).join(", ");
}
```

- [ ] **Step 4: Implement Clean CLI presenter and stream formatter**

Add:

```ts
export function presentAgentTerminalEvent(event: AgentTerminalEvent): string {
  const label = event.backend === "codex" ? "Codex" : "Claude";

  if (event.kind === "assistant_text") {
    return event.text ? `${event.text}${event.text.endsWith("\n") ? "" : "\n"}` : "";
  }

  if (event.kind === "command_start") {
    return `${label} command ${event.command || "command"}\n`;
  }

  if (event.kind === "command_end") {
    const status = event.failed ? "failed" : "ok";
    const exit = event.exitCode !== undefined ? ` exit ${event.exitCode}` : "";
    const duration = durationText(event.durationMs);
    const header = `${label} command ${status}${exit}${duration ? ` ${duration}` : ""}\n`;
    if (!event.failed) return header;
    const detail = truncateBlock(event.stderr || event.stdout || "");
    return detail ? `${header}${detail}\n` : header;
  }

  if (event.kind === "tool_start") {
    const detail = [event.toolName, event.command || event.text]
      .filter(Boolean)
      .join(" ");
    return `${label} tool ${truncateSingleLine(detail || "tool", 180)}\n`;
  }

  if (event.kind === "error") {
    return `${label} error ${truncateSingleLine(event.text || "error", 220)}\n`;
  }

  if (event.kind === "final_result") {
    return event.text ? `${label} done ${truncateSingleLine(event.text, 180)}\n` : `${label} done\n`;
  }

  if (event.kind === "unknown" && event.text && event.text.length <= 500) {
    return `${event.text}${event.text.endsWith("\n") ? "" : "\n"}`;
  }

  return "";
}

export function summarizeAgentEvent(event: AgentTerminalEvent): AgentEventSummary {
  return {
    backend: event.backend,
    kind: event.kind,
    ...(event.text ? { text: truncateSingleLine(event.text, 240) } : {}),
    ...(event.command ? { command: truncateSingleLine(event.command, 240) } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.failed !== undefined ? { failed: event.failed } : {}),
  };
}

export function createAgentTerminalStreamFormatter(backend: AgentBackend) {
  let pending = "";
  let rawTranscript = "";
  let visibleTranscript = "";
  let finalText = "";
  const events: AgentEventSummary[] = [];

  const parse = backend === "codex" ? parseCodexTerminalEvent : parseClaudeTerminalEvent;

  return {
    acceptChunk(chunk: string): AgentTerminalChunkResult {
      rawTranscript = boundedAppend(rawTranscript, chunk);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      let visibleChunk = "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: AgentTerminalEvent;
        try {
          parsed = parse(JSON.parse(line));
        } catch {
          parsed = { backend, kind: "unknown", text: line, raw: line };
        }
        events.push(summarizeAgentEvent(parsed));
        if ((parsed.kind === "assistant_text" || parsed.kind === "final_result") && parsed.text) {
          finalText = parsed.text;
        }
        visibleChunk += presentAgentTerminalEvent(parsed);
      }

      visibleTranscript = boundedAppend(visibleTranscript, visibleChunk);
      return { visibleChunk, finalText: finalText || undefined };
    },

    flush(): AgentTerminalChunkResult {
      if (!pending.trim()) return { visibleChunk: "", finalText: finalText || undefined };
      const line = pending;
      pending = "";
      return this.acceptChunk(`${line}\n`);
    },

    get rawTranscript() {
      return rawTranscript;
    },

    get visibleTranscript() {
      return visibleTranscript;
    },

    get finalText() {
      return finalText;
    },

    get events() {
      return events;
    },
  };
}
```

- [ ] **Step 5: Verify module tests pass**

Run:

```powershell
npm.cmd test -- tests/agent-terminal-presentation.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/agent-terminal-presentation.ts tests/agent-terminal-presentation.test.ts
git commit -m "feat: add agent terminal presentation layer"
```

---

## Task 3: Wire Execute Runner To Clean CLI Formatter

**Files:**
- Modify: `src/types.ts`
- Modify: `src/execute-runner.ts`
- Test: `tests/agent-terminal-presentation.test.ts`

- [ ] **Step 1: Add raw transcript result fields**

In `src/types.ts`, import the summary type:

```ts
import type { AgentEventSummary } from "./agent-terminal-presentation.js";
```

Then extend `RawExecutionResult`:

```ts
  terminalTranscript?: string;
  agentRawTranscript?: string;
  agentEvents?: AgentEventSummary[];
  terminalMode?: "pty" | "stream";
```

- [ ] **Step 2: Update `TerminalCommandResult`**

In `src/execute-runner.ts`, import:

```ts
import { createAgentTerminalStreamFormatter } from "./agent-terminal-presentation.js";
```

Extend `TerminalCommandResult`:

```ts
interface TerminalCommandResult extends SpawnResult {
  terminalSessionId: string;
  terminalTranscript: string;
  agentRawTranscript?: string;
  agentEvents?: AgentEventSummary[];
  terminalMode: "pty" | "stream";
}
```

If the import type is needed separately:

```ts
import type { AgentEventSummary } from "./agent-terminal-presentation.js";
```

- [ ] **Step 3: Replace Claude stream formatting**

Inside `spawnClaudeTerminalStreamCommand()`, replace `terminalTranscript`, `jsonLineBuffer`, and `resultText` local parsing with:

```ts
const formatter = createAgentTerminalStreamFormatter("claude");
let resultText = "";

const emitVisible = (chunk: string, stream: "stdout" | "stderr" = "stdout") => {
  if (!chunk) return;
  opts.terminal.onOutput?.(chunk);
  opts.onOutput?.({ backend: "claude", stream, chunk });
};

const handleStdoutChunk = (chunk: string) => {
  const formatted = formatter.acceptChunk(chunk);
  if (formatted.finalText !== undefined) resultText = formatted.finalText;
  emitVisible(formatted.visibleChunk);
};
```

On stderr:

```ts
emitVisible(event.chunk, "stderr");
```

Before return:

```ts
const flushed = formatter.flush();
if (flushed.finalText !== undefined) resultText = flushed.finalText;
emitVisible(flushed.visibleChunk);
```

Return:

```ts
terminalTranscript: formatter.visibleTranscript,
agentRawTranscript: formatter.rawTranscript,
agentEvents: formatter.events,
```

- [ ] **Step 4: Replace Codex stream formatting**

Apply the same pattern in `spawnCodexTerminalJsonCommand()` with:

```ts
const formatter = createAgentTerminalStreamFormatter("codex");
```

Return:

```ts
terminalTranscript: formatter.visibleTranscript,
agentRawTranscript: formatter.rawTranscript,
agentEvents: formatter.events,
```

Keep Codex final stdout priority exactly as it is now:

```ts
const stdout = finalMessagePath && existsSync(finalMessagePath)
  ? readFileSync(finalMessagePath, "utf-8").trimEnd()
  : result.stdout;
```

- [ ] **Step 5: Delete obsolete inline formatter helpers**

Remove from `src/execute-runner.ts` once no callers remain:

- `ClaudeStreamFormatResult`
- `CodexStreamFormatResult`
- `formatCodexStreamLine`
- `formatCodexStreamEvent`
- `codexTextFromRecord`
- `codexTextFromContent`
- `formatCodexCommand`
- `formatCodexTool`
- `formatCodexDuration`
- `extractCodexResultText` if no longer used
- `formatClaudeStreamLine`
- `formatClaudeStreamEvent`
- `formatClaudeMessageContent`
- `formatClaudeRecordDetail`
- `formatClaudeToolInput`
- `firstString`
- `summarizeObjectKeys`
- `formatClaudeToolResult`
- `extractClaudeResultText` if no longer used

Keep shared ANSI / PTY helpers that are still used by shell / git terminal paths.

- [ ] **Step 6: Verify execute runner integration**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: tests pass and `tsc --noEmit` exits with code 0.

- [ ] **Step 7: Commit**

```powershell
git add src/types.ts src/execute-runner.ts src/agent-terminal-presentation.ts tests/agent-terminal-presentation.test.ts
git commit -m "feat: use clean cli output for agent terminal streams"
```

---

## Task 4: Surface Raw Agent Transcript In Details

**Files:**
- Modify: `src/ui/app.js`
- Test: `tests/agent-terminal-presentation.test.ts`

- [ ] **Step 1: Add UI source assertions**

Add to `tests/agent-terminal-presentation.test.ts`:

```ts
import { readFileSync } from "node:fs";

test("UI exposes raw agent transcript outside the live terminal", () => {
  const uiSource = readFileSync("src/ui/app.js", "utf-8");
  assert.match(uiSource, /agentRawTranscript/);
  assert.match(uiSource, /Raw agent transcript/);
});
```

- [ ] **Step 2: Run the failing assertion**

Run:

```powershell
npm.cmd test -- tests/agent-terminal-presentation.test.ts
```

Expected before UI change: FAIL because `agentRawTranscript` is not rendered.

- [ ] **Step 3: Add detail rendering for raw transcript**

In `src/ui/app.js`, inside `renderRuntimeInspect(activation)` after stderr rendering, add:

```js
    if (result.agentRawTranscript) {
      html += renderInspectStream(
        "Raw agent transcript",
        result.agentRawTranscript,
        "diagnostics"
      );
    }
```

Inside `renderDetail(activation)`, after stderr rendering, add:

```js
    if (r.agentRawTranscript) {
      html += `<div class="detail-section diagnostics-section"><h4>Raw agent transcript</h4><pre>${escapeHtml(r.agentRawTranscript)}</pre></div>`;
    }
```

- [ ] **Step 4: Verify UI source and typecheck**

Run:

```powershell
npm.cmd test -- tests/agent-terminal-presentation.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/ui/app.js tests/agent-terminal-presentation.test.ts
git commit -m "feat: expose raw agent transcript in details"
```

---

## Task 5: Final Verification

**Files:**
- No planned source edits unless verification exposes an issue.

- [ ] **Step 1: Run full automated verification**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: both commands pass.

- [ ] **Step 2: Run a local smoke graph**

Run:

```powershell
npm.cmd start -- examples/simple-test.yaml
```

Expected: run status is success and run record is written under `.agentgraph/runs/`.

- [ ] **Step 3: Optional Codex smoke when credentials are available**

Run a small Codex node graph or existing agent graph that can safely execute read-only behavior.

Expected Terminal behavior:

- no session id line
- no reasoning line
- no tool result body
- assistant final text visible
- failed command summaries visible when a command fails
- run record contains `agentRawTranscript`

- [ ] **Step 4: Commit any verification fixes**

If verification required fixes:

```powershell
git add <changed-files>
git commit -m "fix: stabilize agent terminal presentation"
```

If no fixes were needed, no commit is required for this task.

---

## Final Acceptance

Run from `C:\Users\yulu\Documents\VineGraph\VineGraph`:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd start -- examples/simple-test.yaml
```

Acceptance:

- Codex / Claude Terminal visible transcript uses Clean CLI rules.
- `tool_result`, reasoning, session metadata, and successful command stdout do not appear in live Terminal.
- Failed commands and agent errors remain visible.
- `RawExecutionResult.stdout` remains the final agent result used by downstream nodes.
- `RawExecutionResult.terminalTranscript` stores visible Clean CLI transcript.
- `RawExecutionResult.agentRawTranscript` stores bounded raw JSONL transcript.
- Shell / git backend behavior is unchanged.

## Self-Review

- Spec coverage: tasks cover adapter, presenter, raw transcript preservation, execute runner integration, UI visibility for hidden data, and verification.
- Placeholder scan: no unspecified implementation slots remain; each task has file paths, concrete code snippets, commands, expected results, and commit commands.
- Type consistency: `AgentEventSummary`, `agentRawTranscript`, `agentEvents`, and `createAgentTerminalStreamFormatter()` are introduced before integration tasks use them.
