use crate::{models::RuntimeGuards, MAX_ACTIONS_PER_RUN};
use serde_json::json;
use std::{process::Command, time::Duration};
use tauri::State;

const MAX_SHELL_OUTPUT_BYTES: usize = 4096;
const SHELL_TIMEOUT_SECS: u64 = 10;

/// Check a string (command or output) through WhiteCircle's guardrail API.
/// Returns Ok(true) if safe / no key configured, Ok(false) if blocked.
async fn whitecircle_guard(input: &str, guard_type: &str) -> Result<bool, String> {
    let api_key = std::env::var("WHITECIRCLE_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty());

    let api_key = match api_key {
        Some(k) => k,
        None => {
            println!(
                "[whitecircle] no API key configured, skipping {} guard",
                guard_type
            );
            return Ok(true);
        }
    };

    let base = std::env::var("WHITECIRCLE_API_BASE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "https://eu.whitecircle.ai/api/v1".to_string());

    let strict = std::env::var("WHITECIRCLE_STRICT")
        .ok()
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let url = format!("{}/guard", base.trim_end_matches('/'));

    let payload = json!({
        "type": guard_type,
        "content": input,
        "source": "computer-use-shell"
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("whitecircle client error: {}", e))?;

    match client
        .post(&url)
        .bearer_auth(api_key.trim())
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                let body: serde_json::Value = resp.json().await.unwrap_or(json!({}));
                let allowed = body
                    .get("allowed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let reason = body
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("no reason");
                println!(
                    "[whitecircle] {} guard: allowed={} reason={}",
                    guard_type, allowed, reason
                );
                Ok(allowed)
            } else {
                let body = resp.text().await.unwrap_or_default();
                println!(
                    "[whitecircle] {} guard returned HTTP {}: {}",
                    guard_type,
                    status,
                    body.chars().take(200).collect::<String>()
                );
                if strict {
                    Err(format!("WhiteCircle guard error (HTTP {})", status))
                } else {
                    Ok(true)
                }
            }
        }
        Err(err) => {
            println!("[whitecircle] {} guard network error: {}", guard_type, err);
            if strict {
                Err(format!("WhiteCircle guard unreachable: {}", err))
            } else {
                Ok(true)
            }
        }
    }
}

/// Wait for a child process with a timeout on Tauri's blocking runtime pool.
async fn wait_with_timeout_blocking(
    mut child: std::process::Child,
) -> Result<std::process::Output, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(SHELL_TIMEOUT_SECS);
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    return child
                        .wait_with_output()
                        .map_err(|e| format!("shell output error: {}", e));
                }
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        return Err(format!(
                            "Shell command timed out after {}s",
                            SHELL_TIMEOUT_SECS
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(format!("Error waiting for shell: {}", e)),
            }
        }
    })
    .await
    .map_err(|e| format!("Shell task join error: {}", e))?
}

#[tauri::command]
pub async fn run_shell_cmd(
    guards: State<'_, RuntimeGuards>,
    command: String,
) -> Result<String, String> {
    if guards.estop.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Emergency stop active".to_string());
    }

    let n = guards
        .actions
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if n >= MAX_ACTIONS_PER_RUN {
        guards
            .estop
            .store(true, std::sync::atomic::Ordering::SeqCst);
        return Err("Max actions reached; E-STOP engaged".to_string());
    }

    let input_safe = whitecircle_guard(&command, "input").await?;
    if !input_safe {
        return Err(format!(
            "Command blocked by WhiteCircle guardrail: {}",
            command.chars().take(100).collect::<String>()
        ));
    }

    println!("[shell] executing: {}", command);
    let started = std::time::Instant::now();

    let child = Command::new("/bin/sh")
        .arg("-c")
        .arg(&command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let output = wait_with_timeout_blocking(child).await?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    if !output.stderr.is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str("[stderr] ");
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
    }

    if combined.len() > MAX_SHELL_OUTPUT_BYTES {
        combined.truncate(MAX_SHELL_OUTPUT_BYTES);
        combined.push_str("\n... (output truncated)");
    }

    let exit_code = output.status.code().unwrap_or(-1);
    let elapsed_ms = started.elapsed().as_millis();
    println!(
        "[shell] exit={} ms={} output_bytes={} action_count={}",
        exit_code,
        elapsed_ms,
        combined.len(),
        n + 1
    );

    let output_safe = whitecircle_guard(&combined, "output").await?;
    if !output_safe {
        return Ok("[output redacted by WhiteCircle guardrail]".to_string());
    }

    Ok(combined)
}
