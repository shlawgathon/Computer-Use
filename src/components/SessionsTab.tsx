// ── SessionsTab — Recording & Session Management ──────

import type { SessionManifest, SessionStatus } from "../types";
import { MODEL_OPTIONS } from "../constants";
import { formatDuration } from "../lib/tauri";

interface SessionsTabProps {
  recordingStatus: SessionStatus | null;
  recordingSummary: SessionManifest | null;
  sessions: SessionManifest[];
  selectedSessionId: string | null;
  instruction: string;
  taskContext: string;
  model: string;
  // Setters
  setSelectedSessionId: (id: string) => void;
  setInstruction: (v: string) => void;
  setTaskContext: (v: string) => void;
  updateModel: (m: string) => void;
  // Actions
  startRecording: () => void;
  stopRecording: () => void;
  refreshRecordingStatus: () => void;
  loadSessions: () => void;
  openPath: (path: string) => void;
  replaySelectedSession: () => void;
  stopReplay: () => void;
  recordingsRoot: string;
  // State
  busy: {
    recordStart: boolean;
    recordStop: boolean;
    replay: boolean;
  };
}

export function SessionsTab(props: SessionsTabProps) {
  return (
    <>
      <article className="card">
        <div className="card-head">
          <h2>Sessions</h2>
          <div className="row">
            {props.recordingStatus?.active ? (
              <button
                onClick={props.stopRecording}
                disabled={props.busy.recordStop}
                style={{ borderColor: "rgba(255,100,100,0.5)", color: "#ffc0c0" }}
              >
                {props.busy.recordStop ? "Stopping..." : "■ Stop Recording"}
              </button>
            ) : (
              <button
                className="primary"
                onClick={props.startRecording}
                disabled={props.busy.recordStart}
              >
                {props.busy.recordStart ? "Starting..." : "● Record"}
              </button>
            )}
            <button onClick={props.refreshRecordingStatus}>Refresh</button>
            <button
              onClick={() => props.openPath(props.recordingsRoot)}
              disabled={!props.recordingsRoot}
            >
              Open Folder
            </button>
          </div>
        </div>
        <div className="health-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <div className={`health ${props.recordingStatus?.active ? "ok" : ""}`}>
            <span>Status</span>
            <strong>{props.recordingStatus?.active ? "Recording" : "Idle"}</strong>
          </div>
          <div className="health">
            <span>Frames</span>
            <strong>{props.recordingStatus?.frame_ticks ?? 0}</strong>
          </div>
          <div className="health">
            <span>Duration</span>
            <strong>
              {props.recordingStatus?.elapsed_ms != null
                ? formatDuration(props.recordingStatus.elapsed_ms)
                : "—"}
            </strong>
          </div>
          <div className="health">
            <span>Last Session</span>
            <strong>{props.recordingSummary ? `${props.recordingSummary.frame_ticks} frames` : "—"}</strong>
          </div>
        </div>
      </article>

      <article className="card">
        <div className="card-head">
          <h3>Saved Sessions</h3>
          <div className="row">
            <button onClick={props.loadSessions}>Refresh</button>
          </div>
        </div>
        {props.sessions.length === 0 ? (
          <p className="muted">No saved sessions yet. Record one above or via the HUD.</p>
        ) : (
          <div className="session-list">
            {props.sessions.map((s) => (
              <div
                key={s.session_id}
                className={`session-item ${props.selectedSessionId === s.session_id ? "selected" : ""}`}
                onClick={() => props.setSelectedSessionId(s.session_id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.setSelectedSessionId(s.session_id);
                  }
                }}
              >
                <div>
                  <strong>{s.name || s.session_id}</strong>
                  <small>
                    {s.frame_ticks} frames •{" "}
                    {formatDuration(s.duration_ms)} • {s.fps}fps
                    {s.input_event_count ? ` • ${s.input_event_count} inputs` : ""}
                  </small>
                  {s.instruction && (
                    <small style={{ display: "block", opacity: 0.6, marginTop: "2px" }}>
                      "{s.instruction}"
                    </small>
                  )}
                </div>
                <button
                  className="open-badge"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.openPath(s.output_dir);
                  }}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        )}
      </article>

      <article className="card">
        <h3>Replay Selected Session</h3>
        {props.selectedSessionId ? (
          <>
            <label>
              Instruction (auto-filled from session)
              <input
                value={props.instruction}
                onChange={(e) => props.setInstruction(e.target.value)}
              />
            </label>
            <label>
              Task Context (sent with instruction)
              <textarea
                rows={4}
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
                onClick={props.replaySelectedSession}
                disabled={props.busy.replay}
              >
                {props.busy.replay ? "Running Replay..." : "Replay Session"}
              </button>
              {props.busy.replay && (
                <button onClick={props.stopReplay}>
                  Stop Replay
                </button>
              )}
              <button
                onClick={() =>
                  props.openPath(
                    props.sessions.find((s) => s.session_id === props.selectedSessionId)
                      ?.output_dir ?? "",
                  )
                }
              >
                Open Session Folder
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Select a session above to replay it.</p>
        )}
      </article>
    </>
  );
}
