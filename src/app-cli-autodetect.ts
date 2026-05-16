import { loadAppConfig, saveAppConfig, defaultAppConfigPath } from "./app-config.js";
import {
  initializeAgentCliEnvironment,
  type AgentCliStartupReport,
} from "./startup-cli-probe.js";
import type { AppConfig } from "./product-types.js";

type CliName = "codex" | "claude";

export interface CliAutodetectDiagnostics {
  detected: Partial<Record<CliName, { path: string; version?: string }>>;
  missing: Array<{ name: CliName; label: string; message: string }>;
}

export interface AppConfigAutodetectResult {
  config: AppConfig;
  diagnostics: CliAutodetectDiagnostics;
}

export function loadAppConfigWithCliAutodetect(
  path = defaultAppConfigPath(),
  env: NodeJS.ProcessEnv = process.env
): AppConfigAutodetectResult {
  const config = loadAppConfig(path);
  const missingConfig = {
    codex: !config.codexCliPath,
    claude: !config.claudeCliPath,
  };

  if (!missingConfig.codex && !missingConfig.claude) {
    return { config, diagnostics: emptyDiagnostics() };
  }

  const probeEnv = { ...env };
  if (config.codexCliPath) probeEnv.AGENTGRAPH_CODEX_PATH = config.codexCliPath;
  if (config.claudeCliPath) probeEnv.AGENTGRAPH_CLAUDE_PATH = config.claudeCliPath;

  const report = initializeAgentCliEnvironment({ env: probeEnv });
  const nextConfig: AppConfig = { ...config };
  const diagnostics = diagnosticsFromReport(report, missingConfig);

  if (missingConfig.codex && report.codex.available && report.codex.path) {
    nextConfig.codexCliPath = report.codex.path;
  }
  if (missingConfig.claude && report.claude.available && report.claude.path) {
    nextConfig.claudeCliPath = report.claude.path;
  }

  const changed =
    nextConfig.codexCliPath !== config.codexCliPath ||
    nextConfig.claudeCliPath !== config.claudeCliPath;

  return {
    config: changed ? saveAppConfig(nextConfig, path) : nextConfig,
    diagnostics,
  };
}

function diagnosticsFromReport(
  report: AgentCliStartupReport,
  missingConfig: Record<CliName, boolean>
): CliAutodetectDiagnostics {
  const diagnostics = emptyDiagnostics();
  for (const result of [report.codex, report.claude]) {
    if (!missingConfig[result.name]) continue;
    if (result.available && result.path) {
      diagnostics.detected[result.name] = {
        path: result.path,
        version: result.version,
      };
    } else {
      diagnostics.missing.push({
        name: result.name,
        label: result.label,
        message: result.error ?? `${result.label} was not found.`,
      });
    }
  }
  return diagnostics;
}

function emptyDiagnostics(): CliAutodetectDiagnostics {
  return { detected: {}, missing: [] };
}
