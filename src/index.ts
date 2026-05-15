import { GraphLoader } from "./graph-loader.js";
import { Scheduler } from "./scheduler.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: npx tsx src/index.ts <graph-yaml-path>");
    console.error("       npx tsx src/index.ts --serve [--port 3456]");
    process.exit(1);
  }

  // Server mode
  if (args[0] === "--serve" || args[0] === "-s") {
    const portArg = args.indexOf("--port");
    const port =
      portArg >= 0 && args[portArg + 1]
        ? parseInt(args[portArg + 1], 10)
        : 3456;
    console.log("=".repeat(60));
    console.log("  AgentGraph - Server Mode");
    console.log("=".repeat(60));
    startServer(port);
    return;
  }

  // CLI mode
  const graphPath = args[0];

  console.log("=".repeat(60));
  console.log("  AgentGraph - Phase 4 CLI");
  console.log("=".repeat(60));
  console.log();

  // Load and validate graph
  console.log(`Loading graph: ${graphPath}`);
  const graph = GraphLoader.load(graphPath);
  console.log(`  Graph ID:     ${graph.id}`);
  console.log(`  Version:      ${graph.version}`);
  console.log(`  Nodes:        ${graph.nodes.length}`);
  console.log(`  Edges:        ${graph.edges.length}`);
  const mode = graph.runtime?.workspace?.mode ?? "worktree";
  console.log(`  Workspace:    ${mode}`);
  console.log();

  // Execute
  console.log("Executing graph...");
  console.log("-".repeat(60));
  const result = await Scheduler.run(graph, graphPath);
  console.log("-".repeat(60));
  console.log();

  // Results
  console.log("Results:");
  console.log(`  Status:       ${result.status}`);
  console.log(`  Duration:     ${result.totalDurationMs}ms`);
  console.log(`  Activations:  ${result.activations.length}`);
  console.log();

  for (const activation of result.activations) {
    const statusIcon = activation.status === "succeeded" ? "✓" : "✗";
    const prefix =
      activation.rawResult?.backend === "codex"
        ? "[codex]"
        : activation.rawResult?.backend === "claude"
          ? "[claude]"
          : activation.controllerDecision
            ? "[controller]"
            : "";
    console.log(
      `  ${statusIcon} ${prefix} ${activation.nodeId} [${activation.status}] (${activation.finishedAt! - activation.startedAt}ms)`
    );

    if (activation.controllerDecision) {
      const d = activation.controllerDecision;
      console.log(`      → selected: ${d.selected_output}`);
      console.log(`      → reason:   ${d.reason.slice(0, 100)}`);
      console.log(`      → confidence: ${d.confidence}`);
    }

    if (activation.rawResult) {
      const r = activation.rawResult;
      console.log(`      exitCode: ${r.exitCode}`);
      if (r.stdout) {
        const lines = r.stdout.split("\n");
        for (const line of lines.slice(0, 5)) {
          console.log(`      | ${line}`);
        }
        if (lines.length > 5) {
          console.log(
            `      | ... (${lines.length - 5} more lines)`
          );
        }
      }
    }
  }

  // Workspace & Diff
  const ws = result.workspace;
  if (ws) {
    console.log();
    console.log("Workspace:");
    console.log(`  Mode:         ${ws.mode}`);
    console.log(`  Path:         ${ws.path}`);

    if (ws.changedFiles && ws.changedFiles.length > 0) {
      console.log(
        `  Changed files (${ws.changedFiles.length}):`
      );
      for (const f of ws.changedFiles) {
        console.log(`    - ${f}`);
      }
    } else {
      console.log(`  Changed files: (none)`);
    }

    if (ws.patchPath) {
      console.log(`  Patch:        ${ws.patchPath}`);
    }
  }

  if (result.error) {
    console.log();
    console.log(`  Error: ${result.error}`);
  }

  console.log();
  console.log(
    `Run record saved to: .agentgraph/runs/${result.runId}.json`
  );

  process.exit(result.status === "success" ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
