import Fastify from "fastify";
import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import * as pty from "node-pty";
import { execFile } from "node:child_process";

type ActionMap = Record<string, { name: string; path: string }[]>;
type ContainerInfo = {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
};
type ServiceStatusMap = Record<
  string,
  { installed: boolean; running: boolean; ambiguous: boolean; containers: ContainerInfo[] }
>;

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
const webDevServerUrl = process.env.WEB_DEV_SERVER_URL || "http://localhost:8323";
const useDevProxy = process.env.NODE_ENV === "development";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

if (useDevProxy) {
  await app.register(proxy, {
    upstream: webDevServerUrl,
    httpMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    websocket: true,
    http2: false
  });
} else if (existsSync(webDistRoot)) {
  await app.register(fastifyStatic, { root: webDistRoot });
  app.setNotFoundHandler((_request, reply) => {
    reply.sendFile("index.html");
  });
}

app.get("/api/health", async (_request, reply) => {
  reply.type("text/plain").send("ok");
});

app.get("/api/actions", async (_request, reply) => {
  const actions = await listActions();
  reply.send(actions);
});

app.get("/api/services", async (_request, reply) => {
  const statuses = await listServiceStatuses();
  reply.send(statuses);
});

app.post("/api/cancel", async (request, reply) => {
  const body = (request.body ?? {}) as { runId?: string };
  const runId = body.runId;

  if (!currentRun || !runId || currentRun.runId !== runId) {
    return reply.status(404).send({ ok: false, message: "No such running job." });
  }

  currentRun.killTimer = terminatePty(currentRun.pty, currentRun.killTimer);
  return reply.send({ ok: true });
});

app.post("/api/resize", async (request, reply) => {
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

app.get("/api/run", async (request, reply) => {
  const query = request.query as { cmd?: string | string[]; container?: string };
  const cmds = normalizeCmds(query.cmd);
  const targetContainer = typeof query.container === "string" ? query.container : undefined;

  const origin = request.headers.origin;
  const allowOrigin = typeof origin === "string" ? origin : "*";

  // One active run at a time (simplifies state and cancel/resize)
  const activeRun = currentRun;
  if (activeRun) {
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

      const result = await runScriptPty(scriptPath, sendEvent, targetContainer, (p, runId) => {
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
  targetContainer: string | undefined,
  onStart: (p: pty.IPty, runId: string) => void
) => {
  return new Promise<{ code: number | null; runId: string }>((resolve) => {
    const requiresSudo = isSudoScript(scriptPath);
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const useSudo = requiresSudo && !isRoot;

    const command = useSudo ? "sudo" : "bash";
    const args = useSudo ? ["-n", "bash", scriptPath] : [scriptPath];

    const runId = crypto.randomUUID();

    const env = {
      ...process.env,
      TERM: "xterm-256color",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
    };

    if (targetContainer) {
      env.TARGET_CONTAINER = targetContainer;
    }

    const p = pty.spawn(command, args, {
      cwd: path.dirname(scriptPath),
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env
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

const listServiceStatuses = async () => {
  const actions = await listActions();
  const serviceKeys = Object.keys(actions);

  const docker = await listDockerContainers();
  const statuses: ServiceStatusMap = {};

  for (const service of serviceKeys) {
    const serviceToken = normalizeToken(service);
    const matches = docker.containers.filter((item) =>
      normalizeToken(item.image).includes(serviceToken)
    );

    statuses[service] = {
      installed: matches.length > 0,
      running: matches.some((item) => item.running),
      ambiguous: matches.length > 1,
      containers: matches
    };
  }

  return {
    dockerAvailable: docker.available,
    error: docker.error ?? null,
    services: statuses
  };
};

const listDockerContainers = async () => {
  try {
    const stdout = await execFileAsync("docker", [
      "ps",
      "-a",
      "--format",
      "{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}"
    ]);

    const containers = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, image, name, status = ""] = line.split("\t");
        const running = status.startsWith("Up");
        return { id, image: stripImageTag(image), name, status, running };
      });

    return { available: true, containers, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "docker unavailable";
    return { available: false, containers: [], error: message };
  }
};

const execFileAsync = (command: string, args: string[]) => {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
};

const normalizeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const stripImageTag = (image: string) => {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) return image.slice(0, lastColon);
  return image;
};

const isSudoScript = (scriptPath: string) => {
  const dockerRoot = path.join(scriptsRoot, "docker") + path.sep;
  return scriptPath.startsWith(dockerRoot);
};

const port = Number.parseInt(process.env.PORT || "", 10);
const listenPort = Number.isFinite(port) && port > 0 ? port : 8321;

app.listen({ host: "0.0.0.0", port: listenPort }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
