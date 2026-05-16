#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT=3456
LOG_DIR="$ROOT/.agentgraph"
SERVER_LOG="$LOG_DIR/agentgraph-server.log"
TAURI_BIN="$ROOT/src-tauri/target/debug/agentgraph"

echo "============================================================"
echo "  AgentGraph - Tauri Desktop Launch (macOS)"
echo "============================================================"
echo ""

# --- helpers ---

stop_server() {
    local pid
    pid=$(lsof -ti ":$PORT" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "Stopping existing process on port $PORT (PID $pid)..."
        kill "$pid" 2>/dev/null || true
        sleep 1
    fi
}

wait_for_server() {
    echo "Waiting for AgentGraph server..."
    for i in $(seq 1 30); do
        if curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/graphs" 2>/dev/null | grep -q "project-task-loop"; then
            echo "Server is ready."
            return 0
        fi
        sleep 1
    done
    echo "[ERROR] AgentGraph server did not become ready. See $SERVER_LOG."
    return 1
}

load_env() {
    if [ -f "$ROOT/.env" ]; then
        set -a
        source "$ROOT/.env"
        set +a
        echo "Environment loaded from .env"
    fi
    if [ -f "$ROOT/.env.local" ]; then
        set -a
        source "$ROOT/.env.local"
        set +a
        echo "Environment loaded from .env.local"
    fi
    if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
        echo "DeepSeek API key loaded."
    fi
}

# --- checks ---

ensure_node() {
    if ! command -v node &>/dev/null; then
        echo "[ERROR] Node.js not found. Install with: brew install node"
        exit 1
    fi
    if ! command -v npm &>/dev/null; then
        echo "[ERROR] npm not found."
        exit 1
    fi
    echo "Node.js $(node --version) / npm $(npm --version)"
}

ensure_rust() {
    if command -v rustup &>/dev/null; then
        if ! command -v cargo &>/dev/null || ! cargo --version &>/dev/null || ! rustc --version &>/dev/null; then
            echo "Configuring Rust stable toolchain..."
            rustup default stable
        fi
    fi

    if ! command -v cargo &>/dev/null || ! cargo --version &>/dev/null; then
        echo "[ERROR] Rust/Cargo not found. Install with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
        exit 1
    fi
    if ! command -v rustc &>/dev/null || ! rustc --version &>/dev/null; then
        echo "[ERROR] rustc is not available. If rustup is installed, run: rustup default stable"
        exit 1
    fi
    echo "Cargo $(cargo --version | cut -d' ' -f2)"
}

# --- main ---

ensure_node
ensure_rust

cd "$ROOT"

echo "Installing project dependencies..."
npm install

if [ ! -f "$ROOT/node_modules/.bin/tauri" ]; then
    echo "[ERROR] Tauri CLI not found after npm install."
    exit 1
fi

mkdir -p "$LOG_DIR"
load_env
stop_server

echo "Building Tauri desktop client..."
(cd "$ROOT/src-tauri" && cargo build)

if [ ! -f "$TAURI_BIN" ]; then
    echo "[ERROR] Tauri binary not built: $TAURI_BIN"
    exit 1
fi

echo "Starting AgentGraph server in the background..."
echo "Server log: $SERVER_LOG"
npm run start -- --serve --port "$PORT" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

if ! wait_for_server; then
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
fi

echo "Starting Tauri desktop app..."
"$TAURI_BIN" &
TAURI_PID=$!
wait "$TAURI_PID"
EXIT_CODE=$?

stop_server

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
    echo "Tauri closed."
else
    echo "Tauri exited with code $EXIT_CODE."
fi

exit "$EXIT_CODE"
