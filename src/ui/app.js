// ─── State ──────────────────────────────────────────────────────────
let currentRunId = null;
let eventSource = null;
let activations = [];
let selectedNodeIdx = -1;
let selectedGraphNodeId = "after_tests_controller";
let activeGraphNodeId = null;
let lastRunResult = null;
let currentRunProjectId = null;
let activeTerminalActivationId = null;
let activeTerminalSessionId = null;
let activeTerminalTransport = "server";
let terminalEntriesBySession = new Map();
let selectedInspectTerminalSessionId = null;
let terminalTransportBySession = new Map();
let terminalViewClearedAtBySession = new Map();
let terminalRenderFrame = null;
let terminalModuleLoader = null;
let xtermTerminal = null;
let terminalFitAddon = null;
let terminalReadyPromise = null;
let terminalResizeFrame = null;
let inspectTerminalResizeFrame = null;
let terminalMountedSessionId = null;
let terminalMountRequestId = 0;
let terminalUsesXterm = false;
let terminalAttachRequestId = 0;
let tauriTerminalEventsRegistered = false;
let activationRenderFrame = null;
let runtimeInspectTickTimer = null;
let runtimeDockDrag = null;
let canvasPan = { x: 0, y: 0 };
let canvasBounds = { minX: 0, minY: 0, width: 1220, height: 680 };
let canvasDrag = null;
let currentProject = null;
let graphAssets = [];
let workspaceTargets = [];
let selectedWorkspaceTarget = null;
let currentGraphAsset = null;
let pendingGraphAssetPath = null;
let currentGraphDefinition = null;
let graphDirty = false;
let invalidCommandDrafts = new Map();
let graphDefinitionRequestId = 0;
let workspaceRequestId = 0;
let worktreeCreateInFlight = false;
let workspaceCreateOpen = false;
let readinessRequestId = 0;
let appConfig = { themeMode: "system" };
let settingsDraftThemeMode = "system";
let lastSettingsTrigger = null;

const API_ORIGIN = "http://127.0.0.1:3456";
const TERMINAL_MAX_ENTRIES = 5000;
const TERMINAL_COPY_ON_SELECTION = false;
const RUNTIME_DOCK_HEIGHT_KEY = "vinegraph.runtimeDockHeight";
const RUNTIME_DOCK_MIN_HEIGHT = 180;
const RUNTIME_DOCK_KEYBOARD_STEP = 20;
const TERMINAL_ATTACHMENT_KEY = "vinegraph.terminalAttachment";

function isAgentBackend(backend) {
  const name = String(backend || "").toLowerCase();
  return name === "codex" || name.startsWith("codex ") || name === "claude" || name.startsWith("claude ");
}

// ─── DOM refs ──────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);

const domTask = $("#task-input");
const domTest = $("#test-input");
const domRun = $("#btn-run");
const domCancel = $("#btn-cancel");
const domStatus = $("#status-badge");
const domTimeline = $("#timeline-list");
const domTimelineSummary = $("#timeline-summary");
const domSummaryDuration = $("#summary-duration");
const domSummaryFixes = $("#summary-fixes");
const domDetail = $("#detail-content");
const domRuntimeInspect = $("#runtime-inspect-content");
const domDiff = $("#diff-content");
const domTerminal = $("#terminal-content");
let domTerminalXterm = domTerminal?.querySelector?.("#terminal-xterm") ?? null;
let domTerminalFallbackLines = domTerminal?.querySelector?.("#terminal-fallback-lines") ?? null;
const domTerminalSearch = $("#terminal-search");
const domTerminalNodeFilter = $("#terminal-node-filter");
const domTerminalFollow = $("#terminal-follow");
const domCopyTerminal = $("#btn-copy-terminal");
const domClearTerminalView = $("#btn-clear-terminal-view");
const domRuntimeDock = $("#runtime-dock");
const domRuntimeDockResizeHandle = $("#runtime-dock-resize-handle");
const domToggleRuntimeDock = $("#btn-toggle-runtime-dock");
const domBarDuration = $("#bar-duration");
const domPatch = $("#btn-patch");
const domCanvas = $("#graph-canvas");
const domCanvasTitle = $("#canvas-title");
const domProjectName = $("#project-name");
const domInspector = $("#inspector-content");
const domRunChip = $("#run-id-chip");
const domOpenProject = $("#btn-open-project");
const domCurrentRepoChip = $("#current-repo-chip");
const domOpenGraphPath = $("#open-graph-path");
const domSaveStateChip = $("#save-state-chip");
const domProjectSummary = $("#project-summary");
const domProjectHistory = $("#project-history");
const domGraphAssets = $("#graph-assets");
const domGraphAssetFilter = $("#graph-asset-filter");
const domNewGraph = $("#btn-new-graph");
const domNewGraphPanel = $("#new-graph-panel");
const domNewGraphPath = $("#new-graph-path-input");
const domNewGraphId = $("#new-graph-id-input");
const domCreateGraph = $("#btn-create-graph");
const domNewGraphMessage = $("#new-graph-message");
const domWorkspaceSwitcher = $("#workspace-switcher");
const domToggleWorkspaceCreate = $("#btn-toggle-workspace-create");
const domWorkspaceCreatePopover = $("#workspace-create-popover");
const domWorkspaceBranch = $("#workspace-branch");
const domWorkspaceDirty = $("#workspace-dirty");
const domRunStateText = $("#run-state-text");
const domWorktreeName = $("#worktree-name-input");
const domCreateWorktree = $("#btn-create-worktree");
const domCancelWorktreeCreate = $("#btn-cancel-worktree-create");
const domWorktreeMessage = $("#worktree-message");
const domReadiness = $("#readiness-panel");
const domRefreshReadiness = $("#btn-refresh-readiness");
const domDoctor = $("#btn-doctor");
const domSettings = $("#settings-panel");
const domSettingsOpen = $("#btn-settings");
const domSettingsClose = $("#btn-settings-close");
const domSettingsSave = $("#btn-save-settings");
const domSettingsProbe = $("#btn-run-probe");
const domSettingsMessage = $("#settings-message");
const domSettingControllerApiKey = $("#setting-controller-api-key");
const domSettingCodexPath = $("#setting-codex-path");
const domSettingClaudePath = $("#setting-claude-path");
const domSettingDefaultCodexModel = $("#setting-default-codex-model");
const domSettingDefaultReasoningEffort = $("#setting-default-reasoning-effort");
const domSettingThemeMode = $("#setting-theme-mode");

function connect(from, to, color = "blue", fromOffset = null) {
  return { from, to, color, fromOffset };
}

// ─── Init ──────────────────────────────────────────────────────────
async function init() {
  await loadAppConfig();
  renderGraphCanvas();
  renderInspectorNode(findGraphNode(selectedGraphNodeId));
  renderRuntimeInspect();
  bindTabs();
  bindRuntimeDockResize();
  bindTerminalControls();
  bindCanvasPan();
  bindMinimapDrag();
  registerTauriTerminalEvents();
  restoreTerminalAttachment();

  domRun.addEventListener("click", startRun);
  domCancel.addEventListener("click", cancelRun);
  domOpenProject?.addEventListener("click", openProjectWithPicker);
  domNewGraph?.addEventListener("click", toggleNewGraphPanel);
  domCreateGraph?.addEventListener("click", createGraphAssetFromForm);
  domNewGraphPath?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createGraphAssetFromForm();
  });
  domGraphAssetFilter?.addEventListener("input", renderGraphAssets);
  domWorkspaceSwitcher?.addEventListener("change", () => {
    selectedWorkspaceTarget = workspaceTargets.find((item) => item.id === domWorkspaceSwitcher.value) ?? null;
    renderWorkspaceBar();
  });
  domToggleWorkspaceCreate?.addEventListener("click", () => setWorkspaceCreateOpen(!workspaceCreateOpen));
  domCreateWorktree?.addEventListener("click", createManualWorktree);
  domCancelWorktreeCreate?.addEventListener("click", () => setWorkspaceCreateOpen(false));
  domRefreshReadiness?.addEventListener("click", loadReadiness);
  domDoctor?.addEventListener("click", runSettingsProbe);
  domSettingsOpen?.addEventListener("click", () => openSettingsPanel(domSettingsOpen));
  domSettingsClose?.addEventListener("click", closeSettingsPanel);
  domSettingsSave?.addEventListener("click", saveAppConfig);
  domSettingsProbe?.addEventListener("click", runSettingsProbe);
  domSettingThemeMode?.addEventListener("change", () => {
    settingsDraftThemeMode = domSettingThemeMode.value || "system";
    applyThemeMode(settingsDraftThemeMode);
  });
  domWorktreeName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createManualWorktree();
    if (event.key === "Escape") setWorkspaceCreateOpen(false);
  });
  window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", () => {
    if ((appConfig.themeMode ?? "system") === "system") applyThemeMode("system");
  });
  window.addEventListener("resize", () => {
    applyCanvasPan();
    scheduleTerminalFit();
    scheduleInspectTerminalResize();
  });
  window.addEventListener("keydown", handleSettingsKeydown);
  renderProjectSummary();
  renderGraphAssets();
  renderWorkspaceBar();
  setWorkspaceCreateOpen(false);
  loadReadiness();
}

async function loadAppConfig() {
  try {
    const resp = await fetch(apiUrl("/api/config"), { cache: "no-store" });
    const config = await resp.json();
    if (!resp.ok) throw new Error(config.error || "Settings request failed");
    appConfig = { themeMode: "system", ...config };
  } catch {
    appConfig = { themeMode: "system" };
  }
  renderSettings();
  renderProjectHistory();
  applyThemeMode(appConfig.themeMode);
  applyStartupCliDiagnostics(appConfig);
  return appConfig;
}

async function openProjectWithPicker() {
  const selectedPath = await pickProjectDirectory();
  if (selectedPath) {
    return openProject(selectedPath);
  }
  return null;
}

async function pickProjectDirectory() {
  if (!window.__TAURI__?.core?.invoke) return null;
  try {
    const selectedPath = await window.__TAURI__?.core?.invoke?.("pick_project_directory", {
      initialDirectory: projectPickerInitialDirectory(),
    });
    return typeof selectedPath === "string" && selectedPath.trim()
      ? selectedPath.trim()
      : null;
  } catch (err) {
    showProjectOpenError(err instanceof Error ? err.message : "系统文件夹选择失败");
    return null;
  }
}

function projectPickerInitialDirectory() {
  const candidates = [
    currentProject?.rootPath,
    appConfig?.recentProjects?.[0]?.rootPath,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function applyStartupCliDiagnostics(config) {
  const missing = Array.isArray(config.cliDiagnostics?.missing)
    ? config.cliDiagnostics.missing
    : [];
  if (missing.length === 0) return;

  const names = missing.map((item) => item.label || item.name).join(", ");
  setStatus("failed", `CLI missing: ${names}`);
  domStatus?.classList.add("startup-error");
  if (domStatus) {
    domStatus.title = missing.map((item) => item.message).join("\n");
  }
}

function renderSettings() {
  setFieldValue(domSettingControllerApiKey, "");
  if (domSettingControllerApiKey) {
    domSettingControllerApiKey.placeholder = appConfig.controllerApiKeyConfigured
      ? `${appConfig.controllerApiKeyMasked || "Configured"} configured; type a new key to replace`
      : "Paste controller API key";
  }
  setFieldValue(domSettingCodexPath, appConfig.codexCliPath);
  setFieldValue(domSettingClaudePath, appConfig.claudeCliPath);
  setFieldValue(domSettingDefaultCodexModel, appConfig.defaultCodexModel);
  setFieldValue(domSettingDefaultReasoningEffort, appConfig.defaultReasoningEffort);
  if (domSettingThemeMode) {
    domSettingThemeMode.value = settingsDraftThemeMode || appConfig.themeMode || "system";
  }
}

async function saveAppConfig() {
  const nextConfig = {
    ...appConfig,
    graphAssetGlobs: Array.isArray(appConfig.graphAssetGlobs) ? appConfig.graphAssetGlobs : undefined,
    recentProjects: Array.isArray(appConfig.recentProjects) ? appConfig.recentProjects : [],
    themeMode: settingsDraftThemeMode || "system",
  };
  if (settingValue(domSettingControllerApiKey)) {
    nextConfig.controllerApiKey = settingValue(domSettingControllerApiKey);
  } else {
    delete nextConfig.controllerApiKey;
  }
  setOptionalConfigValue(nextConfig, "codexCliPath", settingValue(domSettingCodexPath));
  setOptionalConfigValue(nextConfig, "claudeCliPath", settingValue(domSettingClaudePath));
  setOptionalConfigValue(nextConfig, "defaultCodexModel", settingValue(domSettingDefaultCodexModel));
  setOptionalConfigValue(nextConfig, "defaultReasoningEffort", settingValue(domSettingDefaultReasoningEffort));

  setSettingsMessage("Saving...");
  if (domSettingsSave) domSettingsSave.disabled = true;
  try {
    const resp = await fetch(apiUrl("/api/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextConfig),
    });
    const saved = await resp.json();
    if (!resp.ok) throw new Error(saved.error || "Settings save failed");
    appConfig = saved;
    settingsDraftThemeMode = appConfig.themeMode ?? "system";
    renderSettings();
    renderProjectHistory();
    applyThemeMode(appConfig.themeMode);
    setSettingsMessage("Saved");
  } catch (err) {
    setSettingsMessage(err instanceof Error ? err.message : "Save failed", "error");
  } finally {
    if (domSettingsSave) domSettingsSave.disabled = false;
  }
}

function applyThemeMode(mode) {
  const theme = mode === "dark" || mode === "light" ? mode : systemTheme();
  document.documentElement.dataset.theme = theme;
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function openSettingsPanel(trigger = null) {
  lastSettingsTrigger = trigger ?? domSettingsOpen;
  settingsDraftThemeMode = appConfig.themeMode ?? "system";
  renderSettings();
  domSettings?.classList.remove("hidden");
  setSettingsMessage("");
  domSettings?.focus();
}

function closeSettingsPanel() {
  domSettings?.classList.add("hidden");
  settingsDraftThemeMode = appConfig.themeMode ?? "system";
  renderSettings();
  applyThemeMode(appConfig.themeMode);
  lastSettingsTrigger?.focus?.();
}

function handleSettingsKeydown(event) {
  if (event.key === "Escape" && !domSettings?.classList.contains("hidden")) {
    closeSettingsPanel();
  }
}

async function runSettingsProbe() {
  if (currentGraphAsset?.relativePath) {
    setSettingsMessage("Running probe...");
    await loadReadiness();
    setSettingsMessage("Probe refreshed");
    return;
  }
  await loadReadiness();
  setSettingsMessage("Open a graph to run readiness probe");
}

function settingValue(field) {
  return String(field?.value ?? "").trim();
}

function setFieldValue(field, value) {
  if (field) field.value = value ?? "";
}

function setOptionalConfigValue(target, key, value) {
  if (value) {
    target[key] = value;
  } else {
    delete target[key];
  }
}

function setSettingsMessage(message, className = "") {
  if (!domSettingsMessage) return;
  domSettingsMessage.textContent = message;
  domSettingsMessage.className = className;
}

function defaultSelectedNodeId() {
  const firstController = currentGraphDefinition?.nodes?.find((item) => item.type === "controller");
  return firstController?.id ?? currentGraphDefinition?.nodes?.[0]?.id ?? null;
}

async function openProject(rootPath) {
  try {
    const resp = await fetch(apiUrl("/api/projects/open"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath }),
    });
    const project = await resp.json();
    if (!resp.ok) throw new Error(project.error || "Project open failed");
    await activateProject(project);
    await loadAppConfig();
    return project;
  } catch (err) {
    const message = err instanceof Error ? err.message : "打开项目失败";
    showProjectOpenError(message);
    return null;
  }
}

async function activateProject(project) {
  currentProject = project;
  currentGraphAsset = null;
  pendingGraphAssetPath = null;
  currentGraphDefinition = null;
  graphDirty = false;
  invalidCommandDrafts.clear();
  renderProjectSummary();
  renderProjectHistory();
  renderOpenGraphState();
  renderGraphCanvas();
  renderRuntimeInspect();
  await Promise.all([loadGraphAssets(), loadWorkspaceTargets()]);
}

function showProjectOpenError(message) {
  if (domProjectSummary) {
    domProjectSummary.innerHTML = `<strong>Open failed</strong><span>${escapeHtml(message)}</span>`;
  }
}

function toggleNewGraphPanel() {
  domNewGraphPanel?.classList.toggle?.("hidden");
  if (domNewGraphPath && !domNewGraphPath.value) domNewGraphPath.value = "main.vg.yaml";
  if (domNewGraphId && !domNewGraphId.value) domNewGraphId.value = "main";
  domNewGraphPath?.focus?.();
}

async function createGraphAssetFromForm() {
  if (!currentProject?.id) {
    setNewGraphMessage("请先打开项目", "error");
    return null;
  }
  const relativePath = String(domNewGraphPath?.value || "").trim();
  if (!relativePath) {
    setNewGraphMessage("请输入 graph 文件名", "error");
    return null;
  }
  const graphId = String(domNewGraphId?.value || "").trim() || filenameToFlowName(relativePath);

  try {
    setNewGraphMessage("Creating graph...");
    const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(currentProject.id)}/graph-assets`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relativePath, graphId }),
    });
    const asset = await resp.json();
    if (!resp.ok) throw new Error(asset.error || "Graph create failed");
    await Promise.all([loadGraphAssets(), loadWorkspaceTargets()]);
    await openGraphAsset(asset.relativePath);
    setNewGraphMessage(`Created ${asset.relativePath}`, "success");
    return asset;
  } catch (err) {
    setNewGraphMessage(err instanceof Error ? err.message : "新建 Graph 失败", "error");
    return null;
  }
}

function setNewGraphMessage(message, className = "") {
  if (!domNewGraphMessage) return;
  domNewGraphMessage.textContent = message;
  domNewGraphMessage.className = `inline-message${className ? ` ${className}` : ""}`;
}

async function loadGraphAssets() {
  if (!currentProject?.id) {
    graphAssets = [];
    renderGraphAssets();
    return;
  }

  const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(currentProject.id)}/graph-assets`), {
    cache: "no-store",
  });
  const items = await resp.json();
  if (!resp.ok) throw new Error(items.error || "Graph assets request failed");
  graphAssets = Array.isArray(items) ? items : [];
  renderGraphAssets();
}

