// ── RunTab — Live Command & Health ─────────────────────

import type { AgentStep } from "../HudWidgets";
import type { RuntimeState, CaptureFrame, VisionAction } from "../types";
import { MODEL_OPTIONS } from "../constants";
import { HealthGrid } from "./HealthGrid";

interface RunTabProps {
  // Health
  permsReady: boolean;
  keyReady: boolean;
  keyLabel: string;
  estopOn: boolean;
  overlayEnabled: boolean;
  hudEnabled: boolean;
  modelActivity: AgentStep[];
  runtime: RuntimeState | null;
  // Controls
  instruction: string;
  setInstruction: (v: string) => void;
  taskContext: string;
  setTaskContext: (v: string) => void;
  model: string;
  updateModel: (m: string) => void;
  // Actions
  refreshPermissions: () => void;
  requestPermissions: () => void;
  validateApiKey: () => void;
  refreshRuntime: () => void;
  runLiveOnce: () => void;
  runAgentLoop: () => void;
  stopLoop: () => void;
  setEstop: (enabled: boolean) => void;
  // State
  looping: boolean;
  busy: { capture: boolean; infer: boolean; click: boolean };
}

export function RunTab(props: RunTabProps) {
  return (
    <>
      <article className="card">
        <div className="card-head">
          <h2>Run</h2>
          <div className="row">
            <button onClick={props.refreshPermissions}>Check Permissions</button>
            <button onClick={props.requestPermissions}>Request</button>
            <button onClick={props.validateApiKey}>Validate API Key</button>
            <button onClick={props.refreshRuntime}>Refresh Runtime</button>
          </div>
        </div>
        <HealthGrid
          permsReady={props.permsReady}
          keyReady={props.keyReady}
          keyLabel={props.keyLabel}
          estopOn={props.estopOn}
          overlayEnabled={props.overlayEnabled}
          hudEnabled={props.hudEnabled}
          modelActivity={props.modelActivity}
          runtime={props.runtime}
        />
      </article>

      <article className="card">
        <h3>Live Command</h3>
        <label>
          Instruction
          <input
            value={props.instruction}
            onChange={(e) => props.setInstruction(e.target.value)}
          />
        </label>
        <label>
          Task Context (sent with instruction)
          <textarea
            rows={3}
            value={props.taskContext}
            onChange={(e) => props.setTaskContext(e.target.value)}
          />
        </label>
        <label>
          Model
          <select
            value={props.model}
            onChange={(e) => props.updateModel(e.target.value)}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <div className="row">
          <button
            className="primary"
            onClick={props.runLiveOnce}
            disabled={props.busy.capture || props.busy.infer || props.busy.click}
          >
            Run One-Shot
          </button>
          <button
            className="primary"
            onClick={props.runAgentLoop}
            disabled={props.looping || props.busy.capture || props.busy.infer || props.busy.click}
          >
            {props.looping ? "Looping..." : "Run Agent Loop"}
          </button>
          {props.looping && (
            <button onClick={props.stopLoop}>
              Stop Loop
            </button>
          )}
          <button onClick={() => props.setEstop(false)}>Clear E-STOP</button>
          <button onClick={() => props.setEstop(true)}>Force E-STOP</button>
        </div>
        <p className="muted">
          Global kill switch: <code>Cmd+Shift+Esc</code>
        </p>
      </article>
    </>
  );
}
