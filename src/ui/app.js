// ─── State ──────────────────────────────────────────────────────────
let currentRunId = null;
let eventSource = null;
let activations = [];
let selectedNodeIdx = -1;
let selectedGraphNodeId = "after_tests_controller";
let activeGraphNodeId = null;
let lastRunResult = null;
let activeTerminalActivationId = null;
let terminalRenderFrame = null;
let activationRenderFrame = null;
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
let graphDefinitionRequestId = 0;
let worktrees = [];
let worktreeRequestId = 0;
let worktreeCreateInFlight = false;
let readinessRequestId = 0;

const API_ORIGIN = "http://127.0.0.1:3456";

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
const domDiff = $("#diff-content");
const domTerminal = $("#terminal-content");
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
const domGraphAssets = $("#graph-assets");
const domGraphAssetFilter = $("#graph-asset-filter");
const domWorkspaceSwitcher = $("#workspace-switcher");
const domWorkspaceBranch = $("#workspace-branch");
const domWorkspaceDirty = $("#workspace-dirty");
const domRunStateText = $("#run-state-text");
const domWorktreeList = $("#worktree-list");
const domWorktreeName = $("#worktree-name-input");
const domCreateWorktree = $("#btn-create-worktree");
const domRefreshWorktrees = $("#btn-refresh-worktrees");
const domWorktreeMessage = $("#worktree-message");
const domReadiness = $("#readiness-panel");
const domRefreshReadiness = $("#btn-refresh-readiness");

function connect(from, to, color = "blue", fromOffset = null) {
  return { from, to, color, fromOffset };
}

// ─── Init ──────────────────────────────────────────────────────────
async function init() {
  renderGraphCanvas();
  renderInspectorNode(findGraphNode(selectedGraphNodeId));
  bindTabs();
  bindCanvasPan();
  bindMinimapDrag();

  domRun.addEventListener("click", startRun);
  domCancel.addEventListener("click", cancelRun);
  domOpenProject?.addEventListener("click", () => {
    const rootPath = window.prompt?.("Project path");
    if (rootPath?.trim()) openProject(rootPath.trim());
  });
  domGraphAssetFilter?.addEventListener("input", renderGraphAssets);
  domWorkspaceSwitcher?.addEventListener("change", () => {
    selectedWorkspaceTarget = workspaceTargets.find((item) => item.id === domWorkspaceSwitcher.value) ?? null;
    renderWorkspaceBar();
  });
  domCreateWorktree?.addEventListener("click", createManualWorktree);
  domRefreshWorktrees?.addEventListener("click", loadWorktrees);
  domRefreshReadiness?.addEventListener("click", loadReadiness);
  domWorktreeName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createManualWorktree();
  });
  window.addEventListener("resize", applyCanvasPan);
  renderProjectSummary();
  renderGraphAssets();
  renderWorkspaceBar();
  renderWorktrees();
  loadReadiness();
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
    currentProject = project;
    currentGraphAsset = null;
    pendingGraphAssetPath = null;
    currentGraphDefinition = null;
    graphDirty = false;
    renderProjectSummary();
    renderOpenGraphState();
    renderGraphCanvas();
    await Promise.all([loadGraphAssets(), loadWorkspaceTargets()]);
  } catch (err) {
    if (domProjectSummary) {
      domProjectSummary.innerHTML = `<strong>Open failed</strong><span>${escapeHtml(err instanceof Error ? err.message : "打开项目失败")}</span>`;
    }
  }
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
    selectedGraphNodeId = defaultSelectedNodeId();
    selectedNodeIdx = -1;
    canvasPan = { x: 0, y: 0 };
    renderOpenGraphState();
    renderGraphAssets();
    renderGraphCanvas();
    renderInspectorNode(findGraphNode(selectedGraphNodeId));
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

