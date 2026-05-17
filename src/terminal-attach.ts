import type {
  NodeActivation,
  RunRecord,
  TerminalSessionAttachSnapshot,
  TerminalSessionLifecycleStatus,
  TerminalSessionSummary,
} from "./types.js";

export const DEFAULT_TERMINAL_ATTACH_SNAPSHOT_CHARS = 200_000;

export function buildTerminalSessionAttachSnapshot(
  run: RunRecord,
  sessionId: string,
  maxChars = DEFAULT_TERMINAL_ATTACH_SNAPSHOT_CHARS
): TerminalSessionAttachSnapshot | null {
  const activation = run.activations.find(
    (item) =>
      item.terminalSessionId === sessionId ||
      item.rawResult?.terminalSessionId === sessionId
  );
  if (!activation) return null;

  const transcript = activation.rawResult?.terminalTranscript ?? "";
  const bounded = boundTerminalSnapshot(transcript, maxChars);
  const terminalSessionId =
    activation.terminalSessionId ??
    activation.rawResult?.terminalSessionId ??
    sessionId;

  return {
    runId: run.runId,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    sessionId,
    terminalSessionId,
    activationId: activation.activationId,
    nodeId: activation.nodeId,
    ...(activation.rawResult?.backend
      ? { backend: activation.rawResult.backend }
      : {}),
    status: terminalStatusFromActivation(activation),
    ...(typeof activation.rawResult?.exitCode === "number"
      ? { exitCode: activation.rawResult.exitCode }
      : {}),
    ...(activation.rawResult?.terminalMode
      ? { terminalMode: activation.rawResult.terminalMode }
      : {}),
    snapshot: bounded.snapshot,
    truncated: bounded.truncated,
    snapshotMaxChars: maxChars,
    liveEventsUrl: `/api/runs/${run.runId}/events`,
  };
}

export function buildPersistedTerminalSessionSummaries(
  run: RunRecord
): TerminalSessionSummary[] {
  const summaries: TerminalSessionSummary[] = [];
  const seen = new Set<string>();

  for (const activation of run.activations) {
    const sessionId =
      activation.terminalSessionId ?? activation.rawResult?.terminalSessionId;
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);

    summaries.push({
      runId: run.runId,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      sessionId,
      terminalSessionId: sessionId,
      activationId: activation.activationId,
      nodeId: activation.nodeId,
      ...(activation.rawResult?.backend
        ? { backend: activation.rawResult.backend }
        : {}),
      status: terminalStatusFromActivation(activation),
      ...(typeof activation.rawResult?.exitCode === "number"
        ? { exitCode: activation.rawResult.exitCode }
        : {}),
      ...(activation.rawResult?.terminalMode
        ? { terminalMode: activation.rawResult.terminalMode }
        : {}),
      source: "persisted",
      snapshotChars: [...(activation.rawResult?.terminalTranscript ?? "")]
        .length,
      liveEventsUrl: `/api/runs/${run.runId}/events`,
    });
  }

  return summaries;
}

export function buildActiveTerminalSessionSummaries(
  runId: string,
  events: Array<{ event: string; data: unknown }>
): TerminalSessionSummary[] {
  const sessions = new Map<
    string,
    {
      terminalSessionId: string;
      activationId: string;
      nodeId: string;
      backend?: TerminalSessionSummary["backend"];
      status: TerminalSessionLifecycleStatus;
      exitCode?: number;
      snapshotChars: number;
    }
  >();

  for (const item of events) {
    if (!isPlainObject(item.data)) continue;
    const sessionId = terminalSessionIdFromEventData(item.data);
    if (!sessionId) continue;

    const current = sessions.get(sessionId) ?? {
      terminalSessionId: sessionId,
      activationId: "",
      nodeId: "",
      status: "running" as TerminalSessionLifecycleStatus,
      snapshotChars: 0,
    };

    if (item.event === "terminal:started") {
      sessions.set(sessionId, {
        ...current,
        terminalSessionId: sessionId,
        activationId:
          typeof item.data.activationId === "string"
            ? item.data.activationId
            : current.activationId,
        nodeId:
          typeof item.data.nodeId === "string"
            ? item.data.nodeId
            : current.nodeId,
        backend: isKnownBackend(item.data.backend)
          ? item.data.backend
          : current.backend,
        status: "running",
      });
      continue;
    }

    if (item.event === "terminal:output") {
      sessions.set(sessionId, {
        ...current,
        snapshotChars:
          current.snapshotChars +
          (typeof item.data.chunk === "string" ? [...item.data.chunk].length : 0),
      });
      continue;
    }

    if (item.event === "terminal:ended") {
      sessions.set(sessionId, {
        ...current,
        status: "exited",
        ...(typeof item.data.exitCode === "number"
          ? { exitCode: item.data.exitCode }
          : {}),
      });
    }
  }

  return [...sessions.entries()].map(([sessionId, session]) => ({
    runId,
    sessionId,
    terminalSessionId: session.terminalSessionId,
    activationId: session.activationId,
    nodeId: session.nodeId,
    ...(session.backend ? { backend: session.backend } : {}),
    status: session.status,
    ...(typeof session.exitCode === "number"
      ? { exitCode: session.exitCode }
      : {}),
    source: "active",
    snapshotChars: session.snapshotChars,
    liveEventsUrl: `/api/runs/${runId}/events`,
  }));
}

export function boundTerminalSnapshot(
  transcript: string,
  maxChars = DEFAULT_TERMINAL_ATTACH_SNAPSHOT_CHARS
): { snapshot: string; truncated: boolean } {
  const transcriptChars = [...transcript];
  if (transcriptChars.length <= maxChars) {
    return { snapshot: transcript, truncated: false };
  }

  return {
    snapshot: transcriptChars.slice(-maxChars).join(""),
    truncated: true,
  };
}

function terminalStatusFromActivation(
  activation: NodeActivation
): TerminalSessionLifecycleStatus {
  if (activation.status === "queued") return "starting";
  if (activation.status === "running") return "running";
  if (activation.status === "cancelled") return "cancelled";
  if (activation.status === "failed") return "failed";
  return "exited";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function terminalSessionIdFromEventData(data: Record<string, unknown>): string {
  return typeof data.terminalSessionId === "string"
    ? data.terminalSessionId
    : "";
}

function isKnownBackend(
  value: unknown
): value is TerminalSessionSummary["backend"] {
  return (
    value === "shell" ||
    value === "internal" ||
    value === "codex" ||
    value === "claude" ||
    value === "git"
  );
}
