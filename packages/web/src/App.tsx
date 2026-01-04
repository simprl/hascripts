import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { LANGUAGES } from "./i18n/TextProvider";
import { useLanguage, useText } from "./i18n/useText";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/+$/, "");

const apiUrl = (path: string) => {
  if (path.startsWith("/")) return `${API_BASE}${path}`;
  return `${API_BASE}/${path}`;
};

type ActionMap = Record<string, { name: string; path: string }[]>;
type ServiceStatus = {
  installed: boolean;
  running: boolean;
  ambiguous: boolean;
  containers: {
    id: string;
    name: string;
    image: string;
    status: string;
    running: boolean;
  }[];
};
type ServiceStatusResponse = {
  dockerAvailable: boolean;
  error: string | null;
  services: Record<string, ServiceStatus>;
};

type RunState = {
  running: boolean;
  current: string | null;
  serviceKey: string | null;
  runId: string | null;
};
type ServiceStatusKey = "installed" | "running" | "not_installed" | "multiple";

const fallbackActions: ActionMap = {};
const ALL_SERVICES_KEY = "__all__";

export default function App() {
  const text = useText();
  const { lang, setLang } = useLanguage();
  const [actions, setActions] = useState<ActionMap>(fallbackActions);
  const [serviceStatuses, setServiceStatuses] = useState<Record<string, ServiceStatus>>({});
  const [runState, setRunState] = useState<RunState>({
    running: false,
    current: null,
    serviceKey: null,
    runId: null
  });
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [consoleVisible, setConsoleVisible] = useState(false);
  const [refreshingStatuses, setRefreshingStatuses] = useState(false);
  const [selectedContainers, setSelectedContainers] = useState<Record<string, string>>({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const runIdRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const term = new Terminal({
      // With PTY output, keep raw control sequences and line endings intact
      convertEol: false,
      scrollback: 2000
    });

    const fitAddon = new FitAddon();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    term.loadAddon(fitAddon);
    term.open(containerRef.current!);
    fitAddon.fit();
    term.writeln(text.readyMessage);

    const scheduleResize = () => {
      const t = terminalRef.current;
      const f = fitAddonRef.current;
      if (!t || !f) return;

      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);

      resizeTimerRef.current = window.setTimeout(() => {
        try {
          f.fit();
        } catch {
          // ignore transient layout errors
        }

        const runId = runIdRef.current;
        if (!runId) return;

        void fetch(`${API_BASE}/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, cols: t.cols, rows: t.rows })
        }).catch(() => {
          // non-fatal
        });
      }, 150);
    };

    // Observe terminal container size changes (better than only window resize)
    const ro = new ResizeObserver(() => scheduleResize());
    resizeObserverRef.current = ro;
    if (containerRef.current) ro.observe(containerRef.current);

    const handleWindowResize = () => scheduleResize();
    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
      ro.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch(apiUrl("/actions"), { signal: controller.signal })
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

  const loadStatuses = useCallback(
    (signal?: AbortSignal) => {
      setRefreshingStatuses(true);
      return fetch(apiUrl("/services"), { signal })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Bad response"))))
        .then((data: ServiceStatusResponse) => {
          if (data && typeof data === "object") {
            setServiceStatuses(data.services ?? {});
          }
        })
        .catch(() => {})
        .finally(() => {
          setRefreshingStatuses(false);
        });
    },
    [setServiceStatuses]
  );

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();

    const tick = () => {
      if (stopped) return;
      void loadStatuses(controller.signal);
    };

    tick();
    const timer = window.setInterval(tick, 10_000);

    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadStatuses]);

  const serviceKeys = useMemo(() => Object.keys(actions).sort(), [actions]);
  const installedServiceKeys = useMemo(
    () =>
      serviceKeys.filter((service) => {
        const status = serviceStatuses[service];
        return (status?.installed ?? true) && !(status?.ambiguous ?? false);
      }),
    [serviceKeys, serviceStatuses]
  );
  const allServicesStatus = useMemo<ServiceStatusKey>(() => {
    if (installedServiceKeys.length === 0) return "not_installed";
    const anyRunning = installedServiceKeys.some(
      (service) => serviceStatuses[service]?.running
    );
    return anyRunning ? "running" : "installed";
  }, [installedServiceKeys, serviceStatuses]);

  useEffect(() => {
    if (selectedService) return;
    if (serviceKeys.length > 0) setSelectedService(ALL_SERVICES_KEY);
  }, [selectedService, serviceKeys]);

  const commonActions = useMemo(() => {
    if (installedServiceKeys.length === 0) return [];

    let intersection = new Set(
      actions[installedServiceKeys[0]]?.map((item) => item.name) ?? []
    );
    for (const service of installedServiceKeys.slice(1)) {
      const names = new Set(actions[service]?.map((item) => item.name) ?? []);
      intersection = new Set([...intersection].filter((name) => names.has(name)));
    }

    return [...intersection]
      .sort()
      .map((name) => ({
        name,
        paths: installedServiceKeys
          .map((service) => actions[service]?.find((item) => item.name === name)?.path)
          .filter((path): path is string => typeof path === "string")
      }));
  }, [actions, installedServiceKeys]);

  const startRun = (
    cmds: string[],
    label: string,
    serviceKey: string,
    containerName?: string
  ) => {
    const term = terminalRef.current;
    if (!term) return;

    stopRun();

    const params = new URLSearchParams();
    cmds.forEach((cmd) => params.append("cmd", cmd));
    if (containerName) params.append("container", containerName);
    const url = `${apiUrl("/run")}?${params.toString()}`;

    term.reset();
    term.writeln(text.starting(label));

    const source = new EventSource(url);
    eventSourceRef.current = source;

    runIdRef.current = null;
    setRunState({ running: true, current: label, serviceKey, runId: null });
    setConsoleVisible(true);

    const handleStatus = (event: MessageEvent) => {
      const payload = parsePayload(event.data);
      const message =
        payload && typeof payload.message === "string" ? payload.message : String(event.data);
      term.writeln(message);
    };

    source.addEventListener("info", handleStatus);
    source.addEventListener("step_start", handleStatus);
    source.addEventListener("step_end", handleStatus);

    // Receive run_id from backend and store it for resize/cancel
    source.addEventListener("run_id", (event) => {
      const payload = parsePayload(event.data);
      const runId = payload?.runId;

      if (typeof runId !== "string" || runId.length === 0) return;

      runIdRef.current = runId;
      setRunState((s) => ({ ...s, runId }));

      // trigger an initial resize sync
      const f = fitAddonRef.current;
      if (f) {
        try {
          f.fit();
        } catch {
          // ignore
        }
      }

      const t = terminalRef.current;
      if (t) {
        void fetch(apiUrl("/resize"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, cols: t.cols, rows: t.rows })
        }).catch(() => {});
      }
    });

    source.addEventListener("done", (event) => {
      handleStatus(event as MessageEvent);
      stopRun();
    });

    source.addEventListener("error", (event) => {
      // SSE error payload can be empty / non-JSON
      handleStatus(event as MessageEvent);
      stopRun();
    });

    source.addEventListener("chunk", (event) => {
      const payload = parsePayload(event.data);
      const b64 = payload?.b64;
      if (typeof b64 !== "string") return;

      // Write bytes to preserve PTY control sequences
      const bytes = b64ToUint8(b64);
      terminalRef.current?.write(bytes);
    });
  };

  const cancelRun = async () => {
    const runId = runIdRef.current;

    if (runId) {
      await fetch(apiUrl("/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId })
      }).catch(() => {});
    }

    stopRun();
  };

  const stopRun = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    runIdRef.current = null;
    setRunState({ running: false, current: null, serviceKey: null, runId: null });
  };

  const selectedServiceStatus =
    selectedService && selectedService !== ALL_SERVICES_KEY
      ? serviceStatuses[selectedService]
      : null;
  const availableContainers = selectedServiceStatus?.containers ?? [];
  const allInstalledContainers = useMemo(
    () =>
      installedServiceKeys
        .map((service) => serviceStatuses[service]?.containers?.[0])
        .filter(
          (container): container is NonNullable<typeof container> => Boolean(container)
        ),
    [installedServiceKeys, serviceStatuses]
  );
  const requiresContainerChoice = Boolean(selectedServiceStatus?.ambiguous);
  const selectedContainerName =
    (selectedService && selectedContainers[selectedService]) || "";
  const selectedContainerValid = availableContainers.some(
    (container) => container.name === selectedContainerName
  );
  const isContainerSelectionMissing =
    requiresContainerChoice && (!selectedContainerName || !selectedContainerValid);

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">{text.brand}</p>
          <h1 className="text-2xl font-semibold text-white">{text.appTitle}</h1>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-slate-400">
            {text.languageLabel}
            <select
              value={lang}
              onChange={(event) => setLang(event.target.value as (typeof LANGUAGES)[number]["key"])}
              className="h-8 rounded-md border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200 outline-none focus:border-lake"
            >
              {LANGUAGES.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="text-right text-sm text-slate-300">
            {runState.running ? text.statusRunning : text.statusIdle}
            {runState.current ? `: ${runState.current}` : ""}
          </div>
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">{text.servicesTitle}</h2>
            <button
              type="button"
              className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-300 transition hover:border-lake hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void loadStatuses()}
              disabled={refreshingStatuses}
            >
              {refreshingStatuses ? text.refreshing : text.refresh}
            </button>
          </div>
          <div className="space-y-2">
            <ServiceItem
              key={ALL_SERVICES_KEY}
              label={text.allInstalled}
              active={selectedService === ALL_SERVICES_KEY}
              disabled={runState.running || installedServiceKeys.length === 0}
              status={allServicesStatus}
              onClick={() => setSelectedService(ALL_SERVICES_KEY)}
            />
            {serviceKeys.map((service) => {
              const status = serviceStatuses[service];
              const isInstalled = status?.installed ?? true;
              const isRunning = status?.running ?? false;
              const stateLabel: ServiceStatusKey = status?.ambiguous
                ? "multiple"
                : isRunning
                ? "running"
                : isInstalled
                  ? "installed"
                  : "not_installed";

              return (
                <ServiceItem
                  key={service}
                  label={service}
                  active={selectedService === service}
                  disabled={runState.running}
                  status={stateLabel}
                  onClick={() => setSelectedService(service)}
                />
              );
            })}
          </div>
          {serviceKeys.length === 0 && (
            <div className="mt-4 text-sm text-slate-400">{text.servicesEmpty}</div>
          )}
        </aside>

        <main className="space-y-6">
          <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                  {text.actionsTitle}
                </p>
                <h2 className="text-lg font-semibold text-white">
                  {selectedService === ALL_SERVICES_KEY
                    ? text.allInstalled
                    : selectedService
                      ? selectedService.replace(/_/g, " ")
                      : text.selectService}
                </h2>
              </div>
              <div className="text-xs text-slate-400">
                {runState.running ? text.consoleActive : text.consoleReady}
              </div>
            </div>

            {selectedService === ALL_SERVICES_KEY ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-3 text-xs text-slate-300">
                  <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-slate-400">
                    {text.allInstalledTargets}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {allInstalledContainers.map((container) => (
                      <div
                        key={container.id}
                        className="rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1 text-[11px] text-slate-200"
                      >
                        {container.name} ({container.image})
                      </div>
                    ))}
                    {allInstalledContainers.length === 0 && (
                      <div className="text-sm text-slate-400">{text.statusNotInstalled}</div>
                    )}
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {commonActions.map((item) => (
                    <button
                      key={item.name}
                      className="rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-3 text-left text-sm text-slate-100 transition hover:border-lake hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() =>
                        startRun(item.paths, text.runAllLabel(item.name), ALL_SERVICES_KEY)
                      }
                      disabled={runState.running || item.paths.length === 0}
                    >
                      {item.name}
                    </button>
                  ))}
                  {commonActions.length === 0 && (
                    <div className="text-sm text-slate-400">
                      {text.noCommonActions}
                    </div>
                  )}
                </div>
              </div>
            ) : selectedService ? (
              <div className="space-y-4">
                {requiresContainerChoice && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
                      <div className="font-semibold">{text.containerWarningTitle}</div>
                      <div className="text-xs text-amber-200/80">{text.containerWarningBody}</div>
                    </div>
                    <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                      {text.containerLabel}
                      <select
                        value={selectedContainerName}
                        onChange={(event) =>
                          setSelectedContainers((prev) => ({
                            ...prev,
                            [selectedService]: event.target.value
                          }))
                        }
                        className="h-9 rounded-md border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200 outline-none focus:border-lake"
                      >
                        <option value="">{text.containerSelectPlaceholder}</option>
                        {availableContainers.map((container) => (
                          <option key={container.id} value={container.name}>
                            {container.name} ({container.image})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                <div className="grid gap-2 md:grid-cols-2">
                  {(actions[selectedService] ?? []).map((item) => (
                    <button
                      key={item.path}
                      className="rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-3 text-left text-sm text-slate-100 transition hover:border-lake hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() =>
                        startRun(
                          [item.path],
                          text.runServiceLabel(selectedService, item.name),
                          selectedService,
                          selectedContainerName || undefined
                        )
                      }
                      disabled={runState.running || isContainerSelectionMissing}
                    >
                      {item.name}
                    </button>
                  ))}
                  {(actions[selectedService] ?? []).length === 0 && (
                    <div className="text-sm text-slate-400">{text.serviceNoActions}</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-400">{text.selectServiceHint}</div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-400">
              <span>{text.consoleTitle}</span>
              <div className="flex items-center gap-3">
                <span>{runState.running ? text.consoleStreaming : text.consoleWaiting}</span>
                <button
                  className="rounded-md border border-flame px-2 py-1 text-[10px] font-semibold text-flame transition hover:bg-flame hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={cancelRun}
                  disabled={!runState.running}
                >
                  {text.cancel}
                </button>
              </div>
            </div>
            <div className="relative">
              <div
                ref={containerRef}
                className={`w-full overflow-hidden rounded-xl border border-slate-800 bg-black/60 transition ${
                  consoleVisible ? "h-[60vh] opacity-100" : "h-0 opacity-0"
                }`}
                aria-hidden={!consoleVisible}
              />
              {!consoleVisible && (
                <div className="flex h-[140px] items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/40 text-sm text-slate-400">
                  {text.consolePlaceholder}
                </div>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

const parsePayload = (data: string): Record<string, any> | null => {
  try {
    return JSON.parse(data) as Record<string, any>;
  } catch {
    return null;
  }
};

const b64ToUint8 = (b64: string) => {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
};

type ServiceItemProps = {
  label: string;
  active: boolean;
  disabled: boolean;
  status: ServiceStatusKey;
  onClick: () => void;
};

const ServiceItem = ({ label, active, disabled, status, onClick }: ServiceItemProps) => {
  const text = useText();
  const initials = label
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition ${
        active
          ? "border-lake bg-slate-800/80 text-white"
          : "border-slate-800 bg-slate-900/60 text-slate-200 hover:border-slate-700"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold uppercase text-slate-200">
          {initials || "AI"}
        </div>
        <div>
          <div className="text-sm font-semibold">{label.replace(/_/g, " ")}</div>
          <div
            className={`text-xs ${
              status === "not_installed"
                ? "text-flame"
                : status === "multiple"
                  ? "text-amber-400"
                  : "text-slate-400"
            }`}
          >
            {status === "running"
              ? text.statusRunningLabel
              : status === "installed"
                ? text.statusInstalledLabel
                : status === "multiple"
                  ? text.statusMultipleLabel
                  : text.statusNotInstalledLabel}
          </div>
        </div>
      </div>
      <div
        className={`h-2.5 w-2.5 rounded-full ${
          status === "running"
            ? "bg-lake"
            : status === "multiple"
              ? "bg-amber-400"
              : status === "not_installed"
              ? "bg-flame"
              : "bg-slate-600"
        }`}
      />
    </button>
  );
};
