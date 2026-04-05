mod config;
mod lcu;
mod models;
mod opgg;

use models::{AppState, ConnectionStatus};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

type SharedState = Arc<Mutex<AppState>>;

fn save_config(app: &tauri::AppHandle, s: &models::AppState) {
    config::save(app, &config::UserConfig {
        region: s.region.clone(),
        auto_apply: s.auto_apply,
        auto_lock: s.auto_lock,
        auto_accept: s.auto_accept,
        lp_history: s.lp_history.clone(),
    });
}

fn notify(title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "display notification \"{}\" with title \"{}\" sound name \"Glass\"",
                body.replace('"', "\\\""),
                title.replace('"', "\\\"")
            ))
            .spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (title, body); // suppress unused warnings; Windows notifications can be added later
    }
}

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
    save_config(&app_handle, &s);
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
    save_config(&app_handle, &s);
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
                    // Fetch match history and ranked stats
                    if let Ok(history) = lcu::get_match_history(&creds).await {
                        s.match_history = history;
                    }
                    if let Ok(ranked) = lcu::get_ranked_stats(&creds).await {
                        // Record initial LP if history is empty or LP changed
                        let should_record = s.lp_history.last()
                            .map(|last| last.lp != ranked.lp || last.tier != ranked.tier || last.rank != ranked.rank)
                            .unwrap_or(true);
                        if should_record && ranked.tier != "UNRANKED" {
                            s.lp_history.push(config::LpEntry {
                                timestamp: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as i64,
                                lp: ranked.lp,
                                tier: ranked.tier.clone(),
                                rank: ranked.rank.clone(),
                            });
                        }
                        s.ranked = Some(ranked);
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
            Ok(p) => {
                log::debug!("Phase: {}", p);
                p
            }
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

        if phase == "ReadyCheck" {
            let auto_accept = state.lock().await.auto_accept;
            if auto_accept {
                // Accept once, then wait for phase to change
                match lcu::accept_ready_check(&creds).await {
                    Ok(()) => {
                        // Wait for phase to transition, don't retry
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    }
                    Err(_) => {} // Already accepted or expired, ignore
                }
            }
            continue;
        }

        if phase == "ChampSelect" {
            // Detect game mode + fetch ban suggestions + comfort picks on first tick
            let first_tick = state.lock().await.status != ConnectionStatus::ChampSelect;
            if first_tick {
                let mut is_aram_mode = false;
                if let Ok((queue_id, _)) = lcu::get_current_queue(&creds).await {
                    is_aram_mode = queue_id == 450 || queue_id == 900;
                    let mut s = state.lock().await;
                    s.game_mode = if is_aram_mode { "aram".to_string() } else { "classic".to_string() };
                }

                if !is_aram_mode {
                    // Extract what we need from state BEFORE making HTTP calls
                    let (region, history) = {
                        let s = state.lock().await;
                        (s.region.clone(), s.match_history.clone())
                    };

                    if let Ok(session) = lcu::get_champ_select_session(&creds).await {
                        let my_pos = session.my_team.iter()
                            .find(|p| p.cell_id == session.local_player_cell_id)
                            .and_then(|p| p.assigned_position.clone())
                            .unwrap_or_default()
                            .to_lowercase();
                        let opgg_pos = map_position(&my_pos);

                        // Fetch ban suggestions (no lock held during HTTP)
                        if let Ok(bans) = opgg::fetch_ban_suggestions(&region, opgg_pos).await {
                            state.lock().await.ban_suggestions = bans;
                        }

                        // Calculate comfort picks from match history
                        let mut champ_counts: std::collections::HashMap<i64, i32> = std::collections::HashMap::new();
                        for m in &history {
                            *champ_counts.entry(m.champion_id).or_insert(0) += 1;
                        }
                        let mut top_champs: Vec<(i64, i32)> = champ_counts.into_iter()
                            .filter(|(_, count)| *count >= 2)
                            .collect();
                        top_champs.sort_by(|a, b| b.1.cmp(&a.1));
                        top_champs.truncate(3);

                        if !top_champs.is_empty() {
                            let champ_ids: Vec<i64> = top_champs.iter().map(|(id, _)| *id).collect();
                            if let Ok(win_rates) = opgg::fetch_champion_win_rates(
                                &region, opgg_pos, &champ_ids
                            ).await {
                                let comfort: Vec<models::ComfortPick> = top_champs.iter().map(|(id, count)| {
                                    models::ComfortPick {
                                        champion_id: *id,
                                        games_played: *count,
                                        meta_win_rate: win_rates.get(id).copied().unwrap_or(0.5),
                                    }
                                }).collect();
                                state.lock().await.comfort_picks = comfort;
                            }
                        }
                    }
                }
            }
            let is_aram = state.lock().await.game_mode == "aram";

            let session = match lcu::get_champ_select_session(&creds).await {
                Ok(s) => s,
                Err(_) => continue,
            };

            let (champion_id, position) = lcu::extract_champion_from_session(&session);
            let draft = lcu::extract_draft_state(&session);

            // Check if ban phase is still active
            let ban_active = session.actions.iter().flatten()
                .any(|a| a.action_type == "ban" && !a.completed);

            // Hash draft state to detect changes
            let draft_hash = {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                for a in &draft.allies { a.champion_id.hash(&mut hasher); }
                for e in &draft.enemies { e.champion_id.hash(&mut hasher); }
                for b in &draft.ally_bans { b.hash(&mut hasher); }
                for b in &draft.enemy_bans { b.hash(&mut hasher); }
                hasher.finish()
            };

            // Update status
            {
                let mut s = state.lock().await;
                if s.status != ConnectionStatus::ChampSelect {
                    s.status = ConnectionStatus::ChampSelect;
                    s.viewing_past_match = false;
                    s.post_game = None;
                    notify("QueryLoL", "Champion Select has started!");
                }
                s.draft = Some(draft.clone());
                s.ban_phase_active = ban_active;
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
                    let enemies_with_pos: Vec<(i64, String)> = draft.enemies.iter()
                        .filter(|e| e.champion_id > 0)
                        .map(|e| (e.champion_id, map_position(&e.position).to_string()))
                        .collect();
                    let ally_ids: Vec<i64> = draft.allies.iter()
                        .filter(|a| !a.is_local)
                        .map(|a| a.champion_id)
                        .filter(|&id| id > 0)
                        .collect();

                    let all_bans: Vec<i64> = draft.ally_bans.iter().chain(draft.enemy_bans.iter()).copied().collect();
                    match opgg::recommend_picks(
                        &region, opgg_pos, &enemies_with_pos, &all_bans, &ally_ids
                    ).await {
                        Ok(recs) => {
                            let mut s = state.lock().await;
                            s.recommendations = recs;
                            let _ = app_handle.emit("app-state-changed", s.clone());
                        }
                        Err(e) => log::warn!("Failed to get recommendations: {}", e),
                    }
                }

                // Fetch counters for visible enemies (even before we pick)
                let visible_enemies: Vec<(i64, String)> = draft.enemies.iter()
                    .filter(|e| e.champion_id > 0)
                    .map(|e| (e.champion_id, map_position(&e.position).to_string()))
                    .collect();

                if !visible_enemies.is_empty() && !is_aram {
                    let mut all_counters: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
                    for (enemy_id, enemy_pos) in &visible_enemies {
                        let pos = if enemy_pos.is_empty() { opgg_pos } else { enemy_pos.as_str() };
                        if let Ok(counters) = opgg::fetch_counters(&region, *enemy_id, pos).await {
                            // Store as "our WR vs this enemy" — invert the perspective
                            // counters contains enemy's WR against each champion
                            // We want: for each enemy, what's the average WR against them
                            let avg_wr = if counters.is_empty() { 0.5 } else {
                                counters.values().sum::<f64>() / counters.len() as f64
                            };
                            // avg_wr is the enemy's average WR against all champions
                            // So 1.0 - avg_wr is roughly "how beatable" the enemy is
                            all_counters.insert(enemy_id.to_string(), 1.0 - avg_wr);
                        }
                    }
                    if !all_counters.is_empty() {
                        let mut s = state.lock().await;
                        s.counters = all_counters;
                        let _ = app_handle.emit("app-state-changed", s.clone());
                    }

                    // Generate prediction if both teams have picks
                    if !visible_enemies.is_empty() {
                        let ally_champs: Vec<(i64, String)> = draft.allies.iter()
                            .filter(|a| a.champion_id > 0)
                            .map(|a| (a.champion_id, map_position(&a.position).to_string()))
                            .collect();

                        if !ally_champs.is_empty() {
                            match opgg::generate_prediction(&region, &ally_champs, &visible_enemies).await {
                                Ok(pred) => {
                                    let mut s = state.lock().await;
                                    s.prediction = Some(pred);
                                    let _ = app_handle.emit("app-state-changed", s.clone());
                                }
                                Err(e) => log::warn!("Failed to generate prediction: {}", e),
                            }
                        }
                    }
                }
            }
        } else if phase == "InProgress" || phase == "GameStart" {
            let (already_in_game, sid, my_name) = {
                let s = state.lock().await;
                (s.status == ConnectionStatus::InGame, s.summoner_id, s.summoner_name.clone().unwrap_or_default())
            };
            if !already_in_game {
                // Fetch live game info once on transition
                match lcu::get_live_game(&creds, sid).await {
                    Ok(mut live) => {
                        let mut s = state.lock().await;
                        // Preserve build into live game state for power spike alerts
                        live.recommended_build = s.build.clone();
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
            } else {
                // Poll live client data API for real-time stats
                let mut s = state.lock().await;
                if let Some(ref mut live) = s.live_game {
                    match lcu::poll_live_game_data(live, &my_name).await {
                        Ok(_) => {
                            let _ = app_handle.emit("app-state-changed", s.clone());
                        }
                        Err(e) => {
                            log::debug!("Live client poll: {}", e);
                        }
                    }
                }
            }
        } else if phase == "WaitingForStats" || phase == "EndOfGame" {
            let mut s = state.lock().await;
            if s.status != ConnectionStatus::PostGame {
                // Transition into post-game: fetch stats once
                match lcu::get_end_of_game_stats(&creds).await {
                    Ok(mut stats) => {
                        s.status = ConnectionStatus::PostGame;
                        // Compute phase stats and gold timeline from live game snapshots
                        if let Some(ref live_game) = s.live_game {
                            if let Some(ref live_data) = live_game.live_data {
                                if !live_data.snapshots.is_empty() {
                                    log::info!("Computing phase stats from {} snapshots", live_data.snapshots.len());
                                    for team in &mut stats.teams {
                                        for player in &mut team.players {
                                            let phases = lcu::compute_phase_stats(&live_data.snapshots, &player.summoner_name);
                                            if !phases.is_empty() {
                                                player.phase_stats = phases;
                                            }
                                        }
                                    }
                                    // Gold timeline and death impacts
                                    let ally_names: Vec<String> = live_game.allies.iter().map(|p| p.summoner_name.clone()).collect();
                                    let enemy_names: Vec<String> = live_game.enemies.iter().map(|p| p.summoner_name.clone()).collect();
                                    let (timeline, deaths) = lcu::compute_gold_timeline(&live_data.snapshots, &ally_names, &enemy_names);
                                    stats.gold_timeline = timeline;
                                    stats.death_events = deaths;
                                }
                            }
                        }
                        s.post_game = Some(stats);
                        s.live_game = None; // Clean up after consuming snapshots
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
            // When viewing a past match, only interrupt for important phases
            if s.viewing_past_match {
                drop(s);
                continue;
            }
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
                // Keep live_game until post-game has consumed snapshots
                if s.live_game.as_ref().and_then(|lg| lg.live_data.as_ref()).map(|ld| ld.snapshots.is_empty()).unwrap_or(true) {
                    s.live_game = None;
                }
                s.game_mode = "classic".to_string();
                last_champion_id = 0;
                last_draft_hash = 0;
                // Refresh match history and ranked stats (delay for API indexing)
                drop(s);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let mut s = state.lock().await;
                if let Ok(history) = lcu::get_match_history(&creds).await {
                    s.match_history = history;
                }
                if let Ok(ranked) = lcu::get_ranked_stats(&creds).await {
                    // Record LP if it changed
                    let should_record = s.ranked.as_ref()
                        .map(|old| old.lp != ranked.lp || old.tier != ranked.tier || old.rank != ranked.rank)
                        .unwrap_or(true);

                    if should_record && ranked.tier != "UNRANKED" {
                        let entry = config::LpEntry {
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as i64,
                            lp: ranked.lp,
                            tier: ranked.tier.clone(),
                            rank: ranked.rank.clone(),
                        };
                        s.lp_history.push(entry);
                        // Keep last 50 entries
                        if s.lp_history.len() > 50 {
                            s.lp_history = s.lp_history[s.lp_history.len()-50..].to_vec();
                        }
                        // Persist
                        save_config(&app_handle, &s);
                    }

                    s.ranked = Some(ranked);
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

#[tauri::command]
async fn set_auto_lock(
    enabled: bool,
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;
    s.auto_lock = enabled;
    let _ = app_handle.emit("app-state-changed", s.clone());
    save_config(&app_handle, &s);
    Ok(())
}

#[tauri::command]
async fn set_auto_accept(
    enabled: bool,
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;
    s.auto_accept = enabled;
    let _ = app_handle.emit("app-state-changed", s.clone());
    save_config(&app_handle, &s);
    Ok(())
}

#[tauri::command]
async fn pick_champion(
    champion_id: i64,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let creds = lcu::read_lockfile().ok_or("League client not found")?;
    let session = lcu::get_champ_select_session(&creds).await?;
    let auto_lock = state.lock().await.auto_lock;

    // Log all actions for debugging
    for (gi, group) in session.actions.iter().enumerate() {
        for action in group {
            if action.actor_cell_id == session.local_player_cell_id {
                log::info!(
                    "My action[{}]: id={} type={} champ={} completed={} inProgress={}",
                    gi, action.id, action.action_type, action.champion_id, action.completed, action.is_in_progress
                );
            }
        }
    }

    let action_id = lcu::find_my_action(&session, "pick")
        .ok_or("No active pick action — it's not your turn to pick")?;

    lcu::select_champion(&creds, action_id, champion_id, auto_lock).await
}

#[tauri::command]
async fn ban_champion(
    champion_id: i64,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let creds = lcu::read_lockfile().ok_or("League client not found")?;
    let session = lcu::get_champ_select_session(&creds).await?;
    let auto_lock = state.lock().await.auto_lock;

    for (gi, group) in session.actions.iter().enumerate() {
        for action in group {
            if action.actor_cell_id == session.local_player_cell_id {
                log::info!(
                    "My ban action[{}]: id={} type={} champ={} completed={} inProgress={}",
                    gi, action.id, action.action_type, action.champion_id, action.completed, action.is_in_progress
                );
            }
        }
    }

    let action_id = lcu::find_my_action(&session, "ban")
        .ok_or("No active ban action — it's not your turn to ban")?;

    lcu::select_champion(&creds, action_id, champion_id, auto_lock).await
}

#[derive(serde::Serialize)]
struct PlayerProfile {
    name: String,
    rank: String,
    matches: Vec<models::MatchHistoryEntry>,
}

#[tauri::command]
async fn view_player_profile(puuid: String) -> Result<PlayerProfile, String> {
    let creds = lcu::read_lockfile().ok_or("League client not found")?;
    let c1 = creds.clone();
    let c2 = creds.clone();
    let p1 = puuid.clone();
    let p2 = puuid.clone();

    let (name, rank, matches) = tokio::join!(
        lcu::get_summoner_name_by_puuid(&c1, &p1),
        lcu::get_player_rank(&c2, &p2),
        lcu::get_player_match_history(&creds, &puuid),
    );

    Ok(PlayerProfile {
        name,
        rank,
        matches: matches.unwrap_or_default(),
    })
}

#[tauri::command]
async fn view_match_details(
    game_id: i64,
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let creds = lcu::read_lockfile().ok_or("League client not found")?;
    let stats = lcu::get_match_details(&creds, game_id).await?;

    let mut s = state.lock().await;
    s.post_game = Some(stats);
    s.status = models::ConnectionStatus::PostGame;
    s.viewing_past_match = true;
    let _ = app_handle.emit("app-state-changed", s.clone());
    Ok(())
}

#[tauri::command]
async fn back_to_lobby(
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;
    s.status = models::ConnectionStatus::Connected;
    s.post_game = None;
    s.viewing_past_match = false;
    let _ = app_handle.emit("app-state-changed", s.clone());
    Ok(())
}

#[tauri::command]
async fn set_overlay_position(
    position: String,
    state: tauri::State<'_, SharedState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    state.lock().await.overlay_position = position.clone();
    if position == "off" {
        if let Some(window) = app_handle.get_webview_window("overlay") {
            let _ = window.hide();
        }
        return Ok(());
    }
    if let Some(window) = app_handle.get_webview_window("overlay") {
        let scale = window.scale_factor().unwrap_or(1.0);
        let monitor = window.current_monitor()
            .map_err(|e| format!("Failed to get monitor: {}", e))?
            .ok_or("No monitor found")?;
        let screen = monitor.size();
        let ow = (320.0 * scale) as i32 + 20;
        let oh = (260.0 * scale) as i32 + 20;
        let margin = (10.0 * scale) as i32;
        let sw = screen.width as i32;
        let sh = screen.height as i32;
        let (x, y) = match position.as_str() {
            "top-left" => (margin, margin),
            "top-right" => (sw - ow, margin),
            "bottom-left" => (margin, sh - oh),
            "bottom-right" => (sw - ow, sh - oh),
            "center" => (sw / 2 - ow / 2, sh / 2 - oh / 2),
            _ => (margin, margin),
        };
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
            .map_err(|e| format!("Failed to set position: {}", e))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Monitors TAB key and shows/hides the overlay window during in-game.
async fn overlay_loop(state: SharedState, app_handle: tauri::AppHandle) {
    use device_query::{DeviceQuery, DeviceState, Keycode};

    let device_state = DeviceState::new();
    let mut was_visible = false;

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let (is_in_game, overlay_off) = {
            let s = state.lock().await;
            (s.status == ConnectionStatus::InGame, s.overlay_position == "off")
        };

        if overlay_off {
            if was_visible {
                if let Some(window) = app_handle.get_webview_window("overlay") {
                    let _ = window.hide();
                }
                was_visible = false;
            }
            continue;
        }

        if !is_in_game {
            if was_visible {
                if let Some(window) = app_handle.get_webview_window("overlay") {
                    let _ = window.hide();
                }
                was_visible = false;
            }
            continue;
        }

        let keys = device_state.get_keys();
        let tab_pressed = keys.contains(&Keycode::Tab);

        if tab_pressed && !was_visible {
            if let Some(window) = app_handle.get_webview_window("overlay") {
                let _ = window.show();
                let _ = window.set_ignore_cursor_events(true);
            }
            was_visible = true;
        } else if !tab_pressed && was_visible {
            if let Some(window) = app_handle.get_webview_window("overlay") {
                let _ = window.hide();
            }
            was_visible = false;
        }
    }
}

pub fn run() {
    env_logger::init();

    let state: SharedState = Arc::new(Mutex::new(AppState::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_auto_apply,
            set_region,
            apply_build_now,
            select_build_option,
            set_auto_lock,
            set_auto_accept,
            pick_champion,
            ban_champion,
            view_player_profile,
            view_match_details,
            back_to_lobby,
            set_overlay_position,
        ])
        .setup(|app| {
            // Load persisted preferences
            let cfg = config::load(app.handle());
            let state = app.state::<SharedState>();
            {
                let mut s = tauri::async_runtime::block_on(state.lock());
                s.region = cfg.region;
                s.auto_apply = cfg.auto_apply;
                s.auto_lock = cfg.auto_lock;
                s.auto_accept = cfg.auto_accept;
                s.lp_history = cfg.lp_history;
            }

            // Spawn auto-reconnect watcher
            let state_clone = Arc::clone(&*app.state::<SharedState>());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                watcher_loop(state_clone, app_handle).await;
            });

            // Spawn overlay keyboard listener (TAB hold-to-show)
            let overlay_state = Arc::clone(&*app.state::<SharedState>());
            let overlay_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                overlay_loop(overlay_state, overlay_handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
