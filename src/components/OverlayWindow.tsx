// ── OverlayWindow — Transparent Cursor Overlay ─────────

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentStep } from "../HudWidgets";
import type { AgentCursorEvent } from "../types";

export function OverlayWindow() {
  const qs = new URLSearchParams(window.location.search);
  const ox = Number(qs.get("ox") ?? "0");
  const oy = Number(qs.get("oy") ?? "0");
  const originRef = useRef<{ x: number; y: number }>({
    x: Number.isFinite(ox) ? ox : 0,
    y: Number.isFinite(oy) ? oy : 0,
  });

  const [cursor, setCursor] = useState<{
    visible: boolean;
    x: number;
    y: number;
    phase: string;
  }>({ visible: false, x: 0, y: 0, phase: "move" });
  const [agentActive, setAgentActive] = useState(false);

  useLayoutEffect(() => {
    document.documentElement.classList.add("overlay-window");
    document.body.classList.add("overlay-window");
    return () => {
      document.documentElement.classList.remove("overlay-window");
      document.body.classList.remove("overlay-window");
    };
  }, []);

  useEffect(() => {
    let hideTimer: number | undefined;
    let unlistenCursor: (() => void) | undefined;
    let unlistenBounds: (() => void) | undefined;

    void (async () => {
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(true).catch(() => undefined);
      await win.setIgnoreCursorEvents(true).catch(() => undefined);
      await win.setFocusable(false).catch(() => undefined);
      await win.setDecorations(false).catch(() => undefined);
      await win.setShadow(false).catch(() => undefined);
      await win.hide().catch(() => undefined);

      unlistenCursor = await listen<AgentCursorEvent>(
        "agent_cursor_event",
        ({ payload }) => {
          void (async () => {
            const w = getCurrentWindow();
            await w.show().catch(() => undefined);
            await w.setAlwaysOnTop(true).catch(() => undefined);
            await w.setIgnoreCursorEvents(true).catch(() => undefined);
            await w.setFocusable(false).catch(() => undefined);
          })();

          const localX = payload.x_pt - originRef.current.x;
          const localY = payload.y_pt - originRef.current.y;
          setCursor({
            visible: true,
            x: localX,
            y: localY,
            phase: payload.phase,
          });

          if (hideTimer) {
            window.clearTimeout(hideTimer);
          }
          hideTimer = window.setTimeout(() => {
            setCursor((prev) => ({ ...prev, visible: false }));
            void getCurrentWindow()
              .hide()
              .catch(() => undefined);
          }, 3000);
        },
      );

      unlistenBounds = await listen<{ x: number; y: number }>(
        "overlay_bounds",
        ({ payload }) => {
          originRef.current = { x: payload.x, y: payload.y };
        },
      );
    })();

    return () => {
      if (hideTimer) window.clearTimeout(hideTimer);
      if (unlistenCursor) unlistenCursor();
      if (unlistenBounds) unlistenBounds();
    };
  }, []);

  // Listen for agent_step events to show/hide the glow border
  useEffect(() => {
    let glowTimeout: number | undefined;
    let unlisten: (() => void) | undefined;

    void (async () => {
      unlisten = await listen<AgentStep>("agent_step", ({ payload }) => {
        if (glowTimeout) window.clearTimeout(glowTimeout);

        if (payload.phase === "done" || payload.phase === "error") {
          // Fade out after 2s
          glowTimeout = window.setTimeout(() => setAgentActive(false), 2000);
        } else {
          void (async () => {
            const w = getCurrentWindow();
            await w.show().catch(() => undefined);
            await w.setAlwaysOnTop(true).catch(() => undefined);
            await w.setIgnoreCursorEvents(true).catch(() => undefined);
            await w.setFocusable(false).catch(() => undefined);
          })();
          setAgentActive(true);
        }
      });
    })();

    return () => {
      if (glowTimeout) window.clearTimeout(glowTimeout);
      if (unlisten) unlisten();
    };
  }, []);

  const cursorVisible = cursor.visible || agentActive;

  return (
    <main className="overlay-root">
      {agentActive && <div className="agent-glow-border" />}
      {cursorVisible && (
        <div
          className={`agent-cursor ${cursor.phase === "click" ? "click" : "move"}`}
          style={{ left: `${cursor.x}px`, top: `${cursor.y}px` }}
        >
          {/* Pointer arrow SVG */}
          <svg
            className="agent-cursor-pointer"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M5 3L19 12L12 13.5L9 21L5 3Z"
              fill="rgba(60, 140, 255, 0.9)"
              stroke="rgba(255, 255, 255, 0.95)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          <span className="agent-cursor-dot" />
          <span className="agent-cursor-ripple" key={`r1-${cursor.x}-${cursor.y}-${cursor.phase}`} />
          <span className="agent-cursor-ripple-2" key={`r2-${cursor.x}-${cursor.y}-${cursor.phase}`} />
          {cursor.phase === "click" && (
            <span className="agent-cursor-label">Click</span>
          )}
        </div>
      )}
    </main>
  );
}
