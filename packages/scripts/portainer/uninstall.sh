#!/usr/bin/env bash
set -euo pipefail

# ============================
# Set to 1 to REMOVE Portainer data (volume portainer_data)
# ============================
WIPE_DATA=0

echo "Portainer uninstall starting"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

if ! have_cmd docker; then
  echo "docker CLI not found. Nothing to uninstall."
  exit 0
fi

CONTAINER_NAME="portainer"
VOLUME_NAME="portainer_data"

echo "[1/4] Stopping/removing container (if exists)..."
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
  echo "Removed container: $CONTAINER_NAME"
else
  echo "Container not found -> skipping."
fi

echo "[2/4] Removing image (best effort)..."
# Only remove if present; ignore failures (might be used by other tags)
docker image rm -f portainer/portainer-ce:latest >/dev/null 2>&1 || true

echo "[3/4] Data cleanup..."
if [[ "$WIPE_DATA" == "1" ]]; then
  if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    docker volume rm -f "$VOLUME_NAME" >/dev/null
    echo "Removed volume: $VOLUME_NAME"
  else
    echo "Volume not found -> skipping."
  fi
else
  echo "WIPE_DATA=0 -> keeping volume: $VOLUME_NAME"
  echo "If you want to remove Portainer data, edit this script and set WIPE_DATA=1."
fi

echo "[4/4] Done."
echo "Portainer uninstall complete"
