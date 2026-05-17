import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const htmlSource = readFileSync("src/ui/index.html", "utf-8");
const uiSource = readFileSync("src/ui/app.js", "utf-8");
const cssSource = readFileSync("src/ui/style.css", "utf-8");

test("UI uses a repo explorer and graph asset tree instead of a graph dropdown", () => {
  assert.match(htmlSource, /id="repo-explorer"/);
  assert.match(htmlSource, /id="graph-assets"/);
  assert.match(htmlSource, /id="open-graph-path"/);
  assert.match(htmlSource, /id="workspace-status-bar"/);
  assert.doesNotMatch(htmlSource, /id="graph-select"/);
});

test("UI loads projects, graph assets, and workspaces from product APIs", () => {
  assert.match(uiSource, /async function openProject\(rootPath\)/);
  assert.match(uiSource, /async function createProject\(rootPath\)/);
  assert.match(uiSource, /async function createGraphAssetFromForm\(\)/);
  assert.match(uiSource, /async function loadGraphAssets\(/);
  assert.match(uiSource, /async function openGraphAsset\(relativePath\)/);
  assert.match(uiSource, /async function loadWorkspaceTargets\(/);
  assert.match(uiSource, /\/api\/projects\/open/);
  assert.match(uiSource, /\/api\/projects\/create/);
  assert.match(uiSource, /\/graph-assets/);
  assert.match(uiSource, /\/workspaces/);
});

test("UI exposes concrete project and graph creation controls instead of prompt-only buttons", () => {
  assert.match(htmlSource, /id="project-path-input"/);
  assert.match(htmlSource, /id="btn-open-project-path"/);
  assert.match(htmlSource, /id="btn-create-project"/);
  assert.match(htmlSource, /id="new-graph-path-input"/);
  assert.match(htmlSource, /id="btn-create-graph"/);
  assert.match(uiSource, /domOpenProjectPath\?\.addEventListener\("click",\s*openProjectFromInput\)/);
  assert.match(uiSource, /domCreateProject\?\.addEventListener\("click",\s*createProjectFromInput\)/);
  assert.match(uiSource, /domNewGraph\?\.addEventListener\("click",\s*toggleNewGraphPanel\)/);
  assert.match(uiSource, /domCreateGraph\?\.addEventListener\("click",\s*createGraphAssetFromForm\)/);
  assert.doesNotMatch(uiSource, /window\.prompt\?\.\("Project path"\)/);
});

test("UI opens projects through the native Tauri directory picker when available", () => {
  assert.match(uiSource, /async function pickProjectDirectory\(\)/);
  assert.match(uiSource, /__TAURI__\?\.core\?\.invoke\?\.\("pick_project_directory"\)/);
  assert.match(uiSource, /domOpenProject\?\.addEventListener\("click",\s*openProjectWithPicker\)/);
  assert.match(uiSource, /focusProjectPathInput\(\)/);
  assert.doesNotMatch(uiSource, /window\.prompt/);
});

test("UI surfaces startup CLI autodetect failures in the top status badge", () => {
  assert.match(uiSource, /function applyStartupCliDiagnostics\(config\)/);
  assert.match(uiSource, /config\.cliDiagnostics\?\.missing/);
  assert.match(uiSource, /setStatus\("failed",\s*`CLI missing:/);
  assert.match(cssSource, /\.status-badge\.startup-error/);
});

test("UI opens graph assets on single click so run path cannot drift from canvas", () => {
  assert.match(uiSource, /row\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*openGraphAsset\(row\.dataset\.path\)/);
  assert.match(uiSource, /pendingGraphAssetPath/);
  assert.match(uiSource, /currentGraphAsset = detail\.asset \?\? asset/);
  assert.doesNotMatch(uiSource, /currentGraphAsset = asset;\s*const requestId/);
  assert.doesNotMatch(uiSource, /row\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*currentGraphAsset =/);
});

test("UI keeps workspace controls in the bottom bar and avoids global worktrees", () => {
  assert.match(htmlSource, /id="workspace-status-bar"/);
  assert.match(htmlSource, /id="workspace-switcher"/);
  assert.match(htmlSource, /id="btn-toggle-workspace-create"/);
  assert.match(htmlSource, /id="workspace-create-popover"/);
  assert.doesNotMatch(htmlSource, /class="sidebar-section worktree-panel"/);
  assert.doesNotMatch(htmlSource, /id="worktree-list"/);
  assert.doesNotMatch(htmlSource, /id="btn-refresh-worktrees"/);
  assert.match(uiSource, /async function loadWorkspaceTargets\(/);
  assert.match(uiSource, /async function createManualWorktree\(/);
  assert.match(uiSource, /\/api\/projects\/\$\{encodeURIComponent\(currentProject\.id\)\}\/workspaces/);
  assert.doesNotMatch(uiSource, /async function loadWorktrees\(/);
  assert.doesNotMatch(uiSource, /apiUrl\("\/api\/worktrees"\)/);
});

test("UI includes projectId when running product readiness", () => {
  assert.match(uiSource, /readinessParams\.set\("projectId", currentProject\.id\)/);
  assert.match(uiSource, /readinessParams\.set\("path", graphPath\)/);
  assert.match(uiSource, /\/api\/readiness\?\$\{readinessParams\.toString\(\)\}/);
});

test("UI renders automatic graph canvas from loaded graph nodes and edges", () => {
  assert.match(uiSource, /function layoutGraphDefinition\(graph\)/);
  assert.match(uiSource, /currentGraphDefinition\.nodes/);
  assert.match(uiSource, /currentGraphDefinition\.edges/);
  assert.doesNotMatch(uiSource, /PRESET\s*=/);
});

test("UI exposes editable graph inspector and graph asset save", () => {
  assert.match(uiSource, /function renderEditableInspectorNode\(nodeInfo\)/);
  assert.match(uiSource, /id="inspector-backend"/);
  assert.match(uiSource, /id="inspector-model"/);
  assert.match(uiSource, /id="inspector-prompt-template"/);
  assert.match(uiSource, /async function saveGraphAsset\(\)/);
  assert.match(uiSource, /method: "PUT"/);
});

test("CSS styles the repo explorer, graph asset rows, and workspace status bar", () => {
  assert.match(cssSource, /#repo-explorer/);
  assert.match(cssSource, /\.graph-asset-row/);
  assert.match(cssSource, /#workspace-status-bar/);
});

test("workspace grid keeps the bottom workspace bar inside a default viewport", () => {
  const workspaceRule = cssSource.match(/#workspace\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(workspaceRule, /grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+32px;/);
});

test("runtime dock tabs expose ARIA tab and panel semantics", () => {
  assert.match(htmlSource, /role="tab"[\s\S]*aria-selected="true"[\s\S]*aria-controls="timeline-panel"/);
  assert.match(htmlSource, /role="tabpanel"[\s\S]*aria-labelledby="tab-timeline"/);
  assert.match(uiSource, /setAttribute\("aria-selected"/);
});

test("UI exposes settings panel fields for local app config", () => {
  assert.match(htmlSource, /id="btn-settings"/);
  assert.match(htmlSource, /<aside id="activity-rail"[\s\S]*id="btn-settings"/);
  assert.doesNotMatch(htmlSource, /<header id="topbar"[\s\S]*id="btn-settings"[\s\S]*<\/header>/);
  assert.match(htmlSource, /id="settings-title"/);
  assert.match(htmlSource, /id="settings-panel"[^>]*class="settings-panel hidden"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="settings-title"[^>]*tabindex="-1"/);
  assert.match(htmlSource, /id="setting-controller-api-key"/);
  assert.match(htmlSource, /id="setting-codex-path"/);
  assert.match(htmlSource, /id="setting-claude-path"/);
  assert.match(htmlSource, /id="setting-theme-mode"/);
});

test("UI loads, saves, and applies app settings theme mode", () => {
  assert.match(uiSource, /let appConfig\s*=/);
  assert.match(uiSource, /async function loadAppConfig\(\)/);
  assert.match(uiSource, /async function saveAppConfig\(\)/);
  assert.match(uiSource, /function applyThemeMode\(mode\)/);
  assert.match(uiSource, /\/api\/config/);
  assert.match(uiSource, /document\.documentElement\.dataset\.theme/);
});

test("UI keeps controller API key redacted and preserves it unless replaced", () => {
  assert.match(uiSource, /controllerApiKeyConfigured/);
  assert.match(uiSource, /controllerApiKeyMasked/);
  assert.match(uiSource, /domSettingControllerApiKey\.placeholder/);
  assert.match(uiSource, /setFieldValue\(domSettingControllerApiKey,\s*""\)/);
  assert.match(uiSource, /if \(settingValue\(domSettingControllerApiKey\)\)/);
  assert.doesNotMatch(uiSource, /setFieldValue\(domSettingControllerApiKey,\s*appConfig\.controllerApiKey\)/);
});

test("UI treats theme changes as a draft preview that reverts on close", () => {
  assert.match(uiSource, /let settingsDraftThemeMode\s*=/);
  assert.match(uiSource, /settingsDraftThemeMode = appConfig\.themeMode \?\? "system"/);
  assert.match(uiSource, /applyThemeMode\(settingsDraftThemeMode\)/);
  assert.match(uiSource, /applyThemeMode\(appConfig\.themeMode\)/);
  assert.match(uiSource, /themeMode: settingsDraftThemeMode \|\| "system"/);
});

test("UI settings drawer behaves like an accessible dialog", () => {
  assert.match(uiSource, /let lastSettingsTrigger\s*=/);
  assert.match(uiSource, /domSettingsOpen\?\.addEventListener\("click",\s*\(\)\s*=>\s*openSettingsPanel\(domSettingsOpen\)\)/);
  assert.match(uiSource, /domSettings\?\.focus\(\)/);
  assert.match(uiSource, /lastSettingsTrigger\?\.focus\?\.\(\)/);
  assert.match(uiSource, /window\.addEventListener\("keydown", handleSettingsKeydown\)/);
  assert.match(uiSource, /event\.key === "Escape"/);
});
