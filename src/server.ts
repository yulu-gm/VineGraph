import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { GraphLoader } from "./graph-loader.js";
import { Scheduler } from "./scheduler.js";
import type { RunRecord, NodeActivation } from "./types.js";

const PORT = parseInt(process.env.PORT ?? "3456", 10);
const UI_DIR = join(import.meta.dirname, "ui");
const RUNS_DIR = ".agentgraph/runs";

// ─── SSE Client management ─────────────────────────────────────────

interface SSEClient {
  id: string;
  res: ServerResponse;
}

const sseClients = new Map<string, SSEClient[]>();

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
  const clients = sseClients.get(runId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      // Client disconnected
    }
  }
}

// ─── Active runs tracking ──────────────────────────────────────────

const activeRuns = new Map<string, { cancel: () => void }>();

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

  // Static files (UI)
  return serveStatic(req, res, url.pathname);
}

// ─── API Handlers ──────────────────────────────────────────────────

function handleListRuns(res: ServerResponse): void {
  try {
    const runsDir = join(process.cwd(), RUNS_DIR);
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

    if (params.task && graph.inputs?.task) {
      graph.inputs.task.default = params.task as string;
    }
    if (params.test_command && graph.inputs?.test_command) {
      graph.inputs.test_command.default =
        params.test_command as string;
    }

    const result = await Scheduler.run(graph, graphPath);

    emitSSE(result.runId, "run:completed", {
      status: result.status,
      workspace: result.workspace,
    });

    sendJSON(res, result);
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : String(err),
      500
    );
  }
}

function handleGetRun(
  res: ServerResponse,
  runId: string
): void {
  try {
    const filePath = join(
      process.cwd(),
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
    active.cancel();
    activeRuns.delete(runId);
    emitSSE(runId, "run:cancelled", { runId });
    sendJSON(res, { cancelled: true });
  } else {
    sendError(res, "Run not active", 404);
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
      process.cwd(),
      ".agentgraph/patches",
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
    const examplesDir = join(process.cwd(), "examples");
    if (!existsSync(examplesDir)) {
      return sendJSON(res, []);
    }
    const files = readdirSync(examplesDir).filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml")
    );
    sendJSON(res, files.map((f) => join(examplesDir, f)));
  } catch (err) {
    sendJSON(res, []);
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
