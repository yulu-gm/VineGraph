# VineGraph Backlog

Date: 2026-05-17
Source PRD: `docs/PRD.md`
Status key: `Todo`, `In Progress`, `Done`, `Deferred`

## Backlog Principles

- Keep M1 focused on completing the small loop workbench.
- Do not pull M2 graph authoring into M1 unless it is required to close an M1 acceptance gap.
- Keep all execution local.
- Treat git as a capability, not a project requirement.
- Keep graph assets file-backed and validated.
- Prefer small tasks with tests and visible acceptance criteria.

## M1: Small Loop Workbench Hardening

| ID | Priority | Status | Task | Acceptance |
| --- | --- | --- | --- | --- |
| VG-M1-001 | P0 | Done | Establish product PRD, progress, and backlog docs. | `docs/PRD.md`, `docs/progress.md`, and `docs/backlog.md` exist and use complete-product scope. |
| VG-M1-002 | P0 | Todo | Add graph asset copy UI. | User can copy an existing `.vg.yaml` / `.vg.yml` asset from the workbench; target path is validated; asset list refreshes. |
| VG-M1-003 | P0 | Todo | Add graph asset rename UI. | User can rename a graph asset without overwriting; open graph state updates to the new path. |
| VG-M1-004 | P0 | Todo | Add graph asset delete UI. | User can delete a graph asset only after confirmation; deleted open graph clears safely. |
| VG-M1-005 | P1 | Todo | Add legacy YAML import UI. | User can select or enter a legacy `.yaml` source and import it into `.vg.yaml` / `.vg.yml`. |
| VG-M1-006 | P0 | Todo | Split settings probes into explicit actions/results. | Settings shows separate controller key, Codex CLI, Claude CLI, and project doctor results. |
| VG-M1-007 | P1 | Todo | Decide and implement graph asset glob policy. | Either project scanning honors configured globs, or PRD/UI explicitly limits M1 to fixed `.vg.yaml` / `.vg.yml` extensions. |
| VG-M1-008 | P1 | Todo | Add recent projects UI. | Recent projects from app config are visible and reopenable. |
| VG-M1-009 | P1 | Todo | Add manual visual acceptance record. | Dark and light screenshots are captured; result notes reference `docs/ui-reference.md`. |
| VG-M1-010 | P1 | Todo | Add Tauri smoke acceptance note. | Document that desktop launch opens the local workbench and can open a project. |
| VG-M1-011 | P1 | Todo | Harden non-git diff messaging. | Diff panel clearly explains non-git capability limits without presenting an error. |
| VG-M1-012 | P2 | Todo | Improve empty states for no project/no graph/no workspace. | Empty states tell the user the next action without adding instructional clutter to normal views. |
| VG-M1-013 | P2 | Todo | Add test report doc for M1 release checks. | A release/acceptance report records typecheck, test, browser/Tauri smoke, and screenshots. |
| VG-M1-014 | P0 | In Progress | Complete session-bound Terminal architecture. | Session ids are carried through node activations, run events, server terminal actions, UI requests, Tauri portable-pty manager, Tauri UI bridge, attach/reattach, session list, bounded transcript, project-scoped run records, and lifecycle cleanup. Remaining acceptance: real desktop Terminal smoke, Codex CLI styled-output check, explicit detach decision, and stabilization of Windows PTY tests that can timeout. |

## M2: Graph Authoring

| ID | Priority | Status | Task | Acceptance |
| --- | --- | --- | --- | --- |
| VG-M2-001 | P0 | Todo | Define graph editing schema and mutation API. | Server exposes safe operations for add/delete/update node and edge edits with validation. |
| VG-M2-002 | P0 | Todo | Add execute node creation UI. | User can create an execute node from canvas/palette and save it to the graph asset. |
| VG-M2-003 | P0 | Todo | Add controller node creation UI. | User can create a controller node with outputs, readiness, and prompt template. |
| VG-M2-004 | P0 | Todo | Add edge creation UI. | User can connect valid output ports to input ports and save the edge. |
| VG-M2-005 | P0 | Todo | Add edge editing and deletion. | User can edit route semantics and remove edges without breaking graph validity. |
| VG-M2-006 | P0 | Todo | Add node deletion with safety checks. | Deleting a node removes or repairs dependent edges and shows validation impact. |
| VG-M2-007 | P1 | Todo | Add port editor. | User can add, rename, and remove controller outputs and required inputs. |
| VG-M2-008 | P1 | Todo | Add drag layout and saved layout metadata. | Manual node positions persist across reloads without changing execution semantics. |
| VG-M2-009 | P1 | Todo | Add graph validation panel. | Validation errors are visible before save/run and point to nodes/edges. |
| VG-M2-010 | P1 | Todo | Add graph templates manager. | Users can create graphs from several useful local templates. |
| VG-M2-011 | P2 | Todo | Add YAML/source view fallback. | Advanced users can inspect raw YAML while keeping validated save behavior. |
| VG-M2-012 | P2 | Todo | Add graph-level metadata editor. | Users can edit graph id, version, description, and runtime limits. |

