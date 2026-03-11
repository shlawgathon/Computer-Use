use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU32},
    Arc, RwLock,
};

#[derive(Default)]
pub struct RuntimeGuards {
    pub estop: AtomicBool,
    pub actions: AtomicU32,
}

#[derive(Default)]
pub struct DisplayState {
    pub primary_scale_factor: Arc<RwLock<f64>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionState {
    pub screen_recording: bool,
    pub accessibility: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureFrame {
    pub monitor_id: u32,
    pub monitor_origin_x_pt: i32,
    pub monitor_origin_y_pt: i32,
    pub screenshot_w_px: u32,
    pub screenshot_h_px: u32,
    pub scale_factor: f64,
    pub png_path: String,
    pub capture_ms: u128,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InferClickRequest {
    pub png_path: String,
    pub instruction: String,
    #[allow(dead_code)]
    pub model: Option<String>,
    #[serde(default)]
    pub step_context: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClickRequest {
    pub x_norm: f64,
    pub y_norm: f64,
    pub screenshot_w_px: u32,
    pub screenshot_h_px: u32,
    pub sent_w_px: u32,
    pub sent_h_px: u32,
    pub monitor_origin_x_pt: i32,
    pub monitor_origin_y_pt: i32,
    pub scale_factor: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InferenceUsage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
    pub estimated_prompt_tokens: u32,
    pub estimated_completion_tokens: u32,
    pub estimated_total_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VisionAction {
    pub action: String,
    pub x_norm: f64,
    pub y_norm: f64,
    pub confidence: f64,
    pub reason: String,
    pub model_ms: u128,
    pub sent_w: u32,
    pub sent_h: u32,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
    pub usage: InferenceUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<KeyAction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyAction {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeState {
    pub estop: bool,
    pub actions: u32,
    pub max_actions: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvStatus {
    pub mistral_api_key_loaded: bool,
    pub mistral_api_base: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MistralAuthStatus {
    pub ok: bool,
    pub http_status: Option<u16>,
    pub message: String,
    pub mistral_api_base: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentCursorEvent {
    pub x_pt: i32,
    pub y_pt: i32,
    pub monitor_origin_x_pt: i32,
    pub monitor_origin_y_pt: i32,
    pub phase: String,
    pub unix_ms: u128,
}

#[derive(Debug, Deserialize)]
pub struct VisionActionRaw {
    pub action: String,
    #[serde(default)]
    pub x_norm: f64,
    #[serde(default)]
    pub y_norm: f64,
    pub confidence: f64,
    pub reason: String,
    #[serde(default)]
    pub keys: Option<Vec<KeyAction>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeyCombo {
    pub key: String,
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PressKeysRequest {
    pub keys: Vec<KeyCombo>,
    pub delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrontmostApp {
    pub app_name: String,
    pub window_title: String,
}

#[derive(Debug, Clone)]
pub struct OsContextSnapshot {
    pub frontmost_app_name: String,
    pub context_block: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppShortcuts {
    pub app_name: String,
    pub shortcuts: String,
    pub from_cache: bool,
}
