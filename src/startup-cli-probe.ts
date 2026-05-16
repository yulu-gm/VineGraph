import { spawnSync } from "node:child_process";
import { cliProbeCandidates } from "./cli-path.js";

type AgentCliName = "codex" | "claude";
type AgentCliSource = "env" | "detected" | "missing";

interface AgentCliProfile {
  name: AgentCliName;
  label: string;
  envVar: string;
  knownPaths: (env: NodeJS.ProcessEnv) => string[];
  invocationArgs: string[];
  promptInput: string;
}

export interface AgentCliProbeResult {
  name: AgentCliName;
  label: string;
  envVar: string;
  available: boolean;
  source: AgentCliSource;
  path: string | null;
  version?: string;
  invocation: string;
  promptInput: string;
  error?: string;
}

export interface AgentCliStartupReport {
  codex: AgentCliProbeResult;
  claude: AgentCliProbeResult;
}

export interface InitializeAgentCliOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;

const AGENT_CLI_PROFILES: AgentCliProfile[] = [
  {
    name: "codex",
    label: "Codex CLI",
    envVar: "AGENTGRAPH_CODEX_PATH",
    knownPaths: codexKnownPaths,
    invocationArgs: [
      "exec",
      "[--model <model>]",
      "[--config model_reasoning_effort=\"<effort>\"]",
      "[--sandbox <read-only|workspace-write>]",
      "--ephemeral",
      "--skip-git-repo-check",
      "-",
    ],
    promptInput: "stdin",
  },
  {
    name: "claude",
    label: "Claude Code",
    envVar: "AGENTGRAPH_CLAUDE_PATH",
    knownPaths: claudeKnownPaths,
    invocationArgs: [
      "-p <prompt>",
      "--output-format text",
      "--no-session-persistence",
      "--permission-mode bypassPermissions",
      "--max-budget-usd 10",
    ],
    promptInput: "argument",
  },
];

function codexKnownPaths(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(env.LOCALAPPDATA
      ? [`${env.LOCALAPPDATA}/OpenAI/Codex/bin/codex.exe`]
      : []),
    ...(env.USERPROFILE
      ? [`${env.USERPROFILE}/AppData/Roaming/npm/codex.cmd`]
      : []),
    ...(env.HOME
      ? [`${env.HOME}/AppData/Roaming/npm/codex.cmd`]
      : []),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
}

function claudeKnownPaths(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(env.USERPROFILE
      ? [`${env.USERPROFILE}/AppData/Roaming/npm/claude.cmd`]
      : []),
    ...(env.HOME
      ? [`${env.HOME}/AppData/Roaming/npm/claude.cmd`]
      : []),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

function probeProfile(
  profile: AgentCliProfile,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): AgentCliProbeResult {
  const configuredPath = env[profile.envVar];
  const candidates = cliProbeCandidates(
    profile.name,
    profile.envVar,
    profile.knownPaths(env),
    env
  );

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
      shell: process.platform === "win32",
      timeout: timeoutMs,
    });
    if (result.status !== 0) continue;

    const configuredCandidate = Boolean(configuredPath && configuredPath === candidate);
    if (!configuredCandidate) {
      env[profile.envVar] = candidate;
    }

    return {
      name: profile.name,
      label: profile.label,
      envVar: profile.envVar,
      available: true,
      source: configuredCandidate ? "env" : "detected",
      path: candidate,
      version: (result.stdout || result.stderr).trim(),
      invocation: `${candidate} ${profile.invocationArgs.join(" ")}`,
      promptInput: profile.promptInput,
    };
  }

  return {
    name: profile.name,
    label: profile.label,
    envVar: profile.envVar,
    available: false,
    source: "missing",
    path: null,
    invocation: `${profile.name} ${profile.invocationArgs.join(" ")}`,
    promptInput: profile.promptInput,
    error: `Install ${profile.label} or set ${profile.envVar}.`,
  };
}

export function initializeAgentCliEnvironment(
  options: InitializeAgentCliOptions = {}
): AgentCliStartupReport {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const report = Object.fromEntries(
    AGENT_CLI_PROFILES.map((profile) => [
      profile.name,
      probeProfile(profile, env, timeoutMs),
    ])
  ) as unknown as AgentCliStartupReport;

  if (options.log) {
    for (const result of [report.codex, report.claude]) {
      if (result.available) {
        options.log(
          `[startup] ${result.label}: ${result.path} (${result.version ?? "version unknown"})`
        );
      } else {
        options.log(`[startup] ${result.label}: ${result.error}`);
      }
    }
  }

  return report;
}
