import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import * as pty from "node-pty";

type ActionMap = Record<string, { name: string; path: string }[]>;

type RunState = {
  runId: string;
  ownerId: string; // identifies SSE connection that started the run
  scriptPath: string;

  pty: pty.IPty;
  killTimer: NodeJS.Timeout | null;

  logChunks: Buffer[];
  logBytes: number;

  startedAt: number;
};

const MAX_LOG_BYTES = 500 * 1024; // 500KB
const STEP_LOG_TAIL_CHARS = 50_000;
const SSE_HEARTBEAT_MS = 15_000;

let currentRun: RunState | null = null;

function appendLog(state: RunState, text: string) {
  const buf = Buffer.from(text, "utf8");
  state.logChunks.push(buf);
  state.logBytes += buf.length;

  while (state.logBytes > MAX_LOG_BYTES && state.logChunks.length > 1) {
    const first = state.logChunks.shift()!;
    state.logBytes -= first.length;
  }
}

function getLogText(state: RunState) {
  return Buffer.concat(state.logChunks, state.logBytes).toString("utf8");
}

const terminatePty = (p: pty.IPty, timer: NodeJS.Timeout | null) => {
  if (timer) clearTimeout(timer);

  try {
    p.kill("SIGTERM");
  } catch {
    // ignore
  }

  const nextTimer = setTimeout(() => {
    try {
      p.kill("SIGKILL");
    } catch {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 3000);

  return nextTimer;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const scriptsRoot = path.join(repoRoot, "packages", "scripts");
const webDistRoot = path.join(repoRoot, "packages", "web", "dist");

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

if (existsSync(webDistRoot)) {
  await app.register(fastifyStatic, { root: webDistRoot });
  app.setNotFoundHandler((_request, reply) => {
    reply.sendFile("index.html");
  });
}

app.get("/health", async (_request, reply) => {
  reply.type("text/plain").send("ok");
});

app.get("/actions", async (_request, reply) => {
  const actions = await listActions();
  reply.send(actions);
});

app.post("/cancel", async (request, reply) => {
  const body = (request.body ?? {}) as { runId?: string };
  const runId = body.runId;

  if (!currentRun || !runId || currentRun.runId !== runId) {
    return reply.status(404).send({ ok: false, message: "No such running job." });
  }

  currentRun.killTimer = terminatePty(currentRun.pty, currentRun.killTimer);
  return reply.send({ ok: true });
});

app.post("/resize", async (request, reply) => {
  const body = (request.body ?? {}) as { runId?: string; cols?: number; rows?: number };
  const { runId, cols, rows } = body;

  if (!currentRun || !runId || currentRun.runId !== runId) {
    return reply.status(404).send({ ok: false, message: "No such running job." });
  }

  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return reply.status(400).send({ ok: false, message: "cols/rows must be numbers." });
  }

  const c = Math.max(20, Math.floor(cols!));
  const r = Math.max(5, Math.floor(rows!));

  try {
    currentRun.pty.resize(c, r);
    return reply.send({ ok: true });
  } catch {
    return reply.status(500).send({ ok: false, message: "resize failed" });
  }
});

app.get("/run", async (request, reply) => {
  const query = request.query as { cmd?: string | string[] };
  const cmds = normalizeCmds(query.cmd);

  const origin = request.headers.origin;
  const allowOrigin = typeof origin === "string" ? origin : "*";

  // One active run at a time (simplifies state and cancel/resize)
  if (currentRun) {
    reply.raw.writeHead(409, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
      Vary: "Origin",
      "X-Accel-Buffering": "no"
    });
    reply.hijack();
    reply.raw.flushHeaders();
    reply.raw.write(`event: error\n`);
    reply.raw.write(`data: ${JSON.stringify({ message: "Another run is already in progress." })}\n\n`);
    reply.raw.end();
    return;
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": allowOrigin,
    Vary: "Origin",
    "X-Accel-Buffering": "no"
  });

  // prevent Fastify from auto-managing response
  reply.hijack();
  reply.raw.flushHeaders();

  const ownerId = crypto.randomUUID();
  let closed = false;

  const sendEvent = (event: string, data: unknown) => {
    if (closed) return;
    try {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // if write fails, treat as closed
      closed = true;
    }
  };

  // Heartbeat to keep SSE alive through proxies
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      reply.raw.write(`: ping\n\n`);
    } catch {
      closed = true;
    }
  }, SSE_HEARTBEAT_MS);

  const closeHandler = () => {
    closed = true;
    clearInterval(heartbeat);

    // If this connection owns the current run, terminate it.
    if (currentRun && currentRun.ownerId === ownerId) {
      currentRun.killTimer = terminatePty(currentRun.pty, currentRun.killTimer);
      // Do not set currentRun = null here; wait for onExit cleanup
    }
  };

  request.raw.on("close", closeHandler);

  try {
    if (cmds.length === 0) {
      sendEvent("error", { message: "No cmd query parameters provided." });
      reply.raw.end();
      return;
    }

    const resolved = cmds.map((cmd) => resolveScript(cmd));
    sendEvent("info", { message: `Starting run with ${resolved.length} step(s).` });

    for (const scriptPath of resolved) {
      if (closed) break;

      sendEvent("step_start", { message: `Running ${path.relative(scriptsRoot, scriptPath)}` });

      const result = await runScriptPty(scriptPath, sendEvent, (p, runId) => {
        currentRun = {
          runId,
          ownerId,
          scriptPath,
          pty: p,
          killTimer: null,
          logChunks: [],
          logBytes: 0,
          startedAt: Date.now()
        };

        sendEvent("run_id", { runId });
      });

      // capture logs before clearing state
      const run = currentRun && currentRun.runId === result.runId ? currentRun : null;
      const logText = run ? getLogText(run) : "";
      const tail = logText.length > STEP_LOG_TAIL_CHARS ? logText.slice(-STEP_LOG_TAIL_CHARS) : logText;

      sendEvent("step_end", {
        message: `Finished with code ${result.code}`,
        code: result.code,
        logTailB64: Buffer.from(tail, "utf8").toString("base64")
      });

      // cleanup run state for next step / future run
      if (currentRun && currentRun.runId === result.runId) {
        if (currentRun.killTimer) {
          clearTimeout(currentRun.killTimer);
        }
        currentRun = null;
      }

      if (result.code !== 0) {
        sendEvent("error", { message: "Stopping due to non-zero exit code." });
        break;
      }
    }

    if (!closed) {
      sendEvent("done", { message: "Run complete." });
      reply.raw.end();
    }
  } catch (error) {
    if (!closed) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendEvent("error", { message });
      reply.raw.end();
    }
  } finally {
    clearInterval(heartbeat);

    // If something threw mid-run and state still belongs to this connection, terminate & clear
    if (currentRun && currentRun.ownerId === ownerId) {
      currentRun.killTimer = terminatePty(currentRun.pty, currentRun.killTimer);
      // give onExit a chance, but clear anyway to avoid lock
      if (currentRun.killTimer) clearTimeout(currentRun.killTimer);
      currentRun = null;
    }
  }
});

