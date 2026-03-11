// ── ActivityLogPanel — Sidebar Activity Log ────────────

interface ActivityLogPanelProps {
  log: string[];
}

export function ActivityLogPanel({ log }: ActivityLogPanelProps) {
  return (
    <aside className="card side">
      <h3>Activity Log</h3>
      <ul className="log">
        {log.length === 0 ? (
          <li>No events yet</li>
        ) : (
          log.map((line, i) => <li key={`${i}-${line}`}>{line}</li>)
        )}
      </ul>
    </aside>
  );
}
