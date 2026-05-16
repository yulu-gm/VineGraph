import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, normalize } from "node:path";

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === "win32") return true;

  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathFileNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  if (/\.(cmd|exe|bat)$/i.test(name)) return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

export function platformCliName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export function isNodeModulesBinPath(path: string): boolean {
  const normalized = normalize(path).replace(/\\/g, "/").toLowerCase();
  return normalized === "node_modules/.bin" || normalized.endsWith("/node_modules/.bin");
}

export function findCliOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || isNodeModulesBinPath(dir)) continue;

    for (const fileName of pathFileNames(name)) {
      const candidate = join(dir, fileName);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function cliProbeCandidates(
  name: string,
  envVar: string,
  knownPaths: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const envPath = env[envVar];
  if (envPath && isExecutable(envPath)) return [envPath];

  return unique([
    findCliOnPath(name, env),
    ...knownPaths.filter(isExecutable),
    platformCliName(name),
  ].filter((item): item is string => Boolean(item)));
}

export function resolveCliPath(
  name: string,
  envVar: string,
  knownPaths: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): string {
  return cliProbeCandidates(name, envVar, knownPaths, env)[0] ?? platformCliName(name);
}
