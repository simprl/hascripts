#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (use sudo)."
  exit 1
fi

INSTALL_DIR="${INSTALL_DIR:-/opt/lazystrap}"
SERVICE_NAME="${SERVICE_NAME:-lazystrap}"

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  systemctl disable --now "${SERVICE_NAME}" || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
fi

rm -rf "${INSTALL_DIR}"

echo "Uninstall complete."
