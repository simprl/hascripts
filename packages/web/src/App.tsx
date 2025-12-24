import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";

type ActionMap = Record<string, { name: string; path: string }[]>;

type RunState = {
  running: boolean;
  current: string | null;
};

const fallbackActions: ActionMap = {
  home_assistant: [
    { name: "backup", path: "home_assistant/backup.sh" },
    { name: "restore", path: "home_assistant/restore.sh" }
  ],
  zigbee2mqtt: [
    { name: "backup", path: "zigbee2mqtt/backup.sh" },
    { name: "restore", path: "zigbee2mqtt/restore.sh" }
  ]
};

export default function App() {
  const [actions, setActions] = useState<ActionMap>(fallbackActions);
  const [runState, setRunState] = useState<RunState>({ running: false, current: null });
  const eventSourceRef = useRef<EventSource | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const term = new Terminal({
      convertEol: false,
      scrollback: 2000
    });
    const fitAddon = new FitAddon();
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    term.loadAddon(fitAddon);
    term.open(containerRef.current!);
    fitAddon.fit();
    term.writeln("Ready. Select an action to run.");

    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`${API_BASE}/actions`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Bad response"))))
      .then((data) => {
        if (data && typeof data === "object") {
          setActions(data as ActionMap);
        }
      })
      .catch(() => {
        setActions(fallbackActions);
      });

    return () => controller.abort();
  }, []);

  const groupedActions = useMemo(() => Object.entries(actions), [actions]);

  const startRun = (cmds: string[], label: string) => {
    if (!terminalRef.current) return;
    stopRun();

    const params = new URLSearchParams();
    cmds.forEach((cmd) => params.append("cmd", cmd));
    const url = `${API_BASE}/run?${params.toString()}`;

    const term = terminalRef.current;
    term.reset();
    term.writeln(`Starting: ${label}`);

    const source = new EventSource(url);
    eventSourceRef.current = source;
    setRunState({ running: true, current: label });

    const handleStatus = (event: MessageEvent) => {
      const payload = parsePayload(event.data);
      if (payload) {
        term.writeln(payload.message);
      } else {
        term.writeln(event.data);
      }
    };

    source.addEventListener("info", handleStatus);
    source.addEventListener("step_start", handleStatus);
    source.addEventListener("step_end", handleStatus);
    source.addEventListener("done", (event) => {
      handleStatus(event as MessageEvent);
      stopRun();
    });
    source.addEventListener("error", (event) => {
      handleStatus(event as MessageEvent);
      stopRun();
    });

    source.addEventListener("chunk", (event) => {
      const payload = parsePayload(event.data);
      if (!payload || !("b64" in payload)) return;
      const text = decodeBase64(payload.b64 as string);
      terminalRef.current?.write(text);
    });
  };

  const stopRun = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setRunState({ running: false, current: null });
  };

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Ops UI</p>
          <h1 className="text-2xl font-semibold text-white">Script Runner</h1>
        </div>
        <div className="text-right text-sm text-slate-300">
          {runState.running ? "Running" : "Idle"}
          {runState.current ? `: ${runState.current}` : ""}
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <aside className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg">
          <h2 className="mb-4 text-lg font-semibold text-white">Actions</h2>
          <div className="space-y-4">
            {groupedActions.map(([service, items]) => (
              <section key={service}>
                <h3 className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                  {service.replace(/_/g, " ")}
                </h3>
                <div className="flex flex-col gap-2">
                  {items.map((item) => (
                    <button
                      key={item.path}
                      className="rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-left text-sm text-slate-100 transition hover:border-lake hover:text-white"
                      onClick={() => startRun([item.path], `${service} ${item.name}`)}
                      disabled={runState.running}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <button
            className="mt-6 w-full rounded-lg bg-lake px-3 py-2 text-sm font-semibold text-ink transition hover:brightness-110"
            onClick={() =>
              startRun(
                ["home_assistant/backup.sh", "zigbee2mqtt/backup.sh"],
                "Run group"
              )
            }
            disabled={runState.running}
          >
            Run group
          </button>

          <button
            className="mt-3 w-full rounded-lg border border-flame px-3 py-2 text-sm font-semibold text-flame transition hover:bg-flame hover:text-white"
            onClick={stopRun}
            disabled={!runState.running}
          >
            Cancel
          </button>
        </aside>

        <main className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 shadow-lg">
          <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-400">
            <span>Console output</span>
            <span>{runState.running ? "Streaming" : "Waiting"}</span>
          </div>
          <div
            ref={containerRef}
            className="h-[60vh] w-full overflow-hidden rounded-xl border border-slate-800 bg-black/60"
          />
        </main>
      </div>
    </div>
  );
}

const parsePayload = (data: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const decodeBase64 = (b64: string) => {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};