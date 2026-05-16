import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, extname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { loadAppConfig, saveAppConfig } from "./app-config.js";
import {
  createGraphAssetFromTemplate,
  deleteGraphAsset,
  readGraphAsset,
  scanGraphAssets,
  writeGraphAsset,
} from "./graph-assets.js";
import { GraphLoader } from "./graph-loader.js";
import { openProjectDirectory } from "./projects.js";
import { checkSelfIterationReadiness } from "./readiness.js";
import { Scheduler } from "./scheduler.js";
import { initializeAgentCliEnvironment } from "./startup-cli-probe.js";
import {
  createWorkspaceTarget,
  listWorkspaceTargets,
} from "./workspace-targets.js";
import { WorkspaceManager, WorktreeConflictError } from "./workspace-manager.js";
import type { AppConfig, ProjectDetails, WorkspaceTarget } from "./product-types.js";
import type { RunRecord, SchedulerRunOptions, WorkspaceMode } from "./types.js";

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

const openProjects = new Map<string, ProjectDetails>();

function getOpenProject(projectId: string): ProjectDetails {
  const project = openProjects.get(projectId);
  if (!project) {
    throw new Error(`Project is not open: ${projectId}`);
  }
  return project;
}

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
  res: ServerResponse,
  projectRoot = PROJECT_ROOT
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
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
    return handleListRuns(res, url.searchParams.get("projectId"));
  }

  if (url.pathname === "/api/runs" && method === "POST") {
    const body = await parseBody(req);
    return handleStartRun(res, body);
  }

  if (url.pathname === "/api/config" && method === "GET") {
    return handleGetConfig(res);
  }

  if (url.pathname === "/api/config" && method === "POST") {
    const body = await parseBody(req);
    return handleSaveConfig(res, body);
  }

  if (url.pathname === "/api/projects/open" && method === "POST") {
    const body = await parseBody(req);
    return handleOpenProject(res, body);
  }

  if (url.pathname === "/api/projects/create" && method === "POST") {
    const body = await parseBody(req);
    return handleCreateProject(res, body);
  }

  const graphAssetListMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/graph-assets$/
  );
  if (graphAssetListMatch && method === "GET") {
    return handleListGraphAssets(res, graphAssetListMatch[1]);
  }
  if (graphAssetListMatch && method === "POST") {
    const body = await parseBody(req);
    return handleCreateGraphAsset(res, graphAssetListMatch[1], body);
  }

  const graphAssetMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/graph-assets\/(.+)$/
  );
  if (graphAssetMatch) {
    const [, projectId, encodedAssetPath] = graphAssetMatch;
    if (method === "GET") {
      return handleReadGraphAsset(res, projectId, encodedAssetPath);
    }
    if (method === "PUT") {
      const body = await parseBody(req);
      return handleWriteGraphAsset(res, projectId, encodedAssetPath, body);
    }
    if (method === "DELETE") {
      return handleDeleteGraphAsset(res, projectId, encodedAssetPath);
    }
  }

  const workspaceMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/workspaces$/
  );
  if (workspaceMatch) {
    if (method === "GET") {
      return handleListProjectWorkspaces(res, workspaceMatch[1]);
    }
    if (method === "POST") {
      const body = await parseBody(req);
      return handleCreateProjectWorkspace(res, workspaceMatch[1], body);
    }
  }

  if (url.pathname === "/api/worktrees" && method === "GET") {
    return handleListWorktrees(res, projectRoot);
  }

  if (url.pathname === "/api/worktrees" && method === "POST") {
    const body = await parseBody(req);
    return handleCreateWorktree(res, body, projectRoot);
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = runMatch[1];
    if (method === "GET") {
      return handleGetRun(res, runId, url.searchParams.get("projectId"));
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
    return handleGetPatch(res, patchMatch[1], url.searchParams.get("projectId"));
  }

  // Graph listing
  if (url.pathname === "/api/graphs" && method === "GET") {
    return handleListGraphs(res);
  }

  if (url.pathname === "/api/graphs/detail" && method === "GET") {
    return handleGetGraphDetails(res, url.searchParams.get("path"));
  }

  if (url.pathname === "/api/readiness" && method === "GET") {
    return handleReadiness(
      res,
      url.searchParams.get("path"),
      projectRoot,
      url.searchParams.get("projectId")
    );
  }

  // Static files (UI)
  return serveStatic(req, res, url.pathname);
}

