#!/usr/bin/env bash
set -euo pipefail

# ── RadSysX Unified Dev Startup ──────────────────────────────────────
# Starts both backend (FastAPI :8000) and frontend (Next.js :3000)
# Usage:
#   ./dev.sh            Start all services
#   ./dev.sh backend    Start backend only
#   ./dev.sh frontend   Start frontend only

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_VENV="$ROOT_DIR/.venv"
ENV_FILE="$ROOT_DIR/.env.local"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# PIDs to track for cleanup
PIDS=()

cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            wait "$pid" 2>/dev/null || true
        fi
    done
    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# ── Preflight checks ───────────────────────────────────────────────

check_backend() {
    if [ ! -d "$BACKEND_VENV" ]; then
        echo -e "${RED}Backend venv not found at $BACKEND_VENV${NC}"
        echo "Create it with: python3 -m venv .venv && . .venv/bin/activate && python3 -m pip install -r backend/requirements-clinical.txt"
        return 1
    fi
}

check_frontend() {
    if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing frontend dependencies...${NC}"
        (cd "$ROOT_DIR" && npm install --legacy-peer-deps)
    fi
}

# ── Service launchers ──────────────────────────────────────────────

start_backend() {
    check_backend || return 1

    echo -e "${CYAN}[backend]${NC} Starting FastAPI on :8000"

    # Load .env.local if it exists
    local env_args=""
    if [ -f "$ENV_FILE" ]; then
        env_args="--env-file $ENV_FILE"
    fi

    (
        cd "$BACKEND_DIR"
        source "$BACKEND_VENV/bin/activate"
        # Export env vars from .env.local so they're available to the process
        if [ -f "$ENV_FILE" ]; then
            set -a
            source "$ENV_FILE"
            set +a
        fi
        exec uvicorn server:app --reload --host 0.0.0.0 --port 8000 2>&1 | while IFS= read -r line; do
            echo -e "${CYAN}[backend]${NC} $line"
        done
    ) &
    PIDS+=($!)
}

start_frontend() {
    check_frontend

    echo -e "${GREEN}[frontend]${NC} Starting Next.js on :3000"

    (
        cd "$FRONTEND_DIR"
        exec npm run dev 2>&1 | while IFS= read -r line; do
            echo -e "${GREEN}[frontend]${NC} $line"
        done
    ) &
    PIDS+=($!)
}

# ── Main ───────────────────────────────────────────────────────────

echo -e "${YELLOW}RadSysX Dev Environment${NC}"
echo "────────────────────────────────────"

MODE="${1:-all}"

case "$MODE" in
    backend)
        start_backend
        ;;
    frontend)
        start_frontend
        ;;
    all|"")
        start_backend
        start_frontend
        echo ""
        echo -e "${YELLOW}Services starting:${NC}"
        echo -e "  Backend API:  ${CYAN}http://localhost:8000${NC}"
        echo -e "  Frontend:     ${GREEN}http://localhost:3000${NC}"
        echo -e "  API Docs:     ${CYAN}http://localhost:8000/docs${NC}"
        echo ""
        echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
        ;;
    *)
        echo "Usage: ./dev.sh [backend|frontend|all]"
        exit 1
        ;;
esac

# Wait for all background processes
wait
