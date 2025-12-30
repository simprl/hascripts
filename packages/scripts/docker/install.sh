#!/usr/bin/env bash
set -euo pipefail

echo "Docker install starting (non-interactive, idempotent)"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

. /etc/os-release
DISTRO_ID="${ID:-}"
CODENAME="${VERSION_CODENAME:-}"

if [[ -z "$DISTRO_ID" || -z "$CODENAME" ]]; then
  echo "Cannot detect distro/codename from /etc/os-release."
  exit 1
fi

case "$DISTRO_ID" in
  ubuntu|debian) ;;
  *)
    echo "Unsupported distro: $DISTRO_ID (only ubuntu/debian supported)."
    exit 1
    ;;
esac

echo "Detected: ${DISTRO_ID} ${CODENAME}"

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export APT_LISTCHANGES_FRONTEND=none

APT_GET=(apt-get -y)
DPKG_OPTS=(
  "-o" "Dpkg::Options::=--force-confdef"
  "-o" "Dpkg::Options::=--force-confold"
)
APT_OPTS=(
  "-o" "Dpkg::Use-Pty=0"
  "-o" "APT::Color=0"
)

have_cmd() { command -v "$1" >/dev/null 2>&1; }

is_pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"
}

all_pkgs_installed() {
  local pkgs=("$@")
  local p
  for p in "${pkgs[@]}"; do
    if ! is_pkg_installed "$p"; then
      return 1
    fi
  done
  return 0
}

BASE_PKGS=(ca-certificates curl gnupg)
DOCKER_PKGS=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

# Fast-path: already installed and docker works
if have_cmd docker && docker --version >/dev/null 2>&1; then
  echo "Docker appears to be installed: $(docker --version)"
  # Still ensure service is started (best effort) but do not reinstall
  echo "Ensuring Docker service is running (best effort)..."
  if have_cmd systemctl; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  elif have_cmd service; then
    service docker start >/dev/null 2>&1 || true
  fi
  echo "Docker install complete (skipped install)"
  exit 0
fi

need_update=0

echo "[1/7] Ensuring base dependencies..."
if ! all_pkgs_installed "${BASE_PKGS[@]}"; then
  echo "Base dependencies missing -> will install."
  need_update=1
else
  echo "Base dependencies already installed -> skipping."
fi

echo "[2/7] Ensuring keyring directory..."
install -m 0755 -d /etc/apt/keyrings

echo "[3/7] Ensuring Docker GPG key..."
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  echo "Docker key not found -> downloading."
  tmp_key="$(mktemp)"
  curl --fail --show-error --location \
    --connect-timeout 10 --max-time 60 \
    --retry 5 --retry-delay 2 \
    "https://download.docker.com/linux/${DISTRO_ID}/gpg" \
    | gpg --batch --yes --dearmor -o "$tmp_key"
  install -m 0644 "$tmp_key" /etc/apt/keyrings/docker.gpg
  rm -f "$tmp_key"
  need_update=1
else
  echo "Docker key already exists -> skipping."
fi

ARCH="$(dpkg --print-architecture)"

echo "[4/7] Ensuring Docker apt repo..."
repo_file="/etc/apt/sources.list.d/docker.list"
repo_line="deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO_ID} ${CODENAME} stable"

if [[ ! -f "$repo_file" ]] || ! grep -qF "download.docker.com/linux/${DISTRO_ID} ${CODENAME} stable" "$repo_file"; then
  echo "Docker repo missing or different -> writing."
  printf "%s\n" "$repo_line" | tee "$repo_file" >/dev/null
  need_update=1
else
  echo "Docker repo already configured -> skipping."
fi

echo "[5/7] apt-get update (if needed)..."
if [[ "$need_update" -eq 1 ]]; then
  "${APT_GET[@]}" "${APT_OPTS[@]}" update
else
  echo "No changes requiring apt-get update -> skipping."
fi

echo "[6/7] Installing base dependencies (if needed)..."
if ! all_pkgs_installed "${BASE_PKGS[@]}"; then
  "${APT_GET[@]}" "${APT_OPTS[@]}" "${DPKG_OPTS[@]}" install "${BASE_PKGS[@]}"
else
  echo "Base dependencies already installed -> skipping."
fi

echo "[7/7] Installing Docker packages (if needed)..."
if ! all_pkgs_installed "${DOCKER_PKGS[@]}"; then
  "${APT_GET[@]}" "${APT_OPTS[@]}" "${DPKG_OPTS[@]}" install "${DOCKER_PKGS[@]}"
else
  echo "Docker packages already installed -> skipping."
fi

echo "Starting Docker service (best effort)..."
if have_cmd systemctl; then
  systemctl enable --now docker >/dev/null 2>&1 || echo "systemctl failed (likely no systemd)."
elif have_cmd service; then
  service docker start >/dev/null 2>&1 || true
fi

# Final verification (non-fatal if docker daemon not running in containers)
if have_cmd docker; then
  echo "Docker installed: $(docker --version)"
else
  echo "Docker binary not found after install (unexpected)."
  exit 1
fi

echo "Docker install complete"
