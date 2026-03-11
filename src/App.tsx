// ── App — Root Router ──────────────────────────────────
// Routes to OverlayWindow, HudWindow, or MainApp based on
// the query-string set by Tauri when creating webview windows.

import { OverlayWindow } from "./components/OverlayWindow";
import { HudWindow } from "./components/HudWindow";
import { MainApp } from "./components/MainApp";
import { OVERLAY_QUERY_KEY, HUD_QUERY_KEY } from "./constants";

export default function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.has(OVERLAY_QUERY_KEY)) return <OverlayWindow />;
  if (params.has(HUD_QUERY_KEY)) return <HudWindow />;
  return <MainApp />;
}
