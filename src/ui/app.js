// ─── State ──────────────────────────────────────────────────────────
let currentRunId = null;
let eventSource = null;
let activations = [];
let selectedNodeIdx = -1;
let runCompleted = false;

// ─── DOM refs ──────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

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
const domBarStatus = $("#bar-status");
const domBarDuration = $("#bar-duration");
const domPatch = $("#btn-patch");

// ─── Init ──────────────────────────────────────────────────────────
async function init() {
  await loadGraphs();
  domRun.addEventListener("click", startRun);
  domCancel.addEventListener("click", cancelRun);
}

async function loadGraphs() {
  try {
    const resp = await fetch("/api/graphs");
    const files = await resp.json();
    for (const f of files) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f.split("/").pop().replace(/\\/g, "/").split("/").pop();
      domGraph.appendChild(opt);
    }
  } catch {
    domGraph.innerHTML = '<option value="">-- no examples/ found --</option>';
  }
}

// ─── Run control ───────────────────────────────────────────────────
async function startRun() {
  const graphPath = domGraph.value;
  if (!graphPath) { alert("Select a graph first"); return; }

  // Reset state
  currentRunId = null;
  activations = [];
  selectedNodeIdx = -1;
  runCompleted = false;
  domTimeline.innerHTML = '<div class="empty-state">Starting...</div>';
  domDetail.innerHTML = '<div class="empty-state">Running...</div>';
  domDiff.innerHTML = '<div class="empty-state">Waiting for changes...</div>';
  domTimelineSummary.classList.add("hidden");
  domPatch.disabled = true;

  setRunning(true);

  try {
    const body = { graphPath };
    if (domTask.value) body.task = domTask.value;
    if (domTest.value) body.test_command = domTest.value;

    const resp = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await resp.json();

    if (resp.ok) {
      onRunCompleted(result);
    } else {
      domTimeline.innerHTML = `<div class="empty-state">Error: ${result.error || "Unknown error"}</div>`;
      domBarStatus.textContent = result.error || "Error";
      setRunning(false);
    }
  } catch (err) {
    domTimeline.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
    domBarStatus.textContent = err.message;
    setRunning(false);
  }
}

async function cancelRun() {
  if (!currentRunId) return;
  try {
    await fetch(`/api/runs/${currentRunId}`, { method: "DELETE" });
  } catch {}
  if (eventSource) eventSource.close();
  setRunning(false);
  domBarStatus.textContent = "Cancelled";
  domStatus.className = "status-badge failed";
  domStatus.textContent = "Cancelled";
}

function setRunning(running) {
  domRun.disabled = running;
  domCancel.disabled = !running;
  if (running) {
    domStatus.className = "status-badge running";
    domStatus.textContent = "Running";
    domBarStatus.textContent = "Executing...";
  }
}

