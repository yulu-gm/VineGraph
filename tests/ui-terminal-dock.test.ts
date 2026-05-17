import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const htmlSource = readFileSync("src/ui/index.html", "utf-8");
const uiSource = readFileSync("src/ui/app.js", "utf-8");
const cssSource = readFileSync("src/ui/style.css", "utf-8");

test("project declares real terminal dependencies", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
    dependencies?: Record<string, string>;
  };

  assert.ok(pkg.dependencies?.["@xterm/xterm"]);
  assert.ok(pkg.dependencies?.["@xterm/addon-fit"]);
  assert.ok(pkg.dependencies?.["node-pty"]);
});

test("runtime dock exposes resize, toggle, and terminal toolbar controls", () => {
  assert.match(
    htmlSource,
    /http:\/\/127\.0\.0\.1:3456\/vendor\/@xterm\/xterm\/css\/xterm\.css/
  );
  assert.match(htmlSource, /<script type="importmap">[\s\S]*@xterm\/xterm[\s\S]*@xterm\/addon-fit/);
  assert.match(
    htmlSource,
    /http:\/\/127\.0\.0\.1:3456\/vendor\/@xterm\/xterm\/lib\/xterm\.mjs/
  );
  assert.match(
    htmlSource,
    /http:\/\/127\.0\.0\.1:3456\/vendor\/@xterm\/addon-fit\/lib\/addon-fit\.mjs/
  );
  assert.match(htmlSource, /id="runtime-dock"[\s\S]*id="runtime-dock-resize-handle"/);
  assert.match(htmlSource, /id="runtime-dock-resize-handle"[^>]*tabindex="0"/);
  assert.match(htmlSource, /id="runtime-dock-resize-handle"[^>]*aria-valuemin=/);
  assert.match(htmlSource, /id="runtime-dock-resize-handle"[^>]*aria-valuemax=/);
  assert.match(htmlSource, /id="runtime-dock-resize-handle"[^>]*aria-valuenow=/);
  assert.match(htmlSource, /id="btn-toggle-runtime-dock"/);
  assert.match(htmlSource, /class="terminal-toolbar"/);
  assert.match(htmlSource, /id="terminal-search"/);
  assert.match(htmlSource, /id="terminal-node-filter"/);
  assert.match(htmlSource, /id="terminal-follow"/);
  assert.match(htmlSource, /id="btn-copy-terminal"/);
  assert.match(htmlSource, /id="btn-clear-terminal-view"/);
  assert.match(htmlSource, /id="terminal-content"[\s\S]*id="terminal-xterm"/);
  assert.match(htmlSource, /id="terminal-xterm"[^>]*aria-label="Active run terminal"/);
  assert.match(htmlSource, /id="terminal-fallback-lines"/);
  assert.match(uiSource, /function bindRuntimeDockResize\(/);
  assert.match(uiSource, /vinegraph\.runtimeDockHeight/);
  assert.match(cssSource, /#runtime-dock-resize-handle/);
  assert.match(cssSource, /#runtime-dock\.is-collapsed/);
  assert.match(cssSource, /\.terminal-xterm/);
  assert.match(cssSource, /\.terminal-fallback-lines/);
});

test("terminal dock lazily imports and mounts xterm without loading modules in default VM hooks", () => {
  assert.match(uiSource, /import\("@xterm\/xterm"\)/);
  assert.match(uiSource, /import\("@xterm\/addon-fit"\)/);
  assert.match(uiSource, /window\.AGENTGRAPH_ENABLE_TEST_HOOKS[\s\S]*terminalModuleLoader/);
  assert.match(uiSource, /new Terminal\(/);
  assert.match(uiSource, /new FitAddon\(/);
  assert.match(uiSource, /\.loadAddon\(terminalFitAddon\)/);
  assert.match(uiSource, /domTerminalXterm/);
});

test("terminal entry model is explicit and renderable", () => {
  assert.match(uiSource, /const TERMINAL_MAX_ENTRIES = 5000/);
  assert.match(uiSource, /let terminalEntries = \[\]/);
  assert.match(uiSource, /let terminalViewClearedAt = 0/);
  assert.match(uiSource, /function appendTerminalEntry\(data\)/);
  assert.match(uiSource, /function renderTerminalEntries\(/);
  assert.match(uiSource, /function renderTerminalLine\(entry\)/);
  assert.match(uiSource, /function ansiToHtml\(text\)/);
  assert.match(htmlSource, /terminal-follow/);
  assert.match(htmlSource, /terminal-search/);
  assert.match(htmlSource, /terminal-node-filter/);
});

test("terminal scrollback is bounded, frame scheduled, and node filter only updates on new nodes", () => {
  const { elements, windowStub, flushAnimationFrames } = loadUiTestHarness(
    async () => {
      throw new Error("unexpected fetch");
    },
    [],
    new Map(),
    true,
  );
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;
  const terminal = elements.get("#terminal-content");
  const nodeFilter = elements.get("#terminal-node-filter");

  hooks.appendTerminalEntryForTest(streamChunk("act-1", "same_node", "codex", "stdout", "first"));
  hooks.appendTerminalEntryForTest(streamChunk("act-1", "same_node", "codex", "stdout", "second"));
  assert.equal(terminal.innerHTML, "");
  assert.equal(nodeFilter.innerHTMLWrites, 1);

  flushAnimationFrames();
  assert.match(terminal.innerHTML, /first/);
  assert.match(terminal.innerHTML, /second/);
  assert.equal(nodeFilter.innerHTMLWrites, 1);

  hooks.appendTerminalEntryForTest(streamChunk("act-2", "other_node", "codex", "stdout", "third"));
  assert.equal(nodeFilter.innerHTMLWrites, 2);

  for (let i = 0; i < 5005; i += 1) {
    hooks.appendTerminalEntryForTest(streamChunk(`act-${i}`, "same_node", "codex", "stdout", `line-${i}`));
  }
  assert.equal(hooks.getTerminalEntriesForTest().length, 5000);

  elements.get("#terminal-search").value = "line-5004";
  flushAnimationFrames();
  hooks.renderTerminalEntriesForTest();
  assert.match(terminal.innerHTML, /line-5004/);
  assert.doesNotMatch(terminal.innerHTML, /line-0/);
});

test("ANSI parser escapes text and closes color spans across color changes and resets", () => {
  const { windowStub } = loadUiTestHarness(async () => {
    throw new Error("unexpected fetch");
  });
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;

  const html = hooks.ansiToHtmlForTest("\u001b[31mred <x>\u001b[32mgreen & y\u001b[0m plain \u001b[34mblue");
  assert.equal(countMatches(html, /<span class="ansi-/g), countMatches(html, /<\/span>/g));
  assert.match(html, /<span class="ansi-red">red &lt;x&gt;<\/span><span class="ansi-green">green &amp; y<\/span> plain <span class="ansi-blue">blue<\/span>/);
});

test("terminal renders appended entries with escaped ANSI colors, search, node filter, clear, and copy", async () => {
  const clipboardWrites: string[] = [];
  const { elements, windowStub } = loadUiTestHarness(
    async () => {
      throw new Error("unexpected fetch");
    },
    clipboardWrites,
  );
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;

  hooks.appendTerminalEntryForTest({
    activationId: "act-1",
    nodeId: "implement_feature",
    backend: "codex",
    stream: "stdout",
    chunk: "\u001b[32mok <safe>\u001b[0m\n",
    timestamp: 1_700_000_000_000,
  });
  hooks.appendTerminalEntryForTest({
    activationId: "act-2",
    nodeId: "run_tests",
    backend: "shell",
    stream: "stderr",
    chunk: "\u001b[31mboom & fail\u001b[0m\n",
    timestamp: 1_700_000_001_000,
  });

  const terminal = elements.get("#terminal-content");
  assert.match(terminal.innerHTML, /terminal-line/);
  assert.match(terminal.innerHTML, /implement_feature/);
  assert.match(terminal.innerHTML, /ansi-green/);
  assert.match(terminal.innerHTML, /ok &lt;safe&gt;/);
  assert.match(terminal.innerHTML, /run_tests/);
  assert.match(terminal.innerHTML, /terminal-stderr/);
  assert.match(terminal.innerHTML, /ansi-red/);
  assert.match(terminal.innerHTML, /boom &amp; fail/);

  elements.get("#terminal-search").value = "boom";
  hooks.renderTerminalEntriesForTest();
  assert.doesNotMatch(terminal.innerHTML, /ok &lt;safe&gt;/);
  assert.match(terminal.innerHTML, /boom &amp; fail/);

  elements.get("#terminal-search").value = "";
  elements.get("#terminal-node-filter").value = "implement_feature";
  hooks.renderTerminalEntriesForTest();
  assert.match(terminal.innerHTML, /ok &lt;safe&gt;/);
  assert.doesNotMatch(terminal.innerHTML, /boom &amp; fail/);

  await hooks.copyVisibleTerminalForTest();
  assert.equal(clipboardWrites.at(-1), "ok <safe>\n");

  hooks.clearTerminalViewForTest();
  assert.match(terminal.innerHTML, /等待 active agent 输出/);

  hooks.appendTerminalEntryForTest(streamChunk("act-3", "implement_feature", "codex", "stdout", "future output"));
  assert.match(terminal.innerHTML, /future output/);
});

test("xterm terminal writes terminal SSE output and sends input, interrupt, resize, clear, and copy", async () => {
  const fetchCalls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const terminalInstances: any[] = [];
  let onData: ((data: string) => unknown) | null = null;

  class FakeTerminal {
    cols = 101;
    rows = 37;
    writes: string[] = [];
    selection = "";
    clearCount = 0;
    openedElement: unknown = null;

    constructor(public options: Record<string, unknown>) {
      terminalInstances.push(this);
    }

    open(element: unknown) {
      this.openedElement = element;
    }

    loadAddon(addon: unknown) {
      this.addon = addon;
    }

    onData(listener: (data: string) => unknown) {
      onData = listener;
      return { dispose() {} };
    }

    write(chunk: string) {
      this.writes.push(chunk);
    }

    clear() {
      this.clearCount += 1;
    }

    getSelection() {
      return this.selection;
    }
  }

  class FakeFitAddon {
    fitCount = 0;
    fit() {
      this.fitCount += 1;
    }
  }

  const clipboardWrites: string[] = [];
  const { windowStub } = loadUiTestHarness(
    async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    clipboardWrites,
  );
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;
  hooks.setTerminalModuleLoaderForTest(async (name: string) => {
    if (name === "@xterm/xterm") return { Terminal: FakeTerminal };
    if (name === "@xterm/addon-fit") return { FitAddon: FakeFitAddon };
    throw new Error(`unexpected module ${name}`);
  });

  await hooks.initializeTerminalForTest();
  hooks.setCurrentRunIdForTest("run-1");
  await hooks.handleTerminalOutputForTest({ chunk: "raw terminal output" });
  hooks.appendActivationOutputForTest(streamChunk("act-legacy", "legacy_node", "codex", "stdout", "legacy output"));

  assert.equal(terminalInstances.length, 1);
  assert.equal(terminalInstances[0].writes.length, 1);
  assert.equal(terminalInstances[0].writes[0], "raw terminal output");

  await onData?.("hello\n");
  await onData?.("\x03");
  await hooks.fitTerminalForTest();

  assert.ok(fetchCalls.some((call) =>
    call.url.endsWith("/api/runs/run-1/terminal/input") &&
    call.init?.method === "POST" &&
    call.init.body === JSON.stringify({ input: "hello\n" })
  ));
  assert.ok(fetchCalls.some((call) =>
    call.url.endsWith("/api/runs/run-1/terminal/interrupt") &&
    call.init?.method === "POST"
  ));
  assert.ok(fetchCalls.some((call) =>
    call.url.endsWith("/api/runs/run-1/terminal/resize") &&
    call.init?.method === "POST" &&
    call.init.body === JSON.stringify({ cols: 101, rows: 37 })
  ));

  terminalInstances[0].selection = "selected from xterm";
  await hooks.copyVisibleTerminalForTest();
  assert.equal(clipboardWrites.at(-1), "selected from xterm");

  hooks.clearTerminalViewForTest();
  assert.equal(terminalInstances[0].clearCount, 1);
});

test("selecting a terminal activation attaches snapshot and binds actions to that session", async () => {
  const fetchCalls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const terminalInstances: any[] = [];
  let onData: ((data: string) => unknown) | null = null;

  class FakeTerminal {
    cols = 88;
    rows = 29;
    writes: string[] = [];
    clearCount = 0;

    constructor(public options: Record<string, unknown>) {
      terminalInstances.push(this);
    }

    open() {}
    loadAddon() {}
    onData(listener: (data: string) => unknown) {
      onData = listener;
      return { dispose() {} };
    }
    write(chunk: string) {
      this.writes.push(chunk);
    }
    clear() {
      this.clearCount += 1;
    }
    getSelection() {
      return "";
    }
  }

  class FakeFitAddon {
    fit() {}
  }

  const storage = new Map<string, string>();
  const { windowStub } = loadUiTestHarness(
    async (url, init) => {
      fetchCalls.push({ url, init });
      if (String(url).includes("/api/runs/run-attach/terminal/sessions/term-1")) {
        return {
          ok: true,
          json: async () => ({
            runId: "run-attach",
            sessionId: "term-1",
            terminalSessionId: "term-1",
            activationId: "act-1",
            nodeId: "shell_node",
            status: "running",
            snapshot: "snapshot line\n",
            truncated: false,
            snapshotMaxChars: 200_000,
            liveEventsUrl: "/api/runs/run-attach/events",
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    [],
    storage,
  );
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;
  hooks.setTerminalModuleLoaderForTest(async (name: string) => {
    if (name === "@xterm/xterm") return { Terminal: FakeTerminal };
    if (name === "@xterm/addon-fit") return { FitAddon: FakeFitAddon };
    throw new Error(`unexpected module ${name}`);
  });

  await hooks.initializeTerminalForTest();
  hooks.setCurrentRunIdForTest("run-attach");
  hooks.setCurrentRunProjectIdForTest("project-1");
  hooks.nodeCompletedForTest({
    activation: {
      activationId: "act-1",
      nodeId: "shell_node",
      terminalSessionId: "term-1",
      status: "succeeded",
      inputs: {},
      iteration: 1,
      startedAt: 1,
      finishedAt: 2,
      rawResult: {
        activationId: "act-1",
        nodeId: "shell_node",
        backend: "shell",
        terminalSessionId: "term-1",
        stdout: "",
        stderr: "",
        exitCode: 0,
        terminalTranscript: "persisted transcript",
        terminalMode: "pty",
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
      },
    },
  });
  await hooks.selectActivationForTest("act-1");

  assert.equal(terminalInstances.length, 1);
  assert.equal(terminalInstances[0].clearCount, 1);
  assert.deepEqual(terminalInstances[0].writes, ["snapshot line\n"]);
  assert.ok(fetchCalls.some((call) =>
    call.url.includes("/api/runs/run-attach/terminal/sessions/term-1?projectId=project-1")
  ));
  assert.equal(
    storage.get("vinegraph.terminalAttachment"),
    JSON.stringify({ runId: "run-attach", sessionId: "term-1", projectId: "project-1" })
  );

  await hooks.handleTerminalOutputForTest({
    terminalSessionId: "term-other",
    chunk: "wrong session",
  });
  await hooks.handleTerminalOutputForTest({
    terminalSessionId: "term-1",
    chunk: "live session",
  });
  assert.deepEqual(terminalInstances[0].writes, ["snapshot line\n", "live session"]);

  await onData?.("typed\n");
  await onData?.("\x03");
  await hooks.fitTerminalForTest();

  const inputCall = fetchCalls.find((call) =>
    call.url.endsWith("/api/runs/run-attach/terminal/input")
  );
  const interruptCall = fetchCalls.find((call) =>
    call.url.endsWith("/api/runs/run-attach/terminal/interrupt")
  );
  const resizeCall = fetchCalls.find((call) =>
    call.url.endsWith("/api/runs/run-attach/terminal/resize")
  );

  assert.deepEqual(JSON.parse(inputCall?.init?.body ?? "{}"), {
    input: "typed\n",
    sessionId: "term-1",
  });
  assert.deepEqual(JSON.parse(interruptCall?.init?.body ?? "{}"), {
    sessionId: "term-1",
  });
  assert.deepEqual(JSON.parse(resizeCall?.init?.body ?? "{}"), {
    cols: 88,
    rows: 29,
    sessionId: "term-1",
  });
});

test("terminal reattach failure from sessionStorage leaves fallback log rendering usable", async () => {
  const storage = new Map<string, string>([
    ["vinegraph.terminalAttachment", JSON.stringify({ runId: "run-old", sessionId: "term-old", projectId: "project-old" })],
  ]);
  const { elements, windowStub } = loadUiTestHarness(
    async (url) => {
      if (String(url).includes("/api/runs/run-old/terminal/sessions/term-old?projectId=project-old")) {
        return { ok: false, json: async () => ({ error: "missing session" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    [],
    storage,
  );
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;

  await hooks.restoreTerminalAttachmentForTest();
  await flushPromises();
  hooks.appendTerminalEntryForTest(streamChunk("act-fallback", "plain_node", "shell", "stdout", "fallback still works"));

  assert.match(elements.get("#terminal-content").innerHTML, /fallback still works/);
  assert.equal(storage.has("vinegraph.terminalAttachment"), false);
});

test("Tauri terminal bridge normalizes native payloads and routes actions", async () => {
  const fetchCalls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const listeners = new Map<string, (event: { payload: unknown }) => unknown>();
  const terminalInstances: FakeTerminalForBridge[] = [];
  let onData: ((data: string) => unknown) | undefined;

  class FakeTerminalForBridge {
    writes: string[] = [];
    clearCount = 0;
    cols = 80;
    rows = 24;
    constructor() {
      terminalInstances.push(this);
    }
    open() {}
    loadAddon() {}
    onData(listener: (data: string) => unknown) {
      onData = listener;
      return { dispose() {} };
    }
    write(chunk: string) {
      this.writes.push(chunk);
    }
    clear() {
      this.clearCount += 1;
    }
    getSelection() {
      return "";
    }
  }

  const { windowStub } = loadUiTestHarness(
    async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: false, json: async () => ({ error: "server missing" }) };
    },
    [],
    new Map(),
    false,
    {
      __TAURI__: {
        core: {
          invoke: async (command: string, args: Record<string, unknown>) => {
            invokeCalls.push({ command, args });
            if (command === "terminal_attach_session") {
              return {
                runId: "run-native",
                sessionId: "native-1",
                activationId: "act-native",
                nodeId: "shell_node",
                status: "running",
                snapshot: "native snapshot\n",
                truncated: false,
                snapshotMaxChars: 200_000,
                liveEventsUrl: "",
              };
            }
            return {};
          },
        },
        event: {
          listen: async (eventName: string, listener: (event: { payload: unknown }) => unknown) => {
            listeners.set(eventName, listener);
            return () => {};
          },
        },
      },
    },
  );
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;
  hooks.setTerminalModuleLoaderForTest(async (name: string) => {
    if (name === "@xterm/xterm") return { Terminal: FakeTerminalForBridge };
    if (name === "@xterm/addon-fit") return { FitAddon: class { fit() {} } };
    throw new Error(`unexpected module ${name}`);
  });

  await hooks.initializeTerminalForTest();
  hooks.registerTauriTerminalEventsForTest();
  await flushPromises();
  assert.ok(listeners.has("terminal://session-started"));
  assert.ok(listeners.has("terminal://output"));

  await listeners.get("terminal://session-started")?.({
    payload: {
      runId: "run-native",
      sessionId: "native-1",
      activationId: "act-native",
      nodeId: "shell_node",
    },
  });
  await listeners.get("terminal://output")?.({
    payload: {
      sessionId: "native-1",
      chunk: "native live",
    },
  });
  assert.deepEqual(terminalInstances[0].writes, ["native live"]);

  await hooks.attachTerminalSessionForTest("run-native", "native-1");
  assert.ok(fetchCalls.some((call) =>
    call.url.includes("/api/runs/run-native/terminal/sessions/native-1")
  ));
  assert.equal(terminalInstances[0].clearCount, 1);
  assert.deepEqual(terminalInstances[0].writes, ["native live", "native snapshot\n"]);

  await onData?.("typed\n");
  await onData?.("\x03");
  assert.deepEqual(
    JSON.parse(JSON.stringify(invokeCalls.filter((call) => call.command !== "terminal_attach_session"))),
    [
    { command: "terminal_resize", args: { sessionId: "native-1", cols: 80, rows: 24 } },
    { command: "terminal_write", args: { sessionId: "native-1", data: "typed\n" } },
    { command: "terminal_interrupt", args: { sessionId: "native-1" } },
    ]
  );
});

test("runtime dock resize persists height and toggle preserves saved height", () => {
  const storage = new Map<string, string>([["vinegraph.runtimeDockHeight", "340"]]);
  const { elements, windowStub } = loadUiTestHarness(
    async () => {
      throw new Error("unexpected fetch");
    },
    [],
    storage,
  );
  const hooks = (windowStub as any).__AGENTGRAPH_UI_TEST_HOOKS__;
  const dock = elements.get("#runtime-dock");
  const handle = elements.get("#runtime-dock-resize-handle");
  const toggle = elements.get("#btn-toggle-runtime-dock");

  hooks.bindRuntimeDockResizeForTest();
  assert.equal(dock.style.height, "340px");
  assert.equal(handle.attributes.get("aria-valuenow"), "340");

  handle.dispatchEvent({ type: "pointerdown", pointerId: 7, clientY: 500, button: 0, preventDefault() {} });
  windowStub.dispatchEvent({ type: "pointermove", pointerId: 7, clientY: 420 });
  windowStub.dispatchEvent({ type: "pointerup", pointerId: 7 });
  assert.equal(dock.style.height, "420px");
  assert.equal(storage.get("vinegraph.runtimeDockHeight"), "420");
  assert.equal(handle.attributes.get("aria-valuenow"), "420");

  handle.dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault() {} });
  assert.equal(dock.style.height, "400px");
  assert.equal(handle.attributes.get("aria-valuenow"), "400");

  handle.dispatchEvent({ type: "keydown", key: "Home", preventDefault() {} });
  assert.equal(dock.style.height, "180px");
  assert.equal(handle.attributes.get("aria-valuenow"), "180");

  handle.dispatchEvent({ type: "keydown", key: "End", preventDefault() {} });
  assert.equal(dock.style.height, "503px");
  assert.equal(handle.attributes.get("aria-valuenow"), "503");

  toggle.dispatchEvent({ type: "click" });
  assert.equal(dock.classList.contains("is-collapsed"), true);
  assert.equal(toggle.attributes.get("aria-expanded"), "false");
  assert.equal(toggle.attributes.get("aria-label"), "展开运行面板");
  assert.equal(toggle.title, "展开运行面板");
  assert.equal(toggle.textContent, "+");

  toggle.dispatchEvent({ type: "click" });
  assert.equal(dock.classList.contains("is-collapsed"), false);
  assert.equal(dock.style.height, "503px");
  assert.equal(toggle.attributes.get("aria-expanded"), "true");
  assert.equal(toggle.attributes.get("aria-label"), "收起运行面板");
  assert.equal(toggle.title, "收起运行面板");
  assert.equal(toggle.textContent, "×");
});

function loadUiTestHarness(
  fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>,
  clipboardWrites: string[] = [],
  storage = new Map<string, string>(),
  enableRaf = false,
  windowOverrides: Record<string, unknown> = {},
) {
  const elements = new Map<string, any>();

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
  const windowListeners = new Map<string, Array<(event: any) => unknown>>();
  const animationFrames: Array<() => void> = [];
  const windowStub = {
    AGENTGRAPH_ENABLE_TEST_HOOKS: true,
    location: {
      hostname: "127.0.0.1",
      protocol: "http:",
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    innerHeight: 720,
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          clipboardWrites.push(text);
        },
      },
    },
    addEventListener(type: string, listener: (event: any) => unknown) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: (event: any) => unknown) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== listener));
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of windowListeners.get(event.type) ?? []) listener(event);
      return true;
    },
    requestAnimationFrame: enableRaf
      ? (callback: () => void) => {
          animationFrames.push(callback);
          return animationFrames.length;
        }
      : undefined,
    open() {},
    ...windowOverrides,
  };

  const context = vm.createContext({
    console,
    document: documentStub,
    fetch: fetchImpl,
    window: windowStub,
    navigator: windowStub.navigator,
    localStorage: windowStub.localStorage,
    sessionStorage: windowStub.sessionStorage,
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
    URLSearchParams,
    encodeURIComponent,
  });

  vm.runInContext(uiSource.replace(/\ninit\(\);\s*$/, "\n"), context);
  return {
    elements,
    windowStub,
    flushAnimationFrames: () => {
      while (animationFrames.length > 0) {
        animationFrames.shift()?.();
      }
    },
  };
}

async function flushPromises(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
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
    timestamp: 1_700_000_002_000,
  };
}

function createElementStub() {
  const listeners = new Map<string, Array<(event: any) => unknown>>();
  const children = new Map<string, any>();
  let innerHTML = "";
  const classNames = new Set<string>();
  const element: any = {
    value: "",
    checked: true,
    innerHTMLWrites: 0,
    textContent: "",
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 100,
    style: {} as Record<string, string>,
    dataset: {},
    attributes: new Map<string, string>(),
    classList: {
      add(name: string) {
        classNames.add(name);
      },
      remove(name: string) {
        classNames.delete(name);
      },
      contains(name: string) {
        return classNames.has(name);
      },
      toggle(name: string, force?: boolean) {
        const shouldAdd = force ?? !classNames.has(name);
        if (shouldAdd) classNames.add(name);
        else classNames.delete(name);
        return shouldAdd;
      },
    },
    addEventListener(type: string, listener: (event: any) => unknown) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: (event: any) => unknown) {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    querySelector(selector: string) {
      return children.get(selector) ?? null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 900, height: 600 };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  return {
    ...element,
    get innerHTML() {
      return innerHTML;
    },
    set innerHTML(value: string) {
      innerHTML = value;
      this.innerHTMLWrites += 1;
      children.clear();
      for (const match of value.matchAll(/<(input|select|button|span)\b([^>]*)id="([^"]+)"([^>]*)>([\s\S]*?)(?:<\/\1>)?/g)) {
        const [, tag, beforeAttrs, id, afterAttrs, content] = match;
        const attrs = `${beforeAttrs} ${afterAttrs}`;
        const child = createElementStub();
        child.disabled = /\sdisabled(?:\s|>|$)/.test(attrs);
        child.checked = !/\stype="checkbox"[\s\S]*?(?:\s|^)checked/.test(attrs) || /\schecked(?:\s|>|$)/.test(attrs);
        const valueMatch = attrs.match(/\svalue="([^"]*)"/);
        child.value = valueMatch ? decodeHtml(valueMatch[1]) : "";
        child.textContent = tag === "span" ? decodeHtml(content ?? "") : "";
        children.set(`#${id}`, child);
      }
    },
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}
