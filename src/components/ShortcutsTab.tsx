// ── ShortcutsTab — Per-App Cached Keyboard Shortcuts ───

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface CachedShortcutEntry {
  app_name: string;
  shortcuts: string;
}

export function ShortcutsTab() {
  const [entries, setEntries] = useState<CachedShortcutEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<CachedShortcutEntry[]>("list_all_cached_shortcuts_cmd");
      setEntries(data);
    } catch (err) {
      console.error("Failed to load shortcuts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = (app: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app); else next.add(app);
      return next;
    });
  };

  const deleteApp = async (app: string) => {
    try {
      await invoke("delete_cached_shortcuts_cmd", { appName: app });
      void refresh();
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  };

  const exportAll = async () => {
    try {
      const md = await invoke<string>("export_shortcuts_cmd");
      await navigator.clipboard.writeText(md);
      alert("Shortcuts copied to clipboard as Markdown!");
    } catch (err) {
      console.error("Export failed:", err);
    }
  };

  const clearAll = async () => {
    if (!confirm("Clear all cached shortcuts?")) return;
    try {
      await invoke("clear_shortcuts_cache_cmd");
      void refresh();
    } catch (err) {
      console.error("Clear failed:", err);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Keyboard Shortcuts</h2>
        <div className="row">
          <button onClick={() => void refresh()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button onClick={() => void exportAll()} disabled={entries.length === 0}>
            Export
          </button>
          <button onClick={() => void clearAll()} disabled={entries.length === 0}>
            Clear All
          </button>
        </div>
      </div>

      <p className="muted" style={{ fontSize: "0.78rem", marginBottom: 8 }}>
        Shortcuts are auto-fetched per app during agent runs and cached on disk.
        Model: <code>llama-3.3-70b-instruct:free</code>
      </p>

      {entries.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          No shortcuts cached yet. Run the agent to auto-populate, or switch apps while running.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {entries.map((entry) => (
            <div
              key={entry.app_name}
              style={{
                border: "1px solid var(--card-border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  cursor: "pointer",
                  background: expanded.has(entry.app_name) ? "rgba(255,255,255,0.04)" : "transparent",
                }}
                onClick={() => toggle(entry.app_name)}
              >
                <strong style={{ fontSize: "0.82rem", textTransform: "capitalize" }}>
                  {expanded.has(entry.app_name) ? "▾" : "▸"} {entry.app_name}
                </strong>
                <button
                  onClick={(e) => { e.stopPropagation(); void deleteApp(entry.app_name); }}
                  style={{ fontSize: "0.7rem", padding: "1px 6px" }}
                >
                  ✕
                </button>
              </div>
              {expanded.has(entry.app_name) && (
                <pre style={{
                  padding: "6px 12px 10px",
                  margin: 0,
                  fontSize: "0.72rem",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  color: "rgba(200, 200, 200, 0.85)",
                  borderTop: "1px solid var(--card-border)",
                  background: "rgba(0, 0, 0, 0.15)",
                }}>
                  {entry.shortcuts}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