// ─── API Handlers ──────────────────────────────────────────────────

function handleListRuns(
  res: ServerResponse,
  projectId: string | null = null
): void {
  try {
    const runsDir = runsDirForProjectId(projectId);
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
    sendRouteError(res, err);
  }
}

function handleGetConfig(res: ServerResponse): void {
  try {
    sendJSON(res, safeAppConfigView(loadAppConfig()));
  } catch (err) {
    sendError(res, "Failed to load app config", 500);
  }
}

function handleSaveConfig(res: ServerResponse, body: unknown): void {
  if (!isPlainObject(body)) {
    return sendError(res, "Invalid request body", 400);
  }

  try {
    const current = loadAppConfig();
    const nextBody = { ...body };
    if (
      typeof nextBody.controllerApiKey !== "string" ||
      !nextBody.controllerApiKey.trim()
    ) {
      delete nextBody.controllerApiKey;
    }
    const saved = saveAppConfig({
      ...current,
      ...nextBody,
    } as AppConfig);
    sendJSON(res, safeAppConfigView(saved));
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : "Failed to save app config",
      400
    );
  }
}

function safeAppConfigView(config: AppConfig): AppConfig & {
  controllerApiKeyConfigured: boolean;
  controllerApiKeyMasked?: string;
} {
  const controllerApiKeyConfigured = Boolean(config.controllerApiKey);
  const safeConfig = {
    ...config,
    controllerApiKey: "",
    controllerApiKeyConfigured,
  };
  if (controllerApiKeyConfigured) {
    return {
      ...safeConfig,
      controllerApiKeyMasked: "••••••••••",
    };
  }
  return safeConfig;
}

function handleOpenProject(res: ServerResponse, body: unknown): void {
  if (!isPlainObject(body)) {
    return sendError(res, "Invalid request body", 400);
  }

  if (typeof body.rootPath !== "string" || !body.rootPath.trim()) {
    return sendError(res, "Missing rootPath", 400);
  }

  try {
    const project = openProjectDirectory(body.rootPath);
    openProjects.set(project.id, project);
    sendJSON(res, project);
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : "Failed to open project",
      400
    );
  }
}

function handleCreateProject(res: ServerResponse, body: unknown): void {
  if (!isPlainObject(body)) {
    return sendError(res, "Invalid request body", 400);
  }

  if (typeof body.rootPath !== "string" || !body.rootPath.trim()) {
    return sendError(res, "Missing rootPath", 400);
  }

  try {
    const rootPath = resolve(body.rootPath);
    mkdirSync(rootPath, { recursive: true });
    const project = openProjectDirectory(rootPath);
    const defaultAssetPath = "main.vg.yaml";
    const asset = existsSync(join(project.rootPath, defaultAssetPath))
      ? scanGraphAssets(graphAssetProject(project)).find(
          (item) => item.relativePath === defaultAssetPath
        )
      : createGraphAssetFromTemplate(
          graphAssetProject(project),
          defaultAssetPath,
          "main"
        );
    openProjects.set(project.id, project);
    sendJSON(res, { project, asset }, 201);
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : "Failed to create project",
      400
    );
  }
}

function handleListGraphAssets(
  res: ServerResponse,
  projectId: string
): void {
  try {
    sendJSON(res, scanGraphAssets(graphAssetProject(getOpenProject(projectId))));
  } catch (err) {
    sendRouteError(res, err);
  }
}

