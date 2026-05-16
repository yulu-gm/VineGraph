import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const htmlSource = readFileSync("src/ui/index.html", "utf-8");
const uiSource = readFileSync("src/ui/app.js", "utf-8");
const cssSource = readFileSync("src/ui/style.css", "utf-8");

test("runtime dock exposes resize, toggle, and terminal toolbar controls", () => {
  assert.match(htmlSource, /id="runtime-dock"[\s\S]*id="runtime-dock-resize-handle"/);
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

  handle.dispatchEvent({ type: "pointerdown", pointerId: 7, clientY: 500, button: 0, preventDefault() {} });
  windowStub.dispatchEvent({ type: "pointermove", pointerId: 7, clientY: 420 });
  windowStub.dispatchEvent({ type: "pointerup", pointerId: 7 });
  assert.equal(dock.style.height, "420px");
  assert.equal(storage.get("vinegraph.runtimeDockHeight"), "420");

  toggle.dispatchEvent({ type: "click" });
  assert.equal(dock.classList.contains("is-collapsed"), true);
  assert.equal(toggle.attributes.get("aria-expanded"), "false");

  toggle.dispatchEvent({ type: "click" });
  assert.equal(dock.classList.contains("is-collapsed"), false);
  assert.equal(dock.style.height, "420px");
  assert.equal(toggle.attributes.get("aria-expanded"), "true");
});

function loadUiTestHarness(
  fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>,
  clipboardWrites: string[] = [],
  storage = new Map<string, string>(),
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
  return { elements, windowStub };
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
