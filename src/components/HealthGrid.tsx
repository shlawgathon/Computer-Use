// ── HealthGrid — Status Chip Grid ──────────────────────

import type { AgentStep } from "../HudWidgets";
import type { RuntimeState } from "../types";

interface HealthGridProps {
  permsReady: boolean;
  keyReady: boolean;
  keyLabel: string;
  estopOn: boolean;
  overlayEnabled: boolean;
  hudEnabled: boolean;
  modelActivity: AgentStep[];
  runtime: RuntimeState | null;
}

export function HealthGrid({
  permsReady,
  keyReady,
  keyLabel,
  estopOn,
  overlayEnabled,
  hudEnabled,
  modelActivity,
  runtime,
}: HealthGridProps) {
  return (
    <div className="health-grid">
      <div className={`health ${permsReady ? "ok" : "bad"}`}>
        <span>Permissions</span>
        <strong>{permsReady ? "Ready" : "Missing"}</strong>
      </div>
      <div className={`health ${keyReady ? "ok" : "bad"}`}>
        <span>Provider Key</span>
        <strong>{keyLabel}</strong>
      </div>
      <div className={`health ${estopOn ? "bad" : "ok"}`}>
        <span>E-STOP</span>
        <strong>{estopOn ? "ON" : "OFF"}</strong>
      </div>
      <div className={`health ${overlayEnabled ? "ok" : "bad"}`}>
        <span>Overlay</span>
        <strong>{overlayEnabled ? "ON" : "OFF"}</strong>
      </div>
      <div className={`health ${hudEnabled ? "ok" : "bad"}`}>
        <span>Top HUD</span>
        <strong>{hudEnabled ? "Visible" : "Hidden"}</strong>
      </div>
      <div className="health">
        <span>Actions</span>
        <strong>
          {modelActivity.filter((s) => s.phase === "click" || s.phase === "hotkey" || s.phase === "type").length}/
          {runtime?.max_actions ?? 30}
        </strong>
      </div>
    </div>
  );
}