function handleCreateGraphAsset(
  res: ServerResponse,
  projectId: string,
  body: unknown
): void {
  if (!isPlainObject(body)) {
    return sendError(res, "Invalid request body", 400);
  }

  if (typeof body.relativePath !== "string" || !body.relativePath.trim()) {
    return sendError(res, "Missing relativePath", 400);
  }

  try {
    const asset = createGraphAssetFromTemplate(
      graphAssetProject(getOpenProject(projectId)),
      body.relativePath.trim(),
      typeof body.graphId === "string" && body.graphId.trim()
        ? body.graphId.trim()
        : graphIdFromPath(body.relativePath)
    );
    sendJSON(res, asset, 201);
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : String(err),
      routeStatusForGraphAssetSaveError(err)
    );
  }
}

function handleReadGraphAsset(
  res: ServerResponse,
  projectId: string,
  encodedAssetPath: string
): void {
  try {
    const assetPath = decodeRoutePath(encodedAssetPath);
    const detail = readGraphAsset(
      graphAssetProject(getOpenProject(projectId)),
      assetPath
    );
    sendJSON(res, detail);
  } catch (err) {
    sendRouteError(res, err);
  }
}

function handleWriteGraphAsset(
  res: ServerResponse,
  projectId: string,
  encodedAssetPath: string,
  body: unknown
): void {
  if (!isPlainObject(body)) {
    return sendError(res, "Invalid request body", 400);
  }

  let raw: string;
  if (typeof body.raw === "string") {
    raw = body.raw;
  } else if (Object.hasOwn(body, "graph")) {
    raw = yaml.dump(body.graph, { lineWidth: 120, noRefs: true });
  } else {
    return sendError(res, "Missing raw graph asset source or graph object", 400);
  }

  try {
    const assetPath = decodeRoutePath(encodedAssetPath);
    sendJSON(
      res,
      writeGraphAsset(
        graphAssetProject(getOpenProject(projectId)),
        assetPath,
        raw
      )
    );
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : String(err),
      routeStatusForGraphAssetSaveError(err)
    );
  }
}

function handleDeleteGraphAsset(
  res: ServerResponse,
  projectId: string,
  encodedAssetPath: string
): void {
  try {
    deleteGraphAsset(
      graphAssetProject(getOpenProject(projectId)),
      decodeRoutePath(encodedAssetPath)
    );
    sendJSON(res, { deleted: true });
  } catch (err) {
    sendRouteError(res, err);
  }
}

async function handleListProjectWorkspaces(
  res: ServerResponse,
  projectId: string
): Promise<void> {
  try {
    sendJSON(res, await listWorkspaceTargets(getOpenProject(projectId)));
  } catch (err) {
    sendRouteError(res, err);
  }
}

async function handleCreateProjectWorkspace(
  res: ServerResponse,
  projectId: string,
  body: unknown
): Promise<void> {
  if (!isPlainObject(body) || typeof body.name !== "string") {
    return sendError(res, "Missing workspace name", 400);
  }

  try {
    sendJSON(
      res,
      await createWorkspaceTarget(getOpenProject(projectId), body.name),
      201
    );
  } catch (err) {
    sendRouteError(res, err);
  }
}

