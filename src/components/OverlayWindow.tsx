// ── OverlayWindow — Transparent Cursor Overlay ─────────

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentStep } from "../HudWidgets";
import type { AgentCursorEvent } from "../types";

// ── Easing: cubic ease-out for natural deceleration ──
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function OverlayWindow() {
  const qs = new URLSearchParams(window.location.search);
  const ox = Number(qs.get("ox") ?? "0");
  const oy = Number(qs.get("oy") ?? "0");
  const originRef = useRef<{ x: number; y: number }>({
    x: Number.isFinite(ox) ? ox : 0,
    y: Number.isFinite(oy) ? oy : 0,
  });

  // Rendered position (updated every animation frame)
  const [renderPos, setRenderPos] = useState<{
    x: number; y: number; phase: string; visible: boolean;
  }>({ x: 0, y: 0, phase: "move", visible: false });

  // Animation state refs (don't trigger re-renders)
  const animRef = useRef({
    fromX: 0, fromY: 0,
    toX: 0, toY: 0,
    startTime: 0, duration: 0,
    rafId: null as number | null,
    currentX: 0, currentY: 0,
    everMoved: false,
  });

  const [agentActive, setAgentActive] = useState(false);
  const [hasAppeared, setHasAppeared] = useState(false);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const rippleKeyRef = useRef(0);
  const [rippleKey, setRippleKey] = useState(0);

  useLayoutEffect(() => {
    document.documentElement.classList.add("overlay-window");
    document.body.classList.add("overlay-window");
    return () => {
      document.documentElement.classList.remove("overlay-window");
      document.body.classList.remove("overlay-window");
    };
  }, []);

  // ── Animate cursor from current position to target ──
  const animateTo = useCallback((targetX: number, targetY: number, phase: string) => {
    const anim = animRef.current;

    // Cancel any running animation
    if (anim.rafId !== null) {
      cancelAnimationFrame(anim.rafId);
      anim.rafId = null;
    }

    const dx = targetX - anim.currentX;
    const dy = targetY - anim.currentY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // If first appearance or very small move, just jump
    if (!anim.everMoved || distance < 5) {
      anim.currentX = targetX;
      anim.currentY = targetY;
      anim.fromX = targetX;
      anim.fromY = targetY;
      anim.toX = targetX;
      anim.toY = targetY;
      anim.everMoved = true;
      setRenderPos({ x: targetX, y: targetY, phase, visible: true });
      if (!hasAppeared) setHasAppeared(true);
      if (phase === "click") {
        rippleKeyRef.current++;
        setRippleKey(rippleKeyRef.current);
      }
      return;
    }

    // Duration scales with distance: 200ms min, 500ms max
    const duration = Math.min(200 + distance * 0.4, 500);

    anim.fromX = anim.currentX;
    anim.fromY = anim.currentY;
    anim.toX = targetX;
    anim.toY = targetY;
    anim.startTime = performance.now();
    anim.duration = duration;

    const step = (now: number) => {
      const elapsed = now - anim.startTime;
      const rawT = Math.min(elapsed / anim.duration, 1);
      const t = easeOutCubic(rawT);

      const x = anim.fromX + (anim.toX - anim.fromX) * t;
      const y = anim.fromY + (anim.toY - anim.fromY) * t;

      anim.currentX = x;
      anim.currentY = y;

      if (rawT < 1) {
        // Mid-animation: show as "move"
        setRenderPos({ x, y, phase: "move", visible: true });
        anim.rafId = requestAnimationFrame(step);
      } else {
        // Arrived: show final phase (click/move)
        setRenderPos({ x: anim.toX, y: anim.toY, phase, visible: true });
        anim.rafId = null;
        if (phase === "click") {
          rippleKeyRef.current++;
          setRippleKey(rippleKeyRef.current);
        }
      }
    };

    anim.rafId = requestAnimationFrame(step);
    if (!hasAppeared) setHasAppeared(true);
    setRenderPos((prev) => ({ ...prev, visible: true }));
  }, [hasAppeared]);

  useEffect(() => {
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

          // Animate to the new position
          animateTo(localX, localY, payload.phase);

          if (hideTimerRef.current) {
            window.clearTimeout(hideTimerRef.current);
          }
          hideTimerRef.current = window.setTimeout(() => {
            setRenderPos((prev) => ({ ...prev, visible: false }));
            void getCurrentWindow().hide().catch(() => undefined);
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
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      const anim = animRef.current;
      if (anim.rafId !== null) cancelAnimationFrame(anim.rafId);
      if (unlistenCursor) unlistenCursor();
      if (unlistenBounds) unlistenBounds();
    };
  }, [animateTo]);

  // Listen for agent_step events to show/hide the glow border
  useEffect(() => {
    let glowTimeout: number | undefined;
    let unlisten: (() => void) | undefined;

    void (async () => {
      unlisten = await listen<AgentStep>("agent_step", ({ payload }) => {
        if (glowTimeout) window.clearTimeout(glowTimeout);

        if (payload.phase === "done" || payload.phase === "error") {
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

  return (
    <main className="overlay-root">
      {agentActive && <div className="agent-glow-border" />}
      {hasAppeared && (
        <div
          className={`agent-cursor ${renderPos.phase === "click" ? "click" : "move"}`}
          style={{
            left: `${renderPos.x}px`,
            top: `${renderPos.y}px`,
            opacity: renderPos.visible ? 1 : 0,
            transition: "opacity 400ms ease",
          }}
        >
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
          <span className="agent-cursor-ripple" key={`r1-${rippleKey}`} />
          <span className="agent-cursor-ripple-2" key={`r2-${rippleKey}`} />
          {renderPos.phase === "click" && (
            <span className="agent-cursor-label">Click</span>
          )}
        </div>
      )}
    </main>
  );
}