async function loadWorkspaceTargets() {
  if (!currentProject?.id) {
    workspaceTargets = [];
    selectedWorkspaceTarget = null;
    renderWorkspaceBar();
    return;
  }

  const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(currentProject.id)}/workspaces`), {
    cache: "no-store",
  });
  const items = await resp.json();
  if (!resp.ok) throw new Error(items.error || "Workspace request failed");
  workspaceTargets = Array.isArray(items) ? items : [];
  selectedWorkspaceTarget = workspaceTargets[0] ?? null;
  renderWorkspaceBar();
  worktrees = workspaceTargets;
  renderWorktrees();
}

async function loadWorktrees() {
  if (!domWorktreeList) return;
  if (!currentProject?.id) {
    worktrees = [];
    renderWorktrees();
    setWorktreeMessage("打开项目后可管理 workspaces");
    return;
  }

  const requestId = ++worktreeRequestId;
  try {
    const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(currentProject.id)}/workspaces`), { cache: "no-store" });
    if (!resp.ok) throw new Error(`Worktree list request failed: ${resp.status}`);
    const items = await resp.json();
    if (requestId !== worktreeRequestId) return;
    worktrees = Array.isArray(items) ? items : [];
    workspaceTargets = worktrees;
    selectedWorkspaceTarget = selectedWorkspaceTarget && workspaceTargets.some((item) => item.id === selectedWorkspaceTarget.id)
      ? workspaceTargets.find((item) => item.id === selectedWorkspaceTarget.id)
      : workspaceTargets[0] ?? null;
    renderWorktrees();
    renderWorkspaceBar();
    setWorktreeMessage("");
  } catch {
    if (requestId !== worktreeRequestId) return;
    worktrees = [];
    domWorktreeList.innerHTML = '<div class="empty-state compact">Worktree 列表加载失败</div>';
    setWorktreeMessage("无法读取 worktree 列表");
  }
}

