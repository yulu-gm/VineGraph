import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { GraphLoader } from "./graph-loader.js";
import { Scheduler } from "./scheduler.js";
import { WorkspaceManager } from "./workspace-manager.js";
import type { RunRecord } from "./types.js";

const PORT = parseInt(process.env.PORT ?? "3456", 10);
export const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const UI_DIR = join(PROJECT_ROOT, "src", "ui");
const RUNS_DIR = join(PROJECT_ROOT, ".agentgraph", "runs");
const PATCHES_DIR = join(PROJECT_ROOT, ".agentgraph", "patches");

// ─── SSE Client management ─────────────────────────────────────────

interface SSEClient {
  id: string;
  res: ServerResponse;
}

interface SSEEvent {
  event: string;
  data: unknown;
}

const sseClients = new Map<string, SSEClient[]>();
const sseEvents = new Map<string, SSEEvent[]>();

function addSSEClient(runId: string, res: ServerResponse): string {
  const clientId = randomUUID();
  if (!sseClients.has(runId)) {
    sseClients.set(runId, []);
  }
  sseClients.get(runId)!.push({ id: clientId, res });
  return clientId;
}

function removeSSEClient(runId: string, clientId: string): void {
  const clients = sseClients.get(runId);
  if (!clients) return;
  const idx = clients.findIndex((c) => c.id === clientId);
  if (idx >= 0) clients.splice(idx, 1);
}

export function emitSSE(runId: string, event: string, data: unknown): void {
  const events = sseEvents.get(runId) ?? [];
  events.push({ event, data });
  if (events.length > 500) events.shift();
  sseEvents.set(runId, events);

  const clients = sseClients.get(runId);
  if (!clients) return;
  for (const client of clients) {
    try {
      writeSSE(client.res, event, data);
    } catch {
      // Client disconnected
    }
  }
}

function writeSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Active runs tracking ──────────────────────────────────────────

const activeRuns = new Map<
  string,
  { controller: AbortController; promise: Promise<RunRecord> }
>();

// ─── MIME types ────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".patch": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// ─── Router ────────────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function sendError(
  res: ServerResponse,
  message: string,
  status = 400
): void {
  sendJSON(res, { error: message }, status);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Routes
  if (url.pathname === "/api/runs" && method === "GET") {
    return handleListRuns(res);
  }

  if (url.pathname === "/api/runs" && method === "POST") {
    const body = await parseBody(req);
    return handleStartRun(res, body);
  }

  if (url.pathname === "/api/worktrees" && method === "GET") {
    return handleListWorktrees(res);
  }

  if (url.pathname === "/api/worktrees" && method === "POST") {
    const body = await parseBody(req);
    return handleCreateWorktree(res, body);
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = runMatch[1];
    if (method === "GET") {
      return handleGetRun(res, runId);
    }
    if (method === "DELETE" || method === "POST") {
      return handleCancelRun(res, runId);
    }
  }

  const eventsMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/events$/
  );
  if (eventsMatch) {
    return handleSSE(req, res, eventsMatch[1]);
  }

  const patchMatch = url.pathname.match(
    /^\/api\/runs\/([^/]+)\/patch$/
  );
  if (patchMatch) {
    return handleGetPatch(res, patchMatch[1]);
  }

  // Graph listing
  if (url.pathname === "/api/graphs" && method === "GET") {
    return handleListGraphs(res);
  }

  if (url.pathname === "/api/graphs/detail" && method === "GET") {
    return handleGetGraphDetails(res, url.searchParams.get("path"));
  }

  // Static files (UI)
  return serveStatic(req, res, url.pathname);
}

// ─── API Handlers ──────────────────────────────────────────────────

function handleListRuns(res: ServerResponse): void {
  try {
    const runsDir = RUNS_DIR;
    if (!existsSync(runsDir)) {
      return sendJSON(res, []);
    }
    const files = readdirSync(runsDir).filter(
      (f) => f.endsWith(".json") && f !== "index.jsonl"
    );
    const runs = files.map((f) => {
      const raw = readFileSync(join(runsDir, f), "utf-8");
      return JSON.parse(raw);
    });
    sendJSON(res, runs);
  } catch (err) {
    sendError(res, "Failed to list runs", 500);
  }
}

async function handleStartRun(
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const params = body as Record<string, unknown>;
  const graphPath = params.graphPath as string;

  if (!graphPath) {
    return sendError(res, "Missing graphPath");
  }

  try {
    const graph = GraphLoader.load(graphPath);

    setInputDefault(graph, "task", params.task);
    setInputDefault(graph, "task_scope", params.task);
    setInputDefault(graph, "test_command", params.test_command);
    setInputDefault(graph, "verification_command", params.test_command);

    const runId = randomUUID();
    const controller = new AbortController();
    const promise = Scheduler.run(graph, graphPath, {
      runId,
      signal: controller.signal,
      onEvent: (event) => emitSSE(runId, event.type, event),
    });

    activeRuns.set(runId, { controller, promise });

    promise
      .then((result) => {
        activeRuns.delete(runId);
        if (result.status === "cancelled") {
          emitSSE(runId, "run:cancelled", result);
        } else {
          emitSSE(runId, "run:completed", result);
        }
      })
      .catch((err) => {
        activeRuns.delete(runId);
        const failed: RunRecord = {
          runId,
          graphId: graph.id,
          graphPath,
          status: "failed",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          activations: [],
          controllerDecisions: [],
          error: err instanceof Error ? err.message : String(err),
        };
        emitSSE(runId, "run:completed", failed);
      });

    sendJSON(res, { runId, status: "running", graphId: graph.id, graphPath }, 202);
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : String(err),
      500
    );
  }
}

