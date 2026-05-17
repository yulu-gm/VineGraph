# VineGraph Progress

Date: 2026-05-17
Source PRD: `docs/PRD.md`
Evidence sources: current repo, `README.md`, `docs/design.md`, `docs/ui-reference.md`, `docs/superpowers/specs/2026-05-16-vinegraph-product-prd-small-loop-design.md`, `docs/superpowers/specs/2026-05-16-real-terminal-v1-design.md`, tests, and source code.

## Current Summary

VineGraph is past the pure runtime prototype stage. The current branch has a working M1 product workbench foundation: local project opening, `.vg.yaml` graph assets, explicit workspace targets, product run APIs, real graph canvas rendering, editable inspector, settings, readiness checks, runtime dock, xterm/PTY terminal support, diff/status handling, and Tauri launcher support.

The main remaining M1 work is product hardening and UI completeness rather than core architecture. M2, M3, and M4 are mostly future product work, with a few foundations already present.

## Verification Snapshot

Commands run on 2026-05-17:

```bash
npm run typecheck
npm test
```

Result:

- `npm run typecheck`: pass.
- `npm test`: pass, 186 passed, 0 failed, 1 skipped.

## Milestone Status

| Area | Status | Notes |
| --- | --- | --- |
| Core runtime | Done | Execute/controller graph runtime, loop guards, scheduler, workspace manager, run history, patch export, controller decisions, and tests exist. |
| M1 small loop workbench | Mostly done | Main product path exists and is verified by automated tests. Some UI operations and manual visual acceptance remain. |
| M2 graph authoring | Not started | Canvas renders real graphs but does not yet create/delete nodes or edit edges visually. |
| M3 debugger | Not started | Prompt assembly and controller decisions are captured, but debugger workflows are not yet productized. |
| M4 local delivery | Partial foundation | Patch export, run records, worktrees, Tauri shell, and active terminal exist. Run history UI, delivery management, git helpers, keychain, and project shell remain. |

## M1 Acceptance Matrix

| Requirement | Status | Evidence / Gap |
| --- | --- | --- |
| Open any local directory as project | Done | `src/projects.ts`, `/api/projects/open`, tests for git and non-git directories. |
| Create a new local project | Done | `/api/projects/create`, UI project controls, server tests. |
| Git project shows branch/dirty state | Done | `openProjectDirectory`, `workspace-targets`, tests. |
| Non-git project remains usable | Done | Directory capability handling and workspace target tests. |
| Scan `.vg.yaml` / `.vg.yml` only | Done | `src/graph-assets.ts`, scanner tests. |
| Create graph from template | Done | Server and UI create graph path exist. |
| Open graph asset from repo explorer | Done | UI opens asset through project graph asset API. |
| Copy/rename/delete/import graph assets | Partial | Service functions exist; full UI controls are not visible in current workbench. |
| Canvas renders real nodes and edges | Done | `layoutGraphDefinition`, graph detail API, UI tests. |
| Auto layout terminates for cyclic graphs | Done | UI layout regression test exists. |
| Inspector edits node config | Done | Editable inspector and save tests exist. |
| Save validates graph before writing | Done | Server graph asset save validation tests exist. |
| Settings save key, CLI paths, model, reasoning, theme | Done | `app-config`, settings UI, config route tests. |
| Settings keep API key redacted | Done | Safe config view and UI tests exist. |
| Dedicated controller key / CLI probe actions | Partial | Readiness probe and startup CLI autodetect exist; independent per-field probe UI/API is not yet complete. |
| Explicit workspace target visible before run | Done | Workspace bar and target API exist. |
| Run executes in selected workspace | Done | Scheduler workspace target tests and server product run tests exist. |
| Terminal output appears incrementally | Partial | Current implementation uses xterm/PTY terminal events. Terminal events and node activations now carry `terminalSessionId`; full `attach(sessionId)` reattach and Tauri/portable-pty remain. |
| Terminal supports search/copy/clear/follow/filter/resize | Partial | Current UI terminal dock tests exist and terminal actions can target a session id. Reattach, transcript persistence, and Tauri/portable-pty capability remain to be implemented if adopted. |
| Runtime dock resizes and collapses | Done | Runtime dock tests exist. |
| Timeline, controller decisions, diff visible | Done | Runtime dock panels exist; server run records include decisions and diff where available. |
| Bottom workspace/status bar always visible | Done | UI structure and tests. |
| Light, dark, system theme modes | Done | Settings and CSS support exist. |
| Manual dark/light screenshot validation | Pending | Not verified in this pass. |
| Graph switching avoids top dropdown | Done | UI uses repo explorer graph asset path and has no graph dropdown. |
| Run history management | Future | Records are persisted and list API exists; product history UI/management remains M4. |

## Implementation Evidence

Completed foundations:

- Product types: `src/product-types.ts`.
- App config store: `src/app-config.ts`.
- Project detection: `src/projects.ts`.
- Graph asset service: `src/graph-assets.ts`.
- Workspace target service: `src/workspace-targets.ts`.
- Product server APIs: `src/server.ts`.
- Explicit workspace scheduler support: `src/scheduler.ts`.
- Run history persistence: `src/run-history.ts`.
- Runtime terminal session layer: `src/terminal-session.ts`.
- Workbench UI: `src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css`.
- Tauri shell and launch tests: `src-tauri/`, launcher tests.

## Product Deltas Against PRD

### Ahead Of Original M1

- Real active-run terminal exists with xterm/PTY, input, resize, and interrupt.
- Tauri launcher and desktop startup support are already covered by tests.
- Worktree creation UI/API exists for git projects.

### Still Needed For M1 Completion

- Expose full graph asset copy, rename, delete, and import controls in the UI.
- Complete the remaining session-bound Terminal architecture described in `docs/m1-terminal-completion.md`, especially Tauri/portable-pty, reattach, transcript persistence, and cleanup policy.
- Add dedicated probe actions and result surfaces for controller API key, Codex CLI, and Claude CLI.
- Wire app-level graph asset scan globs into project scanning or explicitly document the fixed extension rule.
- Run manual browser/Tauri visual acceptance, including dark and light screenshots.

### Future Milestones

- M2 visual graph authoring.
- M3 debugger workflows.
- M4 history management, delivery helpers, general project shell, keychain migration, and packaging hardening.

## Current Risk Register

| Risk | Status | Mitigation |
| --- | --- | --- |
| Graph asset service and UI capability mismatch | Open | Add UI controls or revise M1 acceptance if service-only is acceptable. |
| Probe semantics too broad | Open | Split readiness doctor from per-setting key/CLI probes. |
| Graph asset scan globs stored but not productized | Open | Decide whether globs are configurable in M1 or fixed until M2. |
| Manual visual QA not captured | Open | Add screenshots and record paths/results in docs or test report. |
| M2-M4 scope can expand quickly | Open | Keep backlog milestone-labeled and avoid implementing future features during M1 hardening. |

## Recommended Next Step

Finish M1 hardening before starting M2:

1. Add graph asset UI actions for copy, rename, delete, and import.
2. Add dedicated settings probe actions/results.
3. Decide the graph asset glob policy.
4. Run manual UI acceptance with dark/light screenshots.
5. Then move to M2 graph authoring.
