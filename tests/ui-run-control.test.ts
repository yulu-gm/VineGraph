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
  assert.match(uiSource, /renderTerminal/);
  assert.doesNotMatch(uiSource, /terminalBuffers/);
  assert.match(uiSource, /function appendActivationOutput\(data\)[\s\S]*upsertActivation\([\s\S]*deferRender: true/);
  assert.match(uiSource, /function scheduleActivationRender\(/);
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
  assert.match(terminal.innerHTML, /diagnostics/);
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

test("UI clears active graph node state when a new run starts", async () => {
  const { elements, windowStub } = loadUiTestHarness(async () => ({
    ok: true,
    json: async () => ({ runId: "new-run", status: "running" }),
  }), false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.setGraphValueForTest("examples/project-task-loop.yaml");
  hooks.nodeStartedForTest({
    activation: runningActivation("activation-1", "implement_feature"),
  });
  assert.match(elements.get("#graph-canvas").innerHTML, /data-node-id="implement_feature"[\s\S]*is-active|is-active[\s\S]*data-node-id="implement_feature"/);

  await hooks.startRunForTest();

  assert.equal(hooks.getActiveGraphNodeIdForTest(), null);
  assert.doesNotMatch(elements.get("#graph-canvas").innerHTML, /is-active/);
});

test("UI tracks the currently running graph node from SSE events", () => {
  const { elements, windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.setGraphValueForTest("examples/project-task-loop.yaml");
  hooks.nodeStartedForTest({
    activation: runningActivation("activation-1", "implement_feature"),
  });
  hooks.nodeStartedForTest({
    activation: runningActivation("activation-2", "review_code_quality"),
  });

  assert.equal(hooks.getActiveGraphNodeIdForTest(), "review_code_quality");
  assert.match(elements.get("#graph-canvas").innerHTML, /data-node-id="review_code_quality"[\s\S]*is-active|is-active[\s\S]*data-node-id="review_code_quality"/);

  hooks.nodeCompletedForTest({
    activation: {
      ...runningActivation("activation-2", "review_code_quality"),
      status: "succeeded",
      finishedAt: 1200,
    },
  });

  assert.equal(hooks.getActiveGraphNodeIdForTest(), "implement_feature");
  assert.match(elements.get("#graph-canvas").innerHTML, /data-node-id="implement_feature"[\s\S]*is-active|is-active[\s\S]*data-node-id="implement_feature"/);

  hooks.nodeCompletedForTest({
    activation: {
      ...runningActivation("activation-1", "implement_feature"),
      status: "succeeded",
      finishedAt: 1300,
    },
  });

  assert.equal(hooks.getActiveGraphNodeIdForTest(), null);
  assert.doesNotMatch(elements.get("#graph-canvas").innerHTML, /is-active/);
});

test("UI clears active graph node and refreshes worktrees when a run completes", async () => {
  const requested: string[] = [];
  const { windowStub } = loadUiTestHarness(async (url, init) => {
    requested.push(url);
    if (url.endsWith("/api/projects/open") && init?.method === "POST") {
      return {
        ok: true,
        json: async () => ({ id: "project-1", name: "repo", rootPath: "/repo", kind: "directory", capabilities: { git: false } }),
      };
    }
    if (url.endsWith("/graph-assets") || url.endsWith("/workspaces")) {
      return {
        ok: true,
        json: async () => [],
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  await hooks.openProjectForTest("/repo");
  requested.length = 0;
  hooks.setGraphValueForTest("examples/project-task-loop.yaml");
  hooks.nodeStartedForTest({
    activation: runningActivation("activation-1", "implement_feature"),
  });

  await hooks.runCompletedForTest({
    runId: "run-1",
    status: "success",
    activations: [],
  });

  assert.equal(hooks.getActiveGraphNodeIdForTest(), null);
  assert.deepEqual(requested, ["/api/projects/project-1/workspaces"]);
});

test("server exposes worktree list and create endpoints", () => {
  assert.match(serverSource, /WorkspaceManager/);
  assert.match(serverSource, /WorktreeConflictError/);
  assert.match(serverSource, /url\.pathname === "\/api\/worktrees" && method === "GET"/);
  assert.match(serverSource, /url\.pathname === "\/api\/worktrees" && method === "POST"/);
  assert.match(serverSource, /handleListWorktrees/);
  assert.match(serverSource, /handleCreateWorktree/);
  assert.match(serverSource, /isPlainObject/);
  assert.match(serverSource, /409/);
});

test("server exposes self-iteration readiness endpoint", () => {
  assert.match(serverSource, /checkSelfIterationReadiness/);
  assert.match(serverSource, /url\.pathname === "\/api\/readiness" && method === "GET"/);
  assert.match(serverSource, /handleReadiness/);
});

test("server probes agent CLIs during application startup", () => {
  assert.match(serverSource, /initializeAgentCliEnvironment/);
  assert.match(serverSource, /initializeAgentCliEnvironment\(\{\s*log:\s*console\.log\s*\}\)/);
});

test("UI exposes worktree list and manual create controls", () => {
  assert.match(htmlSource, /id="worktree-list"/);
  assert.match(htmlSource, /id="worktree-name-input"/);
  assert.match(htmlSource, /id="btn-create-worktree"/);
  assert.match(uiSource, /async function loadWorktrees\(/);
  assert.match(uiSource, /async function createManualWorktree\(/);
  assert.match(uiSource, /worktreeRequestId/);
  assert.match(uiSource, /worktreeCreateInFlight/);
  assert.match(uiSource, /\/api\/projects\/\$\{encodeURIComponent\(currentProject\.id\)\}\/workspaces/);
  assert.doesNotMatch(uiSource, /apiUrl\("\/api\/worktrees"\)/);
});

test("UI can show self-iteration readiness", async () => {
  assert.match(htmlSource, /id="readiness-panel"/);
  assert.match(uiSource, /async function loadReadiness\(/);
  assert.match(uiSource, /\/api\/readiness\?path=/);

  const { elements, windowStub } = loadUiTestHarness(async (url) => {
    if (!url.includes("/api/readiness")) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: true,
      json: async () => ({
        ok: false,
        checks: [
          {
            id: "graph_load",
            label: "Graph loads",
            status: "pass",
            message: "Loaded project loop",
          },
          {
            id: "controller_key",
            label: "Controller API key",
            status: "fail",
            message: "Set DEEPSEEK_API_KEY <required>",
          },
        ],
      }),
    };
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.setGraphValueForTest("examples/project-task-loop.yaml");
  await hooks.loadReadinessForTest();

  const readinessHtml = elements.get("#readiness-panel").innerHTML;
  assert.match(readinessHtml, /FAIL/);
  assert.match(readinessHtml, /Graph loads/);
  assert.match(readinessHtml, /Controller API key/);
  assert.match(readinessHtml, /Set DEEPSEEK_API_KEY &lt;required&gt;/);
});

test("UI renders worktrees and creates manual worktrees through the API", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const { elements, windowStub } = loadUiTestHarness(async (url, init) => {
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url.endsWith("/api/projects/open") && init?.method === "POST") {
      return {
        ok: true,
        json: async () => ({ id: "project-1", name: "repo", rootPath: "C:/repo", kind: "git", capabilities: { git: true } }),
      };
    }

    if (url.endsWith("/graph-assets")) {
      return {
        ok: true,
        json: async () => [],
      };
    }

    if (url.endsWith("/workspaces") && init?.method === "POST") {
      return {
        ok: true,
        json: async () => ({
          id: "manual-review-lane",
          kind: "worktree",
          label: "manual-review-lane",
          path: "C:/repo/.agentgraph/worktrees/manual-review-lane",
          branch: null,
          detached: true,
          current: false,
        }),
      };
    }

    if (url.endsWith("/workspaces")) {
      return {
        ok: true,
        json: async () => [
          {
            id: "main",
            kind: "main",
            label: "repo",
            path: "C:/repo",
            branch: "main",
            detached: false,
            current: true,
          },
          {
            id: "manual-review-lane",
            kind: "worktree",
            label: "manual-review-lane",
            path: "C:/repo/.agentgraph/worktrees/manual-review-lane",
            branch: null,
            detached: true,
            current: false,
          },
        ],
      };
    }

    throw new Error(`unexpected fetch: ${url}`);
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  await hooks.openProjectForTest("C:/repo");
  const worktreeList = elements.get("#worktree-list");
  assert.match(worktreeList.innerHTML, /repo/);
  assert.match(worktreeList.innerHTML, /当前/);
  assert.match(worktreeList.innerHTML, /main/);
  assert.match(worktreeList.innerHTML, /manual-review-lane/);
  assert.match(worktreeList.innerHTML, /detached/);

  elements.get("#worktree-name-input").value = "Review Lane";
  await hooks.createManualWorktreeForTest();

  assert.deepEqual(requests.filter((item) => item.url.endsWith("/workspaces")).map((item) => item.method), ["GET", "POST", "GET"]);
  assert.deepEqual(requests.find((item) => item.url.endsWith("/workspaces") && item.method === "POST")?.body, { name: "Review Lane" });
});

test("UI ignores stale worktree list responses", async () => {
  const stale = createDeferred({
    ok: true,
    json: async () => [
      {
        path: "C:/repo/.agentgraph/worktrees/manual-old",
        head: "a".repeat(40),
        branch: null,
        detached: true,
        current: false,
      },
    ],
  });
  const latest = createDeferred({
    ok: true,
    json: async () => [
      {
        path: "C:/repo/.agentgraph/worktrees/manual-latest",
        head: "b".repeat(40),
        branch: null,
        detached: true,
        current: false,
      },
    ],
  });
  const responses = [stale, latest];
  let workspaceRequestCount = 0;
  const { elements, windowStub } = loadUiTestHarness(async (url) => {
    if (url.endsWith("/api/projects/open")) {
      return {
        ok: true,
        json: async () => ({ id: "project-1", name: "repo", rootPath: "C:/repo", kind: "git", capabilities: { git: true } }),
      };
    }
    if (url.endsWith("/graph-assets")) {
      return { ok: true, json: async () => [] };
    }
    if (!url.endsWith("/workspaces")) throw new Error(`unexpected fetch: ${url}`);
    workspaceRequestCount += 1;
    if (workspaceRequestCount === 1) {
      return { ok: true, json: async () => [] };
    }
    const next = responses.shift();
    if (!next) throw new Error("unexpected worktree request");
    return next.promise;
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  await hooks.openProjectForTest("C:/repo");
  const firstLoad = hooks.loadWorktreesForTest();
  const secondLoad = hooks.loadWorktreesForTest();

  latest.resolve();
  await secondLoad;
  assert.match(elements.get("#worktree-list").innerHTML, /manual-latest/);

  stale.resolve();
  await firstLoad;
  assert.match(elements.get("#worktree-list").innerHTML, /manual-latest/);
  assert.doesNotMatch(elements.get("#worktree-list").innerHTML, /manual-old/);
});

test("UI prevents duplicate manual worktree creation while a request is in flight", async () => {
  const createResponse = createDeferred({
    ok: true,
    json: async () => ({
      id: "manual-review-lane",
      kind: "worktree",
      label: "manual-review-lane",
      path: "C:/repo/.agentgraph/worktrees/manual-review-lane",
      branch: null,
      detached: true,
      current: false,
    }),
  });
  let postCount = 0;
  const { elements, windowStub } = loadUiTestHarness(async (url, init) => {
    if (url.endsWith("/api/projects/open")) {
      return {
        ok: true,
        json: async () => ({ id: "project-1", name: "repo", rootPath: "C:/repo", kind: "git", capabilities: { git: true } }),
      };
    }
    if (url.endsWith("/graph-assets")) {
      return { ok: true, json: async () => [] };
    }
    if (!url.endsWith("/workspaces")) throw new Error(`unexpected fetch: ${url}`);
    if (init?.method === "POST") {
      postCount += 1;
      return createResponse.promise;
    }
    return {
      ok: true,
      json: async () => [],
    };
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  await hooks.openProjectForTest("C:/repo");
  elements.get("#worktree-name-input").value = "Review Lane";
  const firstCreate = hooks.createManualWorktreeForTest();
  const secondCreate = hooks.createManualWorktreeForTest();

  assert.equal(postCount, 1);
  await secondCreate;
  createResponse.resolve();
  await firstCreate;
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

test("UI treats successful agent stderr as diagnostics instead of an error stream", () => {
  const { elements, windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.nodeCompletedForTest({
    activation: {
      ...agentActivation("activation-1", "call_codex", "codex"),
      status: "succeeded",
      rawResult: {
        activationId: "activation-1",
        nodeId: "call_codex",
        backend: "codex",
        stdout: '{"tool":"codex","ok":true}',
        stderr: "OpenAI Codex v0.130.0\nworkdir: /Users/example",
        exitCode: 0,
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
      },
    },
  });

  const terminalHtml = elements.get("#terminal-content").innerHTML;
  const detailHtml = elements.get("#detail-content").innerHTML;
  assert.match(terminalHtml, /diagnostics/);
  assert.doesNotMatch(terminalHtml, /<h4>stderr<\/h4>/);
  assert.match(detailHtml, /diagnostics/);
  assert.doesNotMatch(detailHtml, /<h4>stderr<\/h4>/);
});

test("UI keeps failed agent stderr as an error stream", () => {
  const { elements, windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  hooks.nodeCompletedForTest({
    activation: {
      ...agentActivation("activation-1", "call_codex", "codex"),
      status: "failed",
      rawResult: {
        activationId: "activation-1",
        nodeId: "call_codex",
        backend: "codex",
        stdout: "",
        stderr: "real failure",
        exitCode: 1,
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
      },
    },
  });

  const terminalHtml = elements.get("#terminal-content").innerHTML;
  const detailHtml = elements.get("#detail-content").innerHTML;
  assert.match(terminalHtml, /<h4>stderr<\/h4>/);
  assert.match(detailHtml, /<h4>stderr<\/h4>/);
});

test("UI renders empty graph asset states instead of relying on a graph selector", () => {
  assert.match(uiSource, /graphAssets = Array\.isArray\(items\) \? items : \[\]/);
  assert.match(uiSource, /没有匹配的 graph asset/);
  assert.match(uiSource, /打开项目后显示图资产/);
});

test("UI uses the localhost server API when running from Tauri static assets", () => {
  assert.match(uiSource, /const API_ORIGIN = "http:\/\/127\.0\.0\.1:3456"/);
  assert.match(uiSource, /function apiUrl\(path\)/);
  assert.match(uiSource, /window\.location\.hostname/);
  assert.match(uiSource, /tauri\.localhost/);
  assert.match(uiSource, /fetch\(apiUrl\("\/api\/projects\/open"\)/);
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
  assert.match(uiSource, /currentGraphAsset\?\.relativePath\s*===\s*graphPath/);
  assert.match(uiSource, /return true/);
  assert.match(uiSource, /return false/);
  assert.match(uiSource, /currentGraphAsset\?\.relativePath\s*!==\s*graphPath/);
});

test("UI only installs test hooks behind an explicit test flag", () => {
  assert.match(uiSource, /AGENTGRAPH_ENABLE_TEST_HOOKS\s*===\s*true/);
  const { windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  }, false, false);
  assert.equal((windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__, undefined);
});

test("UI graph asset opener ignores stale asset detail renders", async () => {
  const stale = createDeferred({
    ok: true,
    json: async () => ({
      asset: { relativePath: "graphs/first.vg.yaml", name: "first.vg.yaml" },
      graph: { id: "first_graph", nodes: [{ id: "run_tests", type: "execute", promptTemplate: "First" }], edges: [] },
    }),
  });
  const latest = createDeferred({
    ok: true,
    json: async () => ({
      asset: { relativePath: "graphs/second.vg.yaml", name: "second.vg.yaml" },
      graph: { id: "second_graph", nodes: [{ id: "run_tests", type: "execute", promptTemplate: "Second" }], edges: [] },
    }),
  });
  const fetchResponses: Array<Deferred<unknown>> = [stale, latest];
  const { elements, windowStub } = loadUiTestHarness(async (url, init) => {
    if (url.endsWith("/api/projects/open") && init?.method === "POST") {
      return {
        ok: true,
        json: async () => ({ id: "project-1", name: "repo", rootPath: "/repo", kind: "directory", capabilities: { git: false } }),
      };
    }
    if (url.endsWith("/graph-assets") || url.endsWith("/workspaces") || url.endsWith("/api/worktrees")) {
      return {
        ok: true,
        json: async () => [],
      };
    }
    if (url.includes("/api/readiness")) {
      return {
        ok: true,
        json: async () => ({ ok: true, checks: [] }),
      };
    }

    const next = fetchResponses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next.promise;
  }, false);
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__ as UiTestHooks;

  await hooks.openProjectForTest("/repo");
  const inspector = elements.get("#inspector-content");

  const firstOpen = hooks.openGraphAssetForTest("graphs/first.vg.yaml");
  const secondOpen = hooks.openGraphAssetForTest("graphs/second.vg.yaml");

  stale.resolve();
  await firstOpen;
  assert.doesNotMatch(inspector.innerHTML, /First|first_graph/);

  latest.resolve();
  await secondOpen;
  const latestInspectorHtml = inspector.innerHTML;
  assert.match(latestInspectorHtml, /Second/);
});

type UiTestHooks = {
  loadGraphDefinitionForTest: (graphPath: string) => Promise<boolean>;
  getCurrentGraphDefinitionForTest: () => { id?: string } | null;
  getActiveGraphNodeIdForTest: () => string | null;
  setGraphValueForTest: (graphPath: string) => void;
  openProjectForTest: (rootPath: string) => Promise<void>;
  loadGraphAssetsForTest: () => Promise<void>;
  openGraphAssetForTest: (relativePath: string) => Promise<boolean>;
  loadWorkspaceTargetsForTest: () => Promise<void>;
  startRunForTest: () => Promise<void>;
  runCompletedForTest: (result: { runId: string; status: string; activations: TestActivation[] }) => Promise<void>;
  nodeStartedForTest: (data: { activation: TestActivation }) => void;
  nodeCompletedForTest: (data: { activation: TestActivation }) => void;
  selectActivationForTest: (activationId: string) => void;
  loadWorktreesForTest: () => Promise<void>;
  createManualWorktreeForTest: () => Promise<void>;
  loadReadinessForTest: () => Promise<void>;
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
  fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>,
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