async function loadGraphDefinition(graphPath) {
  const requestId = ++graphDefinitionRequestId;
  if (!graphPath) {
    if (requestId === graphDefinitionRequestId && currentGraphAsset?.relativePath === graphPath) {
      currentGraphDefinition = null;
    }
    return false;
  }

  try {
    const resp = await fetch(apiUrl(`/api/graphs/detail?path=${encodeURIComponent(graphPath)}`));
    if (!resp.ok) throw new Error(`Graph detail request failed: ${resp.status}`);
    const graphDefinition = await resp.json();
    if (requestId !== graphDefinitionRequestId || currentGraphAsset?.relativePath !== graphPath) {
      return false;
    }
    currentGraphDefinition = graphDefinition;
    return true;
  } catch {
    if (requestId === graphDefinitionRequestId && currentGraphAsset?.relativePath === graphPath) {
      currentGraphDefinition = null;
    }
    return false;
  }
}

async function openGraphAsset(relativePath) {
  if (!currentProject?.id || !relativePath) return false;
  const asset = graphAssets.find((item) => item.relativePath === relativePath)
    ?? { relativePath, name: basename(relativePath), projectId: currentProject.id };
  pendingGraphAssetPath = relativePath;
  const requestId = ++graphDefinitionRequestId;

  try {
    const encodedPath = encodeURIComponent(relativePath);
    const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(currentProject.id)}/graph-assets/${encodedPath}`), {
      cache: "no-store",
    });
    const detail = await resp.json();
    if (!resp.ok) throw new Error(detail.error || "Graph asset request failed");
    if (requestId !== graphDefinitionRequestId || pendingGraphAssetPath !== relativePath) return false;
    currentGraphAsset = detail.asset ?? asset;
    pendingGraphAssetPath = null;
    currentGraphDefinition = detail.graph ?? null;
    graphDirty = false;
    invalidCommandDrafts.clear();
    selectedGraphNodeId = defaultSelectedNodeId();
    selectedNodeIdx = -1;
    canvasPan = { x: 0, y: 0 };
    renderOpenGraphState();
    renderGraphAssets();
    renderGraphCanvas();
    renderInspectorNode(findGraphNode(selectedGraphNodeId));
    renderRuntimeInspect();
    loadReadiness();
    return true;
  } catch (err) {
    if (requestId === graphDefinitionRequestId && pendingGraphAssetPath === relativePath) {
      pendingGraphAssetPath = null;
      renderOpenGraphState(err instanceof Error ? err.message : "打开图资产失败");
      renderGraphCanvas();
    }
    return false;
  }
}

async function loadWorkspaceTargets(options = {}) {
  const selectId = options.selectId ?? selectedWorkspaceTarget?.id ?? null;
  const requestId = ++workspaceRequestId;
  if (!currentProject?.id) {
    workspaceTargets = [];
    selectedWorkspaceTarget = null;
    renderWorkspaceBar();
    setWorkspaceMessage("打开项目后可创建 workspace");
    return;
  }

  try {
    const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(currentProject.id)}/workspaces`), { cache: "no-store" });
    const items = await resp.json();
    if (requestId !== workspaceRequestId) return;
    if (!resp.ok) throw new Error(items.error || "Workspace request failed");
    workspaceTargets = Array.isArray(items) ? items : [];
    selectedWorkspaceTarget = workspaceTargets.find((item) => item.id === selectId) ?? workspaceTargets[0] ?? null;
    renderWorkspaceBar();
    setWorkspaceMessage("");
  } catch {
    if (requestId !== workspaceRequestId) return;
    workspaceTargets = [];
    selectedWorkspaceTarget = null;
    renderWorkspaceBar();
    setWorkspaceMessage("无法读取 workspace 列表");
  }
}

async function createManualWorktree() {
  if (worktreeCreateInFlight) return;
  if (!currentProject?.id) {
    setWorkspaceMessage("请先打开项目");
    return;
  }

  const name = domWorktreeName?.value?.trim() ?? "";
  if (!name) {
    setWorkspaceMessage("请输入 worktree 名称");
    return;
  }

  worktreeCreateInFlight = true;
  if (domCreateWorktree) domCreateWorktree.disabled = true;
  setWorkspaceMessage("正在创建...");

  try {
    const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(currentProject.id)}/workspaces`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.error || "创建 worktree 失败");
    }
    if (domWorktreeName) domWorktreeName.value = "";
    await loadWorkspaceTargets({ selectId: result.id });
    setWorkspaceMessage(`已创建 ${basename(result.path)}`);
    setWorkspaceCreateOpen(false);
  } catch (err) {
    setWorkspaceMessage(err instanceof Error ? err.message : "创建 worktree 失败");
  } finally {
    worktreeCreateInFlight = false;
    if (domCreateWorktree) domCreateWorktree.disabled = false;
  }
}

async function loadReadiness() {
  if (!domReadiness) return;
  const graphPath = currentGraphAsset?.relativePath;
  if (!graphPath) {
    domReadiness.innerHTML = '<div class="empty-state compact">请选择 graph</div>';
    return;
  }

  const requestId = ++readinessRequestId;
  domReadiness.innerHTML = '<div class="empty-state compact">正在预检...</div>';

  try {
    const readinessParams = new URLSearchParams();
    readinessParams.set("path", graphPath);
    if (currentProject?.id) {
      readinessParams.set("projectId", currentProject.id);
    }
    const resp = await fetch(apiUrl(`/api/readiness?${readinessParams.toString()}`), {
      cache: "no-store",
    });
    const result = await resp.json();
    if (requestId !== readinessRequestId || currentGraphAsset?.relativePath !== graphPath) return;
    if (!resp.ok) throw new Error(result.error || "Readiness request failed");
    renderReadiness(result);
  } catch (err) {
    if (requestId !== readinessRequestId || currentGraphAsset?.relativePath !== graphPath) return;
    domReadiness.innerHTML = `<div class="empty-state compact">${escapeHtml(err instanceof Error ? err.message : "预检失败")}</div>`;
  }
}

function renderReadiness(result) {
  if (!domReadiness) return;
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  if (checks.length === 0) {
    domReadiness.innerHTML = '<div class="empty-state compact">无预检结果</div>';
    return;
  }

  const summary = result.ok ? "PASS" : "FAIL";
  domReadiness.innerHTML = `<div class="readiness-summary ${result.ok ? "pass" : "fail"}">${summary}</div>
    ${checks.map((item) => `<div class="readiness-row ${item.status}">
      <span class="readiness-dot"></span>
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(item.message)}</span>
      </div>
    </div>`).join("")}`;
}

function setWorkspaceMessage(message) {
  if (domWorktreeMessage) domWorktreeMessage.textContent = message;
}

function setWorkspaceCreateOpen(open) {
  workspaceCreateOpen = Boolean(open);
  if (domWorkspaceCreatePopover) {
    domWorkspaceCreatePopover.classList[workspaceCreateOpen ? "remove" : "add"]("hidden");
  }
  domToggleWorkspaceCreate?.setAttribute("aria-expanded", workspaceCreateOpen ? "true" : "false");
  if (workspaceCreateOpen) {
    domWorktreeName?.focus?.();
  }
}

function renderProjectSummary() {
  if (domCurrentRepoChip) domCurrentRepoChip.textContent = currentProject ? currentProject.name : "未打开项目";
  if (domProjectName) domProjectName.textContent = currentProject?.name ?? "No project open";
  if (!domProjectSummary) return;

  if (!currentProject) {
    domProjectSummary.innerHTML = '<strong>No project open</strong><span>Open a local repository or directory to list VineGraph assets.</span>';
    return;
  }

  const branch = currentProject.branch ? `branch ${currentProject.branch}` : currentProject.kind;
  const dirty = currentProject.dirty ? "dirty" : "clean";
  domProjectSummary.innerHTML = `<strong>${escapeHtml(currentProject.name)}</strong>
    <span title="${escapeAttr(currentProject.rootPath)}">${escapeHtml(currentProject.rootPath)}</span>
    <div class="project-card-meta">
      <span>${escapeHtml(currentProject.kind)}</span>
      <span>${escapeHtml(branch)}</span>
      <span>${escapeHtml(dirty)}</span>
    </div>`;
}

function renderProjectHistory() {
  if (!domProjectHistory) return;
  const projects = Array.isArray(appConfig.recentProjects)
    ? [...appConfig.recentProjects].sort((left, right) => (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0))
    : [];

  if (projects.length === 0) {
    domProjectHistory.innerHTML = '<div class="empty-state compact">暂无最近项目</div>';
    return;
  }

  domProjectHistory.innerHTML = projects.map((project) => {
    const active = currentProject?.id === project.id ? " active" : "";
    const lastOpened = formatProjectLastOpened(project.lastOpenedAt);
    return `<button class="project-history-row${active}" type="button" data-root-path="${escapeAttr(project.rootPath)}" title="${escapeAttr(project.rootPath)}">
      <span class="project-history-main">
        <strong>${escapeHtml(project.name)}</strong>
        <small>${escapeHtml(project.rootPath)}</small>
        <small>${escapeHtml(lastOpened)}</small>
      </span>
      <span class="project-history-kind">${escapeHtml(project.kind)}</span>
    </button>`;
  }).join("");

  domProjectHistory.querySelectorAll(".project-history-row").forEach((row) => {
    row.addEventListener("click", () => openProject(row.dataset.rootPath));
  });
}

function formatProjectLastOpened(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "最近打开时间未知";
  }
  return `最近 ${new Date(value).toLocaleString()}`;
}

function renderGraphAssets() {
  if (!domGraphAssets) return;
  const filter = String(domGraphAssetFilter?.value || "").toLowerCase().trim();
  const visible = graphAssets.filter((asset) => {
    const haystack = `${asset.relativePath} ${asset.graphId ?? ""}`.toLowerCase();
    return !filter || haystack.includes(filter);
  });

  if (!currentProject) {
    domGraphAssets.innerHTML = '<div class="empty-state compact">打开项目后显示图资产</div>';
    return;
  }
  if (visible.length === 0) {
    domGraphAssets.innerHTML = '<div class="empty-state compact">没有匹配的 graph asset</div>';
    return;
  }

  domGraphAssets.innerHTML = visible.map((asset) => {
    const active = asset.relativePath === currentGraphAsset?.relativePath ? " selected" : "";
    const graphId = asset.graphId ? `<span>${escapeHtml(asset.graphId)}</span>` : "";
    return `<button class="graph-asset-row${active}" type="button" data-path="${escapeAttr(asset.relativePath)}" title="${escapeAttr(asset.relativePath)}">
      <span class="file-icon graph"></span>
      <span class="graph-asset-main">
        <strong>${escapeHtml(asset.name ?? basename(asset.relativePath))}</strong>
        <small>${escapeHtml(asset.relativePath)}</small>
      </span>
      ${graphId}
    </button>`;
  }).join("");

  domGraphAssets.querySelectorAll(".graph-asset-row").forEach((row) => {
    row.addEventListener("click", () => {
      openGraphAsset(row.dataset.path);
    });
    row.addEventListener("dblclick", () => {
      openGraphAsset(row.dataset.path);
    });
  });
}

function renderOpenGraphState(error = "") {
  const label = currentGraphAsset?.relativePath ?? "未打开图资产";
  if (domOpenGraphPath) domOpenGraphPath.textContent = error ? `打开失败: ${error}` : label;
  if (domSaveStateChip) domSaveStateChip.textContent = graphDirty ? "未保存" : "已保存";
  if (domCanvasTitle) domCanvasTitle.textContent = currentGraphDefinition?.id ?? basename(label) ?? "No graph";
}

function renderWorkspaceBar() {
  if (domWorkspaceSwitcher) {
    domWorkspaceSwitcher.innerHTML = workspaceTargets.map((target) =>
      `<option value="${escapeAttr(target.id)}">${escapeHtml(target.label ?? basename(target.path))}</option>`
    ).join("");
    if (selectedWorkspaceTarget) domWorkspaceSwitcher.value = selectedWorkspaceTarget.id;
    domWorkspaceSwitcher.disabled = workspaceTargets.length === 0;
  }
  if (domToggleWorkspaceCreate) domToggleWorkspaceCreate.disabled = !currentProject?.id;
  if (domCreateWorktree) domCreateWorktree.disabled = !currentProject?.id || worktreeCreateInFlight;
  if (domWorktreeName) domWorktreeName.disabled = !currentProject?.id;

  const target = selectedWorkspaceTarget;
  if (domWorkspaceBranch) {
    const branch = target?.branch ?? (target?.detached ? "detached" : target?.kind ?? "--");
    domWorkspaceBranch.textContent = `${branch}: ${target?.path ?? "--"}`;
  }
  if (domWorkspaceDirty) {
    domWorkspaceDirty.textContent = target?.dirty ? "dirty" : "clean";
    domWorkspaceDirty.className = `workspace-chip${target?.dirty ? " dirty" : ""}`;
  }
}

function bindTabs() {
  document.querySelectorAll(".dock-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".dock-tab").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".dock-pane").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".dock-tab").forEach((item) => item.setAttribute("aria-selected", "false"));
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      $(`#${tab.dataset.panel}-panel`)?.classList.add("active");
    });
  });
}

function bindTerminalControls() {
  domTerminalSearch?.addEventListener("input", renderTerminalEntries);
  domTerminalNodeFilter?.addEventListener("change", renderTerminalEntries);
  domTerminalFollow?.addEventListener("change", renderTerminalEntries);
  domCopyTerminal?.addEventListener("click", copyVisibleTerminalOutput);
  domClearTerminalView?.addEventListener("click", clearTerminalView);
  updateTerminalNodeFilterOptions();
}

function bindRuntimeDockResize() {
  if (!domRuntimeDock) return;
  const storedHeight = readStoredRuntimeDockHeight();
  if (storedHeight !== null) applyRuntimeDockHeight(storedHeight, false);
  updateRuntimeDockResizeAria(runtimeDockHeight());
  updateRuntimeDockToggleState(false);

  domRuntimeDockResizeHandle?.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const startHeight = runtimeDockHeight();
    runtimeDockDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
    };
    domRuntimeDock.classList.add("is-resizing");
    domRuntimeDockResizeHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault?.();
  });

  window.addEventListener("pointermove", (event) => {
    if (!runtimeDockDrag) return;
    const nextHeight = runtimeDockDrag.startHeight + runtimeDockDrag.startY - event.clientY;
    applyRuntimeDockHeight(nextHeight, true);
  });

  window.addEventListener("pointerup", endRuntimeDockDrag);
  window.addEventListener("pointercancel", endRuntimeDockDrag);

  domRuntimeDockResizeHandle?.addEventListener("keydown", (event) => {
    const currentHeight = runtimeDockHeight();
    let nextHeight = null;
    if (event.key === "ArrowUp") nextHeight = currentHeight + RUNTIME_DOCK_KEYBOARD_STEP;
    if (event.key === "ArrowDown") nextHeight = currentHeight - RUNTIME_DOCK_KEYBOARD_STEP;
    if (event.key === "Home") nextHeight = RUNTIME_DOCK_MIN_HEIGHT;
    if (event.key === "End") nextHeight = runtimeDockMaxHeight();
    if (nextHeight === null) return;
    applyRuntimeDockHeight(nextHeight, true);
    event.preventDefault?.();
  });

  domToggleRuntimeDock?.addEventListener("click", () => {
    const collapsed = domRuntimeDock.classList.toggle("is-collapsed");
    updateRuntimeDockToggleState(collapsed);
    if (!collapsed) {
      applyRuntimeDockHeight(readStoredRuntimeDockHeight() ?? runtimeDockHeight(), false);
    }
  });
}

function endRuntimeDockDrag(event) {
  if (!runtimeDockDrag) return;
  domRuntimeDockResizeHandle?.releasePointerCapture?.(event.pointerId);
  runtimeDockDrag = null;
  domRuntimeDock?.classList.remove("is-resizing");
}