function setInputDefault(
  graph: ReturnType<typeof GraphLoader.load>,
  key: string,
  value: unknown
): void {
  if (typeof value !== "string" || !value || !graph.inputs?.[key]) return;
  graph.inputs[key].default = value;
}

function handleGetRun(
  res: ServerResponse,
  runId: string
): void {
  try {
    const filePath = join(
      RUNS_DIR,
      `${runId}.json`
    );
    if (!existsSync(filePath)) {
      return sendError(res, "Run not found", 404);
    }
    const raw = readFileSync(filePath, "utf-8");
    sendJSON(res, JSON.parse(raw));
  } catch (err) {
    sendError(res, "Failed to get run", 500);
  }
}

function handleCancelRun(
  res: ServerResponse,
  runId: string
): void {
  const active = activeRuns.get(runId);
  if (active) {
    active.controller.abort();
    emitSSE(runId, "run:cancelling", { runId, status: "cancelling" });
    sendJSON(res, { cancelled: true, runId });
  } else {
    sendError(res, "Run not active", 404);
  }
}

async function handleListWorktrees(res: ServerResponse): Promise<void> {
  try {
    sendJSON(res, await WorkspaceManager.listWorktrees(PROJECT_ROOT));
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : "Failed to list worktrees",
      500
    );
  }
}

async function handleCreateWorktree(
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const params = body as Record<string, unknown>;
  const name = params.name;
  const ref = params.ref;

  if (typeof name !== "string") {
    return sendError(res, "Missing worktree name", 400);
  }
  if (ref !== undefined && typeof ref !== "string") {
    return sendError(res, "Invalid worktree ref", 400);
  }

  try {
    const worktree = await WorkspaceManager.createManualWorktree(
      PROJECT_ROOT,
      name,
      ref
    );
    sendJSON(res, worktree, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith("Invalid ") ? 400 : 500;
    sendError(res, message, status);
  }
}

function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(": connected\n\n");

  const clientId = addSSEClient(runId, res);
  const events = sseEvents.get(runId) ?? [];
  for (const item of events) {
    writeSSE(res, item.event, item.data);
  }

  req.on("close", () => {
    removeSSEClient(runId, clientId);
  });
}

function handleGetPatch(
  res: ServerResponse,
  runId: string
): void {
  try {
    const patchPath = join(
      PATCHES_DIR,
      `${runId}.patch`
    );
    if (!existsSync(patchPath)) {
      return sendError(res, "Patch not found", 404);
    }
    const content = readFileSync(patchPath, "utf-8");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${runId}.patch"`,
    });
    res.end(content);
  } catch (err) {
    sendError(res, "Failed to get patch", 500);
  }
}

function handleListGraphs(res: ServerResponse): void {
  try {
    sendJSON(res, listGraphPaths());
  } catch (err) {
    sendJSON(res, []);
  }
}

function handleGetGraphDetails(
  res: ServerResponse,
  graphPath: string | null
): void {
  if (!graphPath) {
    return sendError(res, "Missing graph path");
  }

  try {
    sendJSON(res, loadGraphDetails(graphPath));
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : String(err),
      400
    );
  }
}

export function listGraphPaths(root = PROJECT_ROOT): string[] {
  const examplesDir = join(root, "examples");
  if (!existsSync(examplesDir)) {
    return [];
  }

  return readdirSync(examplesDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => join(examplesDir, f));
}

export function loadGraphDetails(
  graphPath: string
): ReturnType<typeof GraphLoader.load> {
  const resolvedPath = resolve(graphPath);
  assertProjectPath(resolvedPath);
  return GraphLoader.load(resolvedPath);
}

function assertProjectPath(resolvedPath: string): void {
  const rel = relative(PROJECT_ROOT, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Graph path must stay inside the project root");
  }
}

// ─── Static file serving ───────────────────────────────────────────

function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): void {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = join(UI_DIR, filePath);

  if (!existsSync(fullPath)) {
    // SPA fallback
    const indexPath = join(UI_DIR, "index.html");
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(fullPath).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";
  const content = readFileSync(fullPath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

// ─── Start ─────────────────────────────────────────────────────────

export function startServer(port: number = PORT): void {
  const server = createServer(handleRequest);
  server.listen(port, () => {
    console.log(`AgentGraph UI available at http://localhost:${port}`);
  });
}

// Allow direct run
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
