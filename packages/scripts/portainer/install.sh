#!/usr/bin/env bash
set -euo pipefail

echo "Portainer install starting (idempotent)"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

if ! have_cmd docker; then
  echo "docker CLI not found. Install Docker first."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not reachable. Is docker running?"
  exit 1
fi

CONTAINER_NAME="portainer"
VOLUME_NAME="portainer_data"
IMAGE="portainer/portainer-ce:latest"

echo "[1/5] Ensuring volume exists..."
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  docker volume create "$VOLUME_NAME" >/dev/null
  echo "Created volume: $VOLUME_NAME"
else
  echo "Volume exists: $VOLUME_NAME"
fi

echo "[2/5] Checking existing container..."
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Container exists: $CONTAINER_NAME"

  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo "Container is already running."
  else
    echo "Starting existing container..."
    docker start "$CONTAINER_NAME" >/dev/null
  fi

  echo "Portainer install complete (skipped create)"
  exit 0
fi

echo "[3/5] Pulling image..."
docker pull "$IMAGE" >/dev/null

echo "[4/5] Creating and starting container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart=always \
  -p 9000:9000 \
  -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${VOLUME_NAME}:/data" \
  "$IMAGE" >/dev/null

echo "[5/5] Status..."
docker ps --filter "name=^/${CONTAINER_NAME}$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo "Portainer install complete"