function runtimeDockHeight() {
  const styleHeight = parseInt(domRuntimeDock?.style?.height || "", 10);
  if (Number.isFinite(styleHeight)) return styleHeight;
  const rectHeight = domRuntimeDock?.getBoundingClientRect?.().height;
  if (Number.isFinite(rectHeight) && rectHeight > 0) return rectHeight;
  return 260;
}

function readStoredRuntimeDockHeight() {
  try {
    const value = window.localStorage?.getItem(RUNTIME_DOCK_HEIGHT_KEY);
    const height = parseInt(value || "", 10);
    return Number.isFinite(height) ? clampRuntimeDockHeight(height) : null;
  } catch {
    return null;
  }
}

function applyRuntimeDockHeight(height, persist) {
  if (!domRuntimeDock) return;
  const clamped = clampRuntimeDockHeight(height);
  domRuntimeDock.style.height = `${clamped}px`;
  updateRuntimeDockResizeAria(clamped);
  scheduleTerminalFit();
  scheduleInspectTerminalResize();
  if (!persist) return;
  try {
    window.localStorage?.setItem(RUNTIME_DOCK_HEIGHT_KEY, String(clamped));
  } catch {
    // Ignore storage failures; resizing should still work.
  }
}

function clampRuntimeDockHeight(height) {
  return clamp(Number(height) || 260, RUNTIME_DOCK_MIN_HEIGHT, runtimeDockMaxHeight());
}

function runtimeDockMaxHeight() {
  return Math.max(260, Math.floor((window.innerHeight || 720) * 0.7));
}

function updateRuntimeDockResizeAria(height) {
  if (!domRuntimeDockResizeHandle) return;
  domRuntimeDockResizeHandle.setAttribute("aria-valuemin", String(RUNTIME_DOCK_MIN_HEIGHT));
  domRuntimeDockResizeHandle.setAttribute("aria-valuemax", String(runtimeDockMaxHeight()));
  domRuntimeDockResizeHandle.setAttribute("aria-valuenow", String(clampRuntimeDockHeight(height)));
}

function updateRuntimeDockToggleState(collapsed) {
  if (!domToggleRuntimeDock) return;
  const label = collapsed ? "展开运行面板" : "收起运行面板";
  domToggleRuntimeDock.setAttribute("aria-expanded", collapsed ? "false" : "true");
  domToggleRuntimeDock.setAttribute("aria-label", label);
  domToggleRuntimeDock.title = label;
  domToggleRuntimeDock.textContent = collapsed ? "+" : "×";
}

// ─── Graph canvas ──────────────────────────────────────────────────
function renderGraphCanvas() {
  renderOpenGraphState();
  if (!currentGraphDefinition) {
    domCanvas.innerHTML = '<div class="empty-state canvas-empty">打开 graph asset 后显示自动布局画布</div>';
    return;
  }

  const definitionNodes = currentGraphDefinition.nodes;
  const definitionEdges = currentGraphDefinition.edges;
  const layout = layoutGraphDefinition(currentGraphDefinition);
  const bounds = graphBounds(layout);
  canvasBounds = bounds;
  canvasPan = clampCanvasPan(canvasPan, canvasBounds);
  const canvasNodes = layout.nodes.map(enrichCanvasNode);
  const nodeMap = new Map(canvasNodes.map((item) => [item.id, item]));
  const svg = layout.connections
    .map((item, index) => renderConnection(item, nodeMap, index))
    .join("");
  const nodes = canvasNodes.map(renderGraphNode).join("");

  domCanvas.innerHTML = `<div class="graph-layer" style="width:${bounds.width}px;height:${bounds.height}px;transform: translate(${-canvasPan.x}px, ${-canvasPan.y}px)">
    <svg class="connections" viewBox="${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}" preserveAspectRatio="xMinYMin meet" style="width:${bounds.width}px;height:${bounds.height}px">${renderConnectionDefs()}${svg}</svg>
    ${nodes}
  </div>
  ${renderMinimap(layout, bounds)}`;

  domCanvas.querySelectorAll(".graph-node").forEach((el) => {
    el.addEventListener("click", () => {
      selectedGraphNodeId = el.dataset.nodeId;
      selectedNodeIdx = latestActivationIndexForNode(selectedGraphNodeId);
      renderGraphCanvas();
      renderTimeline();
      renderInspectorNode(findGraphNode(selectedGraphNodeId));
      renderRuntimeInspect();
      if (selectedNodeIdx >= 0) {
        renderDetail(activations[selectedNodeIdx]);
        syncTerminalForActivationSelection(activations[selectedNodeIdx]);
      }
    });
  });
}

function layoutGraphDefinition(graph) {
  const sourceNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const graphEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  const hasGraphStart = graphEdges.some((edge) => String(edge.from || "") === "graph.start");
  const graphNodes = hasGraphStart
    ? [{ id: "graph_start", type: "start", label: "Start" }, ...sourceNodes]
    : sourceNodes;
  const ids = graphNodes.map((item) => item.id).filter(Boolean);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));

  for (const edge of graphEdges) {
    const from = endpointNodeId(edge.from);
    const to = endpointNodeId(edge.to);
    if (!from || !to || !incoming.has(to)) continue;
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    if (outgoing.has(from)) outgoing.get(from).push(to);
  }

  const levels = new Map();
  const queue = ids.filter((id) => (incoming.get(id) ?? 0) === 0);
  if (queue.length === 0 && ids.length > 0) queue.push(ids[0]);
  for (const id of queue) levels.set(id, 0);

  while (queue.length > 0) {
    const id = queue.shift();
    const nextLevel = (levels.get(id) ?? 0) + 1;
    for (const to of outgoing.get(id) ?? []) {
      // Cyclic graphs are valid for agent loops. Assign each node's first
      // discovered level and still render the back-edge instead of repeatedly
      // relaxing levels forever.
      if (!levels.has(to)) {
        levels.set(to, nextLevel);
        queue.push(to);
      }
    }
  }

  ids.forEach((id) => {
    if (!levels.has(id)) levels.set(id, 0);
  });

  const byLevel = new Map();
  ids.forEach((id) => {
    const level = levels.get(id) ?? 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(id);
  });

  const nodeById = new Map(graphNodes.map((item) => [item.id, item]));
  const nodes = [];
  [...byLevel.entries()].sort((a, b) => a[0] - b[0]).forEach(([level, levelIds]) => {
    levelIds.forEach((id, row) => {
      const realNode = nodeById.get(id);
      const kind = canvasNodeKind(realNode);
      const isController = kind === "controller";
      nodes.push({
        id,
        title: realNode?.label ?? titleFromId(id),
        kind,
        badge: nodeDefinitionBadge(realNode),
        description: realNode?.description ?? "",
        x: 80 + level * 270,
        y: 70 + row * 150,
        width: isController ? 240 : 200,
        height: isController ? 150 : 96,
        outputs: isController ? controllerOutputsForNode(id, graphEdges) : null,
      });
    });
  });

  const connections = graphEdges
    .map((edge) => {
      const from = endpointNodeId(edge.from);
      const to = endpointNodeId(edge.to);
      if (!from || !to) return null;
      return connect(from, to, connectionColor(edge.from));
    })
    .filter(Boolean);

  return { title: graph?.id ?? "graph", nodes, connections };
}

function endpointNodeId(endpoint) {
  const raw = String(endpoint || "");
  if (raw === "graph.start") return "graph_start";
  return raw.split(".")[0] || "";
}

function titleFromId(id) {
  return String(id || "")
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Node";
}

function canvasNodeKind(nodeInfo) {
  const type = String(nodeInfo?.type ?? "").toLowerCase();
  if (type === "controller") return "controller";
  if (type === "end") return "end";
  if (type === "failed") return "failed";
  if (type === "start") return "start";
  return "execute";
}

function nodeDefinitionBackend(nodeInfo) {
  const kind = canvasNodeKind(nodeInfo);
  if (kind === "execute") return nodeInfo?.backend ?? "";
  if (kind === "controller") return "controller";
  return nodeInfo?.backend ?? nodeInfo?.type ?? kind;
}

function nodeDefinitionModel(nodeInfo) {
  const kind = canvasNodeKind(nodeInfo);
  if (kind === "controller") return nodeInfo?.model ?? "";
  return nodeInfo?.execution?.model ?? nodeInfo?.model ?? "";
}

function nodeDefinitionBadge(nodeInfo) {
  const kind = canvasNodeKind(nodeInfo);
  if (kind === "execute") return nodeInfo?.backend ?? "";
  if (kind === "controller") return nodeInfo?.model ?? "controller";
  return nodeInfo?.backend ?? nodeInfo?.type ?? kind;
}

function controllerOutputsForNode(nodeId, edges) {
  const colors = ["orange", "green", "red", "purple", "blue"];
  return edges
    .filter((edge) => endpointNodeId(edge.from) === nodeId)
    .map((edge, index) => {
      const output = String(edge.from || "").split(".outputs.")[1] ?? "done";
      return [endpointNodeId(edge.to), output, colors[index % colors.length]];
    });
}

function connectionColor(endpoint) {
  const output = String(endpoint || "").split(".outputs.")[1] ?? "";
  if (output.includes("failed") || output.includes("fail")) return "red";
  if (output.includes("success")) return "green";
  if (output.includes("fix")) return "orange";
  if (output.includes("next")) return "purple";
  return "blue";
}

function renderMinimap(preset, bounds) {
  const nodes = preset.nodes.map((item) => {
    const left = toPercent((item.x - bounds.minX) / bounds.width);
    const top = toPercent((item.y - bounds.minY) / bounds.height);
    const width = toPercent(item.width / bounds.width);
    const height = toPercent(item.height / bounds.height);
    return `<span class="minimap-node minimap-${escapeAttr(item.kind)}" style="left:${left};top:${top};width:${width};height:${height}"></span>`;
  }).join("");

  return `<div class="minimap" aria-label="画布缩略视图">
    <div class="minimap-nodes">${nodes}</div>
    <div class="minimap-viewport" style="${minimapViewportStyle(bounds)}"></div>
  </div>`;
}

function bindCanvasPan() {
  domCanvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  domCanvas.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".minimap")) return;
    if (event.button !== 2) return;

    canvasDrag = {
      mode: "canvas-pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPan: { ...canvasPan },
    };
    domCanvas.classList.add("is-panning");
    captureCanvasPointer(event);
    event.preventDefault();
  });

  domCanvas.addEventListener("pointermove", (event) => {
    if (canvasDrag?.mode !== "canvas-pan") return;
    const dx = event.clientX - canvasDrag.startX;
    const dy = event.clientY - canvasDrag.startY;
    canvasPan = clampCanvasPan({
      x: canvasDrag.startPan.x - dx,
      y: canvasDrag.startPan.y - dy,
    });
    applyCanvasPan();
  });

  domCanvas.addEventListener("pointerup", endCanvasDrag);
  domCanvas.addEventListener("pointercancel", endCanvasDrag);
}

function bindMinimapDrag() {
  domCanvas.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const minimap = target?.closest(".minimap");
    if (!minimap) return;
    if (event.button !== 0) return;

    const viewport = minimap.querySelector(".minimap-viewport");
    const viewportRect = viewport?.getBoundingClientRect();
    const viewportOffset = target?.closest(".minimap-viewport") && viewportRect
      ? {
          x: event.clientX - viewportRect.left,
          y: event.clientY - viewportRect.top,
        }
      : {
          x: (viewportRect?.width ?? 0) / 2,
          y: (viewportRect?.height ?? 0) / 2,
        };

    canvasDrag = {
      mode: "minimap-pan",
      pointerId: event.pointerId,
      minimap,
      viewportOffset,
    };
    domCanvas.classList.add("is-panning");
    captureCanvasPointer(event);
    minimapPanFromPointer(event, minimap, viewportOffset);
    event.preventDefault();
  });

  domCanvas.addEventListener("pointermove", (event) => {
    if (canvasDrag?.mode !== "minimap-pan") return;
    minimapPanFromPointer(event, canvasDrag.minimap, canvasDrag.viewportOffset);
  });

  domCanvas.addEventListener("pointerup", endCanvasDrag);
  domCanvas.addEventListener("pointercancel", endCanvasDrag);
}

function minimapPanFromPointer(event, minimap, viewportOffset = { x: 0, y: 0 }) {
  const rect = minimap.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const left = event.clientX - rect.left - viewportOffset.x;
  const top = event.clientY - rect.top - viewportOffset.y;

  canvasPan = clampCanvasPan({
    x: (left / width) * canvasBounds.width,
    y: (top / height) * canvasBounds.height,
  });
  applyCanvasPan();
}

function applyCanvasPan() {
  canvasPan = clampCanvasPan(canvasPan, canvasBounds);
  const layer = domCanvas.querySelector(".graph-layer");
  if (layer) {
    layer.style.transform = `translate(${-canvasPan.x}px, ${-canvasPan.y}px)`;
  }

  const viewport = domCanvas.querySelector(".minimap-viewport");
  if (viewport) {
    viewport.setAttribute("style", minimapViewportStyle(canvasBounds));
  }
}

function clampCanvasPan(pan, bounds = canvasBounds) {
  const viewport = canvasViewportSize();
  const maxX = Math.max(0, bounds.width - viewport.width);
  const maxY = Math.max(0, bounds.height - viewport.height);
  return {
    x: clamp(Number(pan.x) || 0, 0, maxX),
    y: clamp(Number(pan.y) || 0, 0, maxY),
  };
}

function minimapViewportStyle(bounds = canvasBounds) {
  const viewport = canvasViewportSize();
  const width = clamp(viewport.width / Math.max(1, bounds.width), 0, 1) * 100;
  const height = clamp(viewport.height / Math.max(1, bounds.height), 0, 1) * 100;
  const left = clamp(canvasPan.x / Math.max(1, bounds.width), 0, 1) * 100;
  const top = clamp(canvasPan.y / Math.max(1, bounds.height), 0, 1) * 100;
  return `left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;width:${width.toFixed(2)}%;height:${height.toFixed(2)}%`;
}

function canvasViewportSize() {
  return {
    width: Math.max(1, domCanvas.clientWidth || 900),
    height: Math.max(1, domCanvas.clientHeight || 520),
  };
}

function captureCanvasPointer(event) {
  if (domCanvas.setPointerCapture) {
    domCanvas.setPointerCapture(event.pointerId);
  }
}

function endCanvasDrag(event) {
  if (!canvasDrag) return;
  if (domCanvas.hasPointerCapture?.(event.pointerId)) {
    domCanvas.releasePointerCapture(event.pointerId);
  }
  canvasDrag = null;
  domCanvas.classList.remove("is-panning");
}

function toPercent(value) {
  return `${(clamp(value, 0, 1) * 100).toFixed(2)}%`;
}

function graphBounds(graphLayout) {
  const layoutNodes = Array.isArray(graphLayout?.nodes) ? graphLayout.nodes : [];
  const maxX = Math.max(...layoutNodes.map((item) => item.x + item.width), 1060);
  const maxY = Math.max(...layoutNodes.map((item) => item.y + item.height), 560);
  return {
    minX: 0,
    minY: 0,
    width: Math.max(1220, maxX + 160),
    height: Math.max(680, maxY + 120),
  };
}

function renderConnectionDefs() {
  const colors = {
    blue: "#6d99ff",
    orange: "#e9a557",
    green: "#54d17a",
    red: "#f25d68",
    purple: "#9b6cff",
  };

  return `<defs>${Object.entries(colors).map(([name, color]) =>
    `<marker id="arrow-${name}" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
      <path d="M 1 1 L 8 5 L 1 9 z" fill="${color}"></path>
    </marker>`
  ).join("")}</defs>`;
}

function renderConnection(connection, nodeMap, index) {
  const from = nodeMap.get(connection.from);
  const to = nodeMap.get(connection.to);
  if (!from || !to) return "";

  const route = routeConnection(connection, from, to, index);
  const active = isConnectionActive(connection) ? " connection-active" : " connection-muted";
  const loop = route.isLoop ? " connection-loop" : "";
  const classes = `connection-group ${connection.color}${active}${loop}`;
  return `<g class="${classes}">
    <path class="connection-casing" d="${route.path}"></path>
    <path class="connection-line" d="${route.path}" marker-end="url(#arrow-${connection.color})"></path>
  </g>`;
}

function routeConnection(connection, from, to, index) {
  const fromCenterX = from.x + from.width / 2;
  const toCenterX = to.x + to.width / 2;
  const isLoop = toCenterX < fromCenterX;
  const startX = isLoop ? from.x : from.x + from.width;
  const startY = from.y + (connection.fromOffset ?? from.height / 2);
  const endX = isLoop ? to.x + to.width : to.x;
  const endY = to.y + to.height / 2;
  const laneOffset = (index % 5) * 18;

  if (isLoop) {
    const laneY = Math.max(from.y + from.height, to.y + to.height) + 40 + laneOffset;
    return {
      isLoop,
      path: roundedPolyline([
        [startX, startY],
        [startX - 34, startY],
        [startX - 34, laneY],
        [endX + 34, laneY],
        [endX + 34, endY],
        [endX, endY],
      ]),
    };
  }

  const distance = endX - startX;
  const laneX = distance < 72
    ? startX + 54 + laneOffset
    : startX + Math.max(46, distance * 0.5);
  return {
    isLoop,
    path: roundedPolyline([
      [startX, startY],
      [laneX, startY],
      [laneX, endY],
      [endX, endY],
    ]),
  };
}

