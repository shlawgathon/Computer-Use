// ── SavedRunsTab — Saved Runs & Replay ─────────────────

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedRun } from "../types";

interface SavedRunsTabProps {
  savedRuns: SavedRun[];
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
  loadSavedRuns: () => void;
  replaySelectedRun: () => void;
  stopReplay: () => void;
  deleteSelectedRun: () => void;
  busy: { replay: boolean };
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function SavedRunsTab(props: SavedRunsTabProps) {
  const selected = props.savedRuns.find((r) => r.run_id === props.selectedRunId);
  const [noteInput, setNoteInput] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const addNote = async () => {
    if (!selected || !noteInput.trim()) return;
    setAddingNote(true);
    try {
      await invoke("add_note_to_run_cmd", { runId: selected.run_id, note: noteInput.trim() });
      setNoteInput("");
      props.loadSavedRuns();
    } catch (err) {
      console.error("Failed to add note:", err);
    } finally {
      setAddingNote(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Saved Runs</h2>
        <div className="row">
          <button onClick={props.loadSavedRuns}>Refresh</button>
          {selected && (
            <>
              <button
                onClick={props.replaySelectedRun}
                disabled={props.busy.replay}
              >
                {props.busy.replay ? "Replaying…" : "▶ Replay"}
              </button>
              {props.busy.replay && (
                <button onClick={props.stopReplay}>Stop</button>
              )}
              <button
                onClick={props.deleteSelectedRun}
                disabled={props.busy.replay}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {props.savedRuns.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          No saved runs yet. Run the agent loop and click "Save Run" to save.
        </p>
      ) : (
        <div className="session-list">
          {props.savedRuns.map((run) => (
            <div
              key={run.run_id}
              className={`session-item ${props.selectedRunId === run.run_id ? "selected" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => props.setSelectedRunId(run.run_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  props.setSelectedRunId(run.run_id);
                }
              }}
            >
              <div>
                <strong>{run.name}</strong>
                <small>
                  {run.total_steps} steps • {run.model.split("/").pop()}
                  {run.total_cost_usd > 0 ? ` • ~$${run.total_cost_usd.toFixed(4)}` : ""}
                  {run.notes.length > 0 ? ` • ${run.notes.length} note${run.notes.length > 1 ? "s" : ""}` : ""}
                </small>
                <small style={{ display: "block", opacity: 0.5 }}>
                  {formatDate(run.created_at)}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div style={{ borderTop: "1px solid var(--card-border)", paddingTop: 10, fontSize: "0.78rem" }}>
          <p className="muted" style={{ marginBottom: 6 }}>
            <strong>Instruction:</strong> {selected.instruction}
          </p>
          <div style={{ display: "grid", gap: 4 }}>
            {selected.steps.map((s, i) => (
              <div key={i} className="muted" style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <span style={{ opacity: 0.5, minWidth: 24 }}>{i + 1}.</span>
                <span>
                  <strong>{s.action}</strong>
                  {s.action === "click" && ` (${s.x_norm.toFixed(0)}, ${s.y_norm.toFixed(0)})`}
                  {s.action === "type" && ` "${s.text}"`}
                  {s.action === "hotkey" && ` ${s.shortcut ?? "keys"}`}
                  {s.action === "shell" && ` \`${s.command}\``}
                  {" — " + s.reason}
                </span>
              </div>
            ))}
          </div>

          {/* ── Mistake Notes ─── */}
          <div style={{ borderTop: "1px solid var(--card-border)", marginTop: 10, paddingTop: 8 }}>
            <strong style={{ fontSize: "0.8rem" }}>📝 Notes & Mistakes</strong>
            {selected.notes.length > 0 && (
              <ul style={{ margin: "6px 0", paddingLeft: 16, fontSize: "0.76rem" }}>
                {selected.notes.map((note, i) => (
                  <li key={i} className="muted" style={{ marginBottom: 3 }}>{note}</li>
                ))}
              </ul>
            )}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input
                type="text"
                placeholder="Note a mistake or observation…"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addNote();
                  }
                }}
                style={{ flex: 1, fontSize: "0.76rem" }}
              />
              <button
                onClick={() => void addNote()}
                disabled={!noteInput.trim() || addingNote}
              >
                {addingNote ? "…" : "Add Note"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
