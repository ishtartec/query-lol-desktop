use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserConfig {
    pub region: String,
    pub auto_apply: bool,
    #[serde(default)]
    pub auto_lock: bool,
}

impl Default for UserConfig {
    fn default() -> Self {
        Self {
            region: "euw".to_string(),
            auto_apply: true,
            auto_lock: false,
        }
    }
}

fn config_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(dir.join("config.json"))
}

pub fn load(app_handle: &tauri::AppHandle) -> UserConfig {
    config_path(app_handle)
        .ok()
        .and_then(|path| std::fs::read_to_string(&path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn save(app_handle: &tauri::AppHandle, config: &UserConfig) {
    if let Ok(path) = config_path(app_handle) {
        if let Ok(json) = serde_json::to_string_pretty(config) {
            let _ = std::fs::write(path, json);
        }
    }
}