function roundedPolyline(points, radius = 12) {
  if (points.length < 2) return "";
  const [first, ...rest] = points;
  let path = `M ${first[0]} ${first[1]}`;

  for (let i = 0; i < rest.length; i++) {
    const current = rest[i];
    const previous = points[i];
    const next = points[i + 2];

    if (!next) {
      path += ` L ${current[0]} ${current[1]}`;
      continue;
    }

    const before = shortenPoint(current, previous, radius);
    const after = shortenPoint(current, next, radius);
    path += ` L ${before[0]} ${before[1]} Q ${current[0]} ${current[1]} ${after[0]} ${after[1]}`;
  }

  return path;
}

function shortenPoint(point, toward, radius) {
  const dx = toward[0] - point[0];
  const dy = toward[1] - point[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  const amount = Math.min(radius, length / 2);
  return [
    point[0] + (dx / length) * amount,
    point[1] + (dy / length) * amount,
  ];
}

function isConnectionActive(connection) {
  return connection.from === selectedGraphNodeId || connection.to === selectedGraphNodeId;
}

function renderGraphNode(item) {
  const selected = item.id === selectedGraphNodeId ? " selected" : "";
  const active = item.id === activeGraphNodeId ? " is-active" : "";
  const runState = statusForNode(item.id);
  const stateClass = runState ? ` run-${runState}` : "";
  const badge = item.badge ? `<span class="node-badge badge-${badgeClass(item.badge)}">${escapeHtml(item.badge)}</span>` : "";
  const outputs = item.outputs
    ? `<div class="controller-outputs">${item.outputs.map(([id, label, color]) =>
        `<div class="output-row" data-output="${escapeAttr(id)}"><span>${escapeHtml(id)}</span><span class="port-dot ${color}"></span></div>`
      ).join("")}</div>`
    : "";

  const description = item.description
    ? `<span class="node-description">${escapeHtml(item.description)}</span>`
    : "";

  return `<button class="graph-node ${item.kind}${selected}${active}${stateClass}" type="button"
      data-node-id="${escapeAttr(item.id)}"
      style="left:${item.x}px;top:${item.y}px;width:${item.width}px;min-height:${item.height}px">
    <span class="node-port in"></span>
    <span class="node-port out"></span>
    <span class="node-topline">
      <span class="node-type-icon">${nodeIcon(item.kind)}</span>
      <span class="node-title">${escapeHtml(item.title)}</span>
    </span>
    ${badge}
    ${description}
    ${outputs}
  </button>`;
}

function nodeIcon(kind) {
  if (kind === "controller") return "C";
  if (kind === "start") return "S";
  if (kind === "failed") return "X";
  if (kind === "end") return "✓";
  return ">";
}

function badgeClass(badge) {
  return badge.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function statusForNode(nodeId) {
  const latest = latestActivationForNode(nodeId);
  return latest?.status;
}

function latestActivationForNode(nodeId) {
  const idx = latestActivationIndexForNode(nodeId);
  return idx >= 0 ? activations[idx] : null;
}

function latestActivationIndexForNode(nodeId) {
  for (let idx = activations.length - 1; idx >= 0; idx -= 1) {
    if (activations[idx].nodeId === nodeId) return idx;
  }
  return -1;
}

function graphDefinitionNode(id) {
  return currentGraphDefinition?.nodes?.find((item) => item.id === id) ?? null;
}

function enrichCanvasNode(item) {
  if (!item) return null;
  const realNode = graphDefinitionNode(item.id);
  if (!realNode) return item;

  const model = nodeDefinitionModel(realNode) || null;
  const backend = nodeDefinitionBackend(realNode) || null;
  return {
    ...item,
    backend,
    command: realNode.command,
    execution: realNode.execution,
    model,
    promptTemplate: realNode.promptTemplate,
    description: realNode.description,
    realNode,
    type: realNode.type,
    badge: nodeDefinitionBadge(realNode) || item.badge,
  };
}

function findGraphNode(nodeId) {
  const layout = currentGraphDefinition ? layoutGraphDefinition(currentGraphDefinition) : { nodes: [] };
  const node = layout.nodes.find((item) => item.id === nodeId) ?? layout.nodes[0] ?? null;
  return enrichCanvasNode(node);
}

// ─── Run control ───────────────────────────────────────────────────
async function startRun() {
  const graphPath = currentGraphAsset?.relativePath;
  if (!graphPath) {
    alert("请先选择 graph");
    return;
  }

  currentRunId = null;
  currentRunProjectId = currentProject?.id ?? null;
  activations = [];
  activeGraphNodeId = null;
  activeTerminalActivationId = null;
  activeTerminalSessionId = null;
  activeTerminalTransport = "server";
  selectedInspectTerminalSessionId = null;
  removeStoredTerminalAttachment();
  selectedNodeIdx = -1;
  lastRunResult = null;
  terminalEntriesBySession = new Map();
  terminalTransportBySession = new Map();
  terminalViewClearedAtBySession = new Map();
  resetXtermTerminal();
  domTimeline.innerHTML = '<div class="empty-state">正在启动运行...</div>';
  if (domDetail) domDetail.innerHTML = '<div class="empty-state">运行中，等待节点输出...</div>';
  if (domRuntimeInspect) {
    domRuntimeInspect.innerHTML = '<div class="empty-state">运行中，等待节点激活...</div>';
  }
  domDiff.innerHTML = '<div class="empty-state">等待 diff...</div>';
  domTimelineSummary.classList.add("hidden");
  domPatch.disabled = true;
  domRunChip.textContent = "运行中";
  domBarDuration.textContent = "";
  setStatus("running", "运行中");
  setRunning(true);
  renderGraphCanvas();
  renderRuntimeInspect();

  try {
    const body = { graphPath };
    if (currentProject?.id) {
      body.projectId = currentProject.id;
      body.graphAssetPath = graphPath;
      body.workspaceTarget = selectedWorkspaceTarget;
    }
    if (domTask.value) body.task = domTask.value;
    if (domTest.value) body.test_command = domTest.value;

    const resp = await fetch(apiUrl("/api/runs"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await resp.json();

    if (resp.ok) {
      if (result.status === "running" && result.runId) {
        currentRunId = result.runId;
        currentRunProjectId = result.projectId ?? currentRunProjectId;
        domRunChip.textContent = `#${String(result.runId).slice(0, 8)}`;
        domTimeline.innerHTML = '<div class="empty-state">运行已启动，等待节点输出...</div>';
        connectSSE(result.runId);
      } else {
        onRunCompleted(result);
      }
    } else {
      domTimeline.innerHTML = `<div class="empty-state">Error: ${escapeHtml(result.error || "Unknown error")}</div>`;
      domRunChip.textContent = "失败";
      setStatus("failed", "失败");
      setRunning(false);
    }
  } catch (err) {
    domTimeline.innerHTML = `<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`;
    domRunChip.textContent = "失败";
    setStatus("failed", "失败");
    setRunning(false);
  }
}

async function cancelRun() {
  if (!currentRunId) return;
  domCancel.disabled = true;
  setStatus("running", "正在取消");
  domRunChip.textContent = "正在取消";
  try {
    const resp = await fetch(apiUrl(`/api/runs/${currentRunId}`), { method: "DELETE" });
    if (!resp.ok) {
      setRunning(false);
      setStatus("failed", "取消失败");
      domRunChip.textContent = "取消失败";
    }
  } catch {
    setRunning(false);
    setStatus("failed", "取消失败");
    domRunChip.textContent = "取消失败";
  }
}

function setRunning(running) {
  domRun.disabled = running;
  domCancel.disabled = !running;
}

function setStatus(status, label) {
  domStatus.className = `status-badge ${status}`;
  domStatus.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(label)}</span>`;
  if (domRunStateText) domRunStateText.textContent = label;
}

// ─── SSE ────────────────────────────────────────────────────────────
function connectSSE(runId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(apiUrl(`/api/runs/${runId}/events`));

  eventSource.addEventListener("node:started", (e) => {
    const data = JSON.parse(e.data);
    handleNodeStarted(data);
  });

  eventSource.addEventListener("node:output", (e) => {
    appendActivationOutput(JSON.parse(e.data));
  });

  eventSource.addEventListener("terminal:started", (e) => {
    handleTerminalStarted(JSON.parse(e.data));
  });

  eventSource.addEventListener("terminal:output", (e) => {
    handleTerminalOutput(JSON.parse(e.data));
  });

  eventSource.addEventListener("terminal:ended", (e) => {
    handleTerminalEnded(JSON.parse(e.data));
  });

  eventSource.addEventListener("node:completed", (e) => {
    const data = JSON.parse(e.data);
    handleNodeCompleted(data);
  });

  eventSource.addEventListener("run:completed", (e) => {
    const data = JSON.parse(e.data);
    onRunCompleted(data);
    if (eventSource) eventSource.close();
    eventSource = null;
  });

  eventSource.addEventListener("run:cancelled", (e) => {
    const data = JSON.parse(e.data);
    onRunCompleted(data);
    if (eventSource) eventSource.close();
    eventSource = null;
  });

  eventSource.onerror = () => {};
}

// ─── Run completed ─────────────────────────────────────────────────
async function onRunCompleted(result) {
  currentRunId = result.runId;
  currentRunProjectId = result.projectId ?? currentRunProjectId ?? currentProject?.id ?? null;
  lastRunResult = result;
  activeGraphNodeId = null;
  setRunning(false);
  setStatus(result.status, statusLabel(result.status));
  domRunChip.textContent = `#${String(result.runId).slice(0, 8)}`;

  if (result.totalDurationMs) {
    const duration = `${(result.totalDurationMs / 1000).toFixed(1)}s`;
    domBarDuration.textContent = duration;
    domSummaryDuration.textContent = duration;
  }

  activations = mergeActivations(activations, result.activations || []);
  activations.forEach((activation) => {
    syncTerminalEntryLabelsForActivation(activation);
    backfillTerminalEntriesFromActivation(activation);
  });
  updateTerminalNodeFilterOptions();
  if (selectedNodeIdx < 0 && activations.length > 0) {
    selectedNodeIdx = activations.length - 1;
    selectedGraphNodeId = activations[selectedNodeIdx].nodeId;
  }
  renderTimeline();
  renderGraphCanvas();
  renderRuntimeInspect();
  if (selectedNodeIdx >= 0) renderDetail(activations[selectedNodeIdx]);
  renderInspectorNode(findGraphNode(selectedGraphNodeId));
  if (selectedNodeIdx >= 0) syncTerminalForActivationSelection(activations[selectedNodeIdx]);

  domSummaryFixes.textContent = result.fixAttempts ?? 0;
  domTimelineSummary.classList.remove("hidden");

  renderDiff(result.workspace);

  if (result.workspace?.patchPath) {
    domPatch.disabled = false;
    domPatch.onclick = () => {
      window.open(apiUrl(patchDownloadPath(result)), "_blank");
    };
  }

  await loadWorkspaceTargets();
}

function statusLabel(status) {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "running") return "运行中";
  return "未运行";
}

// ─── Timeline rendering ────────────────────────────────────────────
function renderTimeline() {
  if (activations.length === 0) {
    domTimeline.innerHTML = '<div class="empty-state">运行后将在这里显示节点时间线</div>';
    return;
  }

  domTimeline.innerHTML = activations
    .map((a, i) => {
      const dur = formatDuration(activationDurationMs(a));
      const sel = i === selectedNodeIdx ? " selected" : "";
      const time = a.startedAt ? new Date(a.startedAt).toLocaleTimeString() : "--";
      return `<button class="timeline-item${sel}" type="button" data-idx="${i}">
        <span class="timeline-time">${escapeHtml(time)}</span>
        <span class="timeline-name">${escapeHtml(timelineNodeName(a))}</span>
        <span class="timeline-status ${escapeAttr(a.status)}">${escapeHtml(a.status)}</span>
        <span class="timeline-duration">${escapeHtml(dur)}</span>
      </button>`;
    })
    .join("");

  domTimeline.querySelectorAll(".timeline-item").forEach((el) => {
    el.addEventListener("click", () => {
      selectActivationAtIndex(parseInt(el.dataset.idx, 10));
    });
  });
}

function timelineNodeName(activation) {
  if (!activation) return "--";
  const iteration = activation.iteration ? ` #${activation.iteration}` : "";
  return `${activation.nodeId ?? "--"}${iteration}`;
}

function selectActivationAtIndex(idx) {
  if (idx < 0 || idx >= activations.length) return;
  selectedNodeIdx = idx;
  selectedGraphNodeId = activations[selectedNodeIdx]?.nodeId ?? selectedGraphNodeId;
  renderTimeline();
  renderGraphCanvas();
  renderDetail(activations[selectedNodeIdx]);
  renderInspectorNode(findGraphNode(selectedGraphNodeId), activations[selectedNodeIdx]);
  renderRuntimeInspect();
  return syncTerminalForActivationSelection(activations[selectedNodeIdx]);
}

function handleNodeStarted(data) {
  const activation = data.activation ?? data;
  upsertActivation(activation);
  updateTerminalNodeFilterOptions();
  activeGraphNodeId = activation.nodeId ?? null;
  renderGraphCanvas();
  syncTerminalForActivationStart(findActivation(activation.activationId) ?? activation);
}

function handleNodeCompleted(data) {
  const activation = data.activation ?? data;
  upsertActivation(activation);
  const completedActivation = findActivation(activation.activationId) ?? activation;
  syncTerminalEntryLabelsForActivation(completedActivation);
  backfillTerminalEntriesFromActivation(completedActivation);
  updateTerminalNodeFilterOptions();
  syncActiveGraphNodeFromRunning();
  renderGraphCanvas();
  syncTerminalForActivationCompletion(completedActivation);
}

function syncActiveGraphNodeFromRunning() {
  const running = [...activations].reverse().find((item) => item.status === "running");
  activeGraphNodeId = running?.nodeId ?? null;
}

function findActivation(activationId) {
  return activations.find((item) => item.activationId === activationId) ?? null;
}

function backendForActivation(activation) {
  if (!activation) return "";
  return activation.rawResult?.backend
    ?? activation.backend
    ?? graphDefinitionNode(activation.nodeId)?.backend
    ?? findGraphNode(activation.nodeId)?.backend
    ?? findGraphNode(activation.nodeId)?.badge
    ?? "";
}

function activationFailed(activation) {
  if (!activation) return false;
  if (activation.status === "cancelled" || activation.rawResult?.aborted) return false;
  if (activation.status === "failed") return true;
  const exitCode = activation.rawResult?.exitCode;
  if (exitCode === undefined || exitCode === null || exitCode === "running") return false;
  return Number(exitCode) !== 0;
}

function stderrPresentationForActivation(activation) {
  const backend = backendForActivation(activation);
  if (isAgentBackend(backend) && !activationFailed(activation)) {
    return { label: "diagnostics", className: "diagnostics" };
  }
  return { label: "stderr", className: "stderr" };
}

function syncTerminalForActivationStart(activation) {
  if (!isAgentBackend(backendForActivation(activation))) return;
  activeTerminalActivationId = activation.activationId;
  const sessionId = terminalSessionIdForActivation(activation);
  if (sessionId && activation.activationId === activations[selectedNodeIdx]?.activationId) {
    selectedInspectTerminalSessionId = sessionId;
    activeTerminalSessionId = sessionId;
    scheduleInspectTerminalResize(sessionId);
  }
  scheduleTerminalRender();
}

function syncTerminalForActivationCompletion(activation) {
  const backend = backendForActivation(activation);
  if (!isAgentBackend(backend)) return;
  if (isAgentBackend(backend)) {
    activeTerminalActivationId = activation.activationId;
  }
  if (activeTerminalActivationId === activation.activationId) {
    scheduleTerminalRender();
  }
  if (activation.activationId === activations[selectedNodeIdx]?.activationId) {
    const sessionId = terminalSessionIdForActivation(activation);
    if (sessionId) {
      selectedInspectTerminalSessionId = sessionId;
      scheduleInspectTerminalResize(sessionId);
    }
  }
}

function syncTerminalForActivationSelection(activation) {
  const sessionId = terminalSessionIdForActivation(activation);
  if (sessionId) {
    selectedInspectTerminalSessionId = sessionId;
    activeTerminalSessionId = sessionId;
  }
  const attached = attachTerminalSessionForActivation(activation);
  if (attached) return attached;
  const isAgent = isAgentBackend(backendForActivation(activation));
  if (!isAgent) return;
  activeTerminalActivationId = activation.activationId;
  scheduleTerminalRender();
}

function scheduleTerminalRender() {
  const raf = window.requestAnimationFrame;
  if (typeof raf !== "function") {
    renderTerminal();
    return;
  }
  if (terminalRenderFrame !== null) return;
  terminalRenderFrame = raf(() => {
    terminalRenderFrame = null;
    renderTerminal();
  });
}

function scheduleActivationRender() {
  const raf = window.requestAnimationFrame;
  if (typeof raf !== "function") {
    renderActivationViews();
    return;
  }
  if (activationRenderFrame !== null) return;
  activationRenderFrame = raf(() => {
    activationRenderFrame = null;
    renderActivationViews();
  });
}

function renderActivationViews() {
  renderTimeline();
  renderGraphCanvas();
  renderRuntimeInspect();
  if (selectedNodeIdx >= 0) {
    renderDetail(activations[selectedNodeIdx]);
    renderInspectorNode(findGraphNode(selectedGraphNodeId), activations[selectedNodeIdx]);
  }
}

function upsertActivation(activation, options = {}) {
  if (!activation?.activationId) return;
  const existingIdx = activations.findIndex((item) => item.activationId === activation.activationId);
  if (existingIdx >= 0) {
    activations[existingIdx] = mergeActivation(activations[existingIdx], activation);
  } else {
    activations.push(activation);
  }

  const idx = activations.findIndex((item) => item.activationId === activation.activationId);
  if (selectedNodeIdx < 0 || selectedNodeIdx === idx) {
    selectedNodeIdx = idx;
    selectedGraphNodeId = activations[idx]?.nodeId ?? selectedGraphNodeId;
  }

  if (options.suppressRender) return;

  if (options.deferRender) {
    scheduleActivationRender();
  } else {
    renderActivationViews();
  }
}

function appendActivationOutput(data) {
  if (!data?.activationId) return;
  const stream = data.stream === "stderr" ? "stderr" : "stdout";
  const isAgentOutput = isAgentBackend(data.backend);
  if (isAgentOutput) {
    activeTerminalActivationId = data.activationId;
  }
  if (!isAgentOutput || data.terminalSessionId || data.sessionId) {
    appendTerminalEntry(data);
  }

  const existingIdx = activations.findIndex((item) => item.activationId === data.activationId);
  const base = existingIdx >= 0
    ? activations[existingIdx]
    : {
        activationId: data.activationId,
        nodeId: data.nodeId,
        status: "running",
        inputs: {},
        iteration: 1,
        startedAt: data.timestamp ?? Date.now(),
      };
  const previousRaw = base.rawResult || {};
  const startedAt = previousRaw.startedAt ?? base.startedAt ?? data.timestamp ?? Date.now();
  const timestamp = data.timestamp ?? Date.now();
  const stdout = stream === "stdout"
    ? `${previousRaw.stdout || ""}${data.chunk || ""}`
    : previousRaw.stdout || "";
  const stderr = stream === "stderr"
    ? `${previousRaw.stderr || ""}${data.chunk || ""}`
    : previousRaw.stderr || "";

  upsertActivation({
    ...base,
    rawResult: {
      ...previousRaw,
      activationId: data.activationId,
      nodeId: data.nodeId ?? previousRaw.nodeId,
      backend: data.backend ?? previousRaw.backend,
      stdout,
      stderr,
      exitCode: previousRaw.exitCode ?? "running",
      startedAt,
      finishedAt: timestamp,
      durationMs: timestamp - startedAt,
    },
  }, { deferRender: !isAgentOutput, suppressRender: isAgentOutput });
}

function mergeActivation(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    rawResult: incoming.rawResult
      ? {
          ...(existing.rawResult || {}),
          ...incoming.rawResult,
        }
      : existing.rawResult,
  };
}

function mergeActivations(current, incoming) {
  const merged = [...current];
  for (const item of incoming) {
    const idx = merged.findIndex((existing) => existing.activationId === item.activationId);
    if (idx >= 0) {
      merged[idx] = mergeActivation(merged[idx], item);
    } else {
      merged.push(item);
    }
  }
  return merged;
}

// ─── Runtime Inspect rendering ─────────────────────────────────────
function renderRuntimeInspect() {
  if (!domRuntimeInspect) return;
  const nodeInfo = findGraphNode(selectedGraphNodeId);
  if (!nodeInfo) {
    syncRuntimeInspectTick(null);
    selectedInspectTerminalSessionId = null;
    domRuntimeInspect.innerHTML = '<div class="empty-state">选择节点查看运行 Inspect</div>';
    return;
  }

  const activation = selectedRuntimeActivation(nodeInfo.id);
  syncRuntimeInspectTick(activation?.status === "running" ? activation.activationId : null);
  const status = activation?.status ?? "not-run";
  const durationMs = activationDurationMs(activation);
  const backend = activation
    ? backendForActivation(activation)
    : nodeInfo.backend ?? nodeInfo.badge ?? nodeInfo.kind ?? "";
  const startedAt = activation?.startedAt ? new Date(activation.startedAt).toLocaleTimeString() : "--";
  const finishedAt = activation?.finishedAt ? new Date(activation.finishedAt).toLocaleTimeString() : "--";
  const terminalSessionId = terminalSessionIdForActivation(activation);
  const preservedTerminalRoot = terminalSessionId ? inspectTerminalRoot(terminalSessionId) : null;

  domRuntimeInspect.innerHTML = `<div class="runtime-inspect">
    <div class="inspect-summary">
      <div class="inspect-heading">
        <span class="inspect-node-icon">${nodeIcon(nodeInfo.kind)}</span>
        <div>
          <h3>${escapeHtml(nodeInfo.title ?? nodeInfo.id)}</h3>
          <p>${escapeHtml(nodeInfo.id)}${backend ? ` · ${escapeHtml(backend)}` : ""}</p>
        </div>
      </div>
      <span class="inspect-status-pill status-${escapeAttr(badgeClass(status))}">${escapeHtml(runtimeStatusLabel(status))}</span>
    </div>

    <div class="inspect-metrics">
      <div class="inspect-metric"><span>运行情况</span><strong>${escapeHtml(runtimeStatusLabel(status))}</strong></div>
      <div class="inspect-metric"><span>已执行时间</span><strong>${escapeHtml(formatDuration(durationMs))}</strong></div>
      <div class="inspect-metric"><span>开始时间</span><strong>${escapeHtml(startedAt)}</strong></div>
      <div class="inspect-metric"><span>结束时间</span><strong>${escapeHtml(finishedAt)}</strong></div>
      <div class="inspect-metric"><span>Iteration</span><strong>${escapeHtml(activation?.iteration ?? "--")}</strong></div>
      <div class="inspect-metric"><span>Activation</span><strong>${escapeHtml(activation?.activationId ? String(activation.activationId).slice(0, 12) : "--")}</strong></div>
    </div>

    <div class="inspect-grid">
      <section class="inspect-card">
        <header>
          <span>节点输入</span>
          <small>${escapeHtml(inputSummary(activation?.inputs))}</small>
        </header>
        ${renderInspectJson(activation?.inputs, activation ? "暂无输入" : "节点尚未执行，暂无输入")}
      </section>
      <section class="inspect-card">
        <header>
          <span>节点输出</span>
          <small>${escapeHtml(outputSummary(activation))}</small>
        </header>
        ${renderInspectOutput(activation)}
      </section>
    </div>
  </div>`;
  const nextTerminalRoot = terminalSessionId ? inspectTerminalRoot(terminalSessionId) : null;
  if (
    preservedTerminalRoot &&
    nextTerminalRoot &&
    preservedTerminalRoot !== nextTerminalRoot &&
    terminalMountedSessionId === terminalSessionId
  ) {
    nextTerminalRoot.replaceWith(preservedTerminalRoot);
    domTerminalXterm = preservedTerminalRoot.querySelector("#terminal-xterm");
    domTerminalFallbackLines = preservedTerminalRoot.querySelector("#terminal-fallback-lines");
  }
  bindInspectTerminalControls();
}

function syncRuntimeInspectTick(activationId) {
  if (activationId && runtimeInspectTickTimer === null && typeof window.setInterval === "function") {
    runtimeInspectTickTimer = window.setInterval(() => {
      renderRuntimeInspect();
    }, 1000);
    return;
  }
  if (!activationId && runtimeInspectTickTimer !== null) {
    if (typeof window.clearInterval === "function") {
      window.clearInterval(runtimeInspectTickTimer);
    }
    runtimeInspectTickTimer = null;
  }
}

function selectedRuntimeActivation(nodeId) {
  const selected = selectedNodeIdx >= 0 ? activations[selectedNodeIdx] : null;
  if (selected?.nodeId === nodeId) return selected;
  return latestActivationForNode(nodeId);
}

function runtimeStatusLabel(status) {
  if (status === "not-run") return "未执行";
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "succeeded") return "已执行";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return String(status || "未知");
}

