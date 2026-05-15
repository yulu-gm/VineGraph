import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const serverSource = readFileSync("src/server.ts", "utf-8");
const uiSource = readFileSync("src/ui/app.js", "utf-8");

test("server starts UI runs asynchronously and tracks an abort controller", () => {
  assert.match(serverSource, /new AbortController\(\)/);
  assert.match(serverSource, /activeRuns\.set\(runId/);
  assert.match(serverSource, /Scheduler\.run\(graph, graphPath,\s*\{/);
  assert.match(serverSource, /sendJSON\(res,\s*\{\s*runId,\s*status:\s*"running"/s);
});

test("server forwards scheduler output and cancellation over SSE", () => {
  assert.match(serverSource, /onEvent:\s*\(event\)\s*=>/);
  assert.match(serverSource, /emitSSE\(runId,\s*event\.type,\s*event\)/);
  assert.match(serverSource, /emitSSE\(runId,\s*"run:cancelled"/);
  assert.match(serverSource, /controller\.abort\(\)/);
});

test("UI connects to SSE immediately, supports cancellation, and renders streamed node output", () => {
  assert.match(uiSource, /connectSSE\(result\.runId\)/);
  assert.match(uiSource, /addEventListener\("node:output"/);
  assert.match(uiSource, /addEventListener\("run:cancelled"/);
  assert.match(uiSource, /fetch\(apiUrl\(`\/api\/runs\/\$\{currentRunId\}`\),\s*\{\s*method:\s*"DELETE"/);
  assert.match(uiSource, /renderDetail\(activations\[selectedNodeIdx\]\)/);
  assert.match(uiSource, /activation\.renderedPrompt/);
  assert.match(uiSource, /<h4>Prompt<\/h4>/);
  assert.match(uiSource, /stdout/);
  assert.match(uiSource, /stderr/);
});

test("UI renders graph loading failures instead of leaving the graph selector blank", () => {
  assert.match(uiSource, /files\.length\s*===\s*0/);
  assert.match(uiSource, /没有可用 graph/);
  assert.match(uiSource, /图列表加载失败/);
});

test("UI uses the localhost server API when running from Tauri static assets", () => {
  assert.match(uiSource, /const API_ORIGIN = "http:\/\/127\.0\.0\.1:3456"/);
  assert.match(uiSource, /function apiUrl\(path\)/);
  assert.match(uiSource, /window\.location\.hostname/);
  assert.match(uiSource, /tauri\.localhost/);
  assert.match(uiSource, /fetch\(apiUrl\("\/api\/graphs"\)\)/);
  assert.match(uiSource, /new EventSource\(apiUrl\(`\/api\/runs\/\$\{runId\}\/events`\)\)/);
  assert.match(uiSource, /window\.open\(apiUrl\(`\/api\/runs\/\$\{result\.runId\}\/patch`\)/);
});
