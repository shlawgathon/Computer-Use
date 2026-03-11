use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

// ── Agent Memory (Persistent Learnings) ────────────────
//
// Stores observations, mistakes, and user-provided corrections
// that the agent can reference. Persisted to a JSON file on disk.

fn memory_file() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("computer-use")
        .join("memory")
        .join("memories.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    pub text: String,
    /// "user" or "agent"
    pub source: String,
    pub created_at: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<String>,
}

fn load_all() -> Vec<MemoryItem> {
    let path = memory_file();
    if !path.exists() {
        return Vec::new();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_all(items: &[MemoryItem]) -> Result<(), String> {
    let path = memory_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ── Tauri Commands ─────────────────────────────────────

#[tauri::command]
pub fn list_memories_cmd() -> Vec<MemoryItem> {
    load_all()
}

#[derive(Debug, Deserialize)]
pub struct AddMemoryRequest {
    pub text: String,
    pub source: Option<String>,
    pub app_context: Option<String>,
}

#[tauri::command]
pub fn add_memory_cmd(req: AddMemoryRequest) -> Result<MemoryItem, String> {
    let mut items = load_all();
    let item = MemoryItem {
        id: format!("mem-{}", now_ms()),
        text: req.text,
        source: req.source.unwrap_or_else(|| "user".to_string()),
        created_at: now_ms(),
        app_context: req.app_context,
    };
    items.push(item.clone());
    save_all(&items)?;
    println!("[memory] added '{}' ({} total)", item.id, items.len());
    Ok(item)
}

#[tauri::command]
pub fn delete_memory_cmd(id: String) -> Result<(), String> {
    let mut items = load_all();
    let before = items.len();
    items.retain(|m| m.id != id);
    if items.len() == before {
        return Err(format!("Memory '{}' not found", id));
    }
    save_all(&items)?;
    println!("[memory] deleted '{}' ({} remaining)", id, items.len());
    Ok(())
}