function activationDurationMs(activation) {
  if (!activation) return null;
  const rawDuration = activation.rawResult?.durationMs;
  if (typeof rawDuration === "number" && Number.isFinite(rawDuration)) return rawDuration;
  const startedAt = activation.rawResult?.startedAt ?? activation.startedAt;
  if (!startedAt) return null;
  const finishedAt = activation.finishedAt ?? activation.rawResult?.finishedAt;
  const end = finishedAt ?? (activation.status === "running" ? Date.now() : null);
  if (!end) return null;
  return Math.max(0, end - startedAt);
}

function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) return "--";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function inputSummary(inputs) {
  const keys = inputs && typeof inputs === "object" ? Object.keys(inputs) : [];
  return keys.length > 0 ? `${keys.length} fields` : "empty";
}

function outputSummary(activation) {
  if (!activation) return "not run";
  if (activation.controllerDecision) return `selected ${activation.controllerDecision.selected_output}`;
  if (activation.error) return "error";
  if (activation.rawResult) return `exit ${activation.rawResult.exitCode ?? "--"}`;
  return activation.status === "running" ? "waiting" : "empty";
}

function renderInspectJson(value, emptyLabel) {
  if (!value || (typeof value === "object" && Object.keys(value).length === 0)) {
    return `<div class="empty-state compact">${escapeHtml(emptyLabel)}</div>`;
  }
  return renderInspectValue(value);
}

function renderInspectValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '<div class="empty-state compact">[]</div>';
    return `<div class="inspect-object">${value.map((item, index) => renderInspectField(`[${index}]`, item)).join("")}</div>`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return '<div class="empty-state compact">{}</div>';
    return `<div class="inspect-object">${entries.map(([key, item]) => renderInspectField(key, item)).join("")}</div>`;
  }
  if (typeof value === "string") {
    return `<pre class="inspect-text">${escapeHtml(decodeEscapedText(value))}</pre>`;
  }
  return `<pre class="inspect-json">${escapeHtml(String(value))}</pre>`;
}

function renderInspectField(key, value) {
  const nested = value && typeof value === "object";
  return `<div class="inspect-field${nested ? " nested" : ""}">
    <div class="inspect-field-key">${escapeHtml(key)}</div>
    <div class="inspect-field-value">${renderInspectValue(value)}</div>
  </div>`;
}

function decodeEscapedText(value) {
  return String(value ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function renderInspectOutput(activation) {
  if (!activation) {
    selectedInspectTerminalSessionId = null;
    return '<div class="empty-state compact">节点尚未执行，暂无输出</div>';
  }

  if (activation.controllerDecision) {
    selectedInspectTerminalSessionId = null;
    return renderControllerDecisionInspect(activation);
  }

  let html = renderInspectTerminal(activation);

  if (activation.error) {
    html += `<div class="inspect-error">${escapeHtml(activation.error)}</div>`;
  }

  return html || '<div class="empty-state compact">等待节点输出</div>';
}

function renderControllerDecisionInspect(activation) {
  const decision = activation?.controllerDecision;
  if (!decision) return '<div class="empty-state compact">暂无 controller decision</div>';
  return `<details class="inspect-controller-decision" open>
    <summary>Controller Decision</summary>
    ${renderInspectJson(decision, "暂无决策")}
  </details>`;
}

function renderInspectTerminal(activation) {
  const sessionId = terminalSessionIdForActivation(activation);
  selectedInspectTerminalSessionId = sessionId || null;
  if (!sessionId) {
    return '<div class="empty-state compact">该节点暂无 terminal session</div>';
  }

  const result = activation.rawResult;
  const resultBar = result
    ? `<div class="inspect-result-bar">
      <span>${escapeHtml(result.backend ?? "backend")}</span>
      <span>exit ${escapeHtml(result.exitCode ?? "--")}</span>
      <span>${escapeHtml(formatDuration(activationDurationMs(activation)))}</span>
    </div>`
    : "";

  return `<div class="inspect-terminal" data-session-id="${escapeAttr(sessionId)}">
    ${resultBar}
    <div class="inspect-terminal-toolbar">
      <span class="inspect-terminal-session" title="${escapeAttr(sessionId)}">${escapeHtml(sessionId)}</span>
      <div class="inspect-terminal-actions">
        <button class="toolbar-button" type="button" data-terminal-action="copy">Copy</button>
        <button class="toolbar-button" type="button" data-terminal-action="interrupt">Interrupt</button>
      </div>
    </div>
    <div class="inspect-terminal-content terminal-content">
      <div id="terminal-xterm" class="inspect-terminal-xterm terminal-xterm" data-inspect-terminal-xterm tabindex="0" aria-label="Node terminal"></div>
      <div id="terminal-fallback-lines" class="inspect-terminal-fallback terminal-fallback-lines hidden" data-inspect-terminal-fallback>
        <div class="empty-state">等待 terminal 输出...</div>
      </div>
    </div>
  </div>`;
}

function bindInspectTerminalControls() {
  const root = domRuntimeInspect?.querySelector(".inspect-terminal");
  if (!root) return;
  const sessionId = root.dataset.sessionId;
  selectedInspectTerminalSessionId = sessionId;
  activeTerminalSessionId = sessionId;
  domTerminalXterm = root.querySelector("#terminal-xterm");
  domTerminalFallbackLines = root.querySelector("#terminal-fallback-lines");
  if (root.dataset.boundTerminalSession !== sessionId) {
    root.querySelector("[data-terminal-action='copy']")?.addEventListener("click", () => {
      copyVisibleTerminalOutput(sessionId);
    });
    root.querySelector("[data-terminal-action='interrupt']")?.addEventListener("click", () => {
      sendTerminalActionToSession("interrupt", sessionId);
    });
    root.dataset.boundTerminalSession = sessionId;
  }
  if (
    xtermTerminal &&
    terminalMountedSessionId === sessionId &&
    domTerminalXterm?.querySelector(".xterm")
  ) {
    scheduleTerminalFit();
    return;
  }
  mountInspectTerminal(sessionId);
}

// ─── Detail rendering ──────────────────────────────────────────────
function renderDetail(activation) {
  if (!domDetail) return;
  if (!activation) {
    domDetail.innerHTML = '<div class="empty-state">选择节点查看详情</div>';
    return;
  }

  let html = `<div class="detail-section">
    <h4>Node</h4>
    <div>${escapeHtml(activation.nodeId)} (iteration ${escapeHtml(String(activation.iteration))})</div>
  </div>`;

  if (activation.renderedPrompt) {
    html += `<div class="detail-section prompt-section"><h4>Prompt</h4><pre>${escapeHtml(activation.renderedPrompt)}</pre></div>`;
  }

  if (activation.controllerDecision) {
    const d = activation.controllerDecision;
    html += `<div class="detail-section">
      <h4>Controller Decision</h4>
      <div class="controller-decision">
        <div class="field"><strong>Selected:</strong> ${escapeHtml(d.selected_output)}</div>
        <div class="field"><strong>Confidence:</strong> ${escapeHtml(String(d.confidence))}</div>
        <div class="field"><strong>Reason:</strong> ${escapeHtml(d.reason)}</div>
        ${d.payload ? `<div class="field"><strong>Payload:</strong><pre>${escapeHtml(JSON.stringify(d.payload, null, 2))}</pre></div>` : ""}
      </div>
    </div>`;
  }

  if (activation.rawResult) {
    const r = activation.rawResult;
    html += `<div class="detail-section">
      <h4>Info</h4>
      <div>Backend: ${escapeHtml(r.backend)} | Exit: ${escapeHtml(String(r.exitCode))} | Duration: ${escapeHtml(String(r.durationMs))}ms</div>
    </div>`;

    if (r.stdout) {
      html += `<div class="detail-section"><h4>stdout</h4><pre>${escapeHtml(r.stdout)}</pre></div>`;
    }
    if (r.stderr) {
      const stderrPresentation = stderrPresentationForActivation(activation);
      html += `<div class="detail-section ${escapeAttr(stderrPresentation.className)}-section"><h4>${escapeHtml(stderrPresentation.label)}</h4><pre>${escapeHtml(r.stderr)}</pre></div>`;
    }
  }

  if (activation.error) {
    html += `<div class="detail-section"><h4>Error</h4><pre>${escapeHtml(activation.error)}</pre></div>`;
  }

  domDetail.innerHTML = html;
}

function appendTerminalEntry(data) {
  appendTerminalEntryToSession(data);
}

function terminalSessionBucket(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) return [];
  const existing = terminalEntriesBySession.get(key);
  if (existing) return existing;
  const created = [];
  terminalEntriesBySession.set(key, created);
  return created;
}

function terminalSessionIdForTerminalData(data) {
  const sessionId = data?.terminalSessionId ?? data?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function terminalTranscriptForSession(sessionId) {
  const bucket = terminalEntriesBySession.get(sessionId) ?? [];
  const clearedAt = terminalViewClearedAtBySession.get(sessionId) ?? 0;
  return bucket.slice(clearedAt).map((entry) => entry.chunk).join("");
}

function allTerminalEntries() {
  return [...terminalEntriesBySession.values()].flat();
}

function appendTerminalEntryToSession(data) {
  const sessionId = terminalSessionIdForTerminalData(data);
  if (!sessionId || !data?.activationId) return;
  const chunk = String(data.chunk ?? data.output ?? "");
  if (!chunk) return;
  const nodeId = String(data.nodeId ?? "unknown");
  const backend = String(data.backend ?? "unknown");
  const stream = data.stream === "stderr" ? "stderr" : "stdout";
  const bucket = terminalSessionBucket(sessionId);
  bucket.push({
    terminalSessionId: sessionId,
    activationId: String(data.activationId),
    nodeId,
    backend,
    stream,
    label: data.label ?? defaultTerminalLabel(backend, stream),
    chunk,
    timestamp: Number(data.timestamp ?? Date.now()),
  });
  trimTerminalEntries(sessionId);
  if (sessionId === selectedInspectTerminalSessionId) {
    if (xtermTerminal && terminalMountedSessionId === sessionId) {
      writeInspectTerminalChunk(sessionId, chunk);
    } else {
      mountInspectTerminal(sessionId);
    }
  }
  scheduleTerminalRender();
}

function terminalFallbackContainer() {
  return domTerminalFallbackLines || domTerminal;
}

function setTerminalFallbackVisible(visible) {
  const inspectFallback = inspectTerminalFallbackElement();
  const inspectXterm = inspectTerminalXtermElement();
  toggleElementClass(inspectFallback, "hidden", !visible);
  toggleElementClass(inspectXterm, "hidden", visible);
  toggleElementClass(domTerminalFallbackLines, "hidden", !visible);
  toggleElementClass(domTerminalXterm, "hidden", visible);
}

function toggleElementClass(element, className, force) {
  if (!element?.classList) return;
  if (typeof element.classList.toggle === "function") {
    element.classList.toggle(className, force);
    return;
  }
  if (force) {
    element.classList.add?.(className);
  } else {
    element.classList.remove?.(className);
  }
}

function defaultTerminalModuleLoader(name) {
  if (name === "@xterm/xterm") return import("@xterm/xterm");
  if (name === "@xterm/addon-fit") return import("@xterm/addon-fit");
  throw new Error(`Unsupported terminal module: ${name}`);
}

function resolveTerminalModuleLoader() {
  if (terminalModuleLoader) return terminalModuleLoader;
  if (typeof window.AGENTGRAPH_TERMINAL_LOADER === "function") {
    return window.AGENTGRAPH_TERMINAL_LOADER;
  }
  if (window.AGENTGRAPH_ENABLE_TEST_HOOKS === true) return null;
  return defaultTerminalModuleLoader;
}

async function initializeTerminal(sessionId = selectedInspectTerminalSessionId) {
  if (!sessionId) return null;
  const container = inspectTerminalXtermElement(sessionId);
  if (!container) {
    setTerminalFallbackVisible(true);
    return null;
  }
  if (
    xtermTerminal &&
    terminalMountedSessionId === sessionId &&
    container.querySelector(".xterm")
  ) {
    return xtermTerminal;
  }
  if (terminalReadyPromise && terminalMountedSessionId === sessionId) {
    return terminalReadyPromise;
  }

  const loader = resolveTerminalModuleLoader();
  if (!loader) {
    setTerminalFallbackVisible(true);
    return null;
  }

  resetXtermTerminal();
  terminalMountedSessionId = sessionId;

  terminalReadyPromise = (async () => {
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        loader("@xterm/xterm"),
        loader("@xterm/addon-fit"),
      ]);
      if (sessionId !== selectedInspectTerminalSessionId) {
        if (terminalMountedSessionId === sessionId) {
          terminalReadyPromise = null;
          terminalMountedSessionId = null;
        }
        return null;
      }
      const currentContainer = inspectTerminalXtermElement(sessionId);
      if (!currentContainer?.isConnected) {
        if (terminalMountedSessionId === sessionId) {
          terminalReadyPromise = null;
          terminalMountedSessionId = null;
        }
        setTerminalFallbackVisible(true);
        return null;
      }
      domTerminalXterm = currentContainer;
      domTerminalFallbackLines = inspectTerminalFallbackElement(sessionId);
      toggleElementClass(domTerminalXterm, "hidden", false);
      toggleElementClass(domTerminalFallbackLines, "hidden", true);
      currentContainer.replaceChildren();
      xtermTerminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: '"Cascadia Mono", Consolas, monospace',
        fontSize: 12,
        theme: {
          background: terminalCssVariable("--terminal-bg", "#050b14"),
          foreground: terminalCssVariable("--text", "#dce7f7"),
          cursor: terminalCssVariable("--heading", "#f6fbff"),
          selectionBackground: "rgba(93, 141, 255, 0.35)",
        },
      });
      terminalFitAddon = new FitAddon();
      xtermTerminal.loadAddon(terminalFitAddon);
      xtermTerminal.open(currentContainer);
      xtermTerminal.attachCustomKeyEventHandler?.((event) => handleTerminalKeyEvent(event, sessionId));
      if (TERMINAL_COPY_ON_SELECTION) {
        xtermTerminal.onSelectionChange?.(() => {
          copyTerminalSelection(sessionId);
        });
      }
      xtermTerminal.onData(handleTerminalInput);
      terminalUsesXterm = true;
      setTerminalFallbackVisible(false);
      scheduleTerminalFit();
      terminalReadyPromise = null;
      return xtermTerminal;
    } catch (err) {
      console.warn("Failed to initialize xterm terminal; using fallback log renderer.", err);
      if (terminalMountedSessionId === sessionId) {
        xtermTerminal = null;
        terminalFitAddon = null;
        terminalUsesXterm = false;
        terminalReadyPromise = null;
        terminalMountedSessionId = null;
        setTerminalFallbackVisible(true);
        renderTerminalEntries();
      }
      return null;
    }
  })();

  return terminalReadyPromise;
}

