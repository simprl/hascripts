#!/usr/bin/env bash
set -euo pipefail

echo "Docker CLEANUP starting (remove all containers/images/volumes/networks/caches; keep Docker installed)"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

if ! have_cmd docker; then
  echo "docker CLI not found. Is Docker installed?"
  exit 1
fi

echo "[1/6] Stopping containers (best effort)..."
docker ps -q | xargs -r docker stop >/dev/null 2>&1 || true

echo "[2/6] Removing all containers..."
docker ps -aq | xargs -r docker rm -f >/dev/null 2>&1 || true

echo "[3/6] Removing all volumes..."
docker volume ls -q | xargs -r docker volume rm -f >/dev/null 2>&1 || true

echo "[4/6] Removing all images..."
docker images -aq | xargs -r docker rmi -f >/dev/null 2>&1 || true

echo "[5/6] Removing user-defined networks..."
docker network ls --format '{{.Name}}' \
  | grep -Ev '^(bridge|host|none)$' \
  | xargs -r docker network rm >/dev/null 2>&1 || true

echo "[6/6] Pruning build cache and leftover data..."
# BuildKit build cache
docker builder prune -af >/dev/null 2>&1 || true
# General system prune (should be mostly no-op after steps above)
docker system prune -af --volumes >/dev/null 2>&1 || true

echo "Docker CLEANUP complete"
