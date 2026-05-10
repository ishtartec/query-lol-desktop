use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Persistent app config. Schema v2 keeps shared toggles at the top and
/// per-account state (LP history) under `accounts`, keyed by Riot puuid so
/// switching accounts in the LoL client doesn't mix LP charts / daily stats.
///
/// `legacy_lp_history` is a migration-only field: deserialised from a v1
/// config that lacked the `accounts` map. The first time we know the active
/// puuid we move that history into the corresponding bucket and stop writing
/// the legacy key.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserConfig {
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(default = "default_true")]
    pub auto_apply: bool,
    #[serde(default)]
    pub auto_lock: bool,
    #[serde(default)]
    pub auto_accept: bool,
    #[serde(default)]
    pub tts_enabled: bool,

    #[serde(default)]
    pub accounts: HashMap<String, AccountState>,

    /// Migration-only: present on configs written by versions ≤ 0.14.x.
    /// Read on load, then folded into `accounts[active_puuid]` on first save
    /// and dropped from disk going forward.
    #[serde(default, rename = "lp_history", skip_serializing_if = "Vec::is_empty")]
    pub legacy_lp_history: Vec<LpEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountState {
    #[serde(default)]
    pub lp_history: Vec<LpEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LpEntry {
    pub timestamp: i64,
    pub lp: i64,
    pub tier: String,
    pub rank: String,
}

fn default_region() -> String { "euw".to_string() }
fn default_true() -> bool { true }

impl UserConfig {
    /// Returns the LP history for a given puuid (empty if unknown).
    /// If the legacy field is populated and `accounts` doesn't yet have a
    /// bucket for this puuid, that legacy data is treated as belonging to it
    /// (the only account this user has ever played from this install).
    pub fn lp_history_for(&self, puuid: &str) -> Vec<LpEntry> {
        if let Some(acc) = self.accounts.get(puuid) {
            return acc.lp_history.clone();
        }
        if !self.legacy_lp_history.is_empty() {
            return self.legacy_lp_history.clone();
        }
        vec![]
    }

    /// Stores LP history for a puuid and clears the migration field.
    pub fn set_lp_history(&mut self, puuid: &str, history: Vec<LpEntry>) {
        self.accounts.entry(puuid.to_string()).or_default().lp_history = history;
        self.legacy_lp_history.clear();
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