function terminalCssVariable(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function inspectTerminalRoot(sessionId = selectedInspectTerminalSessionId) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return null;
  return [...(domRuntimeInspect?.querySelectorAll(".inspect-terminal") ?? [])]
    .find((item) => item.dataset.sessionId === targetSessionId) ?? null;
}

function inspectTerminalXtermElement(sessionId = selectedInspectTerminalSessionId) {
  return inspectTerminalRoot(sessionId)?.querySelector("#terminal-xterm, [data-inspect-terminal-xterm]") ?? null;
}

function inspectTerminalFallbackElement(sessionId = selectedInspectTerminalSessionId) {
  return inspectTerminalRoot(sessionId)?.querySelector("#terminal-fallback-lines, [data-inspect-terminal-fallback]") ?? null;
}

async function mountInspectTerminal(sessionId) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return;
  const requestId = ++terminalMountRequestId;
  const transcript = terminalTranscriptForSession(targetSessionId);
  const terminal = await initializeTerminal(targetSessionId);
  if (
    requestId !== terminalMountRequestId ||
    targetSessionId !== selectedInspectTerminalSessionId
  ) {
    return;
  }

  if (!terminal) {
    renderInspectTerminalFallbackText(targetSessionId, transcript);
    return;
  }

  terminal.clear?.();
  if (transcript) terminal.write(transcript);
  scheduleTerminalFit();
}

function writeInspectTerminalChunk(sessionId, chunk) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId || targetSessionId !== selectedInspectTerminalSessionId) return;
  if (xtermTerminal && terminalMountedSessionId === targetSessionId) {
    xtermTerminal.write(String(chunk ?? ""));
    return;
  }

  const fallback = inspectTerminalFallbackElement(targetSessionId);
  if (!fallback) return;
  renderInspectTerminalFallbackText(targetSessionId, terminalTranscriptForSession(targetSessionId) || String(chunk ?? ""));
}

function renderInspectTerminalFallbackText(sessionId, transcript) {
  const fallback = inspectTerminalFallbackElement(sessionId);
  const xterm = inspectTerminalXtermElement(sessionId);
  if (!fallback) return;
  fallback.textContent = transcript || "等待 terminal 输出...";
  fallback.scrollTop = fallback.scrollHeight;
  toggleElementClass(fallback, "hidden", false);
  toggleElementClass(xterm, "hidden", true);
}

async function restoreTerminalAttachment() {
  const stored = readStoredTerminalAttachment();
  if (!stored) return false;
  return attachTerminalSession(stored.runId, stored.sessionId, {
    fromStorage: true,
    projectId: stored.projectId,
  });
}

function readStoredTerminalAttachment() {
  try {
    const raw = window.sessionStorage?.getItem?.(TERMINAL_ATTACHMENT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (typeof value?.runId !== "string" || typeof value?.sessionId !== "string") {
      removeStoredTerminalAttachment();
      return null;
    }
    const runId = value.runId.trim();
    const sessionId = value.sessionId.trim();
    const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
    if (!runId || !sessionId) {
      removeStoredTerminalAttachment();
      return null;
    }
    return { runId, sessionId, projectId: projectId || null };
  } catch {
    removeStoredTerminalAttachment();
    return null;
  }
}

function storeTerminalAttachment(runId, sessionId, projectId = terminalProjectId()) {
  if (!runId || !sessionId) return;
  const payload = { runId, sessionId };
  if (projectId) payload.projectId = projectId;
  try {
    window.sessionStorage?.setItem?.(
      TERMINAL_ATTACHMENT_KEY,
      JSON.stringify(payload)
    );
  } catch {
    // Session persistence is best-effort.
  }
}

function removeStoredTerminalAttachment() {
  try {
    window.sessionStorage?.removeItem?.(TERMINAL_ATTACHMENT_KEY);
  } catch {
    // Session persistence is best-effort.
  }
}

function terminalSessionIdForActivation(activation) {
  const sessionId = activation?.terminalSessionId ?? activation?.rawResult?.terminalSessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function terminalProjectId(projectId = null) {
  const value = projectId
    ?? currentRunProjectId
    ?? lastRunResult?.projectId
    ?? currentProject?.id
    ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function terminalAttachPath(runId, sessionId, projectId = null) {
  const params = new URLSearchParams();
  const terminalProject = terminalProjectId(projectId);
  if (terminalProject) params.set("projectId", terminalProject);
  const query = params.toString();
  return `/api/runs/${encodeURIComponent(runId)}/terminal/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ""}`;
}

function attachTerminalSessionForActivation(activation) {
  const sessionId = terminalSessionIdForActivation(activation);
  const runId = currentRunId ?? lastRunResult?.runId;
  if (!sessionId || !runId) return false;
  return attachTerminalSession(runId, sessionId, { projectId: terminalProjectId() });
}

async function attachTerminalSession(runId, sessionId, options = {}) {
  const targetRunId = String(runId ?? "").trim();
  const targetSessionId = String(sessionId ?? "").trim();
  if (!targetRunId || !targetSessionId) return false;
  const targetProjectId = terminalProjectId(options.projectId);

  const requestId = ++terminalAttachRequestId;
  try {
    const resp = await fetch(
      apiUrl(terminalAttachPath(targetRunId, targetSessionId, targetProjectId)),
      { cache: "no-store" }
    );
    const snapshot = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(snapshot.error || "Terminal session attach failed");
    }
    if (requestId !== terminalAttachRequestId) return false;

    return applyTerminalAttachSnapshot(
      normalizeTerminalSessionPayload(snapshot),
      targetRunId,
      targetSessionId,
      targetProjectId,
      "server"
    );
  } catch (err) {
    const nativeSnapshot = await attachTauriTerminalSession(targetSessionId);
    if (nativeSnapshot && requestId === terminalAttachRequestId) {
      return applyTerminalAttachSnapshot(
        nativeSnapshot,
        targetRunId,
        targetSessionId,
        targetProjectId,
        "tauri"
      );
    }
    if (options.fromStorage) removeStoredTerminalAttachment();
    console.warn("Failed to attach terminal session.", err);
    return false;
  }
}

async function applyTerminalAttachSnapshot(snapshot, fallbackRunId, fallbackSessionId, projectId, transport) {
  currentRunId = snapshot.runId || fallbackRunId;
  currentRunProjectId = snapshot.projectId ?? projectId ?? currentRunProjectId;
  const sessionId = snapshot.terminalSessionId || snapshot.sessionId || fallbackSessionId;
  activeTerminalSessionId = sessionId;
  activeTerminalTransport = transport;
  if (sessionId) terminalTransportBySession.set(sessionId, transport);
  appendTerminalSnapshotToSession(snapshot, sessionId);
  if (sessionId) storeTerminalAttachment(currentRunId, sessionId, currentRunProjectId);
  if (sessionId === selectedInspectTerminalSessionId) renderRuntimeInspect();
  return true;
}

function appendTerminalSnapshotToSession(snapshot, fallbackSessionId) {
  const sessionId = snapshot?.terminalSessionId || snapshot?.sessionId || fallbackSessionId;
  if (!sessionId || !snapshot?.snapshot) return;
  const bucket = terminalSessionBucket(sessionId);
  if (bucket.length > 0) return;
  appendTerminalEntryToSession({
    terminalSessionId: sessionId,
    activationId: snapshot.activationId,
    nodeId: snapshot.nodeId,
    backend: snapshot.backend ?? "unknown",
    stream: "stdout",
    label: "snapshot",
    chunk: String(snapshot.snapshot ?? ""),
    timestamp: Date.now(),
  });
}

async function attachTauriTerminalSession(sessionId) {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    return normalizeTerminalSessionPayload(
      await invoke("terminal_attach_session", { sessionId })
    );
  } catch {
    return null;
  }
}

function tauriInvoke() {
  const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

function registerTauriTerminalEvents() {
  if (tauriTerminalEventsRegistered) return true;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return false;
  tauriTerminalEventsRegistered = true;

  bindTauriTerminalEvent(listen, "terminal://session-started", (payload) => {
    handleTerminalStarted(payload, "tauri");
  });
  bindTauriTerminalEvent(listen, "terminal://output", (payload) => {
    handleTerminalOutput(payload, "tauri");
  });
  bindTauriTerminalEvent(listen, "terminal://ended", (payload) => {
    handleTerminalEnded(payload, "tauri");
  });
  bindTauriTerminalEvent(listen, "terminal://resized", (payload) => {
    if (payload?.terminalSessionId === selectedInspectTerminalSessionId) scheduleInspectTerminalResize(payload.terminalSessionId);
  });
  bindTauriTerminalEvent(listen, "terminal://status", (payload) => {
    if (payload?.terminalSessionId) terminalTransportBySession.set(payload.terminalSessionId, "tauri");
  });
  return true;
}

function bindTauriTerminalEvent(listen, eventName, handler) {
  try {
    const result = listen(eventName, (event) => {
      handler(normalizeTerminalSessionPayload(event?.payload ?? event));
    });
    result?.catch?.(() => {});
  } catch {
    // Native terminal events are optional in browser/dev mode.
  }
}

function normalizeTerminalSessionPayload(data) {
  if (!data || typeof data !== "object") return data;
  const sessionId = data.terminalSessionId ?? data.sessionId;
  if (!sessionId) return data;
  return {
    ...data,
    sessionId,
    terminalSessionId: sessionId,
  };
}

function handleTerminalStarted(data, transport = "server") {
  const payload = normalizeTerminalSessionPayload(data);
  if (payload?.terminalSessionId) {
    terminalSessionBucket(payload.terminalSessionId);
    terminalTransportBySession.set(payload.terminalSessionId, transport);
    if (payload.terminalSessionId === selectedInspectTerminalSessionId) {
      activeTerminalSessionId = payload.terminalSessionId;
      activeTerminalTransport = transport;
    }
    const runId = payload.runId ?? currentRunId;
    const projectId = terminalProjectId(payload.projectId);
    if (payload.projectId) currentRunProjectId = projectId;
    if (runId && payload.terminalSessionId === selectedInspectTerminalSessionId) {
      storeTerminalAttachment(runId, payload.terminalSessionId, projectId);
    }
  }
  if (payload?.terminalSessionId === selectedInspectTerminalSessionId) {
    if (inspectTerminalRoot(payload.terminalSessionId)) {
      mountInspectTerminal(payload.terminalSessionId);
    } else {
      renderRuntimeInspect();
    }
  }
}

async function handleTerminalOutput(data, transport = "server") {
  const payload = normalizeTerminalSessionPayload(data);
  if (payload?.terminalSessionId) {
    terminalTransportBySession.set(payload.terminalSessionId, transport);
  }
  appendTerminalEntryToSession(payload);
  if (payload?.terminalSessionId === selectedInspectTerminalSessionId) {
    activeTerminalSessionId = payload.terminalSessionId;
    activeTerminalTransport = transport;
  }
}

function handleTerminalEnded(data, transport = "server") {
  const payload = normalizeTerminalSessionPayload(data);
  if (payload?.terminalSessionId) {
    terminalTransportBySession.set(payload.terminalSessionId, transport);
  }
  if (payload?.terminalSessionId && payload.terminalSessionId === selectedInspectTerminalSessionId) {
    activeTerminalTransport = transport;
    activeTerminalSessionId = payload.terminalSessionId;
    renderRuntimeInspect();
  }
}

function isMacPlatform() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function terminalSelectionText(sessionId = selectedInspectTerminalSessionId) {
  const targetSessionId = String(sessionId || "").trim();
  if (
    !targetSessionId ||
    !terminalUsesXterm ||
    terminalMountedSessionId !== targetSessionId ||
    !xtermTerminal?.getSelection
  ) {
    return "";
  }
  return xtermTerminal.getSelection() || "";
}

async function copyTerminalSelection(sessionId = selectedInspectTerminalSessionId) {
  const selection = terminalSelectionText(sessionId);
  return selection ? writeClipboardText(selection) : false;
}

function canReadClipboardText() {
  return typeof navigator.clipboard?.readText === "function";
}

async function pasteClipboardToTerminal(sessionId = selectedInspectTerminalSessionId) {
  if (!canReadClipboardText()) return false;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return false;
    await sendTerminalInputToSession(text, sessionId);
    return true;
  } catch (err) {
    console.warn("Failed to read clipboard text for terminal paste.", err);
    return false;
  }
}

function requestTerminalPaste(sessionId) {
  pasteClipboardToTerminal(sessionId);
  return false;
}

function handleTerminalKeyEvent(event, sessionId) {
  const key = String(event.key || "").toLowerCase();
  const mac = isMacPlatform();
  const ctrl = event.ctrlKey && !event.altKey;
  const command = mac && event.metaKey && !event.ctrlKey && !event.altKey;

  if (key === "c" && ctrl && event.shiftKey) {
    copyTerminalSelection(sessionId);
    return false;
  }
  if (key === "v" && ctrl && event.shiftKey) {
    return requestTerminalPaste(sessionId);
  }
  if (key === "c" && command) {
    copyTerminalSelection(sessionId);
    return false;
  }
  if (key === "v" && command) {
    return requestTerminalPaste(sessionId);
  }
  if (key === "c" && ctrl && !event.shiftKey && !event.metaKey) {
    if (terminalSelectionText(sessionId)) {
      copyTerminalSelection(sessionId);
    } else {
      sendTerminalInputToSession("\x03", sessionId);
    }
    return false;
  }
  if (!mac && key === "v" && ctrl && !event.shiftKey && !event.metaKey) {
    return requestTerminalPaste(sessionId);
  }
  return true;
}

async function handleTerminalInput(input) {
  return sendTerminalInputToSession(input, selectedInspectTerminalSessionId);
}

async function sendTerminalInputToSession(input, sessionId) {
  if (!sessionId) return;
  if (input === "\x03") {
    await postTerminalAction("interrupt", undefined, sessionId);
    return;
  }
  await postTerminalAction("input", { input }, sessionId);
}

function sendTerminalActionToSession(action, sessionId, body) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return Promise.resolve(false);
  return postTerminalAction(action, body, targetSessionId);
}

