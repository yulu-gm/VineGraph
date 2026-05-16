// ─── State ──────────────────────────────────────────────────────────
let currentRunId = null;
let eventSource = null;
let activations = [];
let selectedNodeIdx = -1;
let selectedGraphNodeId = "after_tests_controller";
let lastRunResult = null;
let streamBuffers = new Map();
let terminalBuffers = new Map();
let activeTerminalActivationId = null;
let canvasPan = { x: 0, y: 0 };
let canvasBounds = { minX: 0, minY: 0, width: 1220, height: 680 };
let canvasDrag = null;
let currentGraphDefinition = null;
let graphDefinitionRequestId = 0;

const API_ORIGIN = "http://127.0.0.1:3456";

// ─── DOM refs ──────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);

const domGraph = $("#graph-select");
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
const domGraphFile = $("#selected-graph-file");
const domFlowList = $("#flow-list");
const domProjectName = $("#project-name");
const domInspector = $("#inspector-content");
const domRunChip = $("#run-id-chip");

// ─── Graph display presets ─────────────────────────────────────────
const PRESET = {
  bug_fix_loop: {
    title: "bug_fix_loop",
    nodes: [
      node("start", "Start", "start", "", "开始", 32, 58, 132, 72),
      node("implement", "Implement", "execute", "Codex", "实现代码变更", 190, 52, 190, 96),
      node("run_tests", "Run Tests", "execute", "Shell", "运行测试套件", 190, 212, 190, 96),
      node("fix_from_test_logs", "Fix From Test Logs", "execute", "Claude", "根据测试日志修复代码", 300, 362, 210, 96),
      controllerNode("after_tests_controller", "After Tests Controller", "DeepSeek", "分析测试结果，决定下一步", 525, 140),
      node("rerun_tests", "Run Tests (rerun)", "execute", "Shell", "重新运行测试", 770, 100, 180, 96),
      node("ask_human", "Ask Human", "execute", "Human", "请求人工协助", 770, 220, 180, 96),
      node("end_success", "End Success", "end", "Internal", "流程成功结束", 770, 340, 180, 96),
      node("end_failed", "End Failed", "failed", "Internal", "流程失败结束", 770, 460, 180, 96),
    ],
    connections: [
      connect("start", "implement", "blue"),
      connect("implement", "after_tests_controller", "blue"),
      connect("run_tests", "after_tests_controller", "blue"),
      connect("fix_from_test_logs", "run_tests", "orange"),
      connect("after_tests_controller", "fix_from_test_logs", "orange", 44),
      connect("after_tests_controller", "rerun_tests", "blue", 72),
      connect("after_tests_controller", "ask_human", "purple", 100),
      connect("after_tests_controller", "end_success", "green", 128),
      connect("after_tests_controller", "end_failed", "red", 156),
    ],
  },
  demo_shell_loop: {
    title: "demo_shell_loop",
    nodes: [
      node("start", "Start", "start", "", "开始", 60, 180, 132, 72),
      node("compile", "Compile", "execute", "Shell", "编译项目", 260, 168, 190, 96),
      node("run_tests", "Run Tests", "execute", "Shell", "运行所有测试", 520, 168, 190, 96),
      node("linter", "Linter", "execute", "Shell", "检查代码风格", 780, 168, 190, 96),
      node("end_success", "End Success", "end", "Internal", "流程成功结束", 1040, 168, 190, 96),
    ],
    connections: [
      connect("start", "compile", "blue"),
      connect("compile", "run_tests", "blue"),
      connect("run_tests", "linter", "blue"),
      connect("linter", "end_success", "green"),
    ],
  },
  project_task_loop: {
    title: "project_remaining_tasks_loop",
    nodes: [
      node("start", "Start", "start", "", "开始", 32, 210, 132, 72),
      node("implement_feature", "Implement Feature", "execute", "Codex 5.5", "实现下一个剩余任务", 220, 190, 210, 104),
      node("review_code_quality", "Review Code Quality", "execute", "Codex 5.5", "审查代码质量", 500, 92, 220, 104),
      node("review_functionality", "Review Functionality", "execute", "Codex 5.5", "审查功能正确性", 500, 310, 220, 104),
      controllerNode("review_gate", "Review Gate", "DeepSeek", "两个 review 都通过才放行", 790, 180, [
        ["fix_review_issues", "修复 review 问题", "orange"],
        ["assess_remaining_tasks", "检查剩余任务", "green"],
        ["end_failed", "失败结束", "red"],
      ]),
      node("fix_review_issues", "Fix Review Issues", "execute", "Codex 5.5", "修复 review 发现的问题", 815, 455, 230, 104),
      node("assess_remaining_tasks", "Assess Remaining Tasks", "execute", "Codex 5.5", "评估是否还有剩余任务", 1110, 150, 240, 104),
      controllerNode("task_gate", "Task Gate", "DeepSeek", "决定继续下一个任务或结束", 1410, 175, [
        ["next_task", "继续下一个任务", "purple"],
        ["end_success", "成功结束", "green"],
        ["end_failed", "失败结束", "red"],
      ]),
      node("end_success", "End Success", "end", "Internal", "全部任务完成", 1720, 125, 190, 96),
      node("end_failed", "End Failed", "failed", "Internal", "流程失败结束", 1720, 280, 190, 96),
    ],
    connections: [
      connect("start", "implement_feature", "blue"),
      connect("implement_feature", "review_code_quality", "blue"),
      connect("implement_feature", "review_functionality", "blue"),
      connect("review_code_quality", "review_gate", "blue"),
      connect("review_functionality", "review_gate", "blue"),
      connect("review_gate", "fix_review_issues", "orange", 44),
      connect("fix_review_issues", "review_code_quality", "orange"),
      connect("fix_review_issues", "review_functionality", "orange"),
      connect("review_gate", "assess_remaining_tasks", "green", 72),
      connect("assess_remaining_tasks", "task_gate", "blue"),
      connect("task_gate", "implement_feature", "purple", 44),
      connect("task_gate", "end_success", "green", 72),
      connect("task_gate", "end_failed", "red", 100),
    ],
  },
  simple: {
    title: "phase1_smoke_test",
    nodes: [
      node("start", "Start", "start", "", "开始", 130, 190, 132, 72),
      node("run_tests", "Run Tests", "execute", "Shell", "运行 smoke test", 360, 178, 200, 96),
      node("end_success", "End Success", "end", "Internal", "流程成功结束", 650, 178, 190, 96),
    ],
    connections: [connect("start", "run_tests", "blue"), connect("run_tests", "end_success", "green")],
  },
  failing: {
    title: "phase1_failing_test",
    nodes: [
      node("start", "Start", "start", "", "开始", 130, 190, 132, 72),
      node("run_tests", "Run Tests", "execute", "Shell", "运行失败测试", 360, 178, 200, 96),
      node("end_failed", "End Failed", "failed", "Internal", "流程失败结束", 650, 178, 190, 96),
    ],
    connections: [connect("start", "run_tests", "blue"), connect("run_tests", "end_failed", "red")],
  },
};

