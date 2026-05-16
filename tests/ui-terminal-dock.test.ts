import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const htmlSource = readFileSync("src/ui/index.html", "utf-8");
const uiSource = readFileSync("src/ui/app.js", "utf-8");
const cssSource = readFileSync("src/ui/style.css", "utf-8");

test("runtime dock exposes resize, toggle, and terminal toolbar controls", () => {
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
  assert.match(uiSource, /function bindRuntimeDockResize\(/);
  assert.match(uiSource, /vinegraph\.runtimeDockHeight/);
  assert.match(cssSource, /#runtime-dock-resize-handle/);
  assert.match(cssSource, /#runtime-dock\.is-collapsed/);
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
  };

  const context = vm.createContext({
    console,
    document: documentStub,
    fetch: fetchImpl,
    window: windowStub,
    navigator: windowStub.navigator,
    localStorage: windowStub.localStorage,
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