async function postTerminalAction(action, body, sessionId) {
  const targetRunId = currentRunId ?? lastRunResult?.runId;
  const targetSessionId = String(sessionId || "").trim();
  if (!targetRunId || !targetSessionId) return false;
  const transport = terminalTransportBySession.get(targetSessionId) ?? "server";
  if (transport !== "tauri") return false;
  return postTauriTerminalAction(action, body, targetSessionId);
}

async function postTauriTerminalAction(action, body, sessionId) {
  const invoke = tauriInvoke();
  if (!invoke) return false;
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return false;
  try {
    if (action === "input") {
      await invoke("terminal_write", {
        sessionId: targetSessionId,
        data: String(body?.input ?? ""),
      });
      return true;
    }
    if (action === "resize") {
      await invoke("terminal_resize", {
        sessionId: targetSessionId,
        cols: body?.cols,
        rows: body?.rows,
      });
      return true;
    }
    if (action === "interrupt") {
      await invoke("terminal_interrupt", {
        sessionId: targetSessionId,
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function scheduleTerminalFit() {
  if (!xtermTerminal && !terminalReadyPromise) return;
  const raf = window.requestAnimationFrame;
  if (typeof raf !== "function") {
    fitTerminalToDock();
    return;
  }
  if (terminalResizeFrame !== null) return;
  terminalResizeFrame = raf(() => {
    terminalResizeFrame = null;
    fitTerminalToDock();
  });
}

async function fitTerminalToDock() {
  const terminal = await initializeTerminal();
  if (!terminal || !terminalFitAddon) return;
  try {
    terminalFitAddon.fit();
  } catch {
    return;
  }
  const cols = Number(terminal.cols);
  const rows = Number(terminal.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
  if (selectedInspectTerminalSessionId) {
    await postTerminalAction("resize", { cols, rows }, selectedInspectTerminalSessionId);
  }
}

function scheduleInspectTerminalResize(sessionId = selectedInspectTerminalSessionId) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId || targetSessionId !== selectedInspectTerminalSessionId) return;
  const raf = window.requestAnimationFrame;
  if (typeof raf !== "function") {
    resizeInspectTerminalToSession(targetSessionId);
    return;
  }
  if (inspectTerminalResizeFrame !== null) return;
  inspectTerminalResizeFrame = raf(() => {
    inspectTerminalResizeFrame = null;
    resizeInspectTerminalToSession(targetSessionId);
  });
}

function resizeInspectTerminalToSession(sessionId) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return;
  if (targetSessionId !== selectedInspectTerminalSessionId) return;
  fitTerminalToDock();
}

function clearXtermTerminal() {
  xtermTerminal?.clear?.();
  const fallback = inspectTerminalFallbackElement();
  if (fallback) fallback.textContent = "";
}

function resetXtermTerminal() {
  try {
    xtermTerminal?.dispose?.();
  } catch {
    // Terminal disposal is best-effort during UI rerender.
  }
  xtermTerminal = null;
  terminalFitAddon = null;
  terminalReadyPromise = null;
  terminalMountedSessionId = null;
  terminalUsesXterm = false;
}

function trimTerminalEntries(sessionId) {
  const bucket = terminalEntriesBySession.get(sessionId);
  if (!bucket) return;
  const overflow = bucket.length - TERMINAL_MAX_ENTRIES;
  if (overflow <= 0) return;
  bucket.splice(0, overflow);
  const clearedAt = terminalViewClearedAtBySession.get(sessionId) ?? 0;
  terminalViewClearedAtBySession.set(sessionId, Math.max(0, clearedAt - overflow));
}

function renderTerminal() {
  renderTerminalEntries();
}

function renderTerminalEntries() {
  const target = terminalFallbackContainer();
  if (!target) return;
  if (target.matches?.("[data-inspect-terminal-fallback]")) {
    const sessionId = selectedInspectTerminalSessionId;
    if (!sessionId) return;
    if (xtermTerminal && terminalMountedSessionId === sessionId) {
      setTerminalFallbackVisible(false);
      return;
    }
    renderInspectTerminalFallbackText(sessionId, terminalTranscriptForSession(sessionId));
    return;
  }
  const visibleEntries = visibleTerminalEntries();
  setTerminalFallbackVisible(!terminalUsesXterm || visibleEntries.length > 0 && Boolean(domTerminalFallbackLines) && !xtermTerminal);
  if (visibleEntries.length === 0) {
    target.innerHTML = '<div class="empty-state">等待 active agent 输出...</div>';
    return;
  }

  target.innerHTML = `<div class="terminal-lines">${visibleEntries.map(renderTerminalLine).join("")}</div>`;
  if (domTerminalFollow?.checked !== false) {
    target.scrollTop = target.scrollHeight;
  }
}

function visibleTerminalEntries() {
  const search = String(domTerminalSearch?.value || "").trim().toLowerCase();
  const nodeFilter = String(domTerminalNodeFilter?.value || "").trim();
  return allTerminalEntries().filter((entry, index) => {
    const clearedAt = terminalViewClearedAtBySession.get(entry.terminalSessionId) ?? 0;
    const bucket = terminalEntriesBySession.get(entry.terminalSessionId) ?? [];
    if (bucket.indexOf(entry) < clearedAt) return false;
    if (nodeFilter && entry.nodeId !== nodeFilter) return false;
    if (!search) return true;
    return terminalEntryPlainText(entry).toLowerCase().includes(search);
  });
}

function renderTerminalLine(entry) {
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "--";
  const label = entry.label || entry.stream;
  const streamClass = entry.stream === "stderr"
    ? label === "diagnostics" ? " terminal-diagnostics" : " terminal-stderr"
    : "";
  return `<div class="terminal-line${streamClass}" data-node-id="${escapeAttr(entry.nodeId)}" data-stream="${escapeAttr(entry.stream)}">
    <span class="terminal-line-time">${escapeHtml(time)}</span>
    <span class="terminal-line-node">${escapeHtml(entry.nodeId)}</span>
    <span class="terminal-line-backend">${escapeHtml(entry.backend)}</span>
    <span class="terminal-line-stream">${escapeHtml(label)}</span>
    <span class="terminal-line-text">${ansiToHtml(entry.chunk)}</span>
  </div>`;
}

function ansiToHtml(text) {
  const source = String(text ?? "");
  const ansiPattern = /\u001b\[([0-9;]*)m/g;
  let html = "";
  let lastIndex = 0;
  let activeColor = null;
  let match;

  while ((match = ansiPattern.exec(source)) !== null) {
    html += escapeHtml(source.slice(lastIndex, match.index));
    const color = ansiColorClass(match[1]);
    if (color === null) {
      if (activeColor) {
        html += "</span>";
        activeColor = null;
      }
    } else if (color) {
      if (activeColor) html += "</span>";
      html += `<span class="${color}">`;
      activeColor = color;
    }
    lastIndex = ansiPattern.lastIndex;
  }

  html += escapeHtml(source.slice(lastIndex));
  if (activeColor) html += "</span>";
  return html;
}

function ansiColorClass(codeText) {
  const codes = String(codeText || "0").split(";").map((item) => Number(item));
  if (codes.includes(0) || codes.includes(39)) return null;
  if (codes.includes(31) || codes.includes(91)) return "ansi-red";
  if (codes.includes(32) || codes.includes(92)) return "ansi-green";
  if (codes.includes(33) || codes.includes(93)) return "ansi-amber";
  if (codes.includes(34) || codes.includes(94)) return "ansi-blue";
  if (codes.includes(36) || codes.includes(96)) return "ansi-cyan";
  if (codes.includes(37) || codes.includes(97)) return "ansi-white";
  if (codes.includes(2) || codes.includes(90)) return "ansi-dim";
  return "";
}

function terminalEntryPlainText(entry) {
  return `${entry.nodeId} ${entry.backend} ${entry.label || entry.stream} ${entry.chunk}`;
}

function defaultTerminalLabel(backend, stream) {
  return stream === "stderr" && isAgentBackend(backend) ? "diagnostics" : stream;
}

function visibleTerminalText(sessionId = null) {
  if (sessionId) {
    const bucket = terminalEntriesBySession.get(sessionId) ?? [];
    const clearedAt = terminalViewClearedAtBySession.get(sessionId) ?? 0;
    return bucket
      .slice(clearedAt)
      .map((entry) => stripAnsi(entry.chunk))
      .join("");
  }
  return visibleTerminalEntries().map((entry) => stripAnsi(entry.chunk)).join("");
}

async function writeClipboardText(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "true");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.top = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand?.("copy") === true;
  } finally {
    field.remove();
  }
}

async function copyVisibleTerminalOutput(sessionId = selectedInspectTerminalSessionId) {
  const selection = terminalSelectionText(sessionId);
  if (selection) {
    await writeClipboardText(selection);
    return;
  }
  await writeClipboardText(visibleTerminalText(sessionId));
}

function clearTerminalView() {
  const sessionId = selectedInspectTerminalSessionId;
  if (sessionId) {
    terminalViewClearedAtBySession.set(
      sessionId,
      terminalEntriesBySession.get(sessionId)?.length ?? 0
    );
  } else {
    for (const [key, bucket] of terminalEntriesBySession) {
      terminalViewClearedAtBySession.set(key, bucket.length);
    }
  }
  clearXtermTerminal();
  renderTerminalEntries();
  renderRuntimeInspect();
}

function updateTerminalNodeFilterOptions() {
  if (!domTerminalNodeFilter) return;
  const currentValue = domTerminalNodeFilter.value || "";
  const nodeIds = [...new Set([
    ...allTerminalEntries().map((entry) => entry.nodeId),
    ...activations.map((activation) => activation.nodeId).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b));

  domTerminalNodeFilter.innerHTML = [
    '<option value="">All nodes</option>',
    ...nodeIds.map((nodeId) => `<option value="${escapeAttr(nodeId)}">${escapeHtml(nodeId)}</option>`),
  ].join("");
  domTerminalNodeFilter.value = nodeIds.includes(currentValue) ? currentValue : "";
}

function backfillTerminalEntriesFromActivation(activation) {
  if (!activation?.activationId || !activation.rawResult) return;
  const backend = backendForActivation(activation) || activation.rawResult.backend;
  const timestamp = activation.finishedAt ?? activation.rawResult.finishedAt ?? Date.now();
  if (activation.rawResult.terminalTranscript) {
    appendTerminalEntryIfMissing(activation, backend, "stdout", activation.rawResult.terminalTranscript, timestamp, "transcript");
    return;
  }
  appendTerminalEntryIfMissing(activation, backend, "stdout", activation.rawResult.stdout, timestamp);
  appendTerminalEntryIfMissing(activation, backend, "stderr", activation.rawResult.stderr, timestamp);
}

function syncTerminalEntryLabelsForActivation(activation) {
  if (!activation?.activationId) return;
  const stderrLabel = stderrPresentationForActivation(activation).label;
  let changed = false;
  for (const entry of allTerminalEntries()) {
    if (entry.activationId !== activation.activationId || entry.stream !== "stderr") continue;
    if (entry.label === stderrLabel) continue;
    entry.label = stderrLabel;
    changed = true;
  }
  if (changed) {
    scheduleTerminalRender();
    if (terminalSessionIdForActivation(activation) === selectedInspectTerminalSessionId) {
      scheduleActivationRender();
    }
  }
}

function appendTerminalEntryIfMissing(activation, backend, stream, chunk, timestamp, label = null) {
  if (!chunk) return;
  const sessionId = terminalSessionIdForActivation(activation);
  if (!sessionId) return;
  const bucket = terminalEntriesBySession.get(sessionId) ?? [];
  const exists = bucket.some((entry) =>
    entry.activationId === activation.activationId && entry.stream === stream
  );
  if (exists) return;
  appendTerminalEntry({
    terminalSessionId: sessionId,
    activationId: activation.activationId,
    nodeId: activation.nodeId ?? activation.rawResult?.nodeId,
    backend,
    stream,
    label: label ?? (stream === "stderr" ? stderrPresentationForActivation(activation).label : stream),
    chunk,
    timestamp,
  });
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

function renderInspectorNode(nodeInfo, activation = null) {
  if (!nodeInfo) {
    domInspector.innerHTML = '<div class="empty-state">选择一个节点</div>';
    return;
  }

  renderEditableInspectorNode(nodeInfo);
}

function renderEditableInspectorNode(nodeInfo) {
  if (!nodeInfo) {
    domInspector.innerHTML = '<div class="empty-state">选择一个节点</div>';
    return;
  }

  const latest = [...activations].reverse().find((item) => item.nodeId === nodeInfo.id);
  const isController = nodeInfo.type === "controller" || nodeInfo.kind === "controller";
  const definitionNode = editableGraphNode(nodeInfo.id);
  const editable = Boolean(definitionNode);
  const nodeConfig = definitionNode ?? nodeInfo.realNode ?? nodeInfo;
  const execution = nodeConfig.execution ?? {};
  const backendLabel = nodeDefinitionBackend(nodeConfig) || nodeInfo.backend || nodeInfo.badge || nodeInfo.kind || "-";
  const modelLabel = nodeDefinitionModel(nodeConfig) || nodeInfo.model || "-";
  const nodeType = nodeInfo.type ?? nodeInfo.kind;
  const description = nodeConfig.description ?? nodeInfo.description ?? "";
  const prompt = nodeConfig.promptTemplate ?? nodeInfo.promptTemplate ?? "";
  const commandDraft = invalidCommandDrafts.get(nodeInfo.id);
  const commandValue = commandDraft ?? (nodeConfig.command === undefined ? "" : JSON.stringify(nodeConfig.command, null, 2));
  const disabled = editable ? "" : " disabled";
  const commandDisabled = isController || !editable ? " disabled" : "";
  const saveDisabled = currentProject?.id && currentGraphAsset?.relativePath && currentGraphDefinition ? "" : " disabled";
  const outputs = isController
    ? nodeInfo.outputs.map(([id, label, color]) =>
        `<div class="output-item"><span class="port-dot ${color}"></span><strong>${escapeHtml(id)}</strong><span>${escapeHtml(label)}</span></div>`
      ).join("")
    : "";
  const guards = isController
    ? nodeInfo.outputs.map(([id, label]) =>
        `<div class="guard-item"><span class="guard-check">✓</span><span><strong>${escapeHtml(id)}</strong>: ${escapeHtml(label)}</span></div>`
      ).join("")
    : "";

  domInspector.innerHTML = `<div class="inspector-kicker">
      <span class="node-badge badge-${isController ? "controller" : badgeClass(nodeInfo.badge || "internal")}">${escapeHtml(isController ? "Controller" : (nodeInfo.badge || nodeInfo.kind))}</span>
      <span>已选择节点</span>
    </div>
    <div class="inspector-title">${escapeHtml(nodeInfo.title)}</div>
    <div class="inspector-subtitle">ID: ${escapeHtml(nodeInfo.id)}</div>

    <form class="inspector-form" data-node-id="${escapeAttr(nodeInfo.id)}">
      <div class="inspector-tabs" role="tablist" aria-label="节点属性页签">
        <button class="inspector-tab active" data-inspector-tab="config" type="button" role="tab" aria-selected="true">属性</button>
        <button class="inspector-tab" data-inspector-tab="prompt" type="button" role="tab" aria-selected="false">Prompt</button>
      </div>

      <section class="inspector-tab-panel active" data-inspector-panel="config" role="tabpanel">
        <div class="property-group">
          <h3>基础属性</h3>
          <div class="property-row"><span>后端</span><span class="property-value">${escapeHtml(backendLabel)}</span></div>
          <div class="property-row"><span>模型</span><span class="property-value">${escapeHtml(modelLabel)}</span></div>
          <div class="property-row"><span>节点类型</span><span class="property-value">${escapeHtml(nodeType)}</span></div>
          <div class="property-row"><span>最近状态</span><span class="property-value">${escapeHtml(latest?.status ?? "not-run")}</span></div>
        </div>

        ${isController ? `<div class="property-group">
          <h3>输出路由</h3>
          <div class="output-list">${outputs}</div>
        </div>` : ""}

        <div class="property-group">
          <h3>节点配置</h3>
          <div class="inspector-config-grid">
            <label class="inspector-field">
              <span>Backend</span>
              <input id="inspector-backend" type="text" value="${escapeAttr(nodeConfig.backend ?? "")}"${isController ? " disabled" : disabled}>
            </label>
            <label class="inspector-field">
              <span>Model</span>
              <input id="inspector-model" type="text" value="${escapeAttr(execution.model ?? nodeConfig.model ?? "")}"${disabled}>
            </label>
            <label class="inspector-field">
              <span>Reasoning</span>
              <input id="inspector-reasoning-effort" type="text" value="${escapeAttr(execution.reasoningEffort ?? "")}"${disabled}>
            </label>
            <label class="inspector-field">
              <span>Timeout ms</span>
              <input id="inspector-timeout-ms" type="number" min="0" step="1000" value="${escapeAttr(execution.timeoutMs ?? "")}"${disabled}>
            </label>
            <label class="inspector-field span-2">
              <span>简略描述</span>
              <input id="inspector-description" type="text" value="${escapeAttr(description)}" placeholder="显示在画布节点上的简短说明"${disabled}>
            </label>
            <label class="inspector-field span-2">
              <span>Command JSON</span>
              <textarea id="inspector-command" rows="6"${commandDisabled}>${escapeHtml(commandValue)}</textarea>
            </label>
          </div>
        </div>

        ${isController ? `<div class="property-group">
          <h3>输出守卫</h3>
          <div class="guard-list">${guards}</div>
        </div>` : ""}

        ${lastRunResult ? `<div class="property-group">
          <h3>运行概览</h3>
          <div class="property-row"><span>Run ID</span><span class="property-value">${escapeHtml(String(lastRunResult.runId).slice(0, 12))}</span></div>
          <div class="property-row"><span>状态</span><span class="property-value">${escapeHtml(lastRunResult.status)}</span></div>
        </div>` : ""}
      </section>

      <section class="inspector-tab-panel" data-inspector-panel="prompt" role="tabpanel">
        <div class="property-group prompt-template-group">
          <h3>Prompt template</h3>
          <label class="inspector-field prompt-editor-field">
            <span>Prompt template</span>
            <textarea id="inspector-prompt-template" rows="24"${disabled}>${escapeHtml(prompt)}</textarea>
          </label>
        </div>
      </section>

      <div class="inspector-actions">
        <button id="btn-save-graph" type="button"${saveDisabled}>Save</button>
        <span id="inspector-save-message" role="status"></span>
      </div>
    </form>`;

  bindEditableInspector(nodeInfo.id);
}

function bindEditableInspector(nodeId) {
  const node = editableGraphNode(nodeId);
  const form = domInspector.querySelector(".inspector-form");
  if (!form) return;
  bindInspectorTabs(form);
  if (!node) return;

  const bind = (selector, applyValue) => {
    const field = form.querySelector(selector);
    field?.addEventListener("input", () => {
      applyValue(field.value);
      markGraphDirty();
    });
  };

  bind("#inspector-backend", (value) => {
    if (node.type === "controller") return;
    setOptionalString(node, "backend", value);
  });
  bind("#inspector-model", (value) => {
    if (node.type === "controller") {
      setOptionalString(node, "model", value);
      return;
    }
    setExecutionValue(node, "model", value.trim() ? value : undefined);
  });
  bind("#inspector-reasoning-effort", (value) => {
    setExecutionValue(node, "reasoningEffort", value.trim() ? value : undefined);
  });
  bind("#inspector-timeout-ms", (value) => {
    const parsed = Number(value);
    setExecutionValue(node, "timeoutMs", value.trim() && Number.isFinite(parsed) ? parsed : undefined);
  });
  bind("#inspector-description", (value) => {
    setOptionalString(node, "description", value);
  });
  bind("#inspector-prompt-template", (value) => {
    setOptionalString(node, "promptTemplate", value);
  });

  const command = form.querySelector("#inspector-command");
  command?.addEventListener("input", () => {
    applyCommandEditorValue(node, command);
    markGraphDirty();
  });

  form.querySelector("#btn-save-graph")?.addEventListener("click", saveGraphAsset);
}

function bindInspectorTabs(form) {
  const tabs = [...form.querySelectorAll(".inspector-tab")];
  const panels = [...form.querySelectorAll(".inspector-tab-panel")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.inspectorTab;
      tabs.forEach((item) => {
        const active = item === tab;
        if (active) item.classList.add("active");
        else item.classList.remove("active");
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach((panel) => {
        if (panel.dataset.inspectorPanel === target) panel.classList.add("active");
        else panel.classList.remove("active");
      });
    });
  });
}

function editableGraphNode(nodeId) {
  return currentGraphDefinition?.nodes?.find((item) => item.id === nodeId) ?? null;
}

function setOptionalString(target, key, value) {
  const next = String(value ?? "");
  if (next.trim()) {
    target[key] = next;
  } else {
    delete target[key];
  }
}

function setExecutionValue(node, key, value) {
  if (value === undefined || value === "") {
    if (node.execution) {
      delete node.execution[key];
      if (Object.keys(node.execution).length === 0) delete node.execution;
    }
    return;
  }

  node.execution = {
    ...(node.execution ?? {}),
    [key]: value,
  };
}

function applyCommandEditorValue(node, commandField) {
  const raw = commandField.value.trim();
  const message = domInspector.querySelector("#inspector-save-message");
  commandField.dataset.invalid = "";
  if (!raw) {
    delete node.command;
    invalidCommandDrafts.delete(node.id);
    setInspectorSaveMessage("");
    return true;
  }

  try {
    node.command = JSON.parse(raw);
    invalidCommandDrafts.delete(node.id);
    setInspectorSaveMessage("");
    return true;
  } catch (err) {
    invalidCommandDrafts.set(node.id, commandField.value);
    commandField.dataset.invalid = "true";
    if (message) {
      message.textContent = err instanceof Error ? `Invalid command JSON: ${err.message}` : "Invalid command JSON";
      message.className = "error";
    }
    return false;
  }
}

function hasInvalidCommandJson() {
  return invalidCommandDrafts.size > 0 || domInspector.querySelector("#inspector-command[data-invalid='true']") !== null;
}

function invalidCommandJsonMessage() {
  const nodeIds = [...invalidCommandDrafts.keys()].filter(Boolean);
  return nodeIds.length > 0
    ? `Invalid command JSON in node ${nodeIds.join(", ")}`
    : "Invalid command JSON";
}

function markGraphDirty() {
  graphDirty = true;
  renderOpenGraphState();
  renderGraphCanvas();
}

async function saveGraphAsset() {
  if (!currentProject?.id || !currentGraphAsset?.relativePath || !currentGraphDefinition) return;

  const saveButton = domInspector.querySelector("#btn-save-graph");
  if (saveButton?.disabled) return;
  if (hasInvalidCommandJson()) {
    setInspectorSaveMessage(`${invalidCommandJsonMessage()}. Fix before saving.`, "error");
    graphDirty = true;
    renderOpenGraphState();
    return;
  }

  const saveProjectId = currentProject.id;
  const saveAssetPath = currentGraphAsset.relativePath;
  const saveGraphDefinition = currentGraphDefinition;
  saveButton.disabled = true;
  setInspectorSaveMessage("Saving...");
  try {
    const encodedPath = encodeURIComponent(saveAssetPath);
    const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(saveProjectId)}/graph-assets/${encodedPath}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph: saveGraphDefinition }),
    });
    const detail = await resp.json();
    if (!resp.ok) throw new Error(detail.error || "Graph asset save failed");
    if (
      currentProject?.id !== saveProjectId ||
      currentGraphAsset?.relativePath !== saveAssetPath ||
      currentGraphDefinition !== saveGraphDefinition
    ) {
      setInspectorSaveMessage("Save finished for a graph that is no longer open.");
      return;
    }
    currentGraphAsset = detail.asset ?? detail;
    if (detail.graph) currentGraphDefinition = detail.graph;
    graphDirty = false;
    renderOpenGraphState();
    renderGraphAssets();
    renderGraphCanvas();
    renderEditableInspectorNode(findGraphNode(selectedGraphNodeId));
    setInspectorSaveMessage("Saved");
  } catch (err) {
    if (
      currentProject?.id !== saveProjectId ||
      currentGraphAsset?.relativePath !== saveAssetPath ||
      currentGraphDefinition !== saveGraphDefinition
    ) {
      setInspectorSaveMessage("Save failed for a graph that is no longer open.", "error");
      return;
    }
    graphDirty = true;
    renderOpenGraphState();
    setInspectorSaveMessage(err instanceof Error ? err.message : "Save failed", "error");
    if (saveButton) saveButton.disabled = false;
  }
}

