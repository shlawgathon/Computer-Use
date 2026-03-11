import { useState, useEffect, useRef } from "react";

// ── Types ──────────────────────────────────────────────

export type AgentStep = {
  phase: "capture" | "thinking" | "click" | "hotkey" | "type" | "shell" | "done" | "error";
  step: number;
  max_steps: number;
  message: string;
  cost_usd?: number;
  token_total?: number;
};

export type TimestampedStep = AgentStep & {
  /** epoch ms when the step was recorded */
  ts: number;
};

// ── Helpers ────────────────────────────────────────────

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

// ── Elapsed Timer ──────────────────────────────────────
// Shows a running clock like 0:05, 1:23, etc.
// Starts counting from when `active` becomes true.

export function ElapsedTimer({
  active,
  label,
}: {
  active: boolean;
  label?: string;
}) {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (active) {
      startRef.current = Date.now();
      setElapsed(0);
      const id = window.setInterval(() => {
        if (startRef.current) {
          setElapsed(Date.now() - startRef.current);
        }
      }, 250);
      return () => window.clearInterval(id);
    } else {
      startRef.current = null;
    }
  }, [active]);

  if (!active) return null;

  return (
    <span className="hud-elapsed">
      {label && <span className="hud-elapsed-label">{label}</span>}
      <span className="hud-elapsed-time">{formatElapsed(elapsed)}</span>
    </span>
  );
}

// ── Timestamped Activity Feed ──────────────────────────
// Use `stampStep` to add timestamps, then `ActivityFeed` to render.

export function stampStep(step: AgentStep): TimestampedStep {
  return { ...step, ts: Date.now() };
}

export function ActivityFeed({
  items,
  endRef,
}: {
  items: TimestampedStep[];
  endRef?: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {items.length === 0 ? (
        <div className="hud-activity-item" style={{ opacity: 0.5 }}>
          No activity yet
        </div>
      ) : (
        items.map((a, i) => (
          <div key={i} className="hud-activity-item">
            <span className="activity-ts">{formatTime(new Date(a.ts))}</span>
            <span className={`phase-tag ${a.phase}`}>{a.phase}</span>
            <span>
              {a.step > 0 ? `[${a.step}/${a.max_steps}] ` : ""}
              {a.message}
            </span>
          </div>
        ))
      )}
      {endRef && <div ref={endRef} />}
    </>
  );
}
