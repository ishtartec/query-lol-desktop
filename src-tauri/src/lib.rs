mod config;
mod lcu;
mod models;
mod opgg;

use models::{AppState, ConnectionStatus};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

type SharedState = Arc<Mutex<AppState>>;

fn map_position(pos: &str) -> &'static str {
    match pos {
        "top" => "top",
        "jungle" => "jungle",
        "middle" | "mid" => "mid",
        "bottom" | "adc" => "adc",
        "utility" | "support" => "support",
        _ => "mid",
    }
}

#[tauri::command]
async fn get_state(state: tauri::State<'_, SharedState>) -> Result<AppState, String> {
    Ok(state.lock().await.clone())
}

#[tauri::command]
async fn set_auto_apply(
    enabled: bool,
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;
    s.auto_apply = enabled;
    let _ = app_handle.emit("app-state-changed", s.clone());
    config::save(&app_handle, &config::UserConfig {
        region: s.region.clone(),
        auto_apply: s.auto_apply,
    });
    Ok(())
}

#[tauri::command]
async fn set_region(
    region: String,
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;
    s.region = region;
    let _ = app_handle.emit("app-state-changed", s.clone());
    config::save(&app_handle, &config::UserConfig {
        region: s.region.clone(),
        auto_apply: s.auto_apply,
    });
    Ok(())
}

