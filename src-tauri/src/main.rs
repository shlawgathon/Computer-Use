#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod os_context;
mod recording;
mod shell;
mod shortcuts;
mod vision;

#[allow(unused_imports)]
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use models::{
    AgentCursorEvent, AppShortcuts, CaptureFrame, ClickRequest, DisplayState, EnvStatus,
    MistralAuthStatus, PermissionState, PressKeysRequest, RuntimeGuards, RuntimeState,
};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{atomic::Ordering, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use xcap::Monitor;

const MAX_ACTIONS_PER_RUN: u32 = 30;
const DEFAULT_MISTRAL_MODEL: &str = "mistralai/mistral-large-2512";
const DEFAULT_MISTRAL_BASE: &str = "https://openrouter.ai/api/v1";
const DEFAULT_CONFIDENCE_THRESHOLD: f64 = 0.60;
const DEFAULT_INFER_MAX_DIM: u32 = 2048;

/// Global mutex to serialize all xcap screen captures.
/// macOS's CGWindowListCreateImage is NOT safe to call concurrently
/// from multiple threads; doing so crashes the process.
pub(crate) fn capture_mutex() -> &'static Mutex<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn now_unix_ms() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())
        .map(|d| d.as_millis())
}

fn confidence_threshold() -> f64 {
    std::env::var("AGENT_CONFIDENCE_THRESHOLD")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| v.clamp(0.0, 1.0))
        .unwrap_or(DEFAULT_CONFIDENCE_THRESHOLD)
}

fn clamp_pixel(v: f64, max: f64) -> f64 {
    v.max(0.0).min(max)
}

fn pixel_to_global_points(req: &ClickRequest) -> (i32, i32) {
    let scale_x = req.screenshot_w_px as f64 / req.sent_w_px.max(1) as f64;
    let scale_y = req.screenshot_h_px as f64 / req.sent_h_px.max(1) as f64;

    let x_px = clamp_pixel(
        req.x_norm * scale_x,
        (req.screenshot_w_px.saturating_sub(1)) as f64,
    );
    let y_px = clamp_pixel(
        req.y_norm * scale_y,
        (req.screenshot_h_px.saturating_sub(1)) as f64,
    );

    let x_pt = req.monitor_origin_x_pt as f64 + (x_px / req.scale_factor.max(1.0));
    let y_pt = req.monitor_origin_y_pt as f64 + (y_px / req.scale_factor.max(1.0));

    (x_pt.round() as i32, y_pt.round() as i32)
}

pub(crate) fn perform_real_click(
    app: Option<&tauri::AppHandle>,
    guards: &RuntimeGuards,
    req: &ClickRequest,
) -> Result<(), String> {
    if guards.estop.load(Ordering::SeqCst) {
        return Err("Emergency stop active".to_string());
    }

    if req.confidence < confidence_threshold() {
        return Err(format!(
            "Confidence {:.3} below threshold {:.3}",
            req.confidence,
            confidence_threshold()
        ));
    }

    let n = guards.actions.fetch_add(1, Ordering::SeqCst);
    if n >= MAX_ACTIONS_PER_RUN {
        guards.estop.store(true, Ordering::SeqCst);
        return Err("Max actions reached; E-STOP engaged".to_string());
    }

    let (x_pt, y_pt) = pixel_to_global_points(req);
    let started = Instant::now();

    if let Some(app_handle) = app {
        let _ = app_handle.emit(
            "agent_cursor_event",
            AgentCursorEvent {
                x_pt,
                y_pt,
                monitor_origin_x_pt: req.monitor_origin_x_pt,
                monitor_origin_y_pt: req.monitor_origin_y_pt,
                phase: "move".to_string(),
                unix_ms: now_unix_ms().unwrap_or(0),
            },
        );
    }

    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::{
            CGEvent, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
        };
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        use core_graphics::geometry::CGPoint;

        let point = CGPoint::new(x_pt as f64, y_pt as f64);
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Failed to create CGEventSource")?;

        let mouse_down = CGEvent::new_mouse_event(
            source.clone(),
            CGEventType::LeftMouseDown,
            point,
            CGMouseButton::Left,
        )
        .map_err(|_| "Failed to create mouse-down CGEvent")?;
        mouse_down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 1);

        let mouse_up =
            CGEvent::new_mouse_event(source, CGEventType::LeftMouseUp, point, CGMouseButton::Left)
                .map_err(|_| "Failed to create mouse-up CGEvent")?;
        mouse_up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 1);

        mouse_down.post(CGEventTapLocation::HID);
        std::thread::sleep(Duration::from_millis(30));
        mouse_up.post(CGEventTapLocation::HID);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo
            .move_mouse(x_pt, y_pt, Coordinate::Abs)
            .map_err(|e| e.to_string())?;
        enigo
            .button(Button::Left, Direction::Click)
            .map_err(|e| e.to_string())?;
    }

    if let Some(app_handle) = app {
        let _ = app_handle.emit(
            "agent_cursor_event",
            AgentCursorEvent {
                x_pt,
                y_pt,
                monitor_origin_x_pt: req.monitor_origin_x_pt,
                monitor_origin_y_pt: req.monitor_origin_y_pt,
                phase: "click".to_string(),
                unix_ms: now_unix_ms().unwrap_or(0),
            },
        );
    }

    let click_ms = started.elapsed().as_millis();
    println!(
        "[telemetry] click_ms={} point=({}, {}) norm=({:.1}, {:.1}) screenshot={}x{} scale={:.2} monitor_origin=({}, {}) action_count={}",
        click_ms,
        x_pt,
        y_pt,
        req.x_norm,
        req.y_norm,
        req.screenshot_w_px,
        req.screenshot_h_px,
        req.scale_factor,
        req.monitor_origin_x_pt,
        req.monitor_origin_y_pt,
        n + 1
    );

    Ok(())
}

