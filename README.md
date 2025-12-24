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
- Server: http://localhost:8080
- Web: http://localhost:5173

## Run a group of scripts
Click **Run group** in the UI to run multiple scripts sequentially.

## Security note
Scripts execute on the same host as the server. Keep this local or behind a VPN.
