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
const MAX_AGENT_EVENTS = 5_000;
const MAX_PENDING_CHARS = MAX_TRANSCRIPT_CHARS;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedAppend(
  current: string,
  chunk: string,
  maxLength = MAX_TRANSCRIPT_CHARS
): string {
  const next = current + chunk;
  return next.length <= maxLength
    ? next
    : next.slice(-maxLength);
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

export function parseCodexTerminalEvent(event: unknown): AgentTerminalEvent {
  const outer = recordValue(event) ?? {};
  const payload = recordValue(outer.payload) ?? outer;
  const item = recordValue(payload.item);
  const source = item ?? payload;
  const type =
    [
      stringValue(payload.type),
      stringValue(outer.type),
      stringValue(item?.type),
    ].find(Boolean) ?? "";

  if (type.includes("session")) {
    return { backend: "codex", kind: "session", raw: event };
  }

  if (type.includes("reasoning")) {
    return {
      backend: "codex",
      kind: "reasoning",
      text: textFromRecord(source),
      raw: event,
    };
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
  return textFromContent(record.content);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = recordValue(part);
      return (
        stringValue(record?.text) ??
        stringValue(record?.output_text) ??
        stringValue(record?.summary) ??
        ""
      );
    })
    .filter(Boolean)
    .join("");
}

function formatCommand(record: Record<string, unknown>): string {
  const command = record.command;
  if (Array.isArray(command)) {
    return truncateSingleLine(command.map(String).join(" "), 180);
  }
  return truncateSingleLine(
    stringValue(command) ?? stringValue(record.cmd) ?? "",
    180
  );
}

export function parseClaudeTerminalEvent(event: unknown): AgentTerminalEvent {
  const record = recordValue(event) ?? {};
  const type = stringValue(record.type) ?? "";

  if (type === "system") {
    return { backend: "claude", kind: "session", raw: event };
  }

  if (type === "assistant") {
    return parseClaudeAssistantContent(recordValue(record.message)?.content, event);
  }

  if (type === "user") {
    const content = recordValue(record.message)?.content;
    if (
      Array.isArray(content) &&
      content.some((item) => recordValue(item)?.type === "tool_result")
    ) {
      return { backend: "claude", kind: "tool_result", raw: event };
    }
    return {
      backend: "claude",
      kind: "unknown",
      text: claudeTextFromContent(content),
      raw: event,
    };
  }

  if (type === "result") {
    const subtype = stringValue(record.subtype) ?? "done";
    const isError =
      subtype.toLowerCase().includes("error") ||
      subtype.toLowerCase().includes("fail");
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

function parseClaudeAssistantContent(
  content: unknown,
  raw: unknown
): AgentTerminalEvent {
  if (!Array.isArray(content)) {
    return { backend: "claude", kind: "assistant_text", text: "", raw };
  }

  const textParts: string[] = [];
  const toolUses: Array<{ name: string; summary: string }> = [];
  for (const item of content) {
    const record = recordValue(item);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    }
    if (record.type === "tool_use") {
      toolUses.push({
        name: stringValue(record.name) ?? "tool",
        summary: claudeToolInputSummary(record.input),
      });
    }
  }

  if (toolUses.length > 0) {
    return {
      backend: "claude",
      kind: "tool_start",
      text: textParts.join(""),
      toolName: toolUses.map((toolUse) => toolUse.name).join(", "),
      command: toolUses
        .map((toolUse) => toolUse.summary)
        .filter(Boolean)
        .join("; "),
      raw,
    };
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
    const detail = [event.toolName, event.command]
      .filter(Boolean)
      .join(" ");
    const toolLine = `${label} tool ${truncateSingleLine(detail || "tool", 180)}\n`;
    if (!event.text) return toolLine;
    return `${event.text}${event.text.endsWith("\n") ? "" : "\n"}${toolLine}`;
  }

  if (event.kind === "error") {
    return `${label} error ${truncateSingleLine(event.text || "error", 220)}\n`;
  }

  if (event.kind === "final_result") {
    return event.text
      ? `${label} done ${truncateSingleLine(event.text, 180)}\n`
      : `${label} done\n`;
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

  const parse =
    backend === "codex" ? parseCodexTerminalEvent : parseClaudeTerminalEvent;

  const acceptLine = (line: string): string => {
    if (!line.trim()) return "";
    let parsed: AgentTerminalEvent;
    try {
      parsed = parse(JSON.parse(line));
    } catch {
      parsed = { backend, kind: "unknown", text: line, raw: line };
    }
    events.push(summarizeAgentEvent(parsed));
    if (events.length > MAX_AGENT_EVENTS) {
      events.splice(0, events.length - MAX_AGENT_EVENTS);
    }
    if (
      (parsed.kind === "assistant_text" || parsed.kind === "final_result") &&
      parsed.text
    ) {
      finalText = parsed.text;
    }
    return presentAgentTerminalEvent(parsed);
  };

  return {
    acceptChunk(chunk: string): AgentTerminalChunkResult {
      rawTranscript = boundedAppend(rawTranscript, chunk);
      pending = boundedAppend(pending, chunk, MAX_PENDING_CHARS);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      let visibleChunk = "";

      for (const line of lines) {
        visibleChunk += acceptLine(line);
      }

      visibleTranscript = boundedAppend(visibleTranscript, visibleChunk);
      return { visibleChunk, finalText: finalText || undefined };
    },

    flush(): AgentTerminalChunkResult {
      if (!pending.trim()) {
        return { visibleChunk: "", finalText: finalText || undefined };
      }
      const line = pending;
      pending = "";
      const visibleChunk = acceptLine(line);
      visibleTranscript = boundedAppend(visibleTranscript, visibleChunk);
      return { visibleChunk, finalText: finalText || undefined };
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
