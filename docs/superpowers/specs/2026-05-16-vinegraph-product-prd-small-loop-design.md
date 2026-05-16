# VineGraph Product PRD And Small Loop Workbench Design

Date: 2026-05-16
Status: Approved for planning
Scope: Complete product PRD, with M1 limited to the production-grade small loop workbench

## 1. Product Boundary

VineGraph is a single-machine local agent development workbench. It helps a developer design, run, observe, and refine agent graphs against real local project directories.

VineGraph is not a cloud platform, multi-user collaboration product, remote runner service, or generic automation marketplace. The product should feel like a local desktop developer tool: grounded in files, directories, terminals, graph assets, and visible run state.

The complete product direction includes:

- Project directory management for local folders and git repositories.
- App-level configuration for API keys, CLI paths, default models, reasoning effort, theme, and doctor/probe checks.
- Graph asset management for VineGraph graph files.
- Graph visualization and authoring.
- Agent run orchestration, terminal output, controller decisions, timeline, and diff/status observability.
- Debugging tools for prompts, node inputs/outputs, controller decisions, and reruns.
- Local delivery helpers such as run history, patch export, and optional git workflow assistance.

The M1 release only implements the small loop workbench: enough to use VineGraph for real agent graph development without building the full visual graph editor.

## 2. M1 Goals

M1 must make this loop real:

1. Open a local project directory.
2. Discover or create a VineGraph graph asset.
3. Open the graph from the repo asset explorer.
4. Inspect the graph through an automatically laid-out canvas.
5. Edit key node configuration in the inspector and save it back to the graph file.
6. Configure API keys, CLI paths, models, and doctor checks from the UI.
7. Select the run workspace target.
8. Run the graph.
9. Watch terminal output, timeline, controller decisions, and file changes.
10. Adjust graph configuration or prompts and run again.

M1 explicitly excludes:

- Manual node dragging and saved layout metadata.
- Visual node creation, deletion, and edge editing on canvas.
- Interactive PTY command input.
- Cloud, remote runners, teams, sharing, or collaboration.
- Accept/discard run output. Agent writes remain in the selected workspace and the user manages reversal with normal file or git tools.
- Commit, push, or pull request flows.

## 3. Product Information Architecture

The M1 desktop workbench uses this structure:

- Top toolbar: product identity, current repo, current open graph path, saved/dirty state, Run, Stop, Doctor, Settings.
- Left rail: Repo, Run, History, Config.
- Left panel: Repo Explorer and Graph Assets.
- Center: graph canvas generated from the currently opened graph's real nodes and edges.
- Right panel: editable Inspector for the selected graph or node.
- Bottom runtime dock: resizable, collapsible output area with Terminal, Timeline, Controller Decisions, and Diff/Changed Files.
- Bottom status bar: workspace path, branch or non-git state, dirty status, active run state, and workspace switching entry.

The top toolbar does not contain a graph switching dropdown. Graph switching happens by opening a graph asset from the left repo explorer.

## 4. Project Model

A project is any local directory. It does not have to be a git repository.

Project fields:

- `id`
- `name`
- `rootPath`
- `kind`: `git` or `directory`
- `createdAt`
- `lastOpenedAt`
- `graphAssetGlobs`
- `defaultVerificationCommand`
- project-level config overrides

Git projects enable:

- Branch display.
- Dirty status.
- Git diff and changed file display.
- Worktree listing.
- Main workspace, existing worktree, and new worktree run targets.

Plain directory projects enable:

- Graph asset scanning.
- Graph asset creation, opening, editing, saving, copying, renaming, and deleting.
- Runs against the selected directory.
- Terminal, timeline, and controller decision views.

Plain directory projects do not enable:

- Git branch display.
- Git worktrees.
- Git diff.
- Git changed file status.

Doctor treats git as a capability, not a project admission requirement. Non-git directories show a limited capability warning but remain usable.

## 5. Graph Assets

VineGraph graph assets use a dedicated extension to avoid confusing generic YAML files with graph assets.

Default graph asset extensions:

- `.vg.yaml`
- `.vg.yml`

The repo explorer's Graph Assets section scans only for those extensions by default. Existing legacy graph YAML files can be imported through an action that copies or converts the file into a `.vg.yaml` or `.vg.yml` graph asset.

M1 graph asset operations:

