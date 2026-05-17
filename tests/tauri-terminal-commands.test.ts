import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf-8");
const mainSource = readFileSync("src-tauri/src/main.rs", "utf-8");
const ptySource = readFileSync("src-tauri/src/pty_session.rs", "utf-8");

const terminalCommands = [
  "terminal_create_session",
  "terminal_attach_session",
  "terminal_write",
  "terminal_resize",
  "terminal_interrupt",
  "terminal_close",
  "terminal_list",
  "terminal_portable_pty_capability",
];

test("Tauri terminal source declares portable-pty and desktop commands", () => {
  assert.match(cargoToml, /portable-pty\s*=\s*"0\.9"/);

  for (const command of terminalCommands) {
    assert.match(mainSource, new RegExp(`fn\\s+${command}\\b`));
    assert.match(
      mainSource,
      new RegExp(`generate_handler!\\[[\\s\\S]*\\b${command}\\b[\\s\\S]*\\]`)
    );
  }
});

test("Tauri terminal source declares runtime events and Rust manager controls", () => {
  for (const eventName of [
    "terminal://session-started",
    "terminal://output",
    "terminal://resized",
    "terminal://status",
    "terminal://ended",
  ]) {
    assert.match(mainSource, new RegExp(`"${eventName.replaceAll("/", "\\/")}"`));
  }

  for (const method of [
    "create_session",
    "attach_session",
    "write",
    "resize",
    "interrupt",
    "close_session",
    "shutdown_all",
    "list_sessions",
    "portable_pty_available",
  ]) {
    assert.match(ptySource, new RegExp(`pub\\s+fn\\s+${method}\\b`));
  }

  assert.match(ptySource, /pub\s+terminal_session_id:\s+String/);
  assert.match(ptySource, /terminal_session_id:\s+session_id\.clone\(\)/);
});

test("Tauri terminal resize and shutdown lifecycle are explicitly wired", () => {
  assert.match(mainSource, /const\s+TERMINAL_RESIZED_EVENT:\s*&str\s*=\s*"terminal:\/\/resized"/);
  assert.match(mainSource, /PtySessionEvent::Resized\([^)]*\)\s*=>\s*\{[\s\S]*app\.emit\(TERMINAL_RESIZED_EVENT/);
  assert.match(mainSource, /fn\s+terminal_resize[\s\S]*PtySessionEvent::Resized\(summary\.clone\(\)\)/);

  assert.match(mainSource, /WindowEvent::Destroyed[\s\S]*state::<PtySessionManager>\(\)/);
  assert.match(mainSource, /WindowEvent::Destroyed[\s\S]*shutdown_all\(\)/);
});

test("Tauri terminal capability uses a native pty probe instead of a hardcoded flag", () => {
  assert.doesNotMatch(
    ptySource,
    /pub\s+fn\s+portable_pty_available\(&self\)\s*->\s*bool\s*\{\s*true\s*\}/
  );
  assert.match(ptySource, /native_pty_system\(\)[\s\S]*openpty/);
  assert.match(ptySource, /PtySize\s*\{[\s\S]*cols:\s*1[\s\S]*rows:\s*1/);
});
