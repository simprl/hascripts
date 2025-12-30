#!/usr/bin/env bash
set -euo pipefail

echo "Docker uninstall-if-empty starting"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none

APT_GET=(apt-get -y)
APT_OPTS=(
  "-o" "Dpkg::Use-Pty=0"
  "-o" "APT::Color=0"
)

have_cmd() { command -v "$1" >/dev/null 2>&1; }

is_pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"
}

remove_if_installed() {
  local pkgs=("$@")
  local to_remove=()
  local p
  for p in "${pkgs[@]}"; do
    if is_pkg_installed "$p"; then
      to_remove+=("$p")
    fi
  done
  if ((${#to_remove[@]} > 0)); then
    echo "Purging packages: ${to_remove[*]}"
    "${APT_GET[@]}" "${APT_OPTS[@]}" purge "${to_remove[@]}"
  else
    echo "No target packages installed -> skipping purge."
  fi
}

echo "[1/5] Checking for existing containers..."
if have_cmd docker; then
  # If this returns any IDs, we refuse to uninstall.
  if docker ps -aq | grep -q .; then
    echo "Refusing to uninstall: Docker has containers (including stopped ones)."
    echo "Remove containers first, or use the FULL WIPE script."
    exit 2
  fi
else
  echo "docker CLI not found. Will proceed with package cleanup only."
fi

echo "[2/5] Stopping services (best effort)..."
if have_cmd systemctl; then
  systemctl stop docker.service docker.socket containerd.service >/dev/null 2>&1 || true
  systemctl disable docker.service docker.socket >/dev/null 2>&1 || true
elif have_cmd service; then
  service docker stop >/dev/null 2>&1 || true
  service containerd stop >/dev/null 2>&1 || true
fi

echo "[3/5] Purging Docker packages..."
DOCKER_PKGS=(
  docker-ce
  docker-ce-cli
  docker-ce-rootless-extras
  docker-buildx-plugin
  docker-compose-plugin
  containerd.io
)
ALT_PKGS=(
  docker.io
  docker-compose
  containerd
  runc
)
remove_if_installed "${DOCKER_PKGS[@]}"
remove_if_installed "${ALT_PKGS[@]}"

echo "[4/5] Removing Docker apt repo & key (best effort)..."
rm -f /etc/apt/sources.list.d/docker.list \
      /etc/apt/sources.list.d/docker-ce.list \
      /etc/apt/sources.list.d/*docker*.list 2>/dev/null || true

if [[ -f /etc/apt/sources.list ]]; then
  sed -i.bak '/download\.docker\.com/d' /etc/apt/sources.list || true
fi

rm -f /etc/apt/keyrings/docker.gpg 2>/dev/null || true

echo "[5/5] Autoremove & update..."
"${APT_GET[@]}" "${APT_OPTS[@]}" autoremove --purge
"${APT_GET[@]}" "${APT_OPTS[@]}" update

echo "Docker uninstall-if-empty complete"