async function createManualWorktree() {
  if (worktreeCreateInFlight) return;
  if (!currentProject?.id) {
    setWorktreeMessage("请先打开项目");
    return;
  }

  const name = domWorktreeName?.value?.trim() ?? "";
  if (!name) {
    setWorktreeMessage("请输入 worktree 名称");
    return;
  }

  worktreeCreateInFlight = true;
  if (domCreateWorktree) domCreateWorktree.disabled = true;
  setWorktreeMessage("正在创建...");

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
    setWorktreeMessage(`已创建 ${basename(result.path)}`);
    await loadWorktrees();
  } catch (err) {
    setWorktreeMessage(err instanceof Error ? err.message : "创建 worktree 失败");
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
    const resp = await fetch(apiUrl(`/api/readiness?path=${encodeURIComponent(graphPath)}`), {
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

function renderWorktrees() {
  if (!domWorktreeList) return;
  if (!currentProject) {
    domWorktreeList.innerHTML = '<div class="empty-state compact">打开项目后显示 workspaces</div>';
    if (domCreateWorktree) domCreateWorktree.disabled = true;
    if (domWorktreeName) domWorktreeName.disabled = true;
    return;
  }
  if (domCreateWorktree) domCreateWorktree.disabled = false;
  if (domWorktreeName) domWorktreeName.disabled = false;

  if (worktrees.length === 0) {
    domWorktreeList.innerHTML = '<div class="empty-state compact">暂无 workspace</div>';
    return;
  }

  domWorktreeList.innerHTML = worktrees
    .map((item) => {
      const branch = item.detached ? "detached" : item.branch || item.kind || "unknown";
      const current = item.current ? '<span class="worktree-pill">当前</span>' : "";
      return `<div class="worktree-row${item.current ? " current" : ""}">
        <div class="worktree-main">
          <span>${escapeHtml(item.label ?? basename(item.path))}</span>
          ${current}
        </div>
        <div class="worktree-meta">
          <span>${escapeHtml(branch)}</span>
          <span>${escapeHtml(String(item.head || "").slice(0, 8))}</span>
        </div>
      </div>`;
    })
    .join("");
}

function setWorktreeMessage(message) {
  if (domWorktreeMessage) domWorktreeMessage.textContent = message;
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
  }

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
      selectedNodeIdx = activations.findIndex((a) => a.nodeId === selectedGraphNodeId);
      renderGraphCanvas();
      renderTimeline();
      renderInspectorNode(findGraphNode(selectedGraphNodeId));
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
      if ((levels.get(to) ?? -1) < nextLevel) {
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
        badge: realNode?.execution?.model ?? realNode?.model ?? realNode?.backend ?? realNode?.type ?? "",
        description: realNode?.description ?? realNode?.prompt ?? realNode?.promptTemplate ?? "",
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
    <span class="node-description">${escapeHtml(item.description)}</span>
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
  const latest = [...activations].reverse().find((item) => item.nodeId === nodeId);
  return latest?.status;
}

function graphDefinitionNode(id) {
  return currentGraphDefinition?.nodes?.find((item) => item.id === id) ?? null;
}

function enrichCanvasNode(item) {
  if (!item) return null;
  const realNode = graphDefinitionNode(item.id);
  if (!realNode) return item;

  const model = realNode.execution?.model ?? realNode.model ?? null;
  const backend = realNode.backend ?? null;
  return {
    ...item,
    backend,
    command: realNode.command,
    execution: realNode.execution,
    model,
    promptTemplate: realNode.promptTemplate,
    realNode,
    type: realNode.type,
    badge: model ?? backend ?? item.badge,
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
  activations = [];
  activeGraphNodeId = null;
  activeTerminalActivationId = null;
  selectedNodeIdx = -1;
  lastRunResult = null;
  domTimeline.innerHTML = '<div class="empty-state">正在启动运行...</div>';
  domDetail.innerHTML = '<div class="empty-state">运行中，等待节点输出...</div>';
  domDiff.innerHTML = '<div class="empty-state">等待 diff...</div>';
  renderTerminal();
  domTimelineSummary.classList.add("hidden");
  domPatch.disabled = true;
  domRunChip.textContent = "运行中";
  domBarDuration.textContent = "";
  setStatus("running", "运行中");
  setRunning(true);
  renderGraphCanvas();

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
  if (selectedNodeIdx < 0 && activations.length > 0) {
    selectedNodeIdx = activations.length - 1;
    selectedGraphNodeId = activations[selectedNodeIdx].nodeId;
  }
  renderTimeline();
  renderGraphCanvas();
  if (selectedNodeIdx >= 0) renderDetail(activations[selectedNodeIdx]);
  renderInspectorNode(findGraphNode(selectedGraphNodeId));
  if (selectedNodeIdx >= 0) syncTerminalForActivationSelection(activations[selectedNodeIdx]);

  domSummaryFixes.textContent = result.fixAttempts ?? 0;
  domTimelineSummary.classList.remove("hidden");

  renderDiff(result.workspace);

  if (result.workspace?.patchPath) {
    domPatch.disabled = false;
    domPatch.onclick = () => {
      window.open(apiUrl(`/api/runs/${result.runId}/patch`), "_blank");
    };
  }

  await loadWorktrees();
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
      const dur = a.finishedAt ? `${a.finishedAt - a.startedAt}ms` : "";
      const sel = i === selectedNodeIdx ? " selected" : "";
      const badge = a.controllerDecision
        ? '<span class="node-badge badge-controller">Controller</span>'
        : a.rawResult
          ? `<span class="node-badge badge-${badgeClass(a.rawResult.backend)}">${escapeHtml(a.rawResult.backend)}</span>`
          : "";
      const message = activationMessage(a);
      const time = a.startedAt ? new Date(a.startedAt).toLocaleTimeString() : "--";
      return `<button class="timeline-item${sel}" type="button" data-idx="${i}">
        <span class="timeline-time">${escapeHtml(time)}</span>
        <span class="timeline-name">${badge}${escapeHtml(a.nodeId)} #${a.iteration}</span>
        <span class="timeline-status ${escapeAttr(a.status)}">${escapeHtml(a.status)}</span>
        <span class="timeline-message">${escapeHtml(message)}</span>
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

function activationMessage(activation) {
  if (activation.controllerDecision) {
    return `决策：${activation.controllerDecision.selected_output}，置信度 ${activation.controllerDecision.confidence}`;
  }
  if (activation.error) return activation.error;
  if (activation.rawResult?.stdout) return activation.rawResult.stdout.split("\n")[0];
  return "节点执行完成";
}

function selectActivationAtIndex(idx) {
  if (idx < 0 || idx >= activations.length) return;
  selectedNodeIdx = idx;
  selectedGraphNodeId = activations[selectedNodeIdx]?.nodeId ?? selectedGraphNodeId;
  renderTimeline();
  renderGraphCanvas();
  renderDetail(activations[selectedNodeIdx]);
  renderInspectorNode(findGraphNode(selectedGraphNodeId), activations[selectedNodeIdx]);
  syncTerminalForActivationSelection(activations[selectedNodeIdx]);
}

function handleNodeStarted(data) {
  const activation = data.activation ?? data;
  upsertActivation(activation);
  activeGraphNodeId = activation.nodeId ?? null;
  renderGraphCanvas();
  syncTerminalForActivationStart(findActivation(activation.activationId) ?? activation);
}

function handleNodeCompleted(data) {
  const activation = data.activation ?? data;
  upsertActivation(activation);
  syncActiveGraphNodeFromRunning();
  renderGraphCanvas();
  syncTerminalForActivationCompletion(findActivation(activation.activationId) ?? activation);
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
}

function syncTerminalForActivationSelection(activation) {
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
  }, { deferRender: true });
  if (isAgentOutput || activeTerminalActivationId === data.activationId) {
    scheduleTerminalRender();
  }
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

// ─── Detail rendering ──────────────────────────────────────────────
function renderDetail(activation) {
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

function renderTerminal() {
  if (!domTerminal) return;

  if (!activeTerminalActivationId) {
    domTerminal.innerHTML = '<div class="empty-state">等待 active agent 输出...</div>';
    return;
  }

  const activation = findActivation(activeTerminalActivationId);
  if (!activation) {
    domTerminal.innerHTML = '<div class="empty-state">等待 active agent 输出...</div>';
    return;
  }

  const backend = backendForActivation(activation) || "agent";
  const nodeId = activation.nodeId || activation.rawResult?.nodeId || "unknown";
  const stderrPresentation = stderrPresentationForActivation(activation);
  domTerminal.innerHTML = `<div class="terminal-header">
      <span class="node-badge badge-${badgeClass(backend)}">${escapeHtml(backend)}</span>
      <strong>${escapeHtml(nodeId)}</strong>
    </div>
    <div class="terminal-streams">
      <section class="terminal-stream stdout">
        <h4>stdout</h4>
        <pre>${escapeHtml(activation.rawResult?.stdout || "")}</pre>
      </section>
      <section class="terminal-stream ${escapeAttr(stderrPresentation.className)}">
        <h4>${escapeHtml(stderrPresentation.label)}</h4>
        <pre>${escapeHtml(activation.rawResult?.stderr || "")}</pre>
      </section>
    </div>`;
}

function renderInspectorNode(nodeInfo, activation = null) {
  if (!nodeInfo) {
    domInspector.innerHTML = '<div class="empty-state">选择一个节点</div>';
    return;
  }

  const latest = activation ?? [...activations].reverse().find((item) => item.nodeId === nodeInfo.id);
  const isController = nodeInfo.type === "controller" || nodeInfo.kind === "controller";
  const backendLabel = nodeInfo.model ?? nodeInfo.backend ?? nodeInfo.badge ?? nodeInfo.kind;
  const nodeType = nodeInfo.type ?? nodeInfo.kind;
  const prompt = nodeInfo.promptTemplate ?? promptPreview(nodeInfo);
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

    <div class="property-group">
      <h3>基础属性</h3>
      <div class="property-row"><span>模型 / 后端</span><span class="property-value">${escapeHtml(backendLabel)}</span></div>
      <div class="property-row"><span>节点类型</span><span class="property-value">${escapeHtml(nodeType)}</span></div>
      <div class="property-row"><span>最近状态</span><span class="property-value">${escapeHtml(latest?.status ?? "not-run")}</span></div>
    </div>

    ${isController ? `<div class="property-group">
      <h3>输出路由</h3>
      <div class="output-list">${outputs}</div>
    </div>` : ""}

    <div class="property-group">
      <h3>提示模板</h3>
      <div class="property-code">${escapeHtml(prompt)}</div>
    </div>

    ${isController ? `<div class="property-group">
      <h3>输出守卫</h3>
      <div class="guard-list">${guards}</div>
    </div>` : ""}

    ${lastRunResult ? `<div class="property-group">
      <h3>运行概览</h3>
      <div class="property-row"><span>Run ID</span><span class="property-value">${escapeHtml(String(lastRunResult.runId).slice(0, 12))}</span></div>
      <div class="property-row"><span>状态</span><span class="property-value">${escapeHtml(lastRunResult.status)}</span></div>
    </div>` : ""}`;
}

function promptPreview(nodeInfo) {
  if (nodeInfo.kind === "start") return "graph.start";
  if (nodeInfo.command) return JSON.stringify(nodeInfo.command, null, 2);
  return `执行 ${nodeInfo.title}\n\n工作区：{{workspace.path}}`;
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
    getCurrentGraphDefinitionForTest: () => currentGraphDefinition,
    getActiveGraphNodeIdForTest: () => activeGraphNodeId,
    setGraphValueForTest: (graphPath) => {
      currentGraphAsset = { relativePath: graphPath, name: basename(graphPath) };
      currentGraphDefinition = graphDefinitionForTestPath(graphPath);
    },
    openProjectForTest: openProject,
    loadGraphAssetsForTest: loadGraphAssets,
    openGraphAssetForTest: openGraphAsset,
    loadWorkspaceTargetsForTest: loadWorkspaceTargets,
    startRunForTest: startRun,
    runCompletedForTest: onRunCompleted,
    nodeStartedForTest: handleNodeStarted,
    nodeCompletedForTest: handleNodeCompleted,
    selectActivationForTest: (activationId) => {
      selectActivationAtIndex(activations.findIndex((item) => item.activationId === activationId));
    },
    loadWorktreesForTest: loadWorktrees,
    createManualWorktreeForTest: createManualWorktree,
    loadReadinessForTest: loadReadiness,
    appendActivationOutputForTest: appendActivationOutput,
  };
}

init();
