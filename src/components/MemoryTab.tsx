// ── MemoryTab — Persistent Agent Memory / Learnings ────

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface MemoryItem {
  id: string;
  text: string;
  source: string;
  created_at: number;
  app_context?: string | null;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function MemoryTab() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const items = await invoke<MemoryItem[]>("list_memories_cmd");
      setMemories(items);
    } catch (err) {
      console.error("Failed to load memories:", err);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const addMemory = async () => {
    if (!newText.trim()) return;
    setAdding(true);
    try {
      await invoke("add_memory_cmd", { req: { text: newText.trim(), source: "user" } });
      setNewText("");
      void refresh();
    } catch (err) {
      console.error("Failed to add memory:", err);
    } finally {
      setAdding(false);
    }
  };

  const deleteMemory = async (id: string) => {
    try {
      await invoke("delete_memory_cmd", { id });
      void refresh();
    } catch (err) {
      console.error("Failed to delete memory:", err);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Memory</h2>
        <div className="row">
          <button onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>

      <p className="muted" style={{ fontSize: "0.78rem", marginBottom: 8 }}>
        Persistent learnings, mistakes, and corrections the agent can reference.
        Add your own or remove entries.
      </p>

      {/* Add new memory */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Add a learning, correction, or note…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void addMemory(); }
          }}
          style={{ flex: 1, fontSize: "0.8rem" }}
        />
        <button
          onClick={() => void addMemory()}
          disabled={!newText.trim() || adding}
        >
          {adding ? "…" : "Add"}
        </button>
      </div>

      {memories.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          No memories stored yet. Add learnings or the agent will populate them during runs.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {memories.map((mem) => (
            <div
              key={mem.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "6px 8px",
                border: "1px solid var(--card-border)",
                borderRadius: 6,
                fontSize: "0.78rem",
              }}
            >
              <span
                style={{
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  padding: "1px 5px",
                  borderRadius: 4,
                  background: mem.source === "user"
                    ? "rgba(90, 176, 255, 0.2)"
                    : "rgba(160, 90, 255, 0.2)",
                  color: mem.source === "user"
                    ? "rgba(150, 200, 255, 0.9)"
                    : "rgba(200, 160, 255, 0.9)",
                  flexShrink: 0,
                  marginTop: 1,
                }}
              >
                {mem.source}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "rgba(220, 220, 220, 0.9)" }}>{mem.text}</div>
                <div style={{ fontSize: "0.68rem", opacity: 0.45, marginTop: 2 }}>
                  {formatDate(mem.created_at)}
                  {mem.app_context && ` · ${mem.app_context}`}
                </div>
              </div>
              <button
                onClick={() => void deleteMemory(mem.id)}
                style={{ fontSize: "0.65rem", padding: "1px 5px", flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
