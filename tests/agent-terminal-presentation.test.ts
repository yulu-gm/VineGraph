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
