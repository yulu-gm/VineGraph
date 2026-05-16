import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const uiSource = readFileSync("src/ui/app.js", "utf-8");
const styleSource = readFileSync("src/ui/style.css", "utf-8");

test("graph canvas sizes the SVG from graph bounds instead of a fixed viewBox", () => {
  assert.match(uiSource, /function graphBounds\(/);
  assert.match(uiSource, /viewBox="\$\{bounds\.minX\} \$\{bounds\.minY\} \$\{bounds\.width\} \$\{bounds\.height\}"/);
  assert.match(uiSource, /style="width:\$\{bounds\.width\}px;height:\$\{bounds\.height\}px"/);
});

test("graph connections render readable layered orthogonal paths with arrow markers", () => {
  assert.match(uiSource, /function routeConnection\(/);
  assert.match(uiSource, /marker-end="url\(#arrow-\$\{connection\.color\}\)"/);
  assert.match(uiSource, /connection-casing/);
  assert.match(uiSource, /connection-line/);
  assert.match(uiSource, /connection-active/);
  assert.match(styleSource, /\.connection-casing/);
  assert.match(styleSource, /\.connection-line/);
  assert.match(styleSource, /stroke-linecap: round/);
});

test("graph canvas supports right-button drag panning", () => {
  assert.match(uiSource, /let canvasPan = \{ x: 0, y: 0 \}/);
  assert.match(uiSource, /function bindCanvasPan\(/);
  assert.match(uiSource, /event\.button !== 2/);
  assert.match(uiSource, /domCanvas\.addEventListener\("contextmenu"/);
  assert.match(uiSource, /function applyCanvasPan\(/);
  assert.match(uiSource, /translate\(\$\{-canvasPan\.x\}px, \$\{-canvasPan\.y\}px\)/);
  assert.match(styleSource, /#graph-canvas\.is-panning/);
});

test("graph canvas marks the active runtime node", () => {
  assert.match(uiSource, /activeGraphNodeId/);
  assert.match(styleSource, /\.graph-node\.is-active/);
  assert.match(uiSource, /class="graph-node \$\{item\.kind\}\$\{selected\}\$\{active\}\$\{stateClass\}"/);
});

test("minimap viewport supports left-button dragging the visible area", () => {
  assert.match(uiSource, /function renderMinimap\(/);
  assert.match(uiSource, /class="minimap-viewport"/);
  assert.match(uiSource, /function bindMinimapDrag\(/);
  assert.match(uiSource, /function minimapPanFromPointer\(/);
  assert.match(uiSource, /event\.button !== 0/);
  assert.match(uiSource, /function clampCanvasPan\(/);
  assert.match(styleSource, /\.minimap-viewport/);
  assert.match(styleSource, /touch-action: none/);
});
