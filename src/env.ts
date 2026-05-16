import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;

  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const quote = value[0];
  if (
    (quote === "'" || quote === "\"") &&
    value.endsWith(quote) &&
    value.length >= 2
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;

  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    process.env[key] = value;
  }
}

export function loadLocalEnvFiles(root = process.cwd()): void {
  loadEnvFile(join(root, ".env"));
  loadEnvFile(join(root, ".env.local"));
}