async function handleStartRun(
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const params = body as Record<string, unknown>;
  let graphPath = params.graphPath as string;
  const projectId = params.projectId;

  if (!graphPath) {
    return sendError(res, "Missing graphPath");
  }

  try {
    const productRun = typeof projectId === "string" && projectId
      ? await resolveProductRun(params, graphPath, projectId)
      : null;
    graphPath = productRun?.graphPath ?? graphPath;
    const graph = GraphLoader.load(productRun?.loadGraphPath ?? graphPath);

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
      ...productRun?.schedulerOptions,
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
          projectId: productRun?.schedulerOptions.projectId,
          projectRoot: productRun?.schedulerOptions.projectRoot,
          error: err instanceof Error ? err.message : String(err),
        };
        emitSSE(runId, "run:completed", failed);
      });

    sendJSON(res, {
      runId,
      status: "running",
      graphId: graph.id,
      graphPath,
      ...(productRun ? { projectId: productRun.schedulerOptions.projectId } : {}),
    }, 202);
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : String(err),
      routeStatusForError(err)
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
  runId: string,
  projectId: string | null = null
): void {
  try {
    const filePath = join(
      runsDirForProjectId(projectId),
      `${runId}.json`
    );
    if (!existsSync(filePath)) {
      return sendError(res, "Run not found", 404);
    }
    const raw = readFileSync(filePath, "utf-8");
    sendJSON(res, JSON.parse(raw));
  } catch (err) {
    sendRouteError(res, err);
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

async function handleListWorktrees(
  res: ServerResponse,
  projectRoot = PROJECT_ROOT
): Promise<void> {
  try {
    sendJSON(res, await WorkspaceManager.listWorktrees(projectRoot));
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
  body: unknown,
  projectRoot = PROJECT_ROOT
): Promise<void> {
  if (!isPlainObject(body)) {
    return sendError(res, "Invalid request body", 400);
  }

  const params = body;
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
      projectRoot,
      name,
      ref
    );
    sendJSON(res, worktree, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof WorktreeConflictError
      ? 409
      : message.startsWith("Invalid ")
        ? 400
        : 500;
    sendError(res, message, status);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runsDirForProjectId(projectId: string | null): string {
  if (!projectId) return RUNS_DIR;
  return join(getOpenProject(projectId).rootPath, ".agentgraph", "runs");
}

function patchesDirForProjectId(projectId: string | null): string {
  if (!projectId) return PATCHES_DIR;
  return join(getOpenProject(projectId).rootPath, ".agentgraph", "patches");
}

function decodeRoutePath(encodedPath: string): string {
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    throw new Error("Invalid URL-encoded path");
  }
}

function graphAssetProject(project: ProjectDetails): ProjectDetails {
  return {
    ...project,
    rootPath: realpathSync.native(project.rootPath),
  };
}

function graphIdFromPath(path: string): string {
  const name =
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.vg\.ya?ml$/i, "") ?? "graph";
  return name.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "graph";
}

async function resolveProductRun(
  params: Record<string, unknown>,
  graphPath: string,
  projectId: string
): Promise<{
  graphPath: string;
  loadGraphPath: string;
  schedulerOptions: SchedulerRunOptions;
}> {
  const project = getOpenProject(projectId);
  const resolvedGraphPath = resolve(project.rootPath, graphPath);
  assertPathInsideRoot(resolvedGraphPath, project.rootPath);
  const safeGraphPath = assertExistingPathRealInsideRoot(
    resolvedGraphPath,
    project.rootPath
  );

  const schedulerOptions: SchedulerRunOptions = {
    projectId: project.id,
    projectRoot: project.rootPath,
  };

  if (Object.hasOwn(params, "workspaceTarget")) {
    const workspace = await parseAndValidateWorkspaceTarget(
      project,
      params.workspaceTarget
    );
    schedulerOptions.workspacePath = workspace.path;
    schedulerOptions.workspaceMode = workspaceModeForTarget(workspace);
    schedulerOptions.workspaceGitEnabled = workspaceGitEnabledForTarget(
      project,
      workspace
    );
  }

  return {
    graphPath: resolvedGraphPath,
    loadGraphPath: safeGraphPath,
    schedulerOptions,
  };
}

async function parseAndValidateWorkspaceTarget(
  project: ProjectDetails,
  value: unknown
): Promise<Pick<
  WorkspaceTarget,
  "kind" | "path"
>> {
  if (!isPlainObject(value)) {
    throw new Error("Invalid workspaceTarget");
  }
  if (typeof value.path !== "string" || !value.path.trim()) {
    throw new Error("Invalid workspaceTarget path");
  }
  const workspacePath = value.path;
  const kind = value.kind;
  if (kind !== "directory" && kind !== "main" && kind !== "worktree") {
    throw new Error("Invalid workspaceTarget kind");
  }

  if (kind === "main" || kind === "directory") {
    if (!samePath(workspacePath, project.rootPath)) {
      throw new Error(
        `${kind} workspaceTarget path must match the opened project root`
      );
    }
    return {
      kind,
      path: project.rootPath,
    };
  }

  const targets = await listWorkspaceTargets(project);
  const matchingWorktree = targets.find(
    (target) => target.kind === "worktree" && samePath(target.path, workspacePath)
  );
  if (!matchingWorktree) {
    throw new Error(
      "worktree workspaceTarget path must match an open project worktree"
    );
  }

  return {
    kind,
    path: matchingWorktree.path,
  };
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(path: string): string {
  const normalized = normalizeExistingPath(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeExistingPath(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`workspaceTarget path does not exist: ${path}`);
  }
  return realpathSync.native(resolved).replace(/\\/g, "/");
}

function workspaceModeForTarget(
  workspace: Pick<WorkspaceTarget, "kind">
): WorkspaceMode {
  return workspace.kind === "directory" ? "directory" : "local";
}

function workspaceGitEnabledForTarget(
  project: ProjectDetails,
  workspace: Pick<WorkspaceTarget, "kind">
): boolean {
  if (workspace.kind === "directory") return false;
  return project.capabilities.git;
}

function sendRouteError(res: ServerResponse, err: unknown): void {
  sendError(
    res,
    err instanceof Error ? err.message : String(err),
    routeStatusForError(err)
  );
}

function routeStatusForGraphAssetSaveError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (/validation failed/i.test(message)) return 400;
  return routeStatusForError(err);
}

function routeStatusForError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("not open") ||
    message.includes("not found") ||
    message.includes("ENOENT")
  ) {
    return 404;
  }
  if (
    message.startsWith("Invalid ") ||
    message.includes("Missing ") ||
    message.includes("workspaceTarget") ||
    message.includes("inside project root") ||
    message.includes("inside the project root") ||
    message.includes("must use") ||
    message.includes("validation failed") ||
    message.includes("requires a git project")
  ) {
    return 400;
  }
  if (message.includes("already exists")) {
    return 409;
  }
  return 500;
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
  runId: string,
  projectId: string | null = null
): void {
  try {
    const patchPath = join(
      patchesDirForProjectId(projectId),
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

async function handleReadiness(
  res: ServerResponse,
  graphPath: string | null,
  projectRoot = PROJECT_ROOT,
  projectId: string | null = null
): Promise<void> {
  try {
    const targetRoot = projectId ? getOpenProject(projectId).rootPath : projectRoot;
    const targetPath = graphPath
      ? resolve(targetRoot, graphPath)
      : join(targetRoot, "examples", "project-task-loop.yaml");
    const resolvedPath = resolve(targetPath);
    assertPathInsideRoot(resolvedPath, targetRoot);
    const graphLoadPath = projectId
      ? assertExistingPathRealInsideRoot(resolvedPath, targetRoot)
      : resolvedPath;
    const result = await checkSelfIterationReadiness({
      graphPath: graphLoadPath,
      projectRoot: targetRoot,
    });
    sendJSON(res, projectId ? { ...result, graphPath: resolvedPath } : result);
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
  assertPathInsideRoot(resolvedPath, PROJECT_ROOT);
}

function assertPathInsideRoot(resolvedPath: string, root: string): void {
  const rel = relative(root, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Graph path must stay inside the project root");
  }
}

function assertExistingPathRealInsideRoot(resolvedPath: string, root: string): string {
  const realRoot = realpathSync.native(root);
  const realPath = realpathSync.native(resolvedPath);
  assertPathInsideRoot(realPath, realRoot);
  return realPath;
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

export function createAgentGraphServer(projectRoot = PROJECT_ROOT) {
  return createServer((req, res) => {
    handleRequest(req, res, projectRoot).catch((err) => {
      sendError(res, err instanceof Error ? err.message : String(err), 500);
    });
  });
}

export function startServer(port: number = PORT): void {
  initializeAgentCliEnvironment({ log: console.log });
  const server = createAgentGraphServer();
  server.listen(port, () => {
    console.log(`AgentGraph UI available at http://localhost:${port}`);
  });
}

// Allow direct run
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
