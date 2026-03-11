use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

// ── App Shortcuts Cache (LLM-Powered) ──────────────────
//
// Dynamically fetches keyboard shortcuts for the currently active
// macOS application using a cheap/free LLM model via OpenRouter.
// Results are cached both in-memory and on disk so we only fetch once.

/// Cheaper model for shortcut lookups (free tier on OpenRouter).
const SHORTCUTS_MODEL: &str = "meta-llama/llama-3.3-70b-instruct:free";

/// Disk root for persistent shortcut storage.
fn shortcuts_disk_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("computer-use")
        .join("shortcuts")
}

/// Tauri-managed state (registered in main).
#[derive(Default)]
#[allow(dead_code)]
pub struct ShortcutsCache {
    pub cache: Mutex<HashMap<String, String>>,
}

/// Global static cache so async code can use it without Tauri `State<>`.
fn global_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        // Pre-load from disk on first access
        let mut map = HashMap::new();
        let root = shortcuts_disk_root();
        if root.is_dir() {
            if let Ok(entries) = fs::read_dir(&root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map(|e| e == "txt").unwrap_or(false) {
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            if let Ok(content) = fs::read_to_string(&path) {
                                if !content.trim().is_empty() {
                                    map.insert(stem.to_lowercase(), content);
                                }
                            }
                        }
                    }
                }
            }
            if !map.is_empty() {
                println!("[shortcuts] loaded {} apps from disk cache", map.len());
            }
        }
        Mutex::new(map)
    })
}

/// Apps that are system-level or have no meaningful shortcuts.
const SKIP_APPS: &[&str] = &[
    "loginwindow",
    "systemprefspane",
    "systemuiserver",
    "universalcontrol",
    "dock",
    "screencaptureui",
    "computer use",
    "computer-use",
    "controlcenter",
    "notificationcenter",
    "wallpaper",
    "windowmanager",
    "tauri",
];

/// Returns `true` if this app should be skipped (system-level, no shortcuts).
pub fn should_skip(app_name: &str) -> bool {
    let lower = app_name.trim().to_lowercase();
    if lower.is_empty() {
        return true;
    }
    SKIP_APPS.iter().any(|s| lower == *s)
}

/// Check the global cache for existing shortcuts.
pub fn get_cached_global(app_name: &str) -> Option<String> {
    let key = app_name.trim().to_lowercase();
    if key.is_empty() {
        return None;
    }
    let lock = global_cache().lock().ok()?;
    lock.get(&key).cloned()
}

/// Store shortcuts in the global cache + persist to disk.
fn set_cached_global(app_name: &str, shortcuts: String) {
    let key = app_name.trim().to_lowercase();
    if key.is_empty() {
        return;
    }
    if let Ok(mut lock) = global_cache().lock() {
        lock.insert(key.clone(), shortcuts.clone());
    }
    // Persist to disk
    let root = shortcuts_disk_root();
    let _ = fs::create_dir_all(&root);
    let path = root.join(format!("{}.txt", key));
    let _ = fs::write(&path, &shortcuts);
}

/// Clear the entire global shortcuts cache (memory + disk).
pub fn clear_global_cache() {
    if let Ok(mut lock) = global_cache().lock() {
        lock.clear();
    }
    let root = shortcuts_disk_root();
    if root.is_dir() {
        let _ = fs::remove_dir_all(&root);
    }
}

