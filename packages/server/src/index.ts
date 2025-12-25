import Fastify from "fastify";
import cors from "@fastify/cors";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const scriptsRoot = path.join(repoRoot, "packages", "scripts");

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/health", async (_request, reply) => {
  reply.type("text/plain").send("ok");
});

app.get("/actions", async (_request, reply) => {
  const actions = await listActions();
  reply.send(actions);
});

app.get("/run", async (request, reply) => {
  const query = request.query as { cmd?: string | string[] };
  const cmds = normalizeCmds(query.cmd);
  const origin = request.headers.origin;
  const allowOrigin = typeof origin === "string" ? origin : "*";

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": allowOrigin,
    Vary: "Origin",
    "X-Accel-Buffering": "no"
  });
  reply.raw.flushHeaders();

  let closed = false;
  let currentChild: ReturnType<typeof spawn> | null = null;
  let killTimer: NodeJS.Timeout | null = null;

  const closeHandler = () => {
    closed = true;
    if (currentChild) {
      killTimer = terminateChild(currentChild, killTimer);
    }
  };

  request.raw.on("close", closeHandler);

  const sendEvent = (event: string, data: unknown) => {
    if (closed) return;
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

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

      const result = await runScript(scriptPath, sendEvent, (child) => {
        currentChild = child;
      });

      currentChild = null;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }

      if (result.code === 0) {
        sendEvent("step_end", { message: `Finished with code ${result.code}` });
      } else {
        sendEvent("step_end", { message: `Finished with code ${result.code}` });
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
  }
});

const normalizeCmds = (cmd?: string | string[]) => {
  if (!cmd) return [];
  return Array.isArray(cmd) ? cmd : [cmd];
};

const resolveScript = (cmd: string) => {
  if (path.isAbsolute(cmd)) {
    throw new Error("cmd must be a relative path.");
  }
  if (!cmd.endsWith(".sh")) {
    throw new Error("cmd must end with .sh.");
  }
  if (cmd.includes("..")) {
    throw new Error("cmd must not include ..");
  }

  const resolved = path.resolve(scriptsRoot, cmd);
  if (!resolved.startsWith(scriptsRoot + path.sep)) {
    throw new Error("cmd must resolve under scripts root.");
  }
  return resolved;
};

const runScript = (
  scriptPath: string,
  sendEvent: (event: string, data: unknown) => void,
  onStart: (child: ReturnType<typeof spawn>) => void
) => {
  return new Promise<{ code: number | null }>((resolve) => {
    const child = spawn("bash", [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: process.env
    });

    onStart(child);

    child.stdout.on("data", (data: Buffer) => {
      sendEvent("chunk", { stream: "stdout", b64: data.toString("base64") });
    });

    child.stderr.on("data", (data: Buffer) => {
      sendEvent("chunk", { stream: "stderr", b64: data.toString("base64") });
    });

    child.on("close", (code) => {
      resolve({ code });
    });
  });
};

const terminateChild = (child: ReturnType<typeof spawn>, timer: NodeJS.Timeout | null) => {
  if (timer) clearTimeout(timer);
  child.kill("SIGTERM");
  const nextTimer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 3000);
  return nextTimer;
};

const listActions = async () => {
  const entries = await fs.readdir(scriptsRoot, { withFileTypes: true });
  const result: Record<string, { name: string; path: string }[]> = {};

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

    if (actions.length > 0) {
      result[entry.name] = actions;
    }
  }

  return result;
};

app.listen({ host: "0.0.0.0", port: 8080 }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
