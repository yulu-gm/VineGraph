import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const launcher = readFileSync("start-tauri.bat", "utf-8");
const macLauncher = readFileSync("start-tauri.sh", "utf-8");
const browserLauncher = readFileSync("start.bat", "utf-8");
const uiIndex = readFileSync("src/ui/index.html", "utf-8");
const tauriConfig = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf-8")
) as {
  build?: {
    beforeDevCommand?: string;
    devUrl?: string;
  };
  plugins?: {
    shell?: Record<string, unknown>;
  };
};
const tauriMain = readFileSync("src-tauri/src/main.rs", "utf-8");
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("tauri launcher bootstraps project dependencies before launch", () => {
  assert.match(launcher, /npm\.cmd install/);
  assert.match(launcher, /node_modules\\\.bin\\tauri\.cmd/);
  assert.match(launcher, /CARGO_EXE/);
  assert.match(launcher, /"%CARGO_EXE%"\s+build/);
  assert.match(launcher, /target\\debug\\agentgraph\.exe/);
  assert.doesNotMatch(launcher, /tauri:dev/);
});

test("tauri launcher loads local environment files before launch", () => {
  assert.match(launcher, /call :load_local_env/);
  assert.match(launcher, /\.env\.local/);
  assert.match(launcher, /DEEPSEEK_API_KEY/);
});

test("tauri launcher can bootstrap Node.js when npm is missing", () => {
  assert.match(launcher, /winget install .*OpenJS\.NodeJS\.LTS/i);
});

test("tauri launcher can bootstrap Rust when cargo is missing", () => {
  assert.match(launcher, /rustup default stable-msvc/);
  assert.match(launcher, /winget install .*Rustlang\.Rustup/i);
});

test("macOS tauri launcher can repair a missing Rust stable toolchain", () => {
  assert.match(macLauncher, /rustup default stable/);
  assert.match(macLauncher, /rustc --version/);
  assert.match(macLauncher, /cargo --version/);
});

test("tauri launcher can bootstrap Windows C++ build tools", () => {
  assert.match(launcher, /Microsoft\.VisualStudio\.2022\.BuildTools/i);
  assert.match(launcher, /Microsoft\.VisualStudio\.Workload\.VCTools/i);
});

test("project provides a local Tauri CLI entrypoint", () => {
  assert.ok(pkg.devDependencies?.["@tauri-apps/cli"]);
  assert.equal(pkg.scripts?.["tauri:dev"], "tauri dev");
});

test("tauri launcher starts a stable desktop client without dev watcher output", () => {
  assert.match(launcher, /:build_tauri_debug/);
  assert.match(launcher, /:start_server/);
  assert.match(launcher, /agentgraph-server\.log/);
  assert.match(launcher, /api\/graphs/);
  assert.match(launcher, /start\s+\/wait\s+"AgentGraph"/);
  assert.doesNotMatch(launcher, /npm\.cmd run tauri:dev/);
});

test("tauri launcher clears stale WebView assets before opening the client", () => {
  assert.match(launcher, /:clear_webview_cache/);
  assert.match(launcher, /com\.agentgraph\.app/);
  assert.match(launcher, /EBWebView/);
});

test("browser launcher waits for the graph API before opening the UI", () => {
  assert.match(browserLauncher, /npm\.cmd run start -- --serve --port %PORT%/);
  assert.match(browserLauncher, /api\/graphs/);
  assert.match(browserLauncher, /project-task-loop/);
  assert.doesNotMatch(browserLauncher, /timeout \/t 3/);
});

test("UI assets are cache-busted for the desktop WebView", () => {
  assert.match(uiIndex, /style\.css\?v=/);
  assert.match(uiIndex, /app\.js\?v=/);
});

test("tauri dev starts the local HTTP server before waiting for devUrl", () => {
  assert.equal(tauriConfig.build?.devUrl, "http://localhost:3456");
  assert.equal(
    tauriConfig.build?.beforeDevCommand,
    "npm run start -- --serve --port 3456"
  );
});

test("tauri runtime does not start a duplicate server when devUrl is already running", () => {
  assert.match(tauriMain, /TcpStream::connect/);
  assert.match(tauriMain, /server_is_running\(3456\)/);
});

test("tauri runtime starts the Node server with platform-specific commands", () => {
  assert.match(tauriMain, /cfg!\(windows\)/);
  assert.match(tauriMain, /"npm\.cmd"/);
  assert.match(tauriMain, /"npm"/);
  assert.match(tauriMain, /node_modules\\\\.bin\\\\tsx\.cmd/);
  assert.match(tauriMain, /node_modules\/\.bin\/tsx/);
});

test("tauri runtime resolves the project root from the executable path when cwd is wrong", () => {
  assert.match(tauriMain, /current_exe\(\)/);
  assert.match(tauriMain, /package\.json/);
  assert.match(tauriMain, /examples/);
});

test("tauri shell plugin config uses only Tauri 2 supported fields", () => {
  assert.deepEqual(Object.keys(tauriConfig.plugins?.shell ?? {}).sort(), [
    "open",
  ]);
});