/// Fetch shortcuts for `app_name` via an OpenRouter chat completion.
async fn fetch_via_llm(app_name: &str, api_key: &str, api_base: &str) -> Result<String, String> {
    use openrouter_rs::{
        api::chat::{ChatCompletionRequest, Message},
        types::Role,
        OpenRouterClient,
    };

    let prompt = format!(
        "List the 20 most useful keyboard shortcuts for \"{}\" on macOS.\n\
         Format each as: Shortcut - Description\n\
         One per line. No intro, no outro, no numbering. Just the shortcut lines.\n\
         Include media keys, navigation, and editing shortcuts if applicable.\n\
         Use Cmd/Opt/Ctrl/Shift notation.",
        app_name
    );

    let client = if api_base.contains("openrouter.ai") {
        OpenRouterClient::builder()
            .api_key(api_key)
            .http_referer("https://computer-use.local")
            .x_title("Computer Use Shortcuts")
            .build()
            .map_err(|e| format!("Shortcuts client error: {}", e))?
    } else {
        OpenRouterClient::builder()
            .api_key(api_key)
            .base_url(api_base)
            .http_referer("https://computer-use.local")
            .x_title("Computer Use Shortcuts")
            .build()
            .map_err(|e| format!("Shortcuts client error: {}", e))?
    };

    let request = ChatCompletionRequest::builder()
        .model(SHORTCUTS_MODEL)
        .messages(vec![
            Message::new(Role::System, "You are a keyboard shortcut reference. Respond ONLY with shortcut lines, nothing else."),
            Message::new(Role::User, prompt.as_str()),
        ])
        .temperature(0.0)
        .max_tokens(600_u32)
        .build()
        .map_err(|e| format!("Shortcuts request build error: {}", e))?;

    let response = client
        .send_chat_completion(&request)
        .await
        .map_err(|e| format!("Shortcuts API error: {}", e))?;

    let content = response
        .choices
        .first()
        .and_then(|c| c.content())
        .ok_or_else(|| "No content in shortcuts response".to_string())?
        .to_string();

    Ok(content.trim().to_string())
}

/// High-level helper: get shortcuts for `app_name`, checking cache first,
/// then fetching via LLM. Returns the shortcuts text or empty on failure.
pub async fn get_or_fetch_global(app_name: &str, api_key: &str, api_base: &str) -> String {
    if should_skip(app_name) {
        return String::new();
    }

    // Check cache first
    if let Some(cached) = get_cached_global(app_name) {
        println!("[shortcuts] cache hit for '{}'", app_name);
        return cached;
    }

    // Fetch from LLM
    println!(
        "[shortcuts] fetching shortcuts for '{}' via {} ...",
        app_name, SHORTCUTS_MODEL
    );
    match fetch_via_llm(app_name, api_key, api_base).await {
        Ok(shortcuts) => {
            println!(
                "[shortcuts] fetched {} chars for '{}'",
                shortcuts.len(),
                app_name
            );
            set_cached_global(app_name, shortcuts.clone());
            shortcuts
        }
        Err(err) => {
            println!("[shortcuts] fetch failed for '{}': {}", app_name, err);
            // Cache the failure so we don't keep retrying
            set_cached_global(app_name, String::new());
            String::new()
        }
    }
}

// ── Tauri Commands ─────────────────────────────────────

/// Return type for the list command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedShortcutEntry {
    pub app_name: String,
    pub shortcuts: String,
}

/// List all cached shortcuts (from memory cache).
#[tauri::command]
pub fn list_all_cached_shortcuts_cmd() -> Vec<CachedShortcutEntry> {
    let lock = match global_cache().lock() {
        Ok(l) => l,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<CachedShortcutEntry> = lock
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| CachedShortcutEntry {
            app_name: k.clone(),
            shortcuts: v.clone(),
        })
        .collect();
    entries.sort_by(|a, b| a.app_name.cmp(&b.app_name));
    entries
}

/// Delete a single app's cached shortcuts (memory + disk).
#[tauri::command]
pub fn delete_cached_shortcuts_cmd(app_name: String) {
    let key = app_name.trim().to_lowercase();
    if let Ok(mut lock) = global_cache().lock() {
        lock.remove(&key);
    }
    let path = shortcuts_disk_root().join(format!("{}.txt", key));
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    println!("[shortcuts] deleted cache for '{}'", key);
}

/// Export all cached shortcuts as a single markdown string.
#[tauri::command]
pub fn export_shortcuts_cmd() -> String {
    let entries = list_all_cached_shortcuts_cmd();
    if entries.is_empty() {
        return "No shortcuts cached.".to_string();
    }
    let mut md = String::from("# Cached Keyboard Shortcuts\n\n");
    for entry in &entries {
        md.push_str(&format!("## {}\n\n", entry.app_name));
        md.push_str(&entry.shortcuts);
        md.push_str("\n\n---\n\n");
    }
    md
}
