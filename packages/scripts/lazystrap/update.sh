#!/usr/bin/env bash
set -euo pipefail

echo "Lazystrap update starting"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

if ! have_cmd docker; then
  echo "docker CLI not found. Is Docker installed?"
  exit 1
fi

CONTAINER_NAME="${TARGET_CONTAINER:-lazystrap}"

if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Container '$CONTAINER_NAME' not found."
  exit 1
fi

IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [[ -z "$IMAGE" ]]; then
  echo "Failed to determine image for '$CONTAINER_NAME'."
  exit 1
fi

echo "Pulling image: $IMAGE"
docker pull "$IMAGE" >/dev/null

echo "Restarting container: $CONTAINER_NAME"
docker restart "$CONTAINER_NAME" >/dev/null

echo "Done. Current status:"
docker ps --filter "name=^/${CONTAINER_NAME}$" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

echo "Lazystrap update complete"
