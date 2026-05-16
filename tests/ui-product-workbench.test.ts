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

test("UI renders automatic graph canvas from loaded graph nodes and edges", () => {
  assert.match(uiSource, /function layoutGraphDefinition\(graph\)/);
  assert.match(uiSource, /currentGraphDefinition\.nodes/);
  assert.match(uiSource, /currentGraphDefinition\.edges/);
  assert.doesNotMatch(uiSource, /PRESET\s*=/);
});

test("CSS styles the repo explorer, graph asset rows, and workspace status bar", () => {
  assert.match(cssSource, /#repo-explorer/);
  assert.match(cssSource, /\.graph-asset-row/);
  assert.match(cssSource, /#workspace-status-bar/);
});
