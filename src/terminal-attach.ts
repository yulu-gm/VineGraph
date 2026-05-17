import type {
  NodeActivation,
  RunRecord,
  TerminalSessionAttachSnapshot,
  TerminalSessionLifecycleStatus,
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