fn primary_monitor() -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or_else(|| "No primary monitor found".to_string())
}

#[cfg(target_os = "macos")]
fn primary_backing_scale_factor() -> Option<f64> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;

    let mtm = MainThreadMarker::new()?;
    NSScreen::mainScreen(mtm).map(|s| s.backingScaleFactor() as f64)
}

#[cfg(not(target_os = "macos"))]
fn primary_backing_scale_factor() -> Option<f64> {
    Some(1.0)
}

#[cfg(target_os = "macos")]
fn check_permissions() -> PermissionState {
    use core_graphics::access::ScreenCaptureAccess;
    use macos_accessibility_client::accessibility::application_is_trusted;

    PermissionState {
        screen_recording: ScreenCaptureAccess::default().preflight(),
        accessibility: application_is_trusted(),
    }
}

#[cfg(not(target_os = "macos"))]
fn check_permissions() -> PermissionState {
    PermissionState {
        screen_recording: true,
        accessibility: true,
    }
}

#[cfg(target_os = "macos")]
fn request_permissions() -> PermissionState {
    use core_graphics::access::ScreenCaptureAccess;
    use macos_accessibility_client::accessibility::application_is_trusted_with_prompt;

    let _ = ScreenCaptureAccess::default().request();
    let _ = application_is_trusted_with_prompt();

    let state = check_permissions();

    if !state.screen_recording {
        let _ = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status();
    }

    if !state.accessibility {
        let _ = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status();
    }

    state
}

#[cfg(not(target_os = "macos"))]
fn request_permissions() -> PermissionState {
    check_permissions()
}

pub(crate) fn resolve_primary_api_base() -> String {
    std::env::var("OPENROUTER_API_BASE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("MISTRAL_API_BASE")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_MISTRAL_BASE.to_string())
}

pub(crate) fn resolve_primary_api_key() -> String {
    std::env::var("OPENROUTER_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("MISTRAL_API_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_default()
}

fn is_openrouter_base(base: &str) -> bool {
    base.to_ascii_lowercase().contains("openrouter.ai")
}

#[tauri::command]
fn check_permissions_cmd() -> PermissionState {
    check_permissions()
}

#[tauri::command]
fn request_permissions_cmd() -> PermissionState {
    request_permissions()
}

#[tauri::command]
fn env_status_cmd() -> EnvStatus {
    let key_loaded = !resolve_primary_api_key().trim().is_empty();
    let base = resolve_primary_api_base();

    EnvStatus {
        mistral_api_key_loaded: key_loaded,
        mistral_api_base: base,
    }
}

#[tauri::command]
async fn validate_mistral_api_key_cmd() -> Result<MistralAuthStatus, String> {
    let base = resolve_primary_api_base();
    let api_key = resolve_primary_api_key().trim().to_string();

    if api_key.is_empty() {
        return Ok(MistralAuthStatus {
            ok: false,
            http_status: None,
            message: "Primary API key is missing (set OPENROUTER_API_KEY or MISTRAL_API_KEY)"
                .to_string(),
            mistral_api_base: base,
        });
    }

    let url = format!("{}/models", base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = match client.get(&url).bearer_auth(api_key).send().await {
        Ok(r) => r,
        Err(err) => {
            return Ok(MistralAuthStatus {
                ok: false,
                http_status: None,
                message: format!("Network error while contacting API provider: {}", err),
                mistral_api_base: base,
            });
        }
    };

    let status = resp.status();
    let code = status.as_u16();
    if status.is_success() {
        return Ok(MistralAuthStatus {
            ok: true,
            http_status: Some(code),
            message: "API key validated against provider".to_string(),
            mistral_api_base: base,
        });
    }

    let body = resp
        .text()
        .await
        .unwrap_or_else(|_| "<no body>".to_string());
    let compact_body = body.chars().take(220).collect::<String>();
    let message = if status == reqwest::StatusCode::UNAUTHORIZED && is_openrouter_base(&base) {
        "Unauthorized (401): OPENROUTER_API_KEY is invalid or revoked.".to_string()
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        "Unauthorized (401): MISTRAL_API_KEY is invalid or revoked.".to_string()
    } else {
        format!("API error {}: {}", code, compact_body)
    };

    Ok(MistralAuthStatus {
        ok: false,
        http_status: Some(code),
        message,
        mistral_api_base: base,
    })
}

#[tauri::command]
fn open_path_cmd(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&p)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&p)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&p)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Unsupported OS for open_path_cmd".to_string())
}