- Scan.
- Search/filter.
- Double-click open.
- Create from template.
- Copy.
- Rename.
- Delete with confirmation.
- Save after inspector edits.
- Validate on save.

The graph file content remains YAML. The dedicated extension is an asset management boundary, not a new serialization format.

## 6. App Configuration

Settings must be a real app settings surface, not a placeholder.

App-level config includes:

- Controller API key.
- Codex CLI path.
- Claude CLI path.
- Default Codex model.
- Default Claude model where applicable.
- Default controller model.
- Default reasoning effort.
- Theme mode: `system`, `dark`, or `light`.
- Default graph asset scan globs.
- Recent projects.

API keys are saved locally by M1 in the app config store and shown in semi-masked form. The UI must state that M1 uses local app storage rather than the operating system keychain. A later milestone can migrate secrets to system keychain storage.

Settings must provide probe actions:

- Test controller API key.
- Probe Codex CLI path/version.
- Probe Claude CLI path/version.
- Run project doctor for the current project and open graph.

## 7. Workspace Targets

Every run must have an explicit workspace target. The selected target is always visible in the bottom status bar.

For git projects, targets are:

- Main working tree.
- Existing worktree.
- New worktree created before run.

For non-git directory projects, the only target is the project directory.

Run behavior:

- The run API receives the selected workspace path.
- Execute backends run with `cwd` set to that workspace path.
- Agent writes land directly in the selected workspace.
- VineGraph does not provide an accept/discard step in M1.
- Git users can use normal git commands to revert, reset, commit, or branch.

Before starting a run, the UI must make the write target visible enough that the user knows where the agent will write files.

## 8. Canvas

The graph canvas must be generated from the opened graph's real YAML definition.

M1 requirements:

- Read real `nodes` and `edges`.
- Generate an automatic layout.
- Render node type, backend/model badge, status, and selected state.
- Render directed edges and distinguish success, failure, controller, loop, and normal routes when the data allows.
- Highlight active/running nodes during a run.
- Remove the hard-coded preset canvas as the primary product path.

M1 does not save manual node positions. Automatic layout only needs to be readable, stable, and honest to the graph.

## 9. Editable Inspector

The inspector is the main M1 authoring surface.

Editable execute node fields:

- `backend`
- `promptTemplate`
- `command.program`
- `command.args`
- `command.cwd`
- `execution.model`
- `execution.reasoningEffort`
- `execution.workspaceAccess`
- `execution.timeoutMs`

Editable controller node fields:

- `model`
- `promptTemplate`
- `readiness.mode`
- `outputs`
- `outputGuards`
- `limits.minConfidence`
- `limits.maxEvaluations`

Inspector requirements:

- Show dirty state after edits.
- Save back to the `.vg.yaml` or `.vg.yml` file.
- Validate graph structure before save.
- Preserve unsaved edits if save fails.
- Show actionable validation and parse errors.
- Reload canvas after successful save.

Comment preservation in YAML is desirable but not a hard M1 requirement. Structural correctness and graph validity are required.

## 10. Runtime Dock And Terminal

The runtime dock sits above the bottom workspace/status bar.

Dock requirements:

- Resizable by dragging a handle.
- Collapsible and expandable.
- Has min and max heights.
- Remembers the user's last height.
- Remains available during and after a run.

Dock tabs:

- Terminal.
- Timeline.
- Controller Decisions.
- Diff/Changed Files.

Terminal requirements:

- Merge stdout and stderr by timestamp.
- Stream incrementally as run events arrive.
- Show stream, node, backend, and timestamp metadata.
- Support ANSI colors.
- Support search.
- Support copy.
- Support clear view without clearing run history.
- Support pause/resume auto-follow.
- Support all-nodes and selected-node filtering.
- Avoid full DOM rerender for every chunk on long outputs.

The terminal is a run output terminal, not an interactive PTY. It does not accept shell input in M1.

## 11. Git And File Observability

For git projects, M1 shows:

- Branch.
- Dirty status.
- Changed files.
- Diff for the selected workspace.
- Current workspace path.

For non-git projects, M1 shows:

- Current directory.
- Non-git capability state.
- Run outputs.
- File change detection only if a lightweight non-git file snapshot is implemented. This is optional for M1.

Diff and changed files are capability-dependent. Their absence must be explained as non-git mode, not presented as an error.