function node(id, title, kind, badge, description, x, y, width = 190, height = 96) {
  return { id, title, kind, badge, description, x, y, width, height };
}

function controllerNode(id, title, badge, description, x, y, outputs = [
  ["fix_from_test_logs", "Fix From Test Logs", "orange"],
  ["rerun_tests", "重新运行测试", "blue"],
  ["ask_human", "请求人工协助", "purple"],
  ["end_success", "成功结束", "green"],
  ["end_failed", "失败结束", "red"],
]) {
  return {
    id,
    title,
    kind: "controller",
    badge,
    description,
    x,
    y,
    width: 240,
    height: 170,
    outputs,
  };
}

function connect(from, to, color = "blue", fromOffset = null) {
  return { from, to, color, fromOffset };
}

function getPresetKey(path) {
  const name = basename(path).toLowerCase();
  if (name.includes("project-task-loop") || name.includes("remaining")) return "project_task_loop";
  if (name.includes("bug-fix") || name.includes("bug_fix")) return "bug_fix_loop";
  if (name.includes("demo")) return "demo_shell_loop";
  if (name.includes("failing")) return "failing";
  return "simple";
}

function currentPreset() {
  return PRESET[getPresetKey(domGraph.value)];
}

// ─── Init ──────────────────────────────────────────────────────────
async function init() {
  await loadGraphs();
  await loadGraphDefinition(domGraph.value);
  selectedGraphNodeId = defaultSelectedNodeId(getPresetKey(domGraph.value));
  renderGraphCanvas();
  renderInspectorNode(findGraphNode(selectedGraphNodeId));
  bindTabs();
  bindCanvasPan();
  bindMinimapDrag();

  domRun.addEventListener("click", startRun);
  domCancel.addEventListener("click", cancelRun);
  domGraph.addEventListener("change", async () => {
    const graphPath = domGraph.value;
    const applied = await loadGraphDefinition(graphPath);
    if (domGraph.value !== graphPath) return;
    selectedGraphNodeId = defaultSelectedNodeId(getPresetKey(graphPath));
    canvasPan = { x: 0, y: 0 };
    renderGraphCanvas();
    renderFlowList();
    renderInspectorNode(findGraphNode(selectedGraphNodeId));
  });
  window.addEventListener("resize", applyCanvasPan);
}