#[tauri::command]
fn export_markdown_cmd(filename: String, content: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "Cannot determine HOME directory".to_string())?;
    let desktop = PathBuf::from(&home).join("Desktop");
    if !desktop.exists() {
        fs::create_dir_all(&desktop).map_err(|e| e.to_string())?;
    }

    let base = filename.trim_end_matches(".md");
    let mut target = desktop.join(&filename);
    let mut counter = 1u32;
    while target.exists() {
        target = desktop.join(format!("{}-{}.md", base, counter));
        counter += 1;
    }

    fs::write(&target, &content).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(&target).status();
    }

    let path_str = target.to_string_lossy().to_string();
    println!("[export] wrote {} ({} bytes)", path_str, content.len());
    Ok(path_str)
}

#[tauri::command]
fn get_runtime_state_cmd(guards: State<RuntimeGuards>) -> RuntimeState {
    RuntimeState {
        estop: guards.estop.load(Ordering::SeqCst),
        actions: guards.actions.load(Ordering::SeqCst),
        max_actions: MAX_ACTIONS_PER_RUN,
    }
}

#[tauri::command]
fn set_estop_cmd(guards: State<RuntimeGuards>, enabled: bool) -> RuntimeState {
    guards.estop.store(enabled, Ordering::SeqCst);
    if !enabled {
        guards.actions.store(0, Ordering::SeqCst);
    }

    get_runtime_state_cmd(guards)
}

#[tauri::command]
async fn capture_primary_cmd(
    display_state: State<'_, DisplayState>,
) -> Result<CaptureFrame, String> {
    let startup_scale = *display_state
        .primary_scale_factor
        .read()
        .map_err(|_| "Display scale lock poisoned".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = None;
        for _ in 0..40 {
            match capture_mutex().try_lock() {
                Ok(g) => {
                    guard = Some(g);
                    break;
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("Capture mutex poisoned".to_string());
                }
            }
        }
        let _capture_lock = guard.ok_or("Capture lock busy (recording in progress), try again")?;

        let started = Instant::now();
        let monitor = primary_monitor()?;

        let monitor_id = monitor.id().map_err(|e| e.to_string())?;
        let monitor_origin_x_pt = monitor.x().map_err(|e| e.to_string())?;
        let monitor_origin_y_pt = monitor.y().map_err(|e| e.to_string())?;
        let screenshot = monitor.capture_image().map_err(|e| e.to_string())?;

        let screenshot_w_px = screenshot.width();
        let screenshot_h_px = screenshot.height();
        let xcap_scale = monitor.scale_factor().map_err(|e| e.to_string())? as f64;
        let scale_factor = if startup_scale > 0.0 {
            startup_scale
        } else if xcap_scale > 0.0 {
            xcap_scale
        } else {
            1.0
        };

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let file_name = format!("computer-use-primary-{}-{}.png", monitor_id, ts);
        let png_path: PathBuf = std::env::temp_dir().join(file_name);
        screenshot.save(&png_path).map_err(|e| e.to_string())?;

        let capture_ms = started.elapsed().as_millis();
        println!(
            "[telemetry] capture_ms={} monitor_id={} size={}x{} scale={}",
            capture_ms, monitor_id, screenshot_w_px, screenshot_h_px, scale_factor
        );

        Ok(CaptureFrame {
            monitor_id,
            monitor_origin_x_pt,
            monitor_origin_y_pt,
            screenshot_w_px,
            screenshot_h_px,
            scale_factor,
            png_path: png_path.to_string_lossy().to_string(),
            capture_ms,
        })
    })
    .await
    .map_err(|e| format!("Capture task join error: {}", e))?
}

