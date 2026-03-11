// ── DevTab — Step-by-Step Controls & Runtime Data ──────

import type { CaptureFrame, VisionAction, PermissionState, EnvStatus } from "../types";
import { FLOW } from "../constants";

interface DevTabProps {
  capture: CaptureFrame | null;
  vision: VisionAction | null;
  permissions: PermissionState | null;
  envStatus: EnvStatus | null;
  effectiveInstruction: string;
  recordingsRoot: string;
  busy: { capture: boolean; infer: boolean; click: boolean };
  capturePrimary: () => void;
  inferClick: () => void;
  executeClick: () => void;
}

export function DevTab(props: DevTabProps) {
  return (
    <>
      <article className="card">
        <h3>Step-by-Step Controls</h3>
        <div className="row">
          <button onClick={props.capturePrimary} disabled={props.busy.capture}>
            {props.busy.capture ? "Capturing..." : "Capture"}
          </button>
          <button onClick={props.inferClick} disabled={props.busy.infer || !props.capture}>
            {props.busy.infer ? "Inferring..." : "Infer"}
          </button>
          <button className="primary" onClick={props.executeClick} disabled={props.busy.click}>
            {props.busy.click ? "Clicking..." : "Real Click"}
          </button>
        </div>
      </article>

      <article className="card">
        <h3>Runtime Data</h3>
        <div className="json-grid">
          <div>
            <small>Capture</small>
            <pre>{JSON.stringify(props.capture, null, 2)}</pre>
          </div>
          <div>
            <small>Vision</small>
            <pre>{JSON.stringify(props.vision, null, 2)}</pre>
          </div>
          <div>
            <small>Permissions</small>
            <pre>{JSON.stringify(props.permissions, null, 2)}</pre>
          </div>
          <div>
            <small>Env</small>
            <pre>{JSON.stringify(props.envStatus, null, 2)}</pre>
          </div>
          <div>
            <small>Instruction Sent To Provider</small>
            <pre>{props.effectiveInstruction}</pre>
          </div>
        </div>
      </article>

      <article className="card">
        <h2>How AI Knows What To Do</h2>
        <ol className="plain-list">
          {FLOW.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </article>

      <article className="card">
        <h3>Where Data Is Stored</h3>
        <p className="path">{props.recordingsRoot || "Loading..."}</p>
        <pre>{`session-<unix-ms>/
  manifest.json
  monitor-<id>/
    frame-000001.png
    frame-000002.png
    ...`}</pre>
      </article>
    </>
  );
}