function setInspectorSaveMessage(message, className = "") {
  const target = domInspector.querySelector("#inspector-save-message");
  if (!target) return;
  target.textContent = message;
  target.className = className;
}

// ─── Diff rendering ────────────────────────────────────────────────
function renderDiff(workspace) {
  if (!workspace) {
    domDiff.innerHTML = '<div class="empty-state">暂无 workspace 信息</div>';
    return;
  }

  let html = `<div class="detail-section">
    <h4>Workspace</h4>
    <div>Mode: ${escapeHtml(workspace.mode)} | Path: ${escapeHtml(workspace.path)}</div>
  </div>`;

  if (workspace.changedFiles && workspace.changedFiles.length > 0) {
    html += '<div class="diff-files">';
    for (const f of workspace.changedFiles) {
      html += `<span class="diff-file">${escapeHtml(f)}</span>`;
    }
    html += "</div>";
  } else {
    html += '<div class="empty-state">No files changed</div>';
  }

  if (workspace.diff) {
    html += `<div class="detail-section"><h4>Diff</h4><div class="diff-view">${colorizeDiff(workspace.diff)}</div></div>`;
  }

  domDiff.innerHTML = html;
}

// ─── Helpers ───────────────────────────────────────────────────────
function basename(path) {
  return String(path || "").replace(/\\/g, "/").split("/").pop() || "";
}

function apiUrl(path) {
  const hostname = window.location.hostname;
  const isLocalHttpPage =
    (window.location.protocol === "http:" || window.location.protocol === "https:") &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
  // Tauri static assets can be served from tauri.localhost, so API calls still target the local server.
  if (isLocalHttpPage) {
    return path;
  }
  return `${API_ORIGIN}${path}`;
}

function patchDownloadPath(result) {
  const params = new URLSearchParams();
  if (result.projectId) {
    params.set("projectId", result.projectId);
  }
  const query = params.toString();
  return `/api/runs/${result.runId}/patch${query ? `?${query}` : ""}`;
}

function filenameToFlowName(name) {
  return basename(name).replace(/\.(yaml|yml|graph)$/i, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function colorizeDiff(diff) {
  return escapeHtml(diff)
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return `<span class="diff-add">${line}</span>`;
      if (line.startsWith("-")) return `<span class="diff-del">${line}</span>`;
      if (line.startsWith("@@") || line.startsWith("diff") || line.startsWith("---") || line.startsWith("+++")) {
        return `<span class="diff-hdr">${line}</span>`;
      }
      return line;
    })
    .join("\n");
}

function graphDefinitionForTestPath(graphPath) {
  if (!String(graphPath).includes("project-task-loop")) return currentGraphDefinition;
  return {
    id: "project_remaining_tasks_loop",
    nodes: [
      { id: "implement_feature", type: "execute", backend: "codex" },
      { id: "review_code_quality", type: "execute", backend: "codex" },
      { id: "review_functionality", type: "execute", backend: "codex" },
      { id: "review_gate", type: "controller", model: "DeepSeek" },
      { id: "end_success", type: "end", backend: "internal" },
    ],
    edges: [
      { from: "graph.start", to: "implement_feature.inputs.trigger" },
      { from: "implement_feature.outputs.done", to: "review_code_quality.inputs.trigger" },
      { from: "implement_feature.outputs.done", to: "review_functionality.inputs.trigger" },
      { from: "review_code_quality.outputs.done", to: "review_gate.inputs.trigger" },
      { from: "review_functionality.outputs.done", to: "review_gate.inputs.trigger" },
      { from: "review_gate.outputs.end_success", to: "end_success.inputs.trigger" },
    ],
  };
}

// ─── Boot ──────────────────────────────────────────────────────────
if (window.AGENTGRAPH_ENABLE_TEST_HOOKS === true) {
  window.__AGENTGRAPH_UI_TEST_HOOKS__ = {
    loadGraphDefinitionForTest: loadGraphDefinition,
    layoutGraphDefinitionForTest: layoutGraphDefinition,
    getCurrentGraphDefinitionForTest: () => currentGraphDefinition,
    getCurrentGraphAssetForTest: () => currentGraphAsset,
    isGraphDirtyForTest: () => graphDirty,
    getActiveGraphNodeIdForTest: () => activeGraphNodeId,
    setGraphValueForTest: (graphPath) => {
      currentGraphAsset = { relativePath: graphPath, name: basename(graphPath) };
      currentGraphDefinition = graphDefinitionForTestPath(graphPath);
      graphDirty = false;
      invalidCommandDrafts.clear();
      selectedGraphNodeId = defaultSelectedNodeId();
      selectedNodeIdx = -1;
      renderRuntimeInspect();
    },
    selectGraphNodeForTest: (nodeId) => {
      selectedGraphNodeId = nodeId;
      selectedNodeIdx = latestActivationIndexForNode(selectedGraphNodeId);
      renderGraphCanvas();
      renderInspectorNode(findGraphNode(selectedGraphNodeId));
      renderRuntimeInspect();
    },
    openProjectForTest: openProject,
    createGraphAssetFromFormForTest: createGraphAssetFromForm,
    loadGraphAssetsForTest: loadGraphAssets,
    openGraphAssetForTest: openGraphAsset,
    loadWorkspaceTargetsForTest: loadWorkspaceTargets,
    selectWorkspaceTargetForTest: (workspaceId) => {
      selectedWorkspaceTarget = workspaceTargets.find((item) => item.id === workspaceId) ?? null;
      renderWorkspaceBar();
    },
    startRunForTest: startRun,
    runCompletedForTest: onRunCompleted,
    nodeStartedForTest: handleNodeStarted,
    nodeCompletedForTest: handleNodeCompleted,
    selectActivationForTest: (activationId) => {
      return selectActivationAtIndex(activations.findIndex((item) => item.activationId === activationId));
    },
    createManualWorktreeForTest: createManualWorktree,
    loadReadinessForTest: loadReadiness,
    appendActivationOutputForTest: appendActivationOutput,
    appendTerminalEntryForTest: appendTerminalEntry,
    setTerminalModuleLoaderForTest: (loader) => {
      terminalModuleLoader = loader;
      terminalReadyPromise = null;
    },
    initializeTerminalForTest: initializeTerminal,
    handleTerminalStartedForTest: handleTerminalStarted,
    handleTerminalOutputForTest: handleTerminalOutput,
    handleTerminalEndedForTest: handleTerminalEnded,
    attachTerminalSessionForTest: attachTerminalSession,
    restoreTerminalAttachmentForTest: restoreTerminalAttachment,
    registerTauriTerminalEventsForTest: registerTauriTerminalEvents,
    fitTerminalForTest: fitTerminalToDock,
    setCurrentRunIdForTest: (runId) => {
      currentRunId = runId;
    },
    setCurrentRunProjectIdForTest: (projectId) => {
      currentRunProjectId = projectId;
    },
    getTerminalEntriesForTest: () => allTerminalEntries(),
    getTerminalEntriesBySessionForTest: () => terminalEntriesBySession,
    renderInspectTerminalForTest: renderInspectTerminal,
    ansiToHtmlForTest: ansiToHtml,
    renderTerminalEntriesForTest: renderTerminalEntries,
    copyVisibleTerminalForTest: copyVisibleTerminalOutput,
    clearTerminalViewForTest: clearTerminalView,
    bindRuntimeDockResizeForTest: bindRuntimeDockResize,
  };
}

init();