## 12. Themes

M1 supports:

- System.
- Dark.
- Light.

Default theme is System.

Theme selection is saved in `AppConfig`. Both light and dark themes must preserve the same workbench structure: repo explorer, graph canvas, editable inspector, runtime dock, and workspace/status bar.

Validation must include at least one dark screenshot and one light screenshot.

## 13. Backend API Surface

M1 requires these backend API groups.

Project APIs:

- List recent projects.
- Add/open a project directory.
- Read project metadata and capabilities.
- Remove a project from recent list.

Config APIs:

- Read app config.
- Save app config.
- Probe controller API key.
- Probe Codex CLI.
- Probe Claude CLI.

Graph asset APIs:

- Scan graph assets.
- Read graph asset.
- Save graph asset.
- Create from template.
- Copy.
- Rename.
- Delete.
- Import legacy YAML as graph asset.

Workspace APIs:

- List workspace targets for a project.
- Create git worktree where supported.
- Read git status where supported.
- Read diff and changed files where supported.

Run APIs:

- Start run with project id, graph path, workspace target, and inputs.
- Cancel run.
- Stream run events.
- Read run record.

The scheduler must no longer infer the run repo root from the VineGraph process `cwd` for product runs. It must use the selected project and workspace target.

## 14. Complete Product Roadmap

M1: Small Loop Workbench

- Real project directory management.
- `.vg.yaml` graph assets.
- App settings and doctor.
- Automatic graph layout.
- Editable inspector.
- Explicit workspace target selection.
- Resizable runtime dock.
- Run output terminal.
- Diff/status capability.
- Light, dark, and system themes.

M2: Graph Authoring

- Add/delete nodes from canvas.
- Drag nodes.
- Edit edges and ports.
- Save layout metadata.
- Expand graph templates.
- Graph validation panel.

M3: Debugger

- Run a single node.
- Rerun from node.
- Capture and replay node inputs.
- Prompt diff.
- Controller decision replay.
- Compare runs.
- Search historical logs.

M4: Local Delivery

- Run history management.
- Mark successful runs.
- Patch export improvements.
- Optional commit and branch helpers.
- Optional local project shell/interactive PTY.
- Config backup and migration.

Out of product scope:

- Cloud execution.
- Remote runner service.
- Multi-user collaboration.
- Online workflow marketplace.

## 15. M1 Acceptance Criteria

M1 is acceptable when all of the following are true:

- A user can open any local directory as a project.
- A git project shows branch/dirty state and workspace targets.
- A non-git project remains usable and clearly shows limited capabilities.
- The repo explorer scans and displays `.vg.yaml` and `.vg.yml` graph assets.
- A user can create a graph from a template.
- A user can double-click a graph asset to open it.
- The canvas renders from the opened graph's real nodes and edges.
- A user can edit a Codex node's model and prompt template in the inspector.
- Saving writes the change back to the graph asset and validates it.
- Settings can save API key, CLI path, default model, reasoning effort, and theme.
- Doctor/probe status is visible in the UI.
- A user can choose a workspace target before running.
- The run executes in the selected workspace.
- Output appears in a scrollable terminal with stream metadata.
- Runtime dock can be resized and collapsed.
- Timeline, controller decisions, and diff/changed files are visible when available.
- The bottom workspace/status bar is always visible.
- Light, dark, and system theme modes work.
- The main graph switching path does not depend on a top graph dropdown.

## 16. Risks

YAML save risk:

Saving graph assets can damage formatting or comments. M1 mitigates this by validating graph structure before writing and by preserving unsaved editor state when save fails.

Workspace confusion risk:

Agent writes can affect the wrong directory if the target is hidden. M1 mitigates this with a persistent bottom workspace/status bar and explicit run request fields.

Terminal performance risk:

Long agent logs can become expensive to rerender. M1 requires incremental append or chunked rendering rather than full terminal DOM replacement for every event.

Automatic layout risk:

Complex graphs may look imperfect. M1 accepts imperfect but readable automatic layout and postpones manual layout editing to M2.

Secret storage risk:

M1 stores API keys in local app config. The settings UI must disclose this clearly and leave keychain migration for a later milestone.

Capability variance risk:

Git and non-git projects expose different abilities. M1 treats git as a capability and keeps non-git directories usable instead of blocking them.
