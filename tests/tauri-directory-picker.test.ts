import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("src-tauri/src/main.rs", "utf-8");
const tauriConfig = readFileSync("src-tauri/tauri.conf.json", "utf-8");

test("Tauri exposes a native project directory picker command to the UI", () => {
  assert.match(mainSource, /fn pick_project_directory\(\)/);
  assert.match(mainSource, /choose folder/);
  assert.match(
    mainSource,
    /tauri::generate_handler!\[[^\]]*\bpick_project_directory\b[^\]]*\]/
  );
  assert.match(tauriConfig, /"withGlobalTauri":\s*true/);
});
