// ── ModelActivityPanel — Sidebar Model Activity ────────

import { forwardRef, useImperativeHandle, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentStep } from "../HudWidgets";

interface ModelActivityPanelProps {
  activity: AgentStep[];
  pushLog: (entry: string) => void;
}

export type ModelActivityPanelHandle = {
  focusPanel: () => void;
};

export const ModelActivityPanel = forwardRef<ModelActivityPanelHandle, ModelActivityPanelProps>(function ModelActivityPanel({ activity, pushLog }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useImperativeHandle(ref, () => ({
    focusPanel() {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      panelRef.current?.focus({ preventScroll: true });
    },
  }));

  return (
    <aside className="card side" ref={panelRef} tabIndex={-1}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>Model Activity</h3>
        {activity.length > 0 && (
          <button
            className="btn"
            style={{ fontSize: "0.7rem", padding: "3px 8px" }}
            onClick={async () => {
              const md = activity
                .map((a) => `- **[${a.phase.toUpperCase()}]** ${a.step > 0 ? `[${a.step}/${a.max_steps}] ` : ""}${a.message}`)
                .join("\n");
              try {
                const path = await invoke<string>("export_markdown_cmd", {
                  filename: "model-activity.md",
                  content: `# Model Activity\n\n${md}\n`,
                });
                pushLog(`Exported activity to ${path}`);
              } catch (err) {
                pushLog(`Export failed: ${err}`);
              }
            }}
          >
            Export .md
          </button>
        )}
      </div>
      <div className="model-activity" ref={scrollRef}>
        {activity.length === 0 ? (
          <div className="model-activity-item" style={{ opacity: 0.5 }}>
            <span className="activity-text">No model activity yet. Run the Agent Loop to see live updates.</span>
          </div>
        ) : (
          activity.map((a, i) => (
            <div key={i} className="model-activity-item">
              <span className={`phase-badge ${a.phase}`}>{a.phase}</span>
              <span className="activity-text">
                {a.step > 0 && <strong>[{a.step}/{a.max_steps}] </strong>}
                {a.message}
              </span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
});
