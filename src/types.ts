// ── Shared Type Definitions ────────────────────────────

export type Tab = "run" | "activity" | "saved-runs" | "shortcuts" | "memory" | "dev";

export type PermissionState = {
  screen_recording: boolean;
  accessibility: boolean;
};

export type EnvStatus = {
  mistral_api_key_loaded: boolean;
  mistral_api_base: string;
};

export type MistralAuthStatus = {
  ok: boolean;
  http_status: number | null;
  message: string;
  mistral_api_base: string;
};

export type RuntimeState = {
  estop: boolean;
  actions: number;
  max_actions: number;
};

export type CaptureFrame = {
  monitor_id: number;
  monitor_origin_x_pt: number;
  monitor_origin_y_pt: number;
  screenshot_w_px: number;
  screenshot_h_px: number;
  scale_factor: number;
  png_path: string;
  capture_ms: number;
};

export type FrontmostApp = { app_name: string; window_title: string };

export type KeyAction = {
  key: string;
  direction?: "press" | "release" | "click";
};

export type VisionAction = {
  action: "click" | "hotkey" | "type" | "shell" | "none";
  x_norm: number;
  y_norm: number;
  confidence: number;
  reason: string;
  model_ms: number;
  sent_w: number;
  sent_h: number;
  model: string;
  provider?: string | null;
  tool_name?: string | null;
  shortcut?: string | null;
  usage: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    estimated_prompt_tokens: number;
    estimated_completion_tokens: number;
    estimated_total_tokens: number;
    estimated_cost_usd?: number | null;
  };
  keys?: KeyAction[];
  text?: string;
  command?: string;
  shell_output?: string;
};

export type SessionManifest = {
  session_id: string;
  name: string;
  instruction: string;
  task_context: string;
  model: string;
  output_dir: string;
  fps: number;
  frame_ticks: number;
  duration_ms: number;
  input_event_count: number;
};

export type SessionStatus = {
  active: boolean;
  session_id: string | null;
  name: string | null;
  elapsed_ms: number | null;
  frame_ticks: number;
};

export type AgentCursorEvent = {
  x_pt: number;
  y_pt: number;
  monitor_origin_x_pt: number;
  monitor_origin_y_pt: number;
  phase: "move" | "click" | string;
  unix_ms: number;
};

export type OverlayBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type HudUpdate = {
  estop: boolean;
  overlay: boolean;
  keyLoaded: boolean;
  permsReady: boolean;
  instruction: string;
};

export type HudActionError = {
  action: string;
  message: string;
};

export type SavedRunStep = {
  action: string;
  x_norm: number;
  y_norm: number;
  confidence: number;
  reason: string;
  sent_w: number;
  sent_h: number;
  keys?: KeyAction[] | null;
  text?: string | null;
  command?: string | null;
  tool_name?: string | null;
  shortcut?: string | null;
};

export type SavedRun = {
  run_id: string;
  name: string;
  instruction: string;
  task_context: string;
  model: string;
  created_at: number;
  steps: SavedRunStep[];
  total_steps: number;
  total_cost_usd: number;
  notes: string[];
};
