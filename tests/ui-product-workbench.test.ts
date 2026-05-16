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
  assert.match(uiSource, /async function loadGraphAssets\(/);
  assert.match(uiSource, /async function openGraphAsset\(relativePath\)/);
  assert.match(uiSource, /async function loadWorkspaceTargets\(/);
  assert.match(uiSource, /\/api\/projects\/open/);
  assert.match(uiSource, /\/graph-assets/);
  assert.match(uiSource, /\/workspaces/);
});

test("UI opens graph assets on single click so run path cannot drift from canvas", () => {
  assert.match(uiSource, /row\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*openGraphAsset\(row\.dataset\.path\)/);
  assert.match(uiSource, /pendingGraphAssetPath/);
  assert.match(uiSource, /currentGraphAsset = detail\.asset \?\? asset/);
  assert.doesNotMatch(uiSource, /currentGraphAsset = asset;\s*const requestId/);
  assert.doesNotMatch(uiSource, /row\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*currentGraphAsset =/);
});

test("UI scopes worktree controls to product workspace APIs and avoids global worktrees", () => {
  assert.match(uiSource, /async function loadWorktrees\(/);
  assert.match(uiSource, /async function createManualWorktree\(/);
  assert.match(uiSource, /\/api\/projects\/\$\{encodeURIComponent\(currentProject\.id\)\}\/workspaces/);
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

test("runtime dock tabs expose ARIA tab and panel semantics", () => {
  assert.match(htmlSource, /role="tab"[\s\S]*aria-selected="true"[\s\S]*aria-controls="timeline-panel"/);
  assert.match(htmlSource, /role="tabpanel"[\s\S]*aria-labelledby="tab-timeline"/);
  assert.match(uiSource, /setAttribute\("aria-selected"/);
});