function defaultSelectedNodeId(presetKey) {
  if (presetKey === "bug_fix_loop") return "after_tests_controller";
  if (presetKey === "project_task_loop") return "review_gate";
  return "run_tests";
}

async function loadGraphs() {
  try {
    const resp = await fetch(apiUrl("/api/graphs"));
    if (!resp.ok) throw new Error(`Graph list request failed: ${resp.status}`);
    const files = await resp.json();
    if (!Array.isArray(files) || files.length === 0) {
      setGraphSelectPlaceholder("没有可用 graph");
      renderFlowList();
      return;
    }
    domGraph.innerHTML = "";
    for (const f of files) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = basename(f);
      domGraph.appendChild(opt);
    }
  } catch {
    setGraphSelectPlaceholder("图列表加载失败");
  }
  renderFlowList();
}

async function loadGraphDefinition(graphPath) {
  const requestId = ++graphDefinitionRequestId;
  if (!graphPath) {
    if (requestId === graphDefinitionRequestId && domGraph.value === graphPath) {
      currentGraphDefinition = null;
    }
    return false;
  }

  try {
    const resp = await fetch(apiUrl(`/api/graphs/detail?path=${encodeURIComponent(graphPath)}`));
    if (!resp.ok) throw new Error(`Graph detail request failed: ${resp.status}`);
    const graphDefinition = await resp.json();
    if (requestId !== graphDefinitionRequestId || domGraph.value !== graphPath) {
      return false;
    }
    currentGraphDefinition = graphDefinition;
    return true;
  } catch {
    if (requestId === graphDefinitionRequestId && domGraph.value === graphPath) {
      currentGraphDefinition = null;
    }
    return false;
  }
}

function setGraphSelectPlaceholder(label) {
  domGraph.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = label;
  domGraph.appendChild(opt);
}

function renderFlowList() {
  const options = [...domGraph.options].filter((opt) => opt.value);
  domFlowList.innerHTML = options
    .map((opt) => {
      const active = opt.value === domGraph.value ? " active" : "";
      return `<button class="flow-row${active}" type="button" data-path="${escapeAttr(opt.value)}">
        <span><span class="file-icon graph"></span>${escapeHtml(filenameToFlowName(opt.textContent))}</span>
        <span class="flow-status"></span>
      </button>`;
    })
    .join("");

  domFlowList.querySelectorAll(".flow-row").forEach((row) => {
    row.addEventListener("click", () => {
      domGraph.value = row.dataset.path;
      domGraph.dispatchEvent(new Event("change"));
    });
  });
}

function bindTabs() {
  document.querySelectorAll(".dock-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".dock-tab").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".dock-pane").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      $(`#${tab.dataset.panel}-panel`)?.classList.add("active");
    });
  });
}