#[tauri::command]
async fn get_app_shortcuts_cmd(app_name: String) -> Result<AppShortcuts, String> {
    let api_key = resolve_primary_api_key();
    let api_base = resolve_primary_api_base();

    let was_cached = shortcuts::get_cached_global(&app_name).is_some();
    let text = shortcuts::get_or_fetch_global(&app_name, api_key.trim(), &api_base).await;

    Ok(AppShortcuts {
        app_name,
        shortcuts: text,
        from_cache: was_cached,
    })
}

#[tauri::command]
fn clear_shortcuts_cache_cmd() {
    shortcuts::clear_global_cache();
    println!("[shortcuts] global cache cleared");
}

#[tauri::command]
fn execute_real_click_cmd(
    app: tauri::AppHandle,
    guards: State<RuntimeGuards>,
    req: ClickRequest,
) -> Result<(), String> {
    perform_real_click(Some(&app), &guards, &req)
}

pub(crate) fn parse_key_name(name: &str) -> Result<Key, String> {
    match name {
        "Meta" | "Command" | "Cmd" => Ok(Key::Meta),
        "Tab" => Ok(Key::Tab),
        "Space" => Ok(Key::Space),
        "Return" | "Enter" => Ok(Key::Return),
        "Escape" | "Esc" => Ok(Key::Escape),
        "Shift" => Ok(Key::Shift),
        "Control" | "Ctrl" => Ok(Key::Control),
        "Alt" | "Option" => Ok(Key::Alt),
        "UpArrow" | "Up" => Ok(Key::UpArrow),
        "DownArrow" | "Down" => Ok(Key::DownArrow),
        "LeftArrow" | "Left" => Ok(Key::LeftArrow),
        "RightArrow" | "Right" => Ok(Key::RightArrow),
        "Backspace" => Ok(Key::Backspace),
        "Delete" => Ok(Key::Delete),
        "Home" => Ok(Key::Home),
        "End" => Ok(Key::End),
        "PageUp" => Ok(Key::PageUp),
        "PageDown" => Ok(Key::PageDown),
        "CapsLock" => Ok(Key::CapsLock),
        "F1" => Ok(Key::F1),
        "F2" => Ok(Key::F2),
        "F3" => Ok(Key::F3),
        "F4" => Ok(Key::F4),
        "F5" => Ok(Key::F5),
        "F6" => Ok(Key::F6),
        "F7" => Ok(Key::F7),
        "F8" => Ok(Key::F8),
        "F9" => Ok(Key::F9),
        "F10" => Ok(Key::F10),
        "F11" => Ok(Key::F11),
        "F12" => Ok(Key::F12),
        s if s.chars().count() == 1 => Ok(Key::Unicode(s.chars().next().unwrap())),
        other => Err(format!("Unknown key name: '{}'", other)),
    }
}

fn parse_direction(dir: Option<&str>) -> Result<Direction, String> {
    match dir {
        None | Some("click") | Some("Click") => Ok(Direction::Click),
        Some("press") | Some("Press") => Ok(Direction::Press),
        Some("release") | Some("Release") => Ok(Direction::Release),
        Some(other) => Err(format!(
            "Unknown direction '{}'. Use 'press', 'release', or 'click'.",
            other
        )),
    }
}

#[tauri::command]
fn press_keys_cmd(guards: State<RuntimeGuards>, req: PressKeysRequest) -> Result<(), String> {
    if guards.estop.load(Ordering::SeqCst) {
        return Err("Emergency stop active".to_string());
    }

    let delay = Duration::from_millis(req.delay_ms.unwrap_or(30));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    for (i, combo) in req.keys.iter().enumerate() {
        let key = parse_key_name(&combo.key)?;
        let direction = parse_direction(combo.direction.as_deref())?;

        enigo
            .key(key, direction)
            .map_err(|e| format!("key '{}' failed: {}", combo.key, e))?;

        if i + 1 < req.keys.len() {
            std::thread::sleep(delay);
        }
    }

    let key_desc: Vec<String> = req
        .keys
        .iter()
        .map(|k| {
            let dir = k.direction.as_deref().unwrap_or("click");
            format!("{}:{}", k.key, dir)
        })
        .collect();
    println!(
        "[keyboard] executed {} key action(s): {}",
        req.keys.len(),
        key_desc.join(" -> ")
    );
    Ok(())
}

