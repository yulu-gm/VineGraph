import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "./types.js";

const RUNS_DIR = ".agentgraph/runs";

function ensureDir(projectRoot?: string): string {
  const dir = projectRoot ? join(projectRoot, RUNS_DIR) : RUNS_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveRunRecord(record: RunRecord): void {
  const dir = ensureDir(record.projectRoot);

  // Write individual run record
  const filePath = join(dir, `${record.runId}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");

  // Append to index
  const indexEntry = {
    runId: record.runId,
    graphId: record.graphId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    totalDurationMs: record.totalDurationMs,
  };
  appendFileSync(
    join(dir, "index.jsonl"),
    JSON.stringify(indexEntry) + "\n",
    "utf-8"
  );
}