## M3: Debugger

| ID | Priority | Status | Task | Acceptance |
| --- | --- | --- | --- | --- |
| VG-M3-001 | P0 | Todo | Add node input/output capture viewer. | Users can inspect exact upstream inputs, rendered prompts, outputs, and payloads for each activation. |
| VG-M3-002 | P0 | Todo | Run selected node. | User can run one node with captured or manually supplied inputs. |
| VG-M3-003 | P0 | Todo | Rerun from selected node. | User can rerun a graph suffix from a prior activation context. |
| VG-M3-004 | P0 | Todo | Controller decision replay. | User can replay a controller prompt and compare selected outputs. |
| VG-M3-005 | P1 | Todo | Prompt diff. | User can compare rendered prompts across runs or graph revisions. |
| VG-M3-006 | P1 | Todo | Run comparison. | User can compare timelines, statuses, decisions, outputs, and diffs across two runs. |
| VG-M3-007 | P1 | Todo | Historical log search. | User can search run terminal transcripts and structured node outputs. |
| VG-M3-008 | P1 | Todo | Routing explanation view. | User can understand why a controller or readiness gate did or did not run. |
| VG-M3-009 | P2 | Todo | Debugger bookmarks. | User can mark important activations/decisions for later review. |
| VG-M3-010 | P2 | Todo | Failed-run triage summary. | UI summarizes first failure, likely cause, affected node, and next debug action. |

## M4: Local Delivery

| ID | Priority | Status | Task | Acceptance |
| --- | --- | --- | --- | --- |
| VG-M4-001 | P0 | Todo | Build run history UI. | Users can browse, filter, open, and delete local run records. |
| VG-M4-002 | P0 | Todo | Mark useful/successful runs. | Users can mark runs and see those marks in history. |
| VG-M4-003 | P0 | Todo | Improve patch export workflow. | Users can export patches with clear file naming, location, and changed-file summary. |
| VG-M4-004 | P1 | Todo | Add local artifact cleanup. | Users can clean old run records, patches, and worktrees with confirmation. |
| VG-M4-005 | P1 | Todo | Add optional branch helper. | For git projects, users can create or switch branches from selected run output. |
| VG-M4-006 | P1 | Todo | Add optional commit helper. | Users can stage selected changes and create a commit from the UI after explicit confirmation. |
| VG-M4-007 | P2 | Todo | Add optional PR preparation helper. | Users can prepare PR title/body from a selected run; remote publishing requires explicit user action. |
| VG-M4-008 | P0 | Todo | Add general project shell. | Users can open an interactive shell scoped to the selected project/workspace, separate from run-node terminals. |
| VG-M4-009 | P1 | Todo | Add config backup/export. | Users can export local non-secret config and recent project metadata. |
| VG-M4-010 | P1 | Todo | Add config migration/import. | Users can import compatible config with validation and conflict handling. |
| VG-M4-011 | P0 | Todo | Migrate secrets to system keychain. | API keys are stored through the OS keychain; local config no longer stores plaintext secrets. |
| VG-M4-012 | P1 | Todo | Harden desktop packaging. | Packaged app launch, asset loading, local server startup, and Tauri portable-pty availability are verified. |

## Cross-Cutting Backlog

| ID | Priority | Status | Task | Acceptance |
| --- | --- | --- | --- | --- |
| VG-X-001 | P0 | Todo | Maintain path traversal and symlink tests. | Project, graph asset, run, patch, and readiness routes cannot escape project root. |
| VG-X-002 | P0 | Todo | Keep Windows compatibility coverage. | Path, shell, CLI, Tauri launcher, and git behavior stay covered on Windows-relevant code paths. |
| VG-X-003 | P1 | Todo | Add browser-based visual regression workflow. | Important UI changes include screenshot checks against `docs/ui-reference.md`. |
| VG-X-004 | P1 | Todo | Add product telemetry-free diagnostics export. | User can export local diagnostic info without sending data anywhere. |
| VG-X-005 | P1 | Todo | Document graph schema. | Graph YAML fields, node types, ports, runtime limits, and examples are documented as a user-facing reference. |
| VG-X-006 | P1 | Todo | Add migration notes for legacy AgentGraph naming. | Docs explain current `AgentGraph` implementation name vs `VineGraph` product name. |
| VG-X-007 | P2 | Todo | Normalize UI copy language. | Decide Chinese/English product copy policy and apply consistently. |
| VG-X-008 | P2 | Todo | Add accessibility pass for keyboard navigation. | Core workbench operations are keyboard reachable and dialogs/tabs expose correct semantics. |

## Deferred / Out Of Scope

These are not backlog items unless the PRD is explicitly revised:

- Cloud execution.
- Remote runner service.
- Multi-user collaboration.
- Team permissions.
- Hosted marketplace.
- Account system.
- Browser-only SaaS deployment.
