// ── MainApp — Dashboard Orchestrator ───────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AgentStep } from "../HudWidgets";
import type {
  AgentCursorEvent,
  CaptureFrame,
  EnvStatus,
  HudActionError,
  HudUpdate,
  MistralAuthStatus,
  PermissionState,
  RuntimeState,
  SessionManifest,
  SessionStatus,
  Tab,
  VisionAction,
} from "../types";
import {
  DEFAULT_HUD_MODEL,
  HUD_LABEL,
  MODEL_OPTIONS,
  OVERLAY_LABEL,
} from "../constants";
import {
  ensureHudWindow,
  ensureOverlayWindow,
  enforceOverlayPassThrough,
  formatDuration,
  getWindowContext,
} from "../lib/tauri";
import {
  executeInferredAction,
  formatVisionCost,
  formatVisionUsage,
  runAgentLoop,
  summarizeRunCost,
} from "../lib/agentRunner";
import { RunTab } from "./RunTab";
import { SessionsTab } from "./SessionsTab";
import { DevTab } from "./DevTab";
import { ModelActivityPanel, type ModelActivityPanelHandle } from "./ModelActivityPanel";
import { ActivityLogPanel } from "./ActivityLogPanel";

export function MainApp() {
  const [tab, setTab] = useState<Tab>("run");
  const [darkMode, setDarkMode] = useState<boolean>(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const [hudEnabled, setHudEnabled] = useState(true);

  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [apiAuth, setApiAuth] = useState<MistralAuthStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [capture, setCapture] = useState<CaptureFrame | null>(null);
  const [vision, setVision] = useState<VisionAction | null>(null);
  const [instruction, setInstruction] = useState("Click the Save button");
  const [taskContext, setTaskContext] = useState(
    "Goal: complete the task using all available actions — clicking, typing text, keyboard shortcuts (hotkeys), and shell commands.\nAfter using Cmd+Space to open Spotlight, always TYPE the app name, then press Return.\nUse Cmd+Tab to switch apps if the target app is not visible.\nReturn action=none only when the goal is fully achieved.",
  );
  const [model, setModel] = useState(DEFAULT_HUD_MODEL);

  const updateModel = (m: string) => {
    setModel(m);
    localStorage.setItem("computer-use-default-model", m);
  };

  const [recordingStatus, setRecordingStatus] = useState<SessionStatus | null>(null);
  const [recordingSummary, setRecordingSummary] = useState<SessionManifest | null>(null);
  const [sessions, setSessions] = useState<SessionManifest[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [recordingsRoot, setRecordingsRoot] = useState("");

  // Auto-fill from selected session
  useEffect(() => {
    if (selectedSessionId) {
      const session = sessions.find((s) => s.session_id === selectedSessionId);
      if (session?.instruction) setInstruction(session.instruction);
      if (session?.task_context) setTaskContext(session.task_context);
      if (session?.model) setModel(session.model);
      invoke<AgentStep[]>("load_activity_log_cmd", { sessionId: selectedSessionId })
        .then((log) => { if (log?.length > 0) setModelActivity(log); })
        .catch(() => { /* old sessions may not have activity logs */ });
    } else {
      setModelActivity([]);
    }
  }, [selectedSessionId, sessions]);

  const [log, setLog] = useState<string[]>([]);
  const [modelActivity, setModelActivity] = useState<AgentStep[]>([]);
  const modelActivityRef = useRef<HTMLDivElement>(null);
  const modelActivityPanelRef = useRef<ModelActivityPanelHandle>(null);

  const pushModelActivity = (step: AgentStep) => {
    setModelActivity((a) => [...a.slice(-40), step]);
    setTimeout(() => modelActivityRef.current?.scrollTo({ top: modelActivityRef.current.scrollHeight, behavior: "smooth" }), 50);
  };

  const focusModelActivity = () => {
    setTab("run");
    setTimeout(() => modelActivityPanelRef.current?.focusPanel(), 50);
  };

  const [busy, setBusy] = useState({
    capture: false,
    infer: false,
    click: false,
    recordStart: false,
    recordStop: false,
    replay: false,
  });
  const loopStopRef = useRef(false);
  const replayStopRef = useRef(false);
  const [looping, setLooping] = useState(false);

  const pushLog = (entry: string) => {
    const line = `${new Date().toLocaleTimeString()}  ${entry}`;
    setLog((prev) => [line, ...prev].slice(0, 100));
  };

  const maybeLogRateLimitHint = (err: unknown, scope: string) => {
    const raw = String(err);
    const msg = raw.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit")) {
      const match = raw.match(/wait ~?(\d+)s/i);
      const wait = match?.[1];
      pushLog(
        wait
          ? `Provider is rate-limited during ${scope}; wait ~${wait}s and retry.`
          : `Provider is rate-limited during ${scope}; wait and retry.`,
      );
    }
  };

  const effectiveInstruction = useMemo(() => {
    const base = instruction.trim();
    const ctx = taskContext.trim();
    return ctx ? `${base}\n\nTask Context:\n${ctx}` : base;
  }, [instruction, taskContext]);

  const health = useMemo(() => {
    const keyReady = apiAuth ? apiAuth.ok : Boolean(envStatus?.mistral_api_key_loaded);
    return {
      permsReady: Boolean(permissions?.screen_recording && permissions?.accessibility),
      keyReady,
      estopOn: Boolean(runtime?.estop),
    };
  }, [permissions, envStatus, apiAuth, runtime]);

  const keyHealthLabel = useMemo(() => {
    if (!envStatus?.mistral_api_key_loaded) return "Missing";
    if (!apiAuth) return "Loaded";
    return apiAuth.ok ? "Valid" : "Invalid";
  }, [envStatus?.mistral_api_key_loaded, apiAuth]);

  // ── Effects ──────────────────────────────────────

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => { void bootstrap(); }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshRecordingStatus(true);
      void refreshRuntime(true);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AgentCursorEvent>("agent_cursor_event", ({ payload }) => {
      pushLog(`cursor ${payload.phase} -> (${payload.x_pt}, ${payload.y_pt})`);
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    let unlistenOverlay: (() => void) | undefined;
    let unlistenHudError: (() => void) | undefined;

    void listen<{ enabled: boolean }>("hud_overlay_state_changed", ({ payload }) => {
      setOverlayEnabled(payload.enabled);
      pushLog(`overlay ${payload.enabled ? "enabled" : "hidden"} via HUD`);
      if (payload.enabled) void enforceOverlayPassThrough();
    }).then((fn) => { unlistenOverlay = fn; });

    void listen<HudActionError>("hud_action_error", ({ payload }) => {
      pushLog(`HUD ${payload.action} error: ${payload.message}`);
    }).then((fn) => { unlistenHudError = fn; });

    return () => {
      if (unlistenOverlay) unlistenOverlay();
      if (unlistenHudError) unlistenHudError();
    };
  }, []);

  useEffect(() => {
    if (!overlayEnabled) return;
    void enforceOverlayPassThrough();
    const id = window.setInterval(() => { void enforceOverlayPassThrough(); }, 1200);
    return () => window.clearInterval(id);
  }, [overlayEnabled]);

  const publishHudUpdate = async () => {
    await emitTo(HUD_LABEL, "hud_update", {
      estop: Boolean(runtime?.estop),
      overlay: overlayEnabled,
      keyLoaded: Boolean(envStatus?.mistral_api_key_loaded),
      permsReady: Boolean(permissions?.screen_recording && permissions?.accessibility),
      instruction: effectiveInstruction,
    } satisfies HudUpdate).catch(() => undefined);
  };

  useEffect(() => { void publishHudUpdate(); }, [
    runtime?.estop, overlayEnabled, envStatus?.mistral_api_key_loaded,
    permissions?.screen_recording, permissions?.accessibility, effectiveInstruction,
  ]);

  useEffect(() => {
    if (!hudEnabled) return;
    const id = window.setInterval(() => { void publishHudUpdate(); }, 1000);
    return () => window.clearInterval(id);
  }, [hudEnabled, runtime?.estop, overlayEnabled, envStatus?.mistral_api_key_loaded,
    permissions?.screen_recording, permissions?.accessibility, effectiveInstruction]);

  // ── Bootstrap & Refresh Functions ─────────────────

  const bootstrap = async () => {
    await Promise.all([
      refreshPermissions(true),
      refreshEnv(true),
      refreshRuntime(true),
      refreshRecordingStatus(true),
      loadRecordingsRoot(true),
      loadSessions(true),
    ]);
    if (overlayEnabled) {
      const ok = await ensureOverlayWindow()
        .then(() => true)
        .catch((e) => { pushLog(`overlay init error: ${String(e)}`); return false; });
      if (!ok) setOverlayEnabled(false);
    }
    if (hudEnabled) {
      const hud = await ensureHudWindow().catch((e) => {
        pushLog(`hud init error: ${String(e)}`); return null;
      });
      if (hud) {
        const visible = await hud.isVisible().catch(() => false);
        pushLog(`hud visible=${visible}`);
      }
    }
  };

  const refreshPermissions = async (silent = false) => {
    const res = await invoke<PermissionState>("check_permissions_cmd");
    setPermissions(res);
    if (!silent) pushLog(`permissions -> screen=${res.screen_recording} accessibility=${res.accessibility}`);
  };

  const requestPermissions = async () => {
    const res = await invoke<PermissionState>("request_permissions_cmd");
    setPermissions(res);
    pushLog(`request permissions -> screen=${res.screen_recording} accessibility=${res.accessibility}`);
  };

  const refreshEnv = async (silent = false) => {
    const res = await invoke<EnvStatus>("env_status_cmd");
    setEnvStatus(res);
    if (!res.mistral_api_key_loaded) setApiAuth(null);
    if (!silent) pushLog(`env -> MISTRAL_API_KEY ${res.mistral_api_key_loaded ? "loaded" : "missing"}`);
  };

  const validateApiKey = async () => {
    try {
      const status = await invoke<MistralAuthStatus>("validate_mistral_api_key_cmd");
      setApiAuth(status);
      pushLog(status.ok
        ? `api key valid (${status.http_status ?? "ok"}) @ ${status.mistral_api_base}`
        : `api key invalid: ${status.message}`);
    } catch (err) { pushLog(`api key validation error: ${String(err)}`); }
  };

  const refreshRuntime = async (silent = false) => {
    const res = await invoke<RuntimeState>("get_runtime_state_cmd");
    setRuntime(res);
    if (!silent) pushLog(`runtime -> estop=${res.estop} actions=${res.actions}/${res.max_actions}`);
  };

  const setEstop = async (enabled: boolean) => {
    const res = await invoke<RuntimeState>("set_estop_cmd", { enabled });
    setRuntime(res);
    pushLog(`E-STOP ${enabled ? "enabled" : "cleared"}`);
  };

  const refreshRecordingStatus = async (silent = false) => {
    try {
      const status = await invoke<SessionStatus>("session_status_cmd");
      setRecordingStatus(status);
      if (!silent) pushLog(`recording -> active=${status.active} ticks=${status.frame_ticks}`);
    } catch (err) { if (!silent) pushLog(`recording status error: ${String(err)}`); }
  };

  const startRecording = async () => {
    setBusy((b) => ({ ...b, recordStart: true }));
    try {
      const status = await invoke<SessionStatus>("start_session_cmd", {
        req: {
          instruction: instruction.trim() || undefined,
          task_context: taskContext.trim() || undefined,
          model,
          fps: 2,
        },
      });
      setRecordingStatus(status);
      setRecordingSummary(null);
      pushLog(`recording started -> ${status.name ?? status.session_id ?? "unknown"}`);
    } catch (err) { pushLog(`recording start error: ${String(err)}`); }
    finally { setBusy((b) => ({ ...b, recordStart: false })); }
  };

  const stopRecording = async () => {
    setBusy((b) => ({ ...b, recordStop: true }));
    try {
      const summary = await invoke<SessionManifest>("stop_session_cmd");
      setRecordingSummary(summary);
      pushLog(`recording stopped -> ${summary.frame_ticks} ticks in ${formatDuration(summary.duration_ms)}`);
      await refreshRecordingStatus(true);
      await loadSessions(true);
      setSelectedSessionId(summary.session_id);
    } catch (err) { pushLog(`recording stop error: ${String(err)}`); }
    finally { setBusy((b) => ({ ...b, recordStop: false })); }
  };

  const loadRecordingsRoot = async (silent = false) => {
    try {
      const root = await invoke<string>("recordings_root_cmd");
      setRecordingsRoot(root);
      if (!silent) pushLog(`recordings root -> ${root}`);
    } catch (err) { if (!silent) pushLog(`recordings root error: ${String(err)}`); }
  };

  const loadSessions = async (silent = false) => {
    try {
      const res = await invoke<SessionManifest[]>("list_sessions_cmd");
      setSessions(res);
      if (res.length > 0 && !selectedSessionId) setSelectedSessionId(res[0].session_id);
      if (!silent) pushLog(`sessions loaded -> ${res.length} session(s)`);
    } catch (err) { if (!silent) pushLog(`sessions load error: ${String(err)}`); }
  };

  const openPath = async (path: string) => {
    if (!path) return;
    await invoke("open_path_cmd", { path }).catch((e) => pushLog(`open path error: ${String(e)}`));
  };

  // ── Action Functions ────────────────────────────

  const capturePrimary = async () => {
    setBusy((b) => ({ ...b, capture: true }));
    try {
      const res = await invoke<CaptureFrame>("capture_primary_cmd");
      setCapture(res);
      pushLog(`capture -> ${res.screenshot_w_px}x${res.screenshot_h_px} (${res.capture_ms}ms)`);
    } catch (err) { pushLog(`capture error: ${String(err)}`); }
    finally { setBusy((b) => ({ ...b, capture: false })); }
  };

  const inferClick = async () => {
    if (!capture) { pushLog("infer blocked: capture is missing"); return; }
    setBusy((b) => ({ ...b, infer: true }));
    try {
      pushLog(`infer request -> ${capture.png_path}`);
      const res = await invoke<VisionAction>("infer_click_cmd", {
        req: { png_path: capture.png_path, instruction: effectiveInstruction, model },
      });
      setVision(res);
      const cost = formatVisionCost(res);
      pushLog(
        `infer -> ${res.action} conf=${res.confidence.toFixed(2)} (${res.model_ms}ms, ${formatVisionUsage(res)}, ${res.model}${cost ? `, ${cost}` : ""})`,
      );
    } catch (err) {
      pushLog(`infer error: ${String(err)}`);
      maybeLogRateLimitHint(err, "infer");
    } finally { setBusy((b) => ({ ...b, infer: false })); }
  };

  const executeClick = async () => {
    if (!capture || !vision) { pushLog("action blocked: no vision result ready"); return; }
    setBusy((b) => ({ ...b, click: true }));
    try {
      await executeInferredAction(capture, vision);
      pushLog(`action executed: ${vision.action}`);
      await refreshRuntime(true);
    } catch (err) { pushLog(`click error: ${String(err)}`); }
    finally { setBusy((b) => ({ ...b, click: false })); }
  };

  const runLiveOnce = async () => {
    setBusy((b) => ({ ...b, capture: true, infer: true, click: true }));
    try {
      const captured = await invoke<CaptureFrame>("capture_primary_cmd");
      setCapture(captured);
      pushLog(`one-shot capture -> ${captured.screenshot_w_px}x${captured.screenshot_h_px}`);

      const inferred = await invoke<VisionAction>("infer_click_cmd", {
        req: { png_path: captured.png_path, instruction: effectiveInstruction, model },
      });
      setVision(inferred);
      const cost = formatVisionCost(inferred);
      pushLog(
        `one-shot infer -> ${inferred.action} conf=${inferred.confidence.toFixed(2)} (${formatVisionUsage(inferred)}, ${inferred.model}${cost ? `, ${cost}` : ""})`,
      );

      if (inferred.action !== "none") {
        await executeInferredAction(captured, inferred);
        pushLog(`one-shot action executed: ${inferred.action}`);
      } else {
        pushLog("one-shot stopped: model returned no actionable result");
      }
      if (cost) {
        pushLog(`one-shot total cost ${cost}`);
      }
      await refreshRuntime(true);
    } catch (err) {
      pushLog(`one-shot error: ${String(err)}`);
      maybeLogRateLimitHint(err, "one-shot");
    } finally {
      setBusy((b) => ({ ...b, capture: false, infer: false, click: false }));
    }
  };

  const runLoop = async () => {
    loopStopRef.current = false;
    focusModelActivity();
    setLooping(true);
    setBusy((b) => ({ ...b, capture: true, infer: true, click: true }));
    try {
      const steps = await runAgentLoop({
        instruction: effectiveInstruction,
        model,
        shouldStop: () => loopStopRef.current,
        onStep: (step) => {
          pushModelActivity(step);
          if (step.phase === "error") pushLog(`agent loop error: ${step.message}`);
        },
        onCapture: setCapture,
        onVision: setVision,
      });
      const totalCost = summarizeRunCost(steps);
      pushLog(totalCost ? `agent loop complete (${totalCost})` : "agent loop complete");
      await refreshRuntime(true);
    } catch (err) {
      pushLog(`agent loop error: ${String(err)}`);
      maybeLogRateLimitHint(err, "agent-loop");
    } finally {
      setLooping(false);
      setBusy((b) => ({ ...b, capture: false, infer: false, click: false }));
    }
  };

  const replaySelectedSession = async () => {
    if (!selectedSessionId) { pushLog("replay blocked: select a session first"); return; }
    replayStopRef.current = false;
    focusModelActivity();
    setBusy((b) => ({ ...b, replay: true }));
    try {
      pushLog(`session replay started → ${selectedSessionId}`);
      const steps = await runAgentLoop({
        instruction: effectiveInstruction,
        model,
        shouldStop: () => replayStopRef.current,
        onStep: (step) => {
          pushModelActivity(step);
          void emit("agent_step", step).catch(() => undefined);
        },
        onCapture: (c) => setCapture(c),
        onVision: (v) => setVision(v),
      });

      // Persist activity log
      if (selectedSessionId) {
        invoke("save_activity_log_cmd", {
          sessionId: selectedSessionId,
          activityLog: steps,
        }).catch(() => { /* best-effort */ });
      }
      const totalCost = summarizeRunCost(steps);
      pushLog(totalCost ? `session replay complete (${totalCost})` : "session replay complete");
      await refreshRuntime(true);
    } catch (err) {
      pushLog(`session replay error: ${String(err)}`);
      pushModelActivity({ phase: "error", step: 0, max_steps: 30, message: String(err) });
      if (String(err).includes("401")) {
        pushLog('Provider auth failed: click "Validate API Key" and check OPENROUTER_API_KEY / MISTRAL_API_KEY in .env');
      }
      maybeLogRateLimitHint(err, "session replay");
    } finally {
      setBusy((b) => ({ ...b, replay: false }));
    }
  };

  // ── Render ──────────────────────────────────────

  return (
    <main className="app">
      <div className="bg bg-a" />
      <div className="bg bg-b" />

      <header className="top card">
        <div>
          <h1>Computer Use</h1>
          <p className="muted">OS-native vision automation with hotkey, terminal, and physical gestures.</p>
        </div>
        <div className="row" style={{ alignItems: "center", gap: "8px" }}>
          <select
            value={model}
            onChange={(e) => updateModel(e.target.value)}
            style={{ fontSize: "0.75rem", padding: "5px 8px", background: "rgba(15,23,42,0.7)", color: "rgba(226,232,240,0.9)", border: "1px solid rgba(170,214,255,0.15)", borderRadius: "6px" }}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <button onClick={() => setDarkMode((v) => !v)}>
            {darkMode ? "Light Mode" : "Dark Mode"}
          </button>
        </div>
      </header>

      <nav className="tabs card">
        <button className={tab === "run" ? "tab active" : "tab"} onClick={() => setTab("run")}>
          Run
        </button>
        <button className={tab === "sessions" ? "tab active" : "tab"} onClick={() => setTab("sessions")}>
          Sessions
        </button>
        <button className={tab === "dev" ? "tab active" : "tab"} onClick={() => setTab("dev")}>
          Dev Tools
        </button>
      </nav>

      <div className="main-grid">
        <section className="stack">
          {tab === "run" && (
            <RunTab
              permsReady={health.permsReady}
              keyReady={health.keyReady}
              keyLabel={keyHealthLabel}
              estopOn={health.estopOn}
              overlayEnabled={overlayEnabled}
              hudEnabled={hudEnabled}
              modelActivity={modelActivity}
              runtime={runtime}
              instruction={instruction}
              setInstruction={setInstruction}
              taskContext={taskContext}
              setTaskContext={setTaskContext}
              model={model}
              updateModel={updateModel}
              refreshPermissions={() => void refreshPermissions()}
              requestPermissions={() => void requestPermissions()}
              validateApiKey={() => void validateApiKey()}
              refreshRuntime={() => void refreshRuntime()}
              runLiveOnce={() => void runLiveOnce()}
              runAgentLoop={() => void runLoop()}
              stopLoop={() => { loopStopRef.current = true; }}
              setEstop={(v) => void setEstop(v)}
              looping={looping}
              busy={busy}
            />
          )}

          {tab === "sessions" && (
            <SessionsTab
              recordingStatus={recordingStatus}
              recordingSummary={recordingSummary}
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              instruction={instruction}
              taskContext={taskContext}
              model={model}
              setSelectedSessionId={setSelectedSessionId}
              setInstruction={setInstruction}
              setTaskContext={setTaskContext}
              updateModel={updateModel}
              startRecording={() => void startRecording()}
              stopRecording={() => void stopRecording()}
              refreshRecordingStatus={() => void refreshRecordingStatus()}
              loadSessions={() => void loadSessions()}
              openPath={(p) => void openPath(p)}
              replaySelectedSession={() => void replaySelectedSession()}
              stopReplay={() => { replayStopRef.current = true; }}
              recordingsRoot={recordingsRoot}
              busy={busy}
            />
          )}

          {tab === "dev" && (
            <DevTab
              capture={capture}
              vision={vision}
              permissions={permissions}
              envStatus={envStatus}
              effectiveInstruction={effectiveInstruction}
              recordingsRoot={recordingsRoot}
              busy={busy}
              capturePrimary={() => void capturePrimary()}
              inferClick={() => void inferClick()}
              executeClick={() => void executeClick()}
            />
          )}
        </section>

        <ModelActivityPanel ref={modelActivityPanelRef} activity={modelActivity} pushLog={pushLog} />
        <ActivityLogPanel log={log} />
      </div>
    </main>
  );
}
