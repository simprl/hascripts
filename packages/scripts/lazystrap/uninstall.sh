#!/usr/bin/env bash
set -euo pipefail

echo "Lazystrap uninstall starting"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

if ! have_cmd docker; then
  echo "docker CLI not found. Nothing to uninstall."
  exit 0
fi

CONTAINER_NAME="${TARGET_CONTAINER:-lazystrap}"

echo "Stopping/removing container (if exists)..."
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
  echo "Removed container: $CONTAINER_NAME"
else
  echo "Container not found -> skipping."
fi

echo "Lazystrap uninstall complete"