// ─── Graph canvas ──────────────────────────────────────────────────
function renderGraphCanvas() {
  const preset = currentPreset();
  const graphTitle = currentGraphDefinition?.id ?? preset.title;
  domCanvasTitle.textContent = graphTitle;
  domProjectName.textContent = graphTitle;
  domGraphFile.textContent = basename(domGraph.value) || `${preset.title}.graph`;

  const bounds = graphBounds(preset);
  canvasBounds = bounds;
  canvasPan = clampCanvasPan(canvasPan, canvasBounds);
  const canvasNodes = preset.nodes.map(enrichCanvasNode);
  const nodeMap = new Map(canvasNodes.map((item) => [item.id, item]));
  const svg = preset.connections
    .map((item, index) => renderConnection(item, nodeMap, index))
    .join("");
  const nodes = canvasNodes.map(renderGraphNode).join("");

  domCanvas.innerHTML = `<div class="graph-layer" style="width:${bounds.width}px;height:${bounds.height}px;transform: translate(${-canvasPan.x}px, ${-canvasPan.y}px)">
    <svg class="connections" viewBox="${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}" preserveAspectRatio="xMinYMin meet" style="width:${bounds.width}px;height:${bounds.height}px">${renderConnectionDefs()}${svg}</svg>
    ${nodes}
  </div>
  ${renderMinimap(preset, bounds)}`;

  domCanvas.querySelectorAll(".graph-node").forEach((el) => {
    el.addEventListener("click", () => {
      selectedGraphNodeId = el.dataset.nodeId;
      selectedNodeIdx = activations.findIndex((a) => a.nodeId === selectedGraphNodeId);
      renderGraphCanvas();
      renderTimeline();
      renderInspectorNode(findGraphNode(selectedGraphNodeId));
      if (selectedNodeIdx >= 0) renderDetail(activations[selectedNodeIdx]);
    });
  });
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

function graphBounds(preset) {
  const maxX = Math.max(...preset.nodes.map((item) => item.x + item.width), 1060);
  const maxY = Math.max(...preset.nodes.map((item) => item.y + item.height), 560);
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
  const runState = statusForNode(item.id);
  const stateClass = runState ? ` run-${runState}` : "";
  const badge = item.badge ? `<span class="node-badge badge-${badgeClass(item.badge)}">${escapeHtml(item.badge)}</span>` : "";
  const outputs = item.outputs
    ? `<div class="controller-outputs">${item.outputs.map(([id, label, color]) =>
        `<div class="output-row" data-output="${escapeAttr(id)}"><span>${escapeHtml(id)}</span><span class="port-dot ${color}"></span></div>`
      ).join("")}</div>`
    : "";

  return `<button class="graph-node ${item.kind}${selected}${stateClass}" type="button"
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
  const preset = currentPreset();
  const node = preset.nodes.find((item) => item.id === nodeId) ?? preset.nodes[0];
  return enrichCanvasNode(node);
}

// ─── Run control ───────────────────────────────────────────────────
async function startRun() {
  const graphPath = domGraph.value;
  if (!graphPath) {
    alert("请先选择 graph");
    return;
  }

  currentRunId = null;
  activations = [];
  streamBuffers = new Map();
  terminalBuffers = new Map();
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
}

// ─── SSE ────────────────────────────────────────────────────────────
function connectSSE(runId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(apiUrl(`/api/runs/${runId}/events`));

  eventSource.addEventListener("node:started", (e) => {
    const data = JSON.parse(e.data);
    upsertActivation(data.activation);
  });

  eventSource.addEventListener("node:output", (e) => {
    appendActivationOutput(JSON.parse(e.data));
  });

  eventSource.addEventListener("node:completed", (e) => {
    const data = JSON.parse(e.data);
    upsertActivation(data.activation ?? data);
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
function onRunCompleted(result) {
  currentRunId = result.runId;
  lastRunResult = result;
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

  domSummaryFixes.textContent = result.fixAttempts ?? 0;
  domTimelineSummary.classList.remove("hidden");

  renderDiff(result.workspace);

  if (result.workspace?.patchPath) {
    domPatch.disabled = false;
    domPatch.onclick = () => {
      window.open(apiUrl(`/api/runs/${result.runId}/patch`), "_blank");
    };
  }
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
      selectedNodeIdx = parseInt(el.dataset.idx, 10);
      selectedGraphNodeId = activations[selectedNodeIdx]?.nodeId ?? selectedGraphNodeId;
      renderTimeline();
      renderGraphCanvas();
      renderDetail(activations[selectedNodeIdx]);
      renderInspectorNode(findGraphNode(selectedGraphNodeId), activations[selectedNodeIdx]);
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

function upsertActivation(activation) {
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

  renderTimeline();
  renderGraphCanvas();
  if (selectedNodeIdx >= 0) {
    renderDetail(activations[selectedNodeIdx]);
    renderInspectorNode(findGraphNode(selectedGraphNodeId), activations[selectedNodeIdx]);
  }
}

function appendActivationOutput(data) {
  if (!data?.activationId) return;
  const stream = data.stream === "stderr" ? "stderr" : "stdout";
  const current = streamBuffers.get(data.activationId) ?? {
    stdout: "",
    stderr: "",
    startedAt: data.timestamp ?? Date.now(),
  };
  current[stream] = `${current[stream] || ""}${data.chunk || ""}`;
  streamBuffers.set(data.activationId, current);

  const terminalBuffer = terminalBuffers.get(data.activationId) ?? {
    stdout: "",
    stderr: "",
    nodeId: data.nodeId,
    backend: data.backend,
    startedAt: data.timestamp ?? Date.now(),
  };
  terminalBuffer.nodeId = data.nodeId ?? terminalBuffer.nodeId;
  terminalBuffer.backend = data.backend ?? terminalBuffer.backend;
  terminalBuffer[stream] = `${terminalBuffer[stream] || ""}${data.chunk || ""}`;
  terminalBuffers.set(data.activationId, terminalBuffer);

  const backend = String(data.backend || "").toLowerCase();
  if (backend === "codex" || backend === "claude") {
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
        startedAt: current.startedAt,
      };

  upsertActivation({
    ...base,
    rawResult: {
      ...(base.rawResult || {}),
      activationId: data.activationId,
      nodeId: data.nodeId,
      backend: data.backend,
      stdout: current.stdout,
      stderr: current.stderr,
      exitCode: base.rawResult?.exitCode ?? "running",
      startedAt: base.rawResult?.startedAt ?? current.startedAt,
      finishedAt: data.timestamp ?? Date.now(),
      durationMs: (data.timestamp ?? Date.now()) - (base.rawResult?.startedAt ?? current.startedAt),
    },
  });
  renderTerminal();
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
      html += `<div class="detail-section"><h4>stderr</h4><pre>${escapeHtml(r.stderr)}</pre></div>`;
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

  const buffer = terminalBuffers.get(activeTerminalActivationId);
  if (!buffer) {
    domTerminal.innerHTML = '<div class="empty-state">等待 active agent 输出...</div>';
    return;
  }

  const backend = buffer.backend || "agent";
  const nodeId = buffer.nodeId || "unknown";
  domTerminal.innerHTML = `<div class="terminal-header">
      <span class="node-badge badge-${badgeClass(backend)}">${escapeHtml(backend)}</span>
      <strong>${escapeHtml(nodeId)}</strong>
    </div>
    <div class="terminal-streams">
      <section class="terminal-stream stdout">
        <h4>stdout</h4>
        <pre>${escapeHtml(buffer.stdout || "")}</pre>
      </section>
      <section class="terminal-stream stderr">
        <h4>stderr</h4>
        <pre>${escapeHtml(buffer.stderr || "")}</pre>
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

// ─── Boot ──────────────────────────────────────────────────────────
if (window.AGENTGRAPH_ENABLE_TEST_HOOKS === true) {
  window.__AGENTGRAPH_UI_TEST_HOOKS__ = {
    loadGraphDefinitionForTest: loadGraphDefinition,
    getCurrentGraphDefinitionForTest: () => currentGraphDefinition,
    setGraphValueForTest: (graphPath) => {
      domGraph.value = graphPath;
    },
    appendActivationOutputForTest: appendActivationOutput,
  };
}

init();
