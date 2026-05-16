# Real Terminal v1 Design

## Goal

Replace the current stdout/stderr log-style Terminal tab with a real terminal experience for graph node execution. The user should be able to watch Codex, Claude, shell, and git nodes as if they were running in a CLI: ANSI colors, dynamic terminal updates, natural scrollback, copy/search, resize, and cancellation should behave like a normal command-line terminal.

This is part of the small-loop product work. It keeps the rest of the run UI structured: Timeline still explains node lifecycle, Detail still exposes prompts/results, Diff still shows workspace changes, and run history still stores the final run record.

## Current Problem

The current Terminal tab is a rendered list of streamed stdout/stderr chunks. It is useful for debugging, but it is not a terminal:

- stdout and stderr are rendered as separate labeled lines instead of a continuous terminal stream.
- ANSI support is partial and does not handle cursor movement or dynamic redraws well.
- Codex CLI output looks misleading because startup banners, diagnostics, and progress logs are treated as log rows.
- There is no PTY, so child processes do not receive a real terminal size or terminal semantics.
- The UI cannot send terminal input back to the running process.

## Scope

Real Terminal v1 covers one active run at a time and one displayed terminal stream at a time.

Included:

- Add `@xterm/xterm` for terminal rendering.
- Add a PTY layer for process execution, using `node-pty` if it builds cleanly in this project.
- Stream raw PTY output to the UI over the existing run event channel or a closely related event path.
- Write terminal input, resize events, and interrupt signals from UI to the active PTY process.
- Preserve structured run data: exit code, stdout/stderr or transcript, final agent output, workspace diff, patch, and run status.
- For Codex, prefer a structured final response capture such as `--output-last-message` instead of parsing terminal text.
- Fall back to the existing non-PTY execution path if PTY startup is unavailable, with a visible diagnostic.

Excluded:

- Multiple simultaneous interactive terminal tabs.
- Full interactive replay for historical runs.
- A general-purpose shell console unrelated to graph node execution.
- Replacing Timeline, Detail, Controller Decisions, or Diff panels.

## Architecture

### Frontend Terminal

The Terminal tab becomes an xterm surface mounted inside the existing resizable runtime dock.

Expected controls:

- Terminal viewport with native scrollback.
- Search, copy, clear-view, follow-scroll, and node filter remain available where they still make sense.
- Resize events propagate from the dock and browser viewport to the backend PTY.
- Keyboard input is forwarded only when the terminal tab is focused and the active node allows input.
- `Ctrl+C` maps to interrupting the active PTY process.

The existing log-line renderer can stay as a fallback path during the transition, but the primary live view should use xterm.

### Backend PTY Runner

Introduce a PTY execution adapter alongside the current `spawnProcess`/`spawnCommand` implementation.

The PTY adapter is responsible for:

- Starting the configured command in the selected workspace directory.
- Passing terminal size from the UI, with a safe default before the first resize event.
- Emitting raw terminal chunks.
- Recording a bounded transcript for run history.
- Ending with an exit code, duration, and cancellation status.
- Killing the process tree on run cancellation.

For shell/git nodes, stdout and stderr may be represented by the PTY transcript because real terminals merge streams. For agent nodes, the raw transcript is for display while final model output should still be captured separately when possible.

### Event Flow

The existing SSE run event stream can carry terminal chunks:

- `terminal:started`
- `terminal:output`
- `terminal:ended`

The existing `node:output` event can remain for structured stdout/stderr compatibility, but the xterm UI should consume terminal events for live display.

For input and resize, add HTTP endpoints:

- `POST /api/runs/:runId/terminal/input`
- `POST /api/runs/:runId/terminal/resize`
- `POST /api/runs/:runId/terminal/interrupt`

These endpoints resolve the active PTY session for the run and apply the requested operation.

## Data Model

Add a terminal transcript concept without making it the source of truth for graph decisions.

Suggested activation additions:

- `terminalTranscript?: string`
- `terminalMode?: "pty" | "stream"`

Existing fields stay useful:

- `rawResult.exitCode`
- `rawResult.stdout`
- `rawResult.stderr`
- `rawResult.aborted`

For Codex:

- Use PTY transcript for the Terminal tab.
- Use `--output-last-message` or an equivalent file capture for `rawResult.stdout` when available.
- Keep stderr-like terminal diagnostics visible in the terminal transcript instead of reclassifying them as errors.

## Error Handling

- If PTY allocation fails, the node falls back to the existing spawn runner and emits a visible terminal diagnostic.
- If terminal input arrives for a completed run, return `409`.
- If terminal input arrives for a run without an active PTY, return `404`.
- If resize payloads are invalid, return `400`.
- Cancellation must still finalize the run as `cancelled` and capture any available transcript/diff.

## Testing

Automated tests:

- Backend PTY adapter starts a command, captures terminal output, and reports exit code.
- Cancellation interrupts a PTY process and marks the activation cancelled.
- Resize endpoint forwards cols/rows to the active PTY session.
- Terminal input endpoint writes to stdin for an active PTY session.
- UI mounts an xterm terminal and writes streamed terminal chunks into it.
- UI sends resize/input/interrupt requests to the correct run endpoints.
- Regression coverage keeps non-PTY fallback behavior working.

Manual verification:

- Run a shell node that prints ANSI colors and confirm colors render.
- Run a command that updates one line repeatedly and confirm the terminal behaves like a CLI.
- Run the project task loop and confirm Codex output appears as a terminal stream while final run status and diff remain structured.

## Acceptance Criteria

- The Terminal tab visually and behaviorally reads as a real terminal, not a log table.
- A running Codex node shows the full Codex CLI stream without misleading stdout/stderr row labels.
- Terminal scrollback, copy, search, follow, and resize work in the dock.
- Stop interrupts the active process and finalizes the run cleanly.
- Timeline, Detail, Diff, and run history still work after PTY execution.
- Plain directory projects and git repositories both continue to work.
