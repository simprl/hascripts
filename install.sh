#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

REPO="${REPO:-}"
REF="${REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/hascripts}"
SERVICE_NAME="${SERVICE_NAME:-hascripts}"

if [[ -z "$REPO" ]]; then
  echo "Set REPO (e.g. REPO=owner/repo) to install."
  exit 1
fi

echo "Installing hascripts from ${REPO}@${REF} into ${INSTALL_DIR}"

apt-get update
apt-get install -y ca-certificates curl gnupg tar

if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    | tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  apt-get update
  apt-get install -y nodejs
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz" -o "${tmpdir}/hascripts.tgz"
rm -rf "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
tar -xzf "${tmpdir}/hascripts.tgz" -C "${INSTALL_DIR}" --strip-components=1

cd "${INSTALL_DIR}"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

npm run build

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=hascripts service
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/packages/server
ExecStart=/usr/bin/node ${INSTALL_DIR}/packages/server/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "Install complete. Service is running on http://localhost:8321"