// ─── SSE ────────────────────────────────────────────────────────────
function connectSSE(runId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/runs/${runId}/events`);

  eventSource.addEventListener("node:started", (e) => {
    const data = JSON.parse(e.data);
    // Pre-add placeholder
  });

  eventSource.addEventListener("node:completed", (e) => {
    const data = JSON.parse(e.data);
    // If we get real-time node completions
    addActivation(data);
  });

  eventSource.addEventListener("controller:decided", (e) => {
    const data = JSON.parse(e.data);
    // Real-time controller decisions
  });

  eventSource.addEventListener("run:completed", (e) => {
    const data = JSON.parse(e.data);
    if (data.status) {
      domStatus.className = `status-badge ${data.status}`;
      domStatus.textContent = data.status;
    }
    if (eventSource) eventSource.close();
    eventSource = null;
  });

  eventSource.onerror = () => {
    // SSE disconnected
  };
}

// ─── Run completed ─────────────────────────────────────────────────
function onRunCompleted(result) {
  currentRunId = result.runId;
  runCompleted = true;
  setRunning(false);

  domStatus.className = `status-badge ${result.status}`;
  domStatus.textContent = result.status;
  domBarStatus.textContent = result.status === "success" ? "Completed successfully" : "Completed with errors";

  if (result.totalDurationMs) {
    domBarDuration.textContent = `${(result.totalDurationMs / 1000).toFixed(1)}s`;
  }

  // Render timeline
  activations = result.activations || [];
  renderTimeline();

  // Show summary
  if (result.totalDurationMs) {
    domSummaryDuration.textContent = `${(result.totalDurationMs / 1000).toFixed(1)}s`;
  }
  domSummaryFixes.textContent = result.fixAttempts ?? 0;
  domTimelineSummary.classList.remove("hidden");

  // Render diff & workspace
  renderDiff(result.workspace);

  // Enable patch export
  if (result.workspace?.patchPath) {
    domPatch.disabled = false;
    domPatch.onclick = () => {
      window.open(`/api/runs/${result.runId}/patch`, "_blank");
    };
  }

  // Connect SSE for future runs
  connectSSE(result.runId);
}

// ─── Timeline rendering ────────────────────────────────────────────
function renderTimeline() {
  if (activations.length === 0) {
    domTimeline.innerHTML = '<div class="empty-state">No activations</div>';
    return;
  }

  domTimeline.innerHTML = activations
    .map((a, i) => {
      const icon = a.status === "succeeded" ? "✓" : "✗";
      const iconClass = a.status === "succeeded" ? "ok" : "fail";
      const dur = a.finishedAt ? `${a.finishedAt - a.startedAt}ms` : "";
      const sel = i === selectedNodeIdx ? " selected" : "";
      let badge = "";
      if (a.controllerDecision) {
        badge = '<span class="badge badge-controller">ctrl</span>';
      } else if (a.rawResult) {
        const b = a.rawResult.backend;
        badge = `<span class="badge badge-${b}">${b}</span>`;
      }
      return `<div class="timeline-item${sel}" data-idx="${i}">
        <span class="icon ${iconClass}">${icon}</span>
        <span class="name">${a.nodeId} #${a.iteration}</span>
        ${badge}
        <span class="time">${dur}</span>
      </div>`;
    })
    .join("");

  // Click handlers
  domTimeline.querySelectorAll(".timeline-item").forEach((el) => {
    el.addEventListener("click", () => {
      selectedNodeIdx = parseInt(el.dataset.idx);
      renderTimeline();
      renderDetail(activations[selectedNodeIdx]);
    });
  });
}

function addActivation(activation) {
  activations.push(activation);
  renderTimeline();
}

// ─── Detail rendering ──────────────────────────────────────────────
function renderDetail(activation) {
  if (!activation) {
    domDetail.innerHTML = '<div class="empty-state">Select a node</div>';
    return;
  }

  let html = `<div class="detail-section">
    <h4>Node</h4>
    <div>${activation.nodeId} (iteration ${activation.iteration})</div>
  </div>`;

  if (activation.controllerDecision) {
    const d = activation.controllerDecision;
    html += `<div class="detail-section">
      <h4>Controller Decision</h4>
      <div class="controller-decision">
        <div class="field"><strong>Selected:</strong> ${d.selected_output}</div>
        <div class="field"><strong>Confidence:</strong> ${d.confidence}</div>
        <div class="field"><strong>Reason:</strong> ${d.reason}</div>
        ${d.payload ? `<div class="field"><strong>Payload:</strong> <pre>${JSON.stringify(d.payload, null, 2)}</pre></div>` : ""}
      </div>
    </div>`;
  }

  if (activation.rawResult) {
    const r = activation.rawResult;
    html += `<div class="detail-section">
      <h4>Info</h4>
      <div>Backend: ${r.backend} | Exit: ${r.exitCode} | Duration: ${r.durationMs}ms</div>
    </div>`;

    if (r.stdout) {
      html += `<div class="detail-section">
        <h4>stdout</h4>
        <pre>${escapeHtml(r.stdout)}</pre>
      </div>`;
    }
    if (r.stderr) {
      html += `<div class="detail-section">
        <h4>stderr</h4>
        <pre style="color:#e74c3c">${escapeHtml(r.stderr)}</pre>
      </div>`;
    }
  }

  if (activation.error) {
    html += `<div class="detail-section">
      <h4>Error</h4>
      <pre style="color:#e74c3c">${escapeHtml(activation.error)}</pre>
    </div>`;
  }

  domDetail.innerHTML = html;
}

// ─── Diff rendering ────────────────────────────────────────────────
function renderDiff(workspace) {
  if (!workspace) {
    domDiff.innerHTML = '<div class="empty-state">No workspace info</div>';
    return;
  }

  let html = `<div class="detail-section">
    <div>Mode: ${workspace.mode} | Path: ${workspace.path}</div>
  </div>`;

  if (workspace.changedFiles && workspace.changedFiles.length > 0) {
    html += `<div class="diff-files">
      <h4>Changed Files (${workspace.changedFiles.length})</h4>`;
    for (const f of workspace.changedFiles) {
      html += `<div class="diff-file">${f}</div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="empty-state">No files changed</div>`;
  }

  if (workspace.diff) {
    html += `<div class="detail-section">
      <h4>Diff</h4>
      <div class="diff-view">${colorizeDiff(workspace.diff)}</div>
    </div>`;
  }

  domDiff.innerHTML = html;
}

// ─── Helpers ───────────────────────────────────────────────────────
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colorizeDiff(diff) {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return `<span class="diff-add">${escapeHtml(line)}</span>`;
      if (line.startsWith("-")) return `<span class="diff-del">${escapeHtml(line)}</span>`;
      if (line.startsWith("@@") || line.startsWith("diff") || line.startsWith("---") || line.startsWith("+++"))
        return `<span class="diff-hdr">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    })
    .join("\n");
}

// ─── Boot ──────────────────────────────────────────────────────────
init();
