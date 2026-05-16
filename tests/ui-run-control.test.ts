import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const serverSource = readFileSync("src/server.ts", "utf-8");
const htmlSource = readFileSync("src/ui/index.html", "utf-8");
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

test("UI exposes a real active agent terminal dock", () => {
  assert.match(htmlSource, /data-panel="terminal"/);
  assert.match(htmlSource, /id="terminal-content"/);
  assert.match(uiSource, /activeTerminalActivationId/);
  assert.match(uiSource, /terminalBuffers/);
  assert.match(uiSource, /renderTerminal/);
  assert.match(uiSource, /function appendActivationOutput\(data\)[\s\S]*terminalBuffers\.set/);
});

test("UI appends active codex output into the terminal dock", () => {
  const { elements, windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.appendActivationOutputForTest({
    activationId: "activation-1",
    nodeId: "implement_feature",
    backend: "codex",
    stream: "stdout",
    chunk: "backend/nodeId/stdout <ok>",
    timestamp: 1000,
  });
  hooks.appendActivationOutputForTest({
    activationId: "activation-1",
    nodeId: "implement_feature",
    backend: "codex",
    stream: "stderr",
    chunk: "backend/nodeId/stderr <warn&>",
    timestamp: 1001,
  });

  const terminal = elements.get("#terminal-content");
  assert.match(terminal.innerHTML, /codex/);
  assert.match(terminal.innerHTML, /implement_feature/);
  assert.match(terminal.innerHTML, /stdout/);
  assert.match(terminal.innerHTML, /stderr/);
  assert.match(terminal.innerHTML, /backend\/nodeId\/stdout &lt;ok&gt;/);
  assert.match(terminal.innerHTML, /backend\/nodeId\/stderr &lt;warn&amp;&gt;/);

  hooks.appendActivationOutputForTest(streamChunk("activation-2", "run_tests", "shell", "stdout", "shell output"));
  assert.match(terminal.innerHTML, /backend\/nodeId\/stdout &lt;ok&gt;/);
  assert.doesNotMatch(terminal.innerHTML, /shell output/);
});

test("UI switches the terminal when a second agent starts before streaming output", async () => {
  const { elements, windowStub } = loadUiTestHarness(async () => {
    return {
      ok: true,
      json: async () => ({
        id: "project_task_loop",
        nodes: [{ id: "review_functionality", backend: "codex" }],
      }),
    };
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.setGraphValueForTest("examples/project-task-loop.yaml");
  assert.equal(await hooks.loadGraphDefinitionForTest("examples/project-task-loop.yaml"), true);
  hooks.appendActivationOutputForTest(streamChunk("activation-1", "review_code_quality", "codex", "stdout", "old agent output"));
  hooks.nodeStartedForTest({
    activation: runningActivation("activation-2", "review_functionality"),
  });

  const terminalHtml = elements.get("#terminal-content").innerHTML;
  assert.match(terminalHtml, /codex/);
  assert.match(terminalHtml, /review_functionality/);
  assert.doesNotMatch(terminalHtml, /old agent output/);
});

test("UI syncs the terminal with selected agent activations", () => {
  const { elements, windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.appendActivationOutputForTest(streamChunk("activation-1", "review_code_quality", "codex", "stdout", "quality output"));
  hooks.appendActivationOutputForTest(streamChunk("activation-2", "review_functionality", "claude", "stdout", "functionality output"));

  hooks.selectActivationForTest("activation-1");
  assert.match(elements.get("#terminal-content").innerHTML, /quality output/);

  hooks.selectActivationForTest("activation-2");
  const terminalHtml = elements.get("#terminal-content").innerHTML;
  assert.match(terminalHtml, /functionality output/);
  assert.doesNotMatch(terminalHtml, /quality output/);
});

test("UI clears terminal state when a new run starts", async () => {
  const { elements, windowStub } = loadUiTestHarness(async () => ({
    ok: true,
    json: async () => ({ runId: "new-run", status: "running" }),
  }), false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.appendActivationOutputForTest(streamChunk("activation-1", "implement_feature", "codex", "stdout", "old run output"));
  hooks.setGraphValueForTest("examples/project-task-loop.yaml");
  await hooks.startRunForTest();

  const terminalHtml = elements.get("#terminal-content").innerHTML;
  assert.match(terminalHtml, /等待 active agent 输出/);
  assert.doesNotMatch(terminalHtml, /old run output/);
});

test("UI backfills terminal output from completed agent rawResult", () => {
  const { elements, windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.nodeCompletedForTest({
    activation: {
      ...agentActivation("activation-1", "implement_feature", "codex"),
      status: "succeeded",
      rawResult: {
        activationId: "activation-1",
        nodeId: "implement_feature",
        backend: "codex",
        stdout: "raw stdout <ok>",
        stderr: "raw stderr <err>",
        exitCode: 0,
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
      },
    },
  });

  const terminalHtml = elements.get("#terminal-content").innerHTML;
  assert.match(terminalHtml, /raw stdout &lt;ok&gt;/);
  assert.match(terminalHtml, /raw stderr &lt;err&gt;/);
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
  assert.match(uiSource, /if\s*\(\s*domGraph\.value\s*!==\s*graphPath\s*\)\s*return/);
});

test("UI only installs test hooks behind an explicit test flag", () => {
  assert.match(uiSource, /AGENTGRAPH_ENABLE_TEST_HOOKS\s*===\s*true/);
  const { windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false, false);
  assert.equal((windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__, undefined);
});

test("UI graph selector ignores stale change handler renders", async () => {
  const initial = createDeferred({
    ok: true,
    json: async () => ({ id: "initial_graph", nodes: [{ id: "step_a", type: "codex", prompt: "Initial" }] }),
  });
  const stale = createDeferred({
    ok: true,
    json: async () => ({ id: "first_graph", nodes: [{ id: "run_tests", type: "execute", promptTemplate: "First" }] }),
  });
  const latest = createDeferred({
    ok: true,
    json: async () => ({ id: "second_graph", nodes: [{ id: "run_tests", type: "execute", promptTemplate: "Second" }] }),
  });
  const fetchResponses: Array<Deferred<unknown>> = [initial, stale, latest];
  const { elements, initDone } = loadUiTestHarness(async (url) => {
    if (url.endsWith("/api/graphs")) {
      return {
        ok: true,
        json: async () => [
          "examples/initial.yaml",
          "examples/first.yaml",
          "examples/second.yaml",
        ],
      };
    }

    const next = fetchResponses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next.promise;
  }, true);

  initial.resolve();
  await initDone;

  const graphSelect = elements.get("#graph-select");
  const inspector = elements.get("#inspector-content");
  const initialInspectorWrites = inspector.innerHTMLWrites;

  graphSelect.value = "examples/first.yaml";
  const firstChange = graphSelect.dispatchEvent(new Event("change"));

  graphSelect.value = "examples/second.yaml";
  const secondChange = graphSelect.dispatchEvent(new Event("change"));

  stale.resolve();
  await firstChange;
  assert.equal(inspector.innerHTMLWrites, initialInspectorWrites);
  assert.doesNotMatch(inspector.innerHTML, /First|first_graph/);

  latest.resolve();
  await secondChange;
  const latestInspectorHtml = inspector.innerHTML;
  assert.match(latestInspectorHtml, /Second/);
});

type UiTestHooks = {
  loadGraphDefinitionForTest: (graphPath: string) => Promise<boolean>;
  getCurrentGraphDefinitionForTest: () => { id?: string } | null;
  setGraphValueForTest: (graphPath: string) => void;
  startRunForTest: () => Promise<void>;
  nodeStartedForTest: (data: { activation: TestActivation }) => void;
  nodeCompletedForTest: (data: { activation: TestActivation }) => void;
  selectActivationForTest: (activationId: string) => void;
  appendActivationOutputForTest: (data: {
    activationId: string;
    nodeId: string;
    backend: string;
    stream: "stdout" | "stderr";
    chunk: string;
    timestamp: number;
  }) => void;
};

type TestActivation = {
  activationId: string;
  nodeId: string;
  status: string;
  inputs: Record<string, unknown>;
  iteration: number;
  startedAt: number;
  rawResult?: {
    activationId: string;
    nodeId: string;
    backend: string;
    stdout: string;
    stderr: string;
    exitCode: number | string;
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
  };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: () => void;
  reject: () => void;
};

function loadUiTestHooks(fetchImpl: (url: string) => Promise<unknown>): UiTestHooks {
  const { windowStub } = loadUiTestHarness(fetchImpl, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;
  assert.ok(hooks, "expected UI test hooks to be installed");
  return hooks;
}

function loadUiTestHarness(
  fetchImpl: (url: string) => Promise<unknown>,
  runInit: boolean,
  enableTestHooks = true,
) {
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
    AGENTGRAPH_ENABLE_TEST_HOOKS: enableTestHooks,
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
    EventSource: class EventSource {
      addEventListener() {}
      close() {}
    },
    Element: class Element {},
    Map,
    Date,
    Math,
    JSON,
    String,
    Number,
    encodeURIComponent,
  });

  const source = runInit
    ? uiSource.replace(/\ninit\(\);\s*$/, "\nwindow.__AGENTGRAPH_INIT_DONE__ = init();\n")
    : uiSource.replace(/\ninit\(\);\s*$/, "\n");
  vm.runInContext(source, context);
  const initDone = runInit ? (windowStub as any).__AGENTGRAPH_INIT_DONE__ as Promise<void> : Promise.resolve();
  return { elements, windowStub, initDone };
}

function agentActivation(activationId: string, nodeId: string, backend: "codex" | "claude"): TestActivation {
  const activation = runningActivation(activationId, nodeId);
  return {
    ...activation,
    rawResult: {
      activationId,
      nodeId,
      backend,
      stdout: "",
      stderr: "",
      exitCode: "running",
      startedAt: 1000,
    },
  };
}

function runningActivation(activationId: string, nodeId: string): TestActivation {
  return {
    activationId,
    nodeId,
    status: "running",
    inputs: {},
    iteration: 1,
    startedAt: 1000,
  };
}

function streamChunk(
  activationId: string,
  nodeId: string,
  backend: string,
  stream: "stdout" | "stderr",
  chunk: string,
) {
  return {
    activationId,
    nodeId,
    backend,
    stream,
    chunk,
    timestamp: 1000,
  };
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
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  let innerHTML = "";
  return {
    value: "",
    innerHTMLWrites: 0,
    get innerHTML() {
      return innerHTML;
    },
    set innerHTML(value: string) {
      innerHTML = value;
      this.innerHTMLWrites += 1;
    },
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
      if (!this.value && child.value) this.value = child.value;
    },
    addEventListener(type: string, listener: (event: unknown) => unknown) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    async dispatchEvent(event: { type: string }) {
      await Promise.all((listeners.get(event.type) ?? []).map((listener) => listener(event)));
      return true;
    },
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