#[tauri::command]
fn type_text_cmd(guards: State<RuntimeGuards>, text: String) -> Result<(), String> {
    if guards.estop.load(Ordering::SeqCst) {
        return Err("Emergency stop active".to_string());
    }

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(&text).map_err(|e| e.to_string())?;

    println!("[keyboard] typed {} char(s)", text.len());
    Ok(())
}

fn init_display_scale(display_state: &DisplayState) {
    let from_nsscreen = primary_backing_scale_factor().unwrap_or(0.0);
    let from_xcap = primary_monitor()
        .ok()
        .and_then(|m| m.scale_factor().ok())
        .map(|v| v as f64)
        .unwrap_or(0.0);

    let resolved = if from_nsscreen > 0.0 {
        from_nsscreen
    } else if from_xcap > 0.0 {
        from_xcap
    } else {
        1.0
    };

    if let Ok(mut lock) = display_state.primary_scale_factor.write() {
        *lock = resolved;
    }

    println!(
        "[startup] primary scale factor resolved: nsscreen={} xcap={} final={}",
        from_nsscreen, from_xcap, resolved
    );
}

fn main() {
    let home_env = dirs::home_dir().map(|h| h.join(".computer-use.env"));
    let loaded = dotenvy::dotenv()
        .ok()
        .map(|p| p.display().to_string())
        .or_else(|| {
            home_env
                .as_ref()
                .and_then(|p| dotenvy::from_path(p).ok().map(|_| p.display().to_string()))
        });
    match loaded {
        Some(path) => println!("[startup] loaded environment from {}", path),
        None => println!(
            "[startup] no .env found (checked CWD and {}). Set env vars directly or create ~/.computer-use.env",
            home_env
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        ),
    }

    tauri::Builder::default()
        .manage(RuntimeGuards::default())
        .manage(DisplayState::default())
        .manage(recording::SessionRecordingState::default())
        .manage(shortcuts::ShortcutsCache::default())
        .setup(|app| {
            let display_state = app.state::<DisplayState>();
            init_display_scale(&display_state);

            #[cfg(target_os = "macos")]
            {
                let state = check_permissions();
                if !state.screen_recording || !state.accessibility {
                    let _ = request_permissions();
                }
            }

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["cmd+shift+escape", "cmd+shift+enter"])?
                    .with_handler(|app_handle, shortcut, event| {
                        if event.state == ShortcutState::Pressed
                            && shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::Escape)
                        {
                            let guards = app_handle.state::<RuntimeGuards>();
                            guards.estop.store(true, Ordering::SeqCst);
                            println!("[safety] global E-STOP activated via Cmd+Shift+Esc");
                            return;
                        }

                        if event.state == ShortcutState::Pressed
                            && shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::Enter)
                        {
                            if let Some(main) = app_handle.get_webview_window("main") {
                                let _ = main.show();
                                let _ = main.unminimize();
                                let _ = main.set_focus();
                                println!("[window] restored main window via Cmd+Shift+Enter");
                            } else {
                                println!(
                                    "[window] could not restore main window (label=main not found)"
                                );
                            }
                        }
                    })
                    .build(),
            )?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_permissions_cmd,
            request_permissions_cmd,
            env_status_cmd,
            validate_mistral_api_key_cmd,
            recording::recordings_root_cmd,
            open_path_cmd,
            get_runtime_state_cmd,
            set_estop_cmd,
            capture_primary_cmd,
            vision::infer_click_cmd,
            execute_real_click_cmd,
            press_keys_cmd,
            type_text_cmd,
            shell::run_shell_cmd,
            os_context::get_frontmost_app_cmd,
            recording::start_session_cmd,
            recording::stop_session_cmd,
            recording::session_status_cmd,
            recording::list_sessions_cmd,
            recording::load_session_cmd,
            recording::delete_session_cmd,
            recording::save_activity_log_cmd,
            recording::load_activity_log_cmd,
            get_app_shortcuts_cmd,
            clear_shortcuts_cache_cmd,
            export_markdown_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}

#[cfg(test)]
mod tests {
    use super::{models::ClickRequest, pixel_to_global_points};

    #[test]
    fn maps_pixel_to_points_with_scale() {
        let req = ClickRequest {
            x_norm: 500.0,
            y_norm: 500.0,
            screenshot_w_px: 3000,
            screenshot_h_px: 2000,
            sent_w_px: 2000,
            sent_h_px: 2000,
            monitor_origin_x_pt: 0,
            monitor_origin_y_pt: 0,
            scale_factor: 2.0,
            confidence: 1.0,
        };

        let (x, y) = pixel_to_global_points(&req);
        assert!((x - 375).abs() <= 1);
        assert!((y - 250).abs() <= 1);
    }
}
