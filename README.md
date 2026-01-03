# hascripts

Web UI to run local shell scripts and stream console output via SSE.

## Prerequisites
- Node.js 20+
- npm 9+

## Install
```
npm install
```

## Dev
```
npm run dev
```
- App: http://localhost:8322 (backend proxies to the Vite dev server)
- API base defaults to `/api`; set `VITE_API_BASE` to override.
- To change the proxy target, set `WEB_DEV_SERVER_URL` (default: `http://localhost:8323`).

## Dev (root backend for Docker scripts)
Use this when you need Docker install/uninstall to run without sudo prompts.
```
sudo -E npm run dev -w @hascripts/server
npm run dev -w @hascripts/web
```
- App: http://localhost:8322

## Run a group of scripts
Click **Run group** in the UI to run multiple scripts sequentially.

## Test locally
- Run the dev servers: `npm run dev`
- Open the web UI: http://localhost:5173
- Use the new **docker** group to run `install` or `uninstall`.
- Optional API check: `curl -N "http://localhost:8321/api/run?cmd=docker/install.sh"`
- If you run the server as a non-root user, configure sudo (see below) so the Docker scripts can run.

## Production install (Debian)
This installs the service to `/opt/hascripts` and serves the built frontend from the backend.
```
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | REPO=<owner>/<repo> bash
```
- Service: `hascripts` (systemd)
- App URL: http://localhost:8321
- Logs: `journalctl -u hascripts -f`

## Production uninstall (Debian)
```
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/uninstall.sh | bash
```

## Sudo setup for Docker scripts (Debian)
The Docker scripts run with `sudo -n` (non-interactive) when the server is not root. Add a sudoers
entry so the server user can run the Docker scripts without a password prompt. If the service runs
as root (production install), this is not needed.

1) Create a sudoers file (replace `<repo>` with your repo path):
```
sudo visudo -f /etc/sudoers.d/hascripts-docker
```
2) Add:
```
%sudo ALL=(root) NOPASSWD: /bin/bash <repo>/packages/scripts/docker/install.sh, /bin/bash <repo>/packages/scripts/docker/uninstall.sh
```
3) Ensure permissions:
```
sudo chmod 440 /etc/sudoers.d/hascripts-docker
```

## Security note
Scripts execute on the same host as the server. Keep this local or behind a VPN.