/// Watches for the LoL client to start, connects, runs the poll loop,
/// and reconnects automatically when the client restarts.
async fn watcher_loop(state: SharedState, app_handle: tauri::AppHandle) {
    loop {
        // Phase 1: Wait for LCU to become available
        let creds = loop {
            if let Some(creds) = lcu::read_lockfile() {
                if let Ok(summoner) = lcu::get_current_summoner(&creds).await {
                    let mut s = state.lock().await;
                    s.status = ConnectionStatus::Connected;
                    s.summoner_name = summoner.game_name.or(summoner.display_name);
                    s.summoner_id = summoner.summoner_id;
                    // Fetch match history
                    if let Ok(history) = lcu::get_match_history(&creds).await {
                        s.match_history = history;
                    }
                    let _ = app_handle.emit("app-state-changed", s.clone());
                    log::info!("Connected to LCU");
                    break creds;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        };

        // Phase 2: Run poll loop (returns when LCU disconnects)
        poll_loop(creds, Arc::clone(&state), app_handle.clone()).await;

        // Phase 3: LCU disconnected, loop back to watch
        log::info!("LCU disconnected, watching for reconnect...");
    }
}

async fn poll_loop(
    creds: models::LcuCredentials,
    state: SharedState,
    app_handle: tauri::AppHandle,
) {
    let mut last_champion_id: i64 = 0;
    let mut last_draft_hash: u64 = 0;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let phase = match lcu::get_gameflow_phase(&creds).await {
            Ok(p) => p,
            Err(_) => {
                let mut s = state.lock().await;
                s.status = ConnectionStatus::Disconnected;
                s.champion_id = None;
                s.build = None;
                s.build_alternatives = None;
                s.counters.clear();
                s.draft = None;
                s.recommendations = vec![];
                let _ = app_handle.emit("app-state-changed", s.clone());
                break;
            }
        };

        if phase == "ChampSelect" {
            // Detect game mode (ARAM vs Classic)
            let is_aram = if let Ok((queue_id, _)) = lcu::get_current_queue(&creds).await {
                let mut s = state.lock().await;
                if queue_id == 450 || queue_id == 900 { // ARAM queue IDs
                    s.game_mode = "aram".to_string();
                    true
                } else {
                    s.game_mode = "classic".to_string();
                    false
                }
            } else { false };

            let session = match lcu::get_champ_select_session(&creds).await {
                Ok(s) => s,
                Err(_) => continue,
            };

            let (champion_id, position) = lcu::extract_champion_from_session(&session);
            let draft = lcu::extract_draft_state(&session);

            // Hash draft state to detect changes
            let draft_hash = {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                for a in &draft.allies { a.champion_id.hash(&mut hasher); }
                for e in &draft.enemies { e.champion_id.hash(&mut hasher); }
                for b in &draft.bans { b.hash(&mut hasher); }
                hasher.finish()
            };

            // Update status
            {
                let mut s = state.lock().await;
                if s.status != ConnectionStatus::ChampSelect {
                    s.status = ConnectionStatus::ChampSelect;
                }
                s.draft = Some(draft.clone());
                let _ = app_handle.emit("app-state-changed", s.clone());
            }

            // If our champion changed, fetch build
            if champion_id > 0 && champion_id != last_champion_id {
                last_champion_id = champion_id;
                log::info!("Champion detected: {} (position: {})", champion_id, position);

                {
                    let mut s = state.lock().await;
                    s.champion_id = Some(champion_id);
                    s.assigned_position = Some(position.clone());
                    s.build = None;
                s.build_alternatives = None;
                s.counters.clear();
                    let _ = app_handle.emit("app-state-changed", s.clone());
                }

                let (region, auto_apply, summoner_id) = {
                    let s = state.lock().await;
                    (s.region.clone(), s.auto_apply, s.summoner_id)
                };

                let opgg_pos = if is_aram { "aram" } else { map_position(&position) };

                match opgg::fetch_champion_data(&region, champion_id, opgg_pos).await {
                    Ok(result) => {
                        log::info!("Champion data fetched for {}", champion_id);
                        let build = result.build.clone();
                        {
                            let mut s = state.lock().await;
                            s.build = Some(result.build);
                            s.build_alternatives = Some(result.alternatives);
                            // Store counters with string keys for JSON serialization
                            s.counters = result.counters.iter()
                                .map(|(k, v)| (k.to_string(), *v))
                                .collect();
                            let _ = app_handle.emit("app-state-changed", s.clone());
                        }

                        if auto_apply {
                            if let Some(ref runes) = build.runes {
                                if let Err(e) = lcu::apply_runes(&creds, runes).await {
                                    log::warn!("Failed to apply runes: {}", e);
                                }
                            }
                            if let Some([s1, s2]) = build.summoner_spells {
                                if let Err(e) = lcu::apply_summoner_spells(&creds, s1, s2).await {
                                    log::warn!("Failed to apply spells: {}", e);
                                }
                            }
                            if let Some(sid) = summoner_id {
                                if let Err(e) = lcu::apply_item_set(&creds, sid, champion_id, &build).await {
                                    log::warn!("Failed to apply items: {}", e);
                                }
                            }
                            log::info!("Auto-apply completed");
                        }
                    }
                    Err(e) => log::warn!("Failed to fetch champion data: {}", e),
                }
            }

            // If draft changed and we haven't picked yet, generate recommendations
            if draft_hash != last_draft_hash {
                last_draft_hash = draft_hash;

                let my_champ = champion_id;
                let region = state.lock().await.region.clone();
                // Get position from draft state (more reliable than assigned_position)
                let my_pos = draft.allies.iter()
                    .find(|a| a.is_local)
                    .map(|a| a.position.clone())
                    .unwrap_or_default();
                let opgg_pos = map_position(&my_pos);

                // Only recommend if we haven't picked yet and not ARAM
                if my_champ == 0 && !opgg_pos.is_empty() && !is_aram {
                    let enemy_ids: Vec<i64> = draft.enemies.iter()
                        .map(|e| e.champion_id)
                        .filter(|&id| id > 0)
                        .collect();
                    let ally_ids: Vec<i64> = draft.allies.iter()
                        .filter(|a| !a.is_local)
                        .map(|a| a.champion_id)
                        .filter(|&id| id > 0)
                        .collect();

                    match opgg::recommend_picks(
                        &region, opgg_pos, &enemy_ids, &draft.bans, &ally_ids
                    ).await {
                        Ok(recs) => {
                            let mut s = state.lock().await;
                            s.recommendations = recs;
                            let _ = app_handle.emit("app-state-changed", s.clone());
                        }
                        Err(e) => log::warn!("Failed to get recommendations: {}", e),
                    }
                }
            }
        } else if phase == "InProgress" || phase == "GameStart" {
            let mut s = state.lock().await;
            if s.status != ConnectionStatus::InGame {
                // Fetch live game info once on transition
                match lcu::get_live_game(&creds).await {
                    Ok(live) => {
                        s.status = ConnectionStatus::InGame;
                        s.live_game = Some(live);
                        s.champion_id = None;
                        s.build = None;
                        s.build_alternatives = None;
                        s.counters.clear();
                        s.draft = None;
                        s.recommendations = vec![];
                        last_champion_id = 0;
                        last_draft_hash = 0;
                        let _ = app_handle.emit("app-state-changed", s.clone());
                        log::info!("Live game info loaded");
                    }
                    Err(e) => log::warn!("Failed to fetch live game: {}", e),
                }
            }
        } else if phase == "WaitingForStats" || phase == "EndOfGame" {
            let mut s = state.lock().await;
            if s.status != ConnectionStatus::PostGame {
                // Transition into post-game: fetch stats once
                match lcu::get_end_of_game_stats(&creds).await {
                    Ok(stats) => {
                        s.status = ConnectionStatus::PostGame;
                        s.post_game = Some(stats);
                        s.champion_id = None;
                        s.build = None;
                s.build_alternatives = None;
                s.counters.clear();
                        s.draft = None;
                        s.recommendations = vec![];
                        last_champion_id = 0;
                        last_draft_hash = 0;
                        let _ = app_handle.emit("app-state-changed", s.clone());
                        log::info!("Post-game stats loaded");
                    }
                    Err(e) => log::warn!("Failed to fetch post-game stats: {}", e),
                }
            }
        } else {
            let mut s = state.lock().await;
            if s.status != ConnectionStatus::Connected {
                s.status = ConnectionStatus::Connected;
                s.champion_id = None;
                s.champion_name = None;
                s.assigned_position = None;
                s.build = None;
                s.build_alternatives = None;
                s.counters.clear();
                s.draft = None;
                s.recommendations = vec![];
                s.post_game = None;
                s.live_game = None;
                s.game_mode = "classic".to_string();
                last_champion_id = 0;
                last_draft_hash = 0;
                // Refresh match history
                if let Ok(history) = lcu::get_match_history(&creds).await {
                    s.match_history = history;
                }
                let _ = app_handle.emit("app-state-changed", s.clone());
            }
        }
    }
}

#[tauri::command]
async fn apply_build_now(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let s = state.lock().await;
    let creds = lcu::read_lockfile().ok_or("League client not found")?;

    if let Some(ref build) = s.build {
        if let Some(ref runes) = build.runes {
            lcu::apply_runes(&creds, runes).await?;
        }
        if let Some([s1, s2]) = build.summoner_spells {
            lcu::apply_summoner_spells(&creds, s1, s2).await?;
        }
        if let (Some(sid), Some(cid)) = (s.summoner_id, s.champion_id) {
            lcu::apply_item_set(&creds, sid, cid, build).await?;
        }
        Ok(())
    } else {
        Err("No build available".to_string())
    }
}

#[tauri::command]
async fn select_build_option(
    category: String,
    index: usize,
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;

    // Clone what we need from alternatives before mutating build
    let alts = s.build_alternatives.clone().ok_or("No alternatives available")?;

    let build = s.build.as_mut().ok_or("No build available")?;
    match category.as_str() {
        "runes" => {
            let opt = alts.runes.get(index).ok_or("Invalid rune index")?;
            build.runes = Some(opt.build.clone());
        }
        "spells" => {
            let opt = alts.summoner_spells.get(index).ok_or("Invalid spell index")?;
            build.summoner_spells = Some(opt.ids);
        }
        "items" => {
            let opt = alts.core_items.get(index).ok_or("Invalid item index")?;
            build.core_items = opt.ids.clone();
        }
        _ => return Err("Unknown category".to_string()),
    }

    let _ = app_handle.emit("app-state-changed", s.clone());

    // Re-apply if auto_apply
    if s.auto_apply {
        let creds = lcu::read_lockfile().ok_or("League client not found")?;
        let build = s.build.clone().unwrap();
        let summoner_id = s.summoner_id;
        let champion_id = s.champion_id;
        drop(s);

        if let Some(ref runes) = build.runes {
            if category == "runes" {
                let _ = lcu::apply_runes(&creds, runes).await;
            }
        }
        if let Some([s1, s2]) = build.summoner_spells {
            if category == "spells" {
                let _ = lcu::apply_summoner_spells(&creds, s1, s2).await;
            }
        }
        if category == "items" {
            if let (Some(sid), Some(cid)) = (summoner_id, champion_id) {
                let _ = lcu::apply_item_set(&creds, sid, cid, &build).await;
            }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let state: SharedState = Arc::new(Mutex::new(AppState::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_auto_apply,
            set_region,
            apply_build_now,
            select_build_option,
        ])
        .setup(|app| {
            // Load persisted preferences
            let cfg = config::load(app.handle());
            let state = app.state::<SharedState>();
            {
                let mut s = tauri::async_runtime::block_on(state.lock());
                s.region = cfg.region;
                s.auto_apply = cfg.auto_apply;
            }

            // Spawn auto-reconnect watcher
            let state_clone = Arc::clone(&*app.state::<SharedState>());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                watcher_loop(state_clone, app_handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
