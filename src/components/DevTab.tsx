// ── DevTab — Settings & Tools ──────────────────────

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PermissionState, EnvStatus, RuntimeState } from "../types";

interface DevTabProps {
  permissions: PermissionState | null;
  envStatus: EnvStatus | null;
  runtime: RuntimeState | null;
  recordingsRoot: string;
  maxSteps: number;
  setMaxSteps: (n: number) => void;
  refreshPermissions: () => void;
  requestPermissions: () => void;
  validateApiKey: () => void;
  refreshRuntime: () => void;
  setEstop: (v: boolean) => void;
  openPath: (path: string) => void;
}

export function DevTab(props: DevTabProps) {  // ── Cursor test state ──
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number; rippleKey: number } | null>(null);
  const [cursorSize, setCursorSize] = useState(() => {
    const stored = localStorage.getItem("cu-cursor-size");
    return stored ? parseInt(stored, 10) : 28;
  });
  const [cursorColor, setCursorColor] = useState(() => {
    return localStorage.getItem("cu-cursor-color") || "60, 140, 255";
  });
  const testAreaRef = useRef<HTMLDivElement>(null);
  const rippleIdRef = useRef(0);

  useEffect(() => {
    localStorage.setItem("cu-cursor-size", String(cursorSize));
    document.documentElement.style.setProperty("--cursor-size", `${cursorSize}px`);
  }, [cursorSize]);

  useEffect(() => {
    localStorage.setItem("cu-cursor-color", cursorColor);
    document.documentElement.style.setProperty("--cursor-color", cursorColor);
  }, [cursorColor]);

  const handleTestClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = testAreaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCursorPos({ x, y, rippleKey: ++rippleIdRef.current });
  }, []);

  // Detect if current cursor color is light (needs dark text for WCAG)
  const isLightColor = useMemo(() => {
    const parts = cursorColor.split(",").map((s) => parseInt(s.trim(), 10));
    if (parts.length < 3) return false;
    const luminance = (0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2]) / 255;
    return luminance > 0.6;
  }, [cursorColor]);

  const openRecordings = () => {
    if (props.recordingsRoot) props.openPath(props.recordingsRoot);
  };

  const openSavedRuns = () => {
    const base = props.recordingsRoot.replace(/\/recordings\/?$/, "");
    if (base) props.openPath(`${base}/saved-runs`);
  };

  const revealEnvFile = async () => {
    try {
      const path = await invoke<string>("recordings_root_cmd");
      const root = path.replace(/\/recordings\/?$/, "");
      props.openPath(root);
    } catch { /* ignore */ }
  };

  const perms = props.permissions;
  const env = props.envStatus;
  const rt = props.runtime;

  const COLOR_PRESETS = [
    { label: "Blue", value: "60, 140, 255" },
    { label: "Green", value: "60, 200, 120" },
    { label: "Purple", value: "160, 90, 255" },
    { label: "Orange", value: "255, 150, 50" },
    { label: "Red", value: "255, 80, 80" },
    { label: "Cyan", value: "0, 220, 220" },
    { label: "White", value: "255, 255, 255" },
  ];

  /* ── existing return JSX up to the test area: ── */

  return (
    <>
      {/* ── System Status ─── */}
      <article className="card">
        <div className="card-head">
          <h3>System Status</h3>
          <div className="row">
            <button onClick={props.refreshPermissions}>Refresh</button>
            <button onClick={props.requestPermissions}>Request Permissions</button>
          </div>
        </div>
        <div className="health-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <div className={`health ${perms?.screen_recording ? "ok" : "bad"}`}>
            <small className="muted">Screen Recording</small>
            <strong>{perms?.screen_recording ? "Granted" : "Missing"}</strong>
          </div>
          <div className={`health ${perms?.accessibility ? "ok" : "bad"}`}>
            <small className="muted">Accessibility</small>
            <strong>{perms?.accessibility ? "Granted" : "Missing"}</strong>
          </div>
          <div className={`health ${env?.mistral_api_key_loaded ? "ok" : "bad"}`}>
            <small className="muted">API Key</small>
            <strong>{env?.mistral_api_key_loaded ? "Loaded" : "Missing"}</strong>
          </div>
          <div className={`health ${!rt?.estop ? "ok" : "bad"}`}>
            <small className="muted">E-STOP</small>
            <strong>{rt?.estop ? "ACTIVE" : "Off"}</strong>
          </div>
        </div>
      </article>

      {/* ── API Key ─── */}
      <article className="card">
        <div className="card-head">
          <h3>API Configuration</h3>
          <div className="row">
            <button onClick={props.validateApiKey}>Validate API Key</button>
            <button onClick={revealEnvFile}>Open Config Folder</button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: "0.85rem", lineHeight: 1.6 }}>
          Set <code>MISTRAL_API_KEY</code> or <code>OPENROUTER_API_KEY</code> in your <code>.env</code> file.
          <br />
          API base: <code>{env?.mistral_api_base || "not loaded"}</code>
        </p>
      </article>

      {/* ── Safety Controls ─── */}
      <article className="card">
        <div className="card-head">
          <h3>Safety Controls</h3>
          <div className="row">
            <button onClick={props.refreshRuntime}>Refresh</button>
          </div>
        </div>
        <div className="row" style={{ alignItems: "center", gap: 12 }}>
          <button
            className={rt?.estop ? "primary" : ""}
            onClick={() => props.setEstop(!rt?.estop)}
            style={rt?.estop ? { background: "var(--bad)", borderColor: "var(--bad)" } : {}}
          >
            {rt?.estop ? "Clear E-STOP" : "Activate E-STOP"}
          </button>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Actions: {rt?.actions ?? 0} / {rt?.max_actions ?? 0}
          </span>
        </div>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          E-STOP immediately halts all agent actions. Use it as a safety kill switch.
        </p>
        <div style={{ borderTop: "1px solid var(--card-border)", paddingTop: 10, marginTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: "0.85rem", fontWeight: 600 }}>Max Steps:</span>
            {[30, 50, 100].map((n) => (
              <button
                key={n}
                onClick={() => props.setMaxSteps(n)}
                style={props.maxSteps === n ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : {}}
              >
                {n}
              </button>
            ))}
            <button
              onClick={() => props.setMaxSteps(999999)}
              style={props.maxSteps >= 999999 ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : {}}
            >
              ∞
            </button>
            <input
              type="number"
              min={1}
              value={props.maxSteps >= 999999 ? "" : props.maxSteps}
              placeholder="∞"
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (v > 0) props.setMaxSteps(v);
              }}
              style={{ width: 70, textAlign: "center" }}
            />
          </div>
          <p className="muted" style={{ fontSize: "0.82rem", marginTop: 6 }}>
            Hard cap on agent loop iterations per run. Set to ∞ for unlimited.
          </p>
        </div>
      </article>

      {/* ── Cursor Preview & Test ─── */}
      <article className="card">
        <div className="card-head">
          <h3>Cursor Preview &amp; Test</h3>
          <div className="row">
            <button onClick={() => setCursorPos(null)}>Clear</button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Click inside the area below to test the agent cursor overlay. Also emits a real cursor event to the overlay window.
        </p>

        {/* Interactive test area */}
        <div
          ref={testAreaRef}
          onClick={handleTestClick}
          style={{
            position: "relative",
            width: "100%",
            height: 200,
            borderRadius: 12,
            border: "1px solid var(--card-border)",
            background: "rgba(0, 0, 0, 0.4)",
            cursor: "crosshair",
            overflow: "hidden",
            userSelect: "none",
          }}
        >
          {!cursorPos && (
            <span style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              color: "rgba(150, 150, 150, 0.4)",
              fontSize: "0.85rem",
              fontWeight: 600,
              pointerEvents: "none",
            }}>
              Click anywhere to test cursor
            </span>
          )}
          {cursorPos && (
            <div
              className="agent-cursor click"
              style={{
                left: `${cursorPos.x}px`,
                top: `${cursorPos.y}px`,
                transition: "left 300ms cubic-bezier(0.22, 1, 0.36, 1), top 300ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
            >
              <svg
                className="agent-cursor-pointer"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{ width: cursorSize, height: cursorSize }}
              >
                <path
                  d="M5 3L19 12L12 13.5L9 21L5 3Z"
                  fill={`rgba(${cursorColor}, 0.9)`}
                  stroke="rgba(255, 255, 255, 0.95)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="agent-cursor-dot" style={{ background: `rgba(${cursorColor}, 0.9)`, boxShadow: `0 0 6px rgba(${cursorColor}, 0.6)` }} />
              <span key={`r1-${cursorPos.rippleKey}`} className="agent-cursor-ripple" style={{ borderColor: `rgba(${cursorColor}, 0.7)` }} />
              <span key={`r2-${cursorPos.rippleKey}`} className="agent-cursor-ripple-2" style={{ borderColor: `rgba(${cursorColor}, 0.7)` }} />
              <span className="agent-cursor-label" style={{ background: `rgba(${cursorColor}, 0.85)`, color: isLightColor ? '#111' : '#fff' }}>Click</span>
            </div>
          )}
        </div>

        {/* Cursor customization */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          <span className="muted" style={{ fontSize: "0.85rem", fontWeight: 600 }}>Size:</span>
          <input
            type="range"
            min={16}
            max={48}
            value={cursorSize}
            onChange={(e) => setCursorSize(parseInt(e.target.value, 10))}
            style={{ width: 120 }}
          />
          <span className="muted" style={{ fontSize: "0.82rem" }}>{cursorSize}px</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <span className="muted" style={{ fontSize: "0.85rem", fontWeight: 600 }}>Color:</span>
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.value}
              onClick={() => setCursorColor(c.value)}
              title={c.label}
              style={{
                width: 22,
                height: 22,
                minHeight: 22,
                borderRadius: "50%",
                padding: 0,
                background: `rgb(${c.value})`,
                border: cursorColor === c.value ? "2px solid #fff" : "2px solid transparent",
                boxShadow: cursorColor === c.value ? `0 0 8px rgba(${c.value}, 0.5)` : "none",
              }}
            />
          ))}
        </div>
      </article>

      {/* ── Data Folders ─── */}
      <article className="card">
        <div className="card-head">
          <h3>Data &amp; Storage</h3>
          <div className="row">
            <button onClick={openRecordings}>Open Recordings</button>
            <button onClick={openSavedRuns}>Open Saved Runs</button>
          </div>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <div>
            <small className="muted">Recordings Path</small>
            <p className="path">{props.recordingsRoot || "Loading..."}</p>
          </div>
          <div>
            <small className="muted">Saved Runs Path</small>
            <p className="path">
              {props.recordingsRoot
                ? props.recordingsRoot.replace(/\/recordings\/?$/, "/saved-runs")
                : "Loading..."}
            </p>
          </div>
        </div>
      </article>
    </>
  );
}
