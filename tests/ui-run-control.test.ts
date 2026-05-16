import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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

test("UI loads graph definitions and uses node prompt templates in the inspector", () => {
  assert.match(uiSource, /loadGraphDefinition/);
  assert.match(uiSource, /currentGraphDefinition/);
  assert.match(uiSource, /nodeInfo\.promptTemplate/);
  assert.doesNotMatch(uiSource, /你是一个代码质量控制器/);
});

test("UI graph definition loader ignores stale detail responses", async () => {
  const fetchResponses: Array<Deferred<unknown>> = [];
  const hooks = loadUiTestHooks(async () => {
    const next = fetchResponses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next.promise;
  });

  const first = createDeferred({
    ok: true,
    json: async () => ({ id: "first_graph" }),
  });
  const second = createDeferred({
    ok: true,
    json: async () => ({ id: "second_graph" }),
  });
  fetchResponses.push(first, second);

  hooks.setGraphValueForTest("examples/first.yaml");
  const firstLoad = hooks.loadGraphDefinitionForTest("examples/first.yaml");
  hooks.setGraphValueForTest("examples/second.yaml");
  const secondLoad = hooks.loadGraphDefinitionForTest("examples/second.yaml");

  second.resolve();
  assert.equal(await secondLoad, true);
  assert.equal(hooks.getCurrentGraphDefinitionForTest()?.id, "second_graph");

  first.resolve();
  assert.equal(await firstLoad, false);
  assert.equal(hooks.getCurrentGraphDefinitionForTest()?.id, "second_graph");
});

test("UI graph definition loader keeps the current definition on stale failures", async () => {
  const fetchResponses: Array<Deferred<unknown>> = [];
  const hooks = loadUiTestHooks(async () => {
    const next = fetchResponses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next.promise;
  });

  const first = createDeferred({
    ok: true,
    json: async () => ({ id: "first_graph" }),
  });
  fetchResponses.push(first);

  hooks.setGraphValueForTest("examples/first.yaml");
  const firstLoad = hooks.loadGraphDefinitionForTest("examples/first.yaml");
  first.resolve();
  assert.equal(await firstLoad, true);
  assert.equal(hooks.getCurrentGraphDefinitionForTest()?.id, "first_graph");

  const staleFailure = createDeferred(new Error("network failed"));
  const latest = createDeferred({
    ok: true,
    json: async () => ({ id: "latest_graph" }),
  });
  fetchResponses.push(staleFailure, latest);

  hooks.setGraphValueForTest("examples/stale.yaml");
  const staleLoad = hooks.loadGraphDefinitionForTest("examples/stale.yaml");
  hooks.setGraphValueForTest("examples/latest.yaml");
  const latestLoad = hooks.loadGraphDefinitionForTest("examples/latest.yaml");

  latest.resolve();
  assert.equal(await latestLoad, true);
  assert.equal(hooks.getCurrentGraphDefinitionForTest()?.id, "latest_graph");

  staleFailure.reject();
  assert.equal(await staleLoad, false);
  assert.equal(hooks.getCurrentGraphDefinitionForTest()?.id, "latest_graph");
});

test("UI graph definition loader has an explicit request guard", () => {
  assert.match(uiSource, /graphDefinitionRequestId/);
  assert.match(uiSource, /domGraph\.value\s*===\s*graphPath/);
  assert.match(uiSource, /return true/);
  assert.match(uiSource, /return false/);
});

type UiTestHooks = {
  loadGraphDefinitionForTest: (graphPath: string) => Promise<boolean>;
  getCurrentGraphDefinitionForTest: () => { id?: string } | null;
  setGraphValueForTest: (graphPath: string) => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: () => void;
  reject: () => void;
};

function loadUiTestHooks(fetchImpl: (url: string) => Promise<unknown>): UiTestHooks {
  const elements = new Map<string, any>();
  const graphSelect = createElementStub();
  graphSelect.value = "";
  elements.set("#graph-select", graphSelect);

  const documentStub = {
    querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, createElementStub());
      return elements.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return createElementStub();
    },
  };
  const windowStub = {
    location: {
      hostname: "127.0.0.1",
      protocol: "http:",
    },
    addEventListener() {},
    open() {},
  };

  const context = vm.createContext({
    console,
    document: documentStub,
    fetch: fetchImpl,
    window: windowStub,
    Event: class Event {
      constructor(public type: string) {}
    },
    EventSource: class EventSource {},
    Element: class Element {},
    Map,
    Date,
    Math,
    JSON,
    String,
    Number,
    encodeURIComponent,
  });

  vm.runInContext(uiSource.replace(/\ninit\(\);\s*$/, "\n"), context);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;
  assert.ok(hooks, "expected UI test hooks to be installed");
  return hooks;
}

function createDeferred<T>(value: T): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise(value),
    reject: () => rejectPromise(value),
  };
}

function createElementStub() {
  return {
    value: "",
    innerHTML: "",
    textContent: "",
    disabled: false,
    options: [] as any[],
    dataset: {},
    classList: {
      add() {},
      remove() {},
    },
    appendChild(child: any) {
      this.options.push(child);
    },
    addEventListener() {},
    dispatchEvent() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1, height: 1 };
    },
  };
}
