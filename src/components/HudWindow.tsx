// ── HudWindow — Floating HUD Pill ──────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ElapsedTimer, ActivityFeed, stampStep, type TimestampedStep, type AgentStep } from "../HudWidgets";
import type {
  CaptureFrame,
  EnvStatus,
  HudActionError,
  HudUpdate,
  PermissionState,
  SessionManifest,
  SessionStatus,
  VisionAction,
} from "../types";
import {
  DEFAULT_HUD_MODEL,
  HUD_HEIGHT,
  HUD_WIDTH,
  MAIN_LABEL,
  MODEL_OPTIONS,
  OVERLAY_LABEL,
} from "../constants";
import {
  ensureOverlayWindow,
  formatDuration,
  getWindowContext,
  revealMainWindow,
} from "../lib/tauri";
import {
  executeInferredAction,
  buildStepHistoryEntry,
  runAgentLoop,
} from "../lib/agentRunner";

export function HudWindow() {
  const [status, setStatus] = useState<HudUpdate>({
    estop: false,
    overlay: true,
    keyLoaded: false,
    permsReady: false,
    instruction: "Waiting for command",
  });
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingTicks, setRecordingTicks] = useState(0);
  const [busy, setBusy] = useState({
    start: false,
    stop: false,
    run: false,
  });
  const loopStopRef = useRef(false);
  const [looping, setLooping] = useState(false);
  const hudIsSourceRef = useRef(false);

  const refreshRecordingState = async () => {
    try {
      const rs = await invoke<SessionStatus>("session_status_cmd");
      setRecordingActive(rs.active);
      setRecordingTicks(rs.frame_ticks);
    } catch {
      // best-effort for HUD
    }
  };

  useLayoutEffect(() => {
    document.documentElement.classList.add("hud-window");
    document.body.classList.add("hud-window");
    return () => {
      document.documentElement.classList.remove("hud-window");
      document.body.classList.remove("hud-window");
    };
  }, []);

  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;

    void (async () => {
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
      await win.setMaxSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
      await win.setMinSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
      await win.show().catch(() => undefined);
      await win.setAlwaysOnTop(true).catch(() => undefined);
      await win.setDecorations(false).catch(() => undefined);
      await win.setShadow(false).catch(() => undefined);
      await win.setFocusable(true).catch(() => undefined);
      await win.setBackgroundColor({ red: 0, green: 0, blue: 0, alpha: 0 }).catch(() => undefined);

      unlistenStatus = await listen<HudUpdate>("hud_update", ({ payload }) => {
        setStatus(payload);
      });

      try {
        const [perms, env] = await Promise.all([
          invoke<PermissionState>("check_permissions_cmd"),
          invoke<EnvStatus>("env_status_cmd"),
        ]);
        setStatus((prev) => ({
          ...prev,
          permsReady: Boolean(perms.screen_recording && perms.accessibility),
          keyLoaded: Boolean(env.mistral_api_key_loaded),
        }));
      } catch {
        // best-effort
      }

      await refreshRecordingState();
    })();

    const id = window.setInterval(() => {
      void refreshRecordingState();
    }, 1000);

    return () => {
      window.clearInterval(id);
      if (unlistenStatus) unlistenStatus();
    };
  }, []);

  // ── HUD panel state ──────────────────────────

  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [hudPanel, setHudPanel] = useState<"none" | "activity" | "command" | "record">("none");
  const [activityFeed, setActivityFeed] = useState<TimestampedStep[]>([]);
  const [hudInstruction, setHudInstruction] = useState("");
  const [hudContext, setHudContext] = useState("");
  const activityEndRef = useRef<HTMLDivElement>(null);

  // ── Record panel state ──────────────────────────
  const [recSessionName, setRecSessionName] = useState("");
  const [recInstruction, setRecInstruction] = useState("");
  const [recActive, setRecActive] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [savedSessions, setSavedSessions] = useState<SessionManifest[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionManifest | null>(null);
  const [repeatCount, setRepeatCount] = useState(1);
  const [infiniteRepeat, setInfiniteRepeat] = useState(false);
  const replayStopRef = useRef(false);
  const [replaying, setReplaying] = useState(false);
  const [saveRun, setSaveRun] = useState(false);
  const [hudModel, setHudModel] = useState(() => {
    const stored = localStorage.getItem("computer-use-default-model");
    if (!stored || stored === "mistralai/ministral-14b-2512" || stored === "mistralai/mistral-small-3.1-24b-instruct") {
      localStorage.setItem("computer-use-default-model", DEFAULT_HUD_MODEL);
      return DEFAULT_HUD_MODEL;
    }
    return stored;
  });

  const updateHudModel = (m: string) => {
    setHudModel(m);
    localStorage.setItem("computer-use-default-model", m);
  };

  const pushActivity = (step: AgentStep) => {
    setActivityFeed((f) => [...f.slice(-30), stampStep(step)]);
    setTimeout(() => activityEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<AgentStep>("agent_step", ({ payload }) => {
        if (cancelled) return;
        // Skip if the HUD itself is the source (already pushed via onStep callback)
        if (hudIsSourceRef.current) return;
        pushActivity(payload);
        if (payload.phase !== "done" && payload.phase !== "error") {
          setHudPanel((p) => p === "none" ? "activity" : p);
        }
      });
    })();
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, []);

  // ── Panel toggling ──────────────────────────────

  const togglePanel = async (panel: "activity" | "command" | "record") => {
    const win = getCurrentWindow();
    if (hudPanel === panel) {
      setHudPanel("none");
      await win.setFocusable(false).catch(() => undefined);
      await win.setSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
      await win.setMaxSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
      await win.setMinSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
    } else {
      setHudPanel(panel);
      const h = panel === "activity" ? 180 : panel === "record" ? (selectedSession ? 280 : 220) : 200;
      await win.setFocusable(panel === "command" || panel === "record").catch(() => undefined);
      await win.setMinSize(new LogicalSize(HUD_WIDTH, h)).catch(() => undefined);
      await win.setMaxSize(new LogicalSize(HUD_WIDTH, h)).catch(() => undefined);
      await win.setSize(new LogicalSize(HUD_WIDTH, h)).catch(() => undefined);
    }
  };

  // ── Record panel helpers ────────────────────────

  const refreshSessions = async () => {
    try {
      const list = await invoke<SessionManifest[]>("list_sessions_cmd");
      setSavedSessions(list);
    } catch { /* best-effort */ }
  };

  const refreshRecSession = async () => {
    try {
      const s = await invoke<SessionStatus>("session_status_cmd");
      setRecActive(s.active);
      setRecElapsed(s.elapsed_ms ?? 0);
    } catch { /* best-effort */ }
  };

  useEffect(() => {
    if (hudPanel === "record") {
      void refreshSessions();
      void refreshRecSession();
    }
  }, [hudPanel]);

  useEffect(() => {
    if (hudPanel !== "record") return;
    const h = selectedSession ? 280 : 220;
    const win = getCurrentWindow();
    void (async () => {
      await win.setMinSize(new LogicalSize(HUD_WIDTH, h)).catch(() => undefined);
      await win.setMaxSize(new LogicalSize(HUD_WIDTH, h)).catch(() => undefined);
      await win.setSize(new LogicalSize(HUD_WIDTH, h)).catch(() => undefined);
    })();
  }, [selectedSession, hudPanel]);

  useEffect(() => {
    if (!recActive) return;
    const id = window.setInterval(() => void refreshRecSession(), 500);
    return () => window.clearInterval(id);
  }, [recActive]);

  const startSession = async () => {
    try {
      await invoke("start_session_cmd", {
        req: {
          name: recSessionName.trim() || undefined,
          instruction: recInstruction.trim() || undefined,
          task_context: hudContext.trim() || undefined,
          model: hudModel,
          fps: 2,
        },
      });
      setRecActive(true);
    } catch (err) {
      await emit("hud_action_error", { action: "session_start", message: String(err) }).catch(() => undefined);
    }
  };

  const stopSession = async () => {
    try {
      await invoke<SessionManifest>("stop_session_cmd");
      setRecActive(false);
      setRecSessionName("");
      setRecInstruction("");
      void refreshSessions();
    } catch (err) {
      await emit("hud_action_error", { action: "session_stop", message: String(err) }).catch(() => undefined);
    }
  };

  // ── Agent loop from HUD (with tracking & save) ──

  const runAgentLoopFromHudWithTracking = async () => {
    loopStopRef.current = false;
    hudIsSourceRef.current = true;
    setLooping(true);
    setBusy((b) => ({ ...b, run: true }));
    const inst = hudInstruction || status.instruction || "Click the target button";

    // Auto-save run as session if toggled on
    if (saveRun) {
      try {
        await invoke("start_session_cmd", {
          req: {
            name: `Run: ${inst.slice(0, 40)}`,
            instruction: inst,
            task_context: hudContext.trim() || undefined,
            model: hudModel,
            fps: 2,
          },
        });
        setRecActive(true);
      } catch { /* best-effort */ }
    }

    let loopSuccess = false;
    try {
      const steps = await runAgentLoop({
        instruction: inst,
        model: hudModel,
        shouldStop: () => loopStopRef.current,
        onStep: pushActivity,
      });

      loopSuccess = steps.some((s) => s.phase === "done");

      // Save collected activity
      if (saveRun) {
        try {
          const manifest = await invoke<SessionManifest>("stop_session_cmd");
          setRecActive(false);
          if (loopSuccess) {
            await invoke("save_activity_log_cmd", {
              sessionId: manifest.session_id,
              activityLog: steps,
            }).catch(() => { /* best-effort */ });
            void refreshSessions();
          } else {
            await invoke("delete_session_cmd", { sessionId: manifest.session_id }).catch(() => {});
          }
        } catch { /* best-effort */ }
      }
    } catch (err) {
      await emit("hud_action_error", {
        action: "agent_loop",
        message: String(err),
      }).catch(() => undefined);
    } finally {
      hudIsSourceRef.current = false;
      setLooping(false);
      setBusy((b) => ({ ...b, run: false }));
    }
  };

  // ── Replay ──────────────────────────────────────

  const replaySession = async () => {
    if (!selectedSession) return;
    replayStopRef.current = false;
    hudIsSourceRef.current = true;
    setReplaying(true);
    const loops = infiniteRepeat ? Infinity : Math.max(1, repeatCount);
    const inst = selectedSession.instruction || hudInstruction || "Repeat the recorded task";
    const collectedSteps: AgentStep[] = [];

    try {
      for (let rep = 0; rep < loops; rep++) {
        if (replayStopRef.current) break;
        loopStopRef.current = false;
        setLooping(true);
        setBusy((b) => ({ ...b, run: true }));

        const steps = await runAgentLoop({
          instruction: inst,
          model: hudModel,
          shouldStop: () => loopStopRef.current || replayStopRef.current,
          onStep: pushActivity,
          delayMs: 800,
        });
        collectedSteps.push(...steps);

        setLooping(false);
        setBusy((b) => ({ ...b, run: false }));
        if (rep + 1 < loops && !replayStopRef.current) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } finally {
      if (selectedSession && collectedSteps.length > 0) {
        invoke("save_activity_log_cmd", {
          sessionId: selectedSession.session_id,
          activityLog: collectedSteps,
        }).catch(() => { /* best-effort */ });
      }
      hudIsSourceRef.current = false;
      setReplaying(false);
      setLooping(false);
      setBusy((b) => ({ ...b, run: false }));
    }
  };

  // ── Export activity to clipboard / .md ────────────

  const exportActivity = async () => {
    const md = activityFeed
      .map((a) => {
        const ts = new Date(a.ts).toLocaleTimeString();
        const prefix = a.step > 0 ? `[${a.step}/${a.max_steps}] ` : "";
        return `- **${ts}** [${a.phase.toUpperCase()}] ${prefix}${a.message}`;
      })
      .join("\n");
    const content = `# HUD Activity\n\n${md}\n`;
    try {
      const path = await invoke<string>("export_markdown_cmd", {
        filename: "hud-activity.md",
        content,
      });
      // Also copy to clipboard as fallback
      await navigator.clipboard.writeText(content).catch(() => undefined);
      pushActivity({ phase: "done", step: 0, max_steps: 0, message: `Exported to ${path} (also copied to clipboard)` });
    } catch (err) {
      // Fallback: copy to clipboard only
      try {
        await navigator.clipboard.writeText(content);
        pushActivity({ phase: "done", step: 0, max_steps: 0, message: "Copied activity to clipboard" });
      } catch {
        await emit("hud_action_error", { action: "export_activity", message: String(err) }).catch(() => undefined);
      }
    }
  };

  // ── Overlay toggling ────────────────────────────

  const toggleOverlayFromHud = async () => {
    try {
      if (status.overlay) {
        const overlay = await WebviewWindow.getByLabel(OVERLAY_LABEL);
        if (overlay) await overlay.hide().catch(() => undefined);
        setStatus((s) => ({ ...s, overlay: false }));
        await emit("hud_overlay_state_changed", { enabled: false }).catch(() => undefined);
      } else {
        await ensureOverlayWindow();
        setStatus((s) => ({ ...s, overlay: true }));
        await emit("hud_overlay_state_changed", { enabled: true }).catch(() => undefined);
      }
    } catch (err) {
      await emit("hud_action_error", { action: "toggle_overlay", message: String(err) }).catch(() => undefined);
    }
  };

  // ── Main window toggling ────────────────────────

  const openMainFromHud = async () => {
    const main = await WebviewWindow.getByLabel(MAIN_LABEL);
    if (!main) {
      await emit("hud_action_error", { action: "open_main", message: "Main window not found (label=main)" }).catch(() => undefined);
      return;
    }
    const visible = await main.isVisible().catch(() => false);
    if (visible) {
      await main.hide().catch(() => undefined);
    } else {
      await revealMainWindow();
    }
  };

  const suppressDashboard = () => {
    void (async () => {
      const main = await WebviewWindow.getByLabel(MAIN_LABEL);
      if (main) await main.hide().catch(() => undefined);
    })();
  };

  // ── Collapse / Expand ────────────────────────────

  const collapseHud = async () => {
    const win = getCurrentWindow();
    const monitor = await currentMonitor();
    const scale = monitor?.scaleFactor || 1;
    const monX = monitor ? monitor.position.x / scale : 0;
    const monW = monitor ? monitor.size.width / scale : 1400;
    const monY = monitor ? monitor.position.y / scale : 0;
    setHudCollapsed(true);
    setHudPanel("none");
    const w = 48, h = 48;
    await win.setFocusable(false).catch(() => undefined);
    await win.setMinSize(new LogicalSize(w, h)).catch(() => undefined);
    await win.setMaxSize(new LogicalSize(w, h)).catch(() => undefined);
    await win.setSize(new LogicalSize(w, h)).catch(() => undefined);
    await win.setPosition(new LogicalPosition(monX + monW / 2 - w / 2, monY + 20)).catch(() => undefined);
  };

  const expandHud = async () => {
    const win = getCurrentWindow();
    const monitor = await currentMonitor();
    const scale = monitor?.scaleFactor || 1;
    const monX = monitor ? monitor.position.x / scale : 0;
    const monW = monitor ? monitor.size.width / scale : 1400;
    const monY = monitor ? monitor.position.y / scale : 0;
    setHudCollapsed(false);
    await win.setMinSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
    await win.setMaxSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
    await win.setSize(new LogicalSize(HUD_WIDTH, HUD_HEIGHT)).catch(() => undefined);
    await win.setPosition(new LogicalPosition(monX + monW / 2 - HUD_WIDTH / 2, monY + 20)).catch(() => undefined);
  };

  const toggleCollapse = async () => {
    if (hudCollapsed) await expandHud();
    else await collapseHud();
  };

  // ── Render ──────────────────────────────────────

  return (
    <main
      className={`hud-root ${hudPanel !== "none" ? "hud-expanded" : ""} ${hudCollapsed ? "hud-collapsed" : ""}`}
      onClick={suppressDashboard}
    >
      <section
        className={`hud-pill ${hudPanel !== "none" ? "expanded" : ""} ${hudCollapsed ? "collapsed" : ""}`}
        onMouseDown={(e) => { if (hudPanel !== "command" && hudPanel !== "record") e.preventDefault(); }}
        title={hudCollapsed ? "Click to expand" : "Computer Use HUD"}
      >
        {hudCollapsed ? (
          <button
            className="hud-btn hud-btn-icon"
            onClick={() => void toggleCollapse()}
            title="Expand HUD"
            type="button"
          >
            <svg viewBox="0 0 24 24" className="hud-icon" aria-hidden="true">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        ) : (
          <>
        <div className="hud-main">
          <div className="hud-controls">
            <button
              className="hud-btn hud-btn-icon"
              onClick={(e) => { e.stopPropagation(); void openMainFromHud(); }}
              title="Show main menu"
              aria-label="Show main menu"
              type="button"
            >
              <svg viewBox="0 0 24 24" className="hud-icon" aria-hidden="true">
                <path d="M5 7h14" />
                <path d="M5 12h14" />
                <path d="M5 17h14" />
              </svg>
            </button>
            <button
              className={`hud-btn hud-btn-icon ${hudPanel === "record" ? "active" : ""} ${recActive ? "recording-pulse" : ""}`}
              onClick={(e) => { e.stopPropagation(); void togglePanel("record"); }}
              title="Session recording & replay"
              aria-label="Session recording & replay"
              type="button"
            >
              <svg viewBox="0 0 24 24" className="hud-icon" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button
              className={`hud-btn hud-btn-icon ${hudPanel === "command" ? "active" : ""}`}
              onClick={(e) => { e.stopPropagation(); void togglePanel("command"); }}
              title="Set instruction & run agent loop"
              aria-label="Set instruction & run agent loop"
              type="button"
            >
              <svg viewBox="0 0 24 24" className="hud-icon" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
            <button
              className={`hud-btn hud-btn-icon ${hudPanel === "activity" ? "active" : ""}`}
              onClick={(e) => { e.stopPropagation(); void togglePanel("activity"); }}
              title="Toggle model activity feed"
              aria-label="Toggle model activity feed"
              type="button"
            >
              <svg viewBox="0 0 24 24" className="hud-icon" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <button
              className={`hud-btn hud-btn-icon ${status.overlay ? "" : "overlay-off"}`}
              onClick={(e) => { e.stopPropagation(); void toggleOverlayFromHud(); }}
              title="Toggle visual overlay cursor layer"
              aria-label="Toggle visual overlay cursor layer"
              type="button"
            >
              <svg viewBox="0 0 24 24" className="hud-icon" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="4.5" />
                <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
                <path d="M12 2v4" />
                <path d="M12 18v4" />
                <path d="M2 12h4" />
                <path d="M18 12h4" />
              </svg>
            </button>
          </div>
          <div className="hud-right">
            {looping && (
              <button
                className="hud-btn"
                onClick={(e) => { e.stopPropagation(); loopStopRef.current = true; }}
                title="Stop agent loop"
                style={{ fontSize: "0.5rem", padding: "2px 5px" }}
              >
                STOP
              </button>
            )}
            <ElapsedTimer active={looping} label="▶" />
            <ElapsedTimer active={recActive} label="●" />
            <span
              className={`hud-state ${recordingActive ? "ok" : "bad"}`}
              title={recordingActive ? `Recording (${recordingTicks} ticks)` : "Recording idle"}
            >
              {recordingActive ? "REC" : "IDLE"}
            </span>
            <span
              className={`hud-state ${status.permsReady && status.keyLoaded ? "ok" : "bad"}`}
              title={status.permsReady && status.keyLoaded ? "Ready" : "Setup needed"}
            >
              {status.permsReady && status.keyLoaded ? "READY" : "SETUP"}
            </span>

            <button
              className="hud-btn hud-btn-icon"
              onClick={(e) => { e.stopPropagation(); void toggleCollapse(); }}
              title="Collapse HUD"
              type="button"
            >
              <svg viewBox="0 0 24 24" className="hud-icon" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </div>
        </div>

        {hudPanel === "activity" && (
          <div className="hud-dropdown">
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "4px", padding: "0 2px 2px" }}>
              <button
                className="hud-btn"
                onClick={(e) => { e.stopPropagation(); void exportActivity(); }}
                style={{ fontSize: "0.46rem", padding: "2px 6px" }}
                title="Export activity as .md and copy to clipboard"
              >
                Export .md
              </button>
              <button
                className="hud-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  const text = activityFeed
                    .map((a) => {
                      const ts = new Date(a.ts).toLocaleTimeString();
                      const prefix = a.step > 0 ? `[${a.step}/${a.max_steps}] ` : "";
                      return `${ts} [${a.phase.toUpperCase()}] ${prefix}${a.message}`;
                    })
                    .join("\n");
                  void navigator.clipboard.writeText(text).then(() => {
                    pushActivity({ phase: "done", step: 0, max_steps: 0, message: "Copied to clipboard" });
                  });
                }}
                style={{ fontSize: "0.46rem", padding: "2px 6px" }}
                title="Copy activity text to clipboard"
              >
                Copy
              </button>
              {activityFeed.length > 0 && (
                <button
                  className="hud-btn"
                  onClick={(e) => { e.stopPropagation(); setActivityFeed([]); }}
                  style={{ fontSize: "0.46rem", padding: "2px 6px" }}
                  title="Clear activity feed"
                >
                  Clear
                </button>
              )}
            </div>
            <ActivityFeed items={activityFeed} endRef={activityEndRef} />
          </div>
        )}

        {hudPanel === "command" && (
          <div className="hud-input-panel">
            <input
              placeholder="Instruction (e.g. Open Chrome and go to google.com)"
              value={hudInstruction}
              onChange={(e) => setHudInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void runAgentLoopFromHudWithTracking();
                }
              }}
            />
            <textarea
              placeholder="Task context (optional)"
              rows={2}
              value={hudContext}
              onChange={(e) => setHudContext(e.target.value)}
            />
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <select
                value={hudModel}
                onChange={(e) => updateHudModel(e.target.value)}
                style={{ fontSize: "0.48rem", fontWeight: 400, padding: "1px 14px 1px 4px", height: "16px", minHeight: 0, background: "rgba(15,23,42,0.5)", color: "rgba(226,232,240,0.6)", border: "1px solid rgba(170,214,255,0.1)", borderRadius: "4px", flex: 1, backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M2 4l4 4 4-4'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="hud-input-actions">
              <button
                className="hud-btn"
                disabled={busy.run || !hudInstruction.trim()}
                onClick={() => void runAgentLoopFromHudWithTracking()}
              >
                {looping ? "Running..." : "▶ Run Loop"}
              </button>
              <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.5rem", color: "rgba(226,232,240,0.7)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={saveRun}
                  onChange={(e) => setSaveRun(e.target.checked)}
                  style={{ width: "12px", height: "12px", accentColor: "var(--accent)" }}
                />
                Save run
              </label>
            </div>
          </div>
        )}

        {hudPanel === "record" && (
          <div className="hud-input-panel">
            {recActive ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span className="hud-state recording-pulse" style={{ background: "rgba(255,60,60,0.25)", borderColor: "rgba(255,60,60,0.7)", color: "#ff8080" }}>● REC</span>
                  <span style={{ fontSize: "0.55rem", color: "rgba(226,232,240,0.7)" }}>{formatDuration(recElapsed)}</span>
                </div>
                <div className="hud-input-actions">
                  <button className="hud-btn overlay-off" onClick={() => void stopSession()}>■ Stop</button>
                </div>
              </>
            ) : (
              <>
                <input
                  placeholder="Session name (auto-generated if empty)"
                  value={recSessionName}
                  onChange={(e) => setRecSessionName(e.target.value)}
                />
                <input
                  placeholder="What should this do?"
                  value={recInstruction}
                  onChange={(e) => setRecInstruction(e.target.value)}
                />
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <select
                    value={hudModel}
                    onChange={(e) => updateHudModel(e.target.value)}
                    style={{ fontSize: "0.48rem", fontWeight: 400, padding: "1px 14px 1px 4px", height: "16px", minHeight: 0, background: "rgba(15,23,42,0.5)", color: "rgba(226,232,240,0.6)", border: "1px solid rgba(170,214,255,0.1)", borderRadius: "4px", flex: 1, backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M2 4l4 4 4-4'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className="hud-input-actions">
                  <button className="hud-btn" onClick={() => void startSession()}>● Record</button>
                </div>
                {savedSessions.length > 0 && (
                  <>
                    <div style={{ borderTop: "1px solid rgba(170,214,255,0.12)", paddingTop: "4px", marginTop: "2px" }}>
                      <div style={{ fontSize: "0.52rem", color: "rgba(148,163,184,0.6)", marginBottom: "3px" }}>Saved Sessions</div>
                      <div style={{ maxHeight: "60px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" }}>
                        {savedSessions.map((s) => (
                          <button
                            key={s.session_id}
                            className={`hud-btn ${selectedSession?.session_id === s.session_id ? "active" : ""}`}
                            style={{ fontSize: "0.5rem", textAlign: "left", padding: "3px 6px" }}
                            onClick={() => {
                              if (selectedSession?.session_id === s.session_id) {
                                setSelectedSession(null);
                              } else {
                                setSelectedSession(s);
                                if (s.model) setHudModel(s.model);
                              }
                            }}
                          >
                            {s.name} — {formatDuration(Number(s.duration_ms))}
                          </button>
                        ))}
                      </div>
                    </div>
                    {selectedSession && (
                      <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "2px", flexWrap: "wrap" }}>
                        <button
                          className="hud-btn"
                          disabled={replaying || busy.run}
                          onClick={() => void replaySession()}
                          style={{ fontSize: "0.52rem" }}
                        >
                            {replaying ? "Replaying..." : "▶ Replay"}
                        </button>
                        {replaying && (
                          <button
                            className="hud-btn overlay-off"
                            onClick={() => { replayStopRef.current = true; loopStopRef.current = true; }}
                            style={{ fontSize: "0.52rem" }}
                          >
                            ■ Stop
                          </button>
                        )}
                        <select
                          value={hudModel}
                          onChange={(e) => updateHudModel(e.target.value)}
                          style={{ fontSize: "0.46rem", padding: "2px 3px", background: "rgba(15,23,42,0.7)", color: "rgba(226,232,240,0.9)", border: "1px solid rgba(170,214,255,0.15)", borderRadius: "3px", maxWidth: "100px" }}
                        >
                          {MODEL_OPTIONS.map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                        <span style={{ fontSize: "0.48rem", color: "rgba(226,232,240,0.6)" }}>×</span>
                        {infiniteRepeat ? (
                          <button className="hud-btn active" onClick={() => setInfiniteRepeat(false)} style={{ fontSize: "0.52rem", padding: "2px 5px" }}>∞</button>
                        ) : (
                          <>
                            <input
                              type="number"
                              min={1}
                              max={999}
                              value={repeatCount}
                              onChange={(e) => setRepeatCount(Math.max(1, Number(e.target.value) || 1))}
                              style={{ width: "32px", fontSize: "0.52rem", padding: "2px 4px", textAlign: "center" }}
                            />
                            <button className="hud-btn" onClick={() => setInfiniteRepeat(true)} style={{ fontSize: "0.48rem", padding: "2px 4px" }}>∞</button>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        </>
        )}
      </section>
    </main>
  );
}