const normalizeCmds = (cmd?: string | string[]) => {
  if (!cmd) return [];
  return Array.isArray(cmd) ? cmd : [cmd];
};

const resolveScript = (cmd: string) => {
  if (path.isAbsolute(cmd)) throw new Error("cmd must be a relative path.");
  if (!cmd.endsWith(".sh")) throw new Error("cmd must end with .sh.");
  if (cmd.includes("..")) throw new Error("cmd must not include ..");

  const resolved = path.resolve(scriptsRoot, cmd);
  if (!resolved.startsWith(scriptsRoot + path.sep)) {
    throw new Error("cmd must resolve under scripts root.");
  }
  return resolved;
};

const runScriptPty = (
  scriptPath: string,
  sendEvent: (event: string, data: unknown) => void,
  onStart: (p: pty.IPty, runId: string) => void
) => {
  return new Promise<{ code: number | null; runId: string }>((resolve) => {
    const requiresSudo = isSudoScript(scriptPath);
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const useSudo = requiresSudo && !isRoot;

    const command = useSudo ? "sudo" : "bash";
    const args = useSudo ? ["-n", "bash", scriptPath] : [scriptPath];

    const runId = crypto.randomUUID();

    const p = pty.spawn(command, args, {
      cwd: path.dirname(scriptPath),
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
      }
    });

    onStart(p, runId);

    p.onData((text: string) => {
      sendEvent("chunk", {
        stream: "pty",
        b64: Buffer.from(text, "utf8").toString("base64")
      });

      if (currentRun && currentRun.runId === runId) {
        appendLog(currentRun, text);
      }
    });

    p.onExit(({ exitCode }) => {
      resolve({ code: typeof exitCode === "number" ? exitCode : null, runId });
    });
  });
};

const listActions = async (): Promise<ActionMap> => {
  const entries = await fs.readdir(scriptsRoot, { withFileTypes: true });
  const result: ActionMap = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const serviceDir = path.join(scriptsRoot, entry.name);
    const files = await fs.readdir(serviceDir, { withFileTypes: true });

    const actions = files
      .filter((file) => file.isFile() && file.name.endsWith(".sh"))
      .map((file) => ({
        name: file.name.replace(/\.sh$/, ""),
        path: path.posix.join(entry.name, file.name)
      }));

    if (actions.length > 0) result[entry.name] = actions;
  }

  return result;
};

const isSudoScript = (scriptPath: string) => {
  const dockerRoot = path.join(scriptsRoot, "docker") + path.sep;
  return scriptPath.startsWith(dockerRoot);
};

app.listen({ host: "0.0.0.0", port: 8080 }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
