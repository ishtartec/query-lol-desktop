use crate::models::*;
use base64::Engine;
use log::info;
use std::path::PathBuf;

/// Try to find and parse the League client lockfile.
pub fn read_lockfile() -> Option<LcuCredentials> {
    let mut possible_paths: Vec<Option<PathBuf>> = vec![];

    // macOS paths
    #[cfg(target_os = "macos")]
    {
        possible_paths.push(Some(PathBuf::from("/Applications/League of Legends.app/Contents/LoL/lockfile")));
        if let Ok(home) = std::env::var("HOME") {
            let path = PathBuf::from(home)
                .join("Library/Application Support/Riot Games/League of Legends/lockfile");
            if path.exists() { possible_paths.push(Some(path)); }
        }
    }

    // Windows paths
    #[cfg(target_os = "windows")]
    {
        let common_paths = [
            "C:\\Riot Games\\League of Legends\\lockfile",
            "D:\\Riot Games\\League of Legends\\lockfile",
            "C:\\Program Files\\Riot Games\\League of Legends\\lockfile",
            "C:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile",
        ];
        for p in &common_paths {
            possible_paths.push(Some(PathBuf::from(p)));
        }
        // Also check LOCALAPPDATA for Riot Client install path
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let install_path = PathBuf::from(&local).join("Riot Games\\League of Legends\\lockfile");
            possible_paths.push(Some(install_path));
        }
    }

    for path in possible_paths.into_iter().flatten() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let parts: Vec<&str> = content.trim().split(':').collect();
            if parts.len() >= 5 {
                if let Ok(port) = parts[2].parse::<u16>() {
                    info!("Found lockfile at {:?} (port: {})", path, port);
                    return Some(LcuCredentials {
                        port,
                        password: parts[3].to_string(),
                    });
                }
            }
        }
    }

    read_from_process()
}

fn read_from_process() -> Option<LcuCredentials> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("ps")
            .args(["-A", "-o", "args="])
            .output()
            .ok()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if !line.contains("LeagueClientUx") { continue; }
            let port = extract_arg(line, "--app-port=")?;
            let token = extract_arg(line, "--remoting-auth-token=")?;
            info!("Found LCU via process args (port: {})", port);
            return Some(LcuCredentials { port: port.parse().ok()?, password: token });
        }
    }

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("wmic")
            .args(["process", "where", "name='LeagueClientUx.exe'", "get", "CommandLine", "/format:list"])
            .output()
            .ok()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if !line.contains("LeagueClientUx") { continue; }
            let port = extract_arg(line, "--app-port=")?;
            let token = extract_arg(line, "--remoting-auth-token=")?;
            info!("Found LCU via process args (port: {})", port);
            return Some(LcuCredentials { port: port.parse().ok()?, password: token });
        }
    }

    None
}

fn extract_arg(line: &str, prefix: &str) -> Option<String> {
    line.split_whitespace()
        .find(|arg| arg.starts_with(prefix))
        .map(|arg| arg.trim_start_matches(prefix).to_string())
}

fn auth_header(password: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", password));
    format!("Basic {}", encoded)
}

fn lcu_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .http1_only()
        .build()
        .expect("Failed to build HTTP client")
}

fn lcu_url(creds: &LcuCredentials, path: &str) -> String {
    format!("https://127.0.0.1:{}{}", creds.port, path)
}

// --- REST API calls ---

pub async fn get_gameflow_phase(creds: &LcuCredentials) -> Result<String, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-gameflow/v1/gameflow-phase"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get gameflow phase: {}", e))?;

    let text = resp.text().await
        .map_err(|e| format!("Failed to read gameflow phase: {}", e))?;
    Ok(text.trim_matches('"').to_string())
}

pub async fn get_current_summoner(creds: &LcuCredentials) -> Result<LcuSummoner, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-summoner/v1/current-summoner"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get summoner: {}", e))?;

    resp.json().await
        .map_err(|e| format!("Failed to parse summoner: {}", e))
}

pub async fn get_champ_select_session(creds: &LcuCredentials) -> Result<ChampSelectSession, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-champ-select/v1/session"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get champ select: {}", e))?;

    resp.json().await
        .map_err(|e| format!("Failed to parse champ select session: {}", e))
}

pub async fn apply_runes(creds: &LcuCredentials, build: &RuneBuild) -> Result<(), String> {
    let client = lcu_client();

    let pages: Vec<LcuRunePage> = client
        .get(lcu_url(creds, "/lol-perks/v1/pages"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get rune pages: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse rune pages: {}", e))?;

    if let Some(page) = pages.iter().find(|p| p.id.unwrap_or(0) > 0) {
        let _ = client
            .delete(lcu_url(creds, &format!("/lol-perks/v1/pages/{}", page.id.unwrap())))
            .header("Authorization", auth_header(&creds.password))
            .send()
            .await;
        info!("Deleted rune page: {}", page.name);
    }

    let new_page = LcuRunePage {
        id: None,
        name: "QueryLoL Auto".to_string(),
        primary_style_id: build.primary_style_id,
        sub_style_id: build.sub_style_id,
        selected_perk_ids: build.selected_perk_ids.clone(),
        current: true,
    };

    let resp = client
        .post(lcu_url(creds, "/lol-perks/v1/pages"))
        .header("Authorization", auth_header(&creds.password))
        .json(&new_page)
        .send()
        .await
        .map_err(|e| format!("Failed to create rune page: {}", e))?;

    if resp.status().is_success() {
        info!("Runes applied successfully");
        Ok(())
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("Failed to create rune page: {} - {}", status, body))
    }
}

pub async fn apply_summoner_spells(creds: &LcuCredentials, spell1: i64, spell2: i64) -> Result<(), String> {
    let client = lcu_client();
    let body = serde_json::json!({ "spell1Id": spell1, "spell2Id": spell2 });

    let resp = client
        .patch(lcu_url(creds, "/lol-champ-select/v1/session/my-selection"))
        .header("Authorization", auth_header(&creds.password))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to apply spells: {}", e))?;

    if resp.status().is_success() {
        info!("Summoner spells applied: {} / {}", spell1, spell2);
        Ok(())
    } else {
        Err(format!("Failed to apply spells: {}", resp.status()))
    }
}

pub async fn apply_item_set(
    creds: &LcuCredentials,
    summoner_id: i64,
    champion_id: i64,
    build: &ChampionBuild,
) -> Result<(), String> {
    let client = lcu_client();
    let mut blocks = vec![];

    if !build.starter_items.is_empty() {
        blocks.push(serde_json::json!({
            "type": "Starter Items",
            "items": build.starter_items.iter().map(|id| serde_json::json!({"id": id.to_string(), "count": 1})).collect::<Vec<_>>()
        }));
    }
    if !build.boots.is_empty() {
        blocks.push(serde_json::json!({
            "type": "Boots",
            "items": build.boots.iter().map(|id| serde_json::json!({"id": id.to_string(), "count": 1})).collect::<Vec<_>>()
        }));
    }
    if !build.core_items.is_empty() {
        blocks.push(serde_json::json!({
            "type": "Core Build",
            "items": build.core_items.iter().map(|id| serde_json::json!({"id": id.to_string(), "count": 1})).collect::<Vec<_>>()
        }));
    }

    let item_set = serde_json::json!({
        "title": "QueryLoL Recommended",
        "type": "custom",
        "map": "SR",
        "mode": "any",
        "priority": true,
        "sortrank": 0,
        "blocks": blocks,
        "associatedChampions": [champion_id],
    });

    let body = serde_json::json!({
        "accountId": summoner_id,
        "itemSets": [item_set],
    });

    let url = lcu_url(creds, &format!("/lol-item-sets/v1/item-sets/{}/sets", summoner_id));
    let resp = client
        .put(&url)
        .header("Authorization", auth_header(&creds.password))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to apply item set: {}", e))?;

    if resp.status().is_success() {
        info!("Item set applied for champion {}", champion_id);
        Ok(())
    } else {
        Err(format!("Failed to apply item set: {}", resp.status()))
    }
}

pub async fn get_end_of_game_stats(creds: &LcuCredentials) -> Result<PostGameStats, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-end-of-game/v1/eog-stats-block"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get EOG stats: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("EOG stats returned: {}", resp.status()));
    }

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse EOG stats: {}", e))?;

    let game_duration_secs = raw.get("gameLength")
        .and_then(|v| v.as_i64())
        .or_else(|| raw.get("gameDuration").and_then(|v| v.as_i64()))
        .unwrap_or(0);

    let game_id = raw.get("gameId")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    // Parse the LCU response into our clean types
    let mut teams = vec![];

    if let Some(raw_teams) = raw.get("teams").and_then(|t| t.as_array()) {
        for raw_team in raw_teams {
            let is_winner = raw_team.get("isWinningTeam")
                .and_then(|w| w.as_bool())
                .unwrap_or(false);

            let mut players = vec![];
            if let Some(raw_players) = raw_team.get("players").and_then(|p| p.as_array()) {
                for rp in raw_players {
                    let stats = rp.get("stats").unwrap_or(&serde_json::Value::Null);
                    // Name: prefer riotIdGameName, fall back to summonerName, then championName
                    let name = [
                        rp.get("riotIdGameName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()),
                        rp.get("summonerName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()),
                        rp.get("championName").and_then(|v| v.as_str()),
                    ]
                    .into_iter()
                    .flatten()
                    .next()
                    .unwrap_or("Unknown");

                    // Items: try player-level array first, then stats ITEM0-ITEM5
                    let items: Vec<i64> = rp.get("items")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).filter(|&id| id > 0).collect())
                        .unwrap_or_else(|| {
                            (0..6).filter_map(|i| {
                                stats.get(&format!("ITEM{}", i)).and_then(|v| v.as_i64()).filter(|&id| id > 0)
                            }).collect()
                        });

                    let position = rp.get("detectedTeamPosition")
                        .and_then(|v| v.as_str())
                        .or_else(|| rp.get("selectedPosition").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_uppercase();

                    let puuid_str = rp.get("puuid").and_then(|v| v.as_str()).unwrap_or("");
                    let rank = if !puuid_str.is_empty() {
                        get_player_rank(creds, puuid_str).await
                    } else {
                        String::new()
                    };

                    players.push(PostGamePlayer {
                        champion_id: rp.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
                        summoner_name: name.to_string(),
                        position,
                        rank,
                        puuid: puuid_str.to_string(),
                        is_local: rp.get("isLocalPlayer").and_then(|v| v.as_bool()).unwrap_or(false),
                        kills: stats.get("CHAMPIONS_KILLED").and_then(|v| v.as_i64()).unwrap_or(0),
                        deaths: stats.get("NUM_DEATHS").and_then(|v| v.as_i64()).unwrap_or(0),
                        assists: stats.get("ASSISTS").and_then(|v| v.as_i64()).unwrap_or(0),
                        total_damage: stats.get("TOTAL_DAMAGE_DEALT_TO_CHAMPIONS").and_then(|v| v.as_i64()).unwrap_or(0),
                        gold_earned: stats.get("GOLD_EARNED").and_then(|v| v.as_i64()).unwrap_or(0),
                        cs: stats.get("MINIONS_KILLED").and_then(|v| v.as_i64()).unwrap_or(0)
                            + stats.get("NEUTRAL_MINIONS_KILLED").and_then(|v| v.as_i64()).unwrap_or(0),
                        vision_score: stats.get("VISION_SCORE").and_then(|v| v.as_i64()).unwrap_or(0),
                        wards_placed: stats.get("WARD_PLACED").and_then(|v| v.as_i64()).unwrap_or(0),
                        wards_killed: stats.get("WARD_KILLED").and_then(|v| v.as_i64()).unwrap_or(0),
                        damage_share: 0.0,
                        kill_participation: 0.0,
                        double_kills: stats.get("DOUBLE_KILLS").and_then(|v| v.as_i64()).unwrap_or(0),
                        triple_kills: stats.get("TRIPLE_KILLS").and_then(|v| v.as_i64()).unwrap_or(0),
                        quadra_kills: stats.get("QUADRA_KILLS").and_then(|v| v.as_i64()).unwrap_or(0),
                        penta_kills: stats.get("PENTA_KILLS").and_then(|v| v.as_i64()).unwrap_or(0),
                        mvp_score: 0.0,
                        is_mvp: false,
                        items,
                        phase_stats: vec![],
                    });
                }
            }

            // Calculate damage share and kill participation
            let team_total_damage = players.iter().map(|p| p.total_damage).sum::<i64>().max(1);
            let team_total_kills = players.iter().map(|p| p.kills).sum::<i64>().max(1);
            for p in &mut players {
                p.damage_share = p.total_damage as f64 / team_total_damage as f64;
                p.kill_participation = (p.kills + p.assists) as f64 / team_total_kills as f64;
            }

            // Calculate MVP scores
            for p in &mut players {
                p.mvp_score = p.kills as f64 * 4.0
                    + p.assists as f64 * 2.0
                    - p.deaths as f64 * 3.0
                    + p.total_damage as f64 / 1000.0 * 1.0
                    + p.cs as f64 * 0.1
                    + p.vision_score as f64 * 0.2
                    + (p.kills + p.assists) as f64 / (p.deaths.max(1)) as f64 * 5.0;
            }

            // Mark MVP (highest score)
            if let Some(max_score) = players.iter().map(|p| p.mvp_score).reduce(f64::max) {
                if let Some(mvp) = players.iter_mut().find(|p| (p.mvp_score - max_score).abs() < 0.01) {
                    mvp.is_mvp = true;
                }
            }

            // Calculate team averages
            let count = players.len().max(1) as i64;
            let avg_damage = players.iter().map(|p| p.total_damage).sum::<i64>() / count;
            let avg_gold = players.iter().map(|p| p.gold_earned).sum::<i64>() / count;
            let avg_cs = players.iter().map(|p| p.cs).sum::<i64>() / count;
            let avg_vision = players.iter().map(|p| p.vision_score).sum::<i64>() / count;

            teams.push(PostGameTeam {
                is_winner, players,
                avg_damage, avg_gold, avg_cs, avg_vision,
            });
        }
    }

    info!("Post-game stats parsed: {} teams, duration: {}s, gameId: {}", teams.len(), game_duration_secs, game_id);
    Ok(PostGameStats { teams, game_duration_secs, game_id, gold_timeline: vec![], death_events: vec![] })
}

/// Select a champion in champ select (hover). Optionally lock it in.
pub async fn select_champion(
    creds: &LcuCredentials,
    action_id: i64,
    champion_id: i64,
    lock: bool,
) -> Result<(), String> {
    let client = lcu_client();

    // Select (hover) the champion
    let url = lcu_url(creds, &format!("/lol-champ-select/v1/session/actions/{}", action_id));
    let resp = client
        .patch(&url)
        .header("Authorization", auth_header(&creds.password))
        .json(&serde_json::json!({ "championId": champion_id }))
        .send()
        .await
        .map_err(|e| format!("Failed to select champion: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Select champion failed: {}", resp.status()));
    }

    info!("Champion {} selected on action {}", champion_id, action_id);

    // Lock in if requested
    if lock {
        let lock_url = lcu_url(creds, &format!("/lol-champ-select/v1/session/actions/{}/complete", action_id));
        let resp = client
            .post(&lock_url)
            .header("Authorization", auth_header(&creds.password))
            .send()
            .await
            .map_err(|e| format!("Failed to lock champion: {}", e))?;

        if resp.status().is_success() {
            info!("Champion {} locked in", champion_id);
        } else {
            return Err(format!("Lock champion failed: {}", resp.status()));
        }
    }

    Ok(())
}

/// Find the current player's active pick or ban action ID.
pub fn find_my_action(session: &ChampSelectSession, action_type: &str) -> Option<i64> {
    let my_cell = session.local_player_cell_id;
    for group in &session.actions {
        for action in group {
            if action.actor_cell_id == my_cell
                && action.action_type == action_type
                && action.is_in_progress
                && !action.completed
            {
                return Some(action.id);
            }
        }
    }
    None
}

/// Extract full draft state from champ select session.
pub fn extract_draft_state(session: &ChampSelectSession) -> DraftState {
    let my_cell = session.local_player_cell_id;

    // Build a map of cell_id -> champion_id from actions (pre-lock picks)
    let mut action_picks: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    let mut ally_bans: Vec<i64> = vec![];
    let mut enemy_bans: Vec<i64> = vec![];

    // Collect ally cell IDs for ban attribution
    let ally_cells: std::collections::HashSet<i64> = session.my_team.iter().map(|p| p.cell_id).collect();

    for action_group in &session.actions {
        for action in action_group {
            if action.action_type == "pick" && action.champion_id > 0 {
                action_picks.insert(action.actor_cell_id, action.champion_id);
            }
            if action.action_type == "ban" && action.champion_id > 0 && action.completed {
                if ally_cells.contains(&action.actor_cell_id) {
                    ally_bans.push(action.champion_id);
                } else {
                    enemy_bans.push(action.champion_id);
                }
            }
        }
    }

    let allies: Vec<DraftPlayer> = session.my_team.iter().map(|p| {
        let champ_id = if p.champion_id > 0 {
            p.champion_id
        } else {
            action_picks.get(&p.cell_id).copied().unwrap_or(0)
        };
        DraftPlayer {
            champion_id: champ_id,
            position: p.assigned_position.clone().unwrap_or_default().to_lowercase(),
            is_local: p.cell_id == my_cell,
        }
    }).collect();

    let enemies: Vec<DraftPlayer> = session.their_team.iter().map(|p| {
        let champ_id = if p.champion_id > 0 {
            p.champion_id
        } else {
            action_picks.get(&p.cell_id).copied().unwrap_or(0)
        };
        DraftPlayer {
            champion_id: champ_id,
            position: p.assigned_position.clone().unwrap_or_default().to_lowercase(),
            is_local: false,
        }
    }).collect();

    ally_bans.dedup();
    enemy_bans.dedup();

    DraftState { allies, enemies, ally_bans, enemy_bans }
}

/// Extract champion ID from session, checking both myTeam and actions.
/// Before lock-in, championId in myTeam is 0; the actual pick is in actions.
pub fn extract_champion_from_session(session: &ChampSelectSession) -> (i64, String) {
    let my_cell = session.local_player_cell_id;

    let my_player = session.my_team.iter().find(|p| p.cell_id == my_cell);
    let position = my_player
        .and_then(|p| p.assigned_position.clone())
        .unwrap_or_default()
        .to_lowercase();

    if let Some(player) = my_player {
        if player.champion_id > 0 {
            return (player.champion_id, position);
        }
    }

    // Fallback: check actions for our pick (before lock-in)
    for action_group in &session.actions {
        for action in action_group {
            if action.actor_cell_id == my_cell
                && action.action_type == "pick"
                && action.champion_id > 0
            {
                return (action.champion_id, position);
            }
        }
    }

    (0, position)
}

/// Accept the ready check (queue pop).
pub async fn accept_ready_check(creds: &LcuCredentials) -> Result<(), String> {
    let client = lcu_client();
    let resp = client
        .post(lcu_url(creds, "/lol-matchmaking/v1/ready-check/accept"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to accept ready check: {}", e))?;

    if resp.status().is_success() {
        info!("Ready check accepted");
        Ok(())
    } else {
        Err(format!("Accept ready check failed: {}", resp.status()))
    }
}

/// Fetch ranked stats for current summoner.
pub async fn get_ranked_stats(creds: &LcuCredentials) -> Result<RankedInfo, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-ranked/v1/current-ranked-stats"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get ranked stats: {}", e))?;

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse ranked stats: {}", e))?;

    // Find solo queue stats
    let queues = raw.get("queues").and_then(|q| q.as_array());
    if let Some(queues) = queues {
        for q in queues {
            let queue_type = q.get("queueType").and_then(|v| v.as_str()).unwrap_or("");
            if queue_type == "RANKED_SOLO_5x5" {
                return Ok(RankedInfo {
                    tier: q.get("tier").and_then(|v| v.as_str()).unwrap_or("UNRANKED").to_string(),
                    rank: q.get("division").and_then(|v| v.as_str())
                        .or_else(|| q.get("rank").and_then(|v| v.as_str()))
                        .unwrap_or("").to_string(),
                    lp: q.get("leaguePoints").and_then(|v| v.as_i64()).unwrap_or(0),
                    wins: q.get("wins").and_then(|v| v.as_i64()).unwrap_or(0),
                    losses: q.get("losses").and_then(|v| v.as_i64()).unwrap_or(0),
                });
            }
        }
    }

    Err("No ranked data found".to_string())
}

/// Resolve summoner name by summoner ID.
pub async fn get_summoner_name(creds: &LcuCredentials, summoner_id: i64) -> String {
    let client = lcu_client();
    let url = lcu_url(creds, &format!("/lol-summoner/v1/summoners/{}", summoner_id));
    let resp = match client
        .get(&url)
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return String::new(),
    };

    let raw: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return String::new(),
    };

    raw.get("gameName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| raw.get("displayName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string()
}

/// Resolve summoner name by puuid.
pub async fn get_summoner_name_by_puuid(creds: &LcuCredentials, puuid: &str) -> String {
    let client = lcu_client();
    let url = lcu_url(creds, &format!("/lol-summoner/v2/summoners/puuid/{}", puuid));
    let resp = match client.get(&url).header("Authorization", auth_header(&creds.password)).send().await {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    let raw: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    raw.get("gameName").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .or_else(|| raw.get("displayName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .unwrap_or("Unknown").to_string()
}

/// Fetch ranked tier for a player by puuid. Returns e.g. "GOLD III" or "".
pub async fn get_player_rank(creds: &LcuCredentials, puuid: &str) -> String {
    let (rank, _, _) = get_player_ranked_stats(creds, puuid).await;
    rank
}

/// Fetch ranked stats: (rank string, wins, losses).
pub async fn get_player_ranked_stats(creds: &LcuCredentials, puuid: &str) -> (String, i64, i64) {
    let client = lcu_client();
    let url = lcu_url(creds, &format!("/lol-ranked/v1/ranked-stats/{}", puuid));
    let resp = match client
        .get(&url)
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return (String::new(), 0, 0),
    };

    let raw: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return (String::new(), 0, 0),
    };

    // Try "queues" array first, then "queueMap" object (different LCU versions)
    let solo_queue = if let Some(queues) = raw.get("queues").and_then(|q| q.as_array()) {
        queues.iter().find(|q| q.get("queueType").and_then(|v| v.as_str()).unwrap_or("") == "RANKED_SOLO_5x5").cloned()
    } else if let Some(qmap) = raw.get("queueMap").and_then(|q| q.as_object()) {
        qmap.get("RANKED_SOLO_5x5").cloned()
    } else {
        None
    };

    if let Some(q) = solo_queue {
        let tier = q.get("tier").and_then(|v| v.as_str()).unwrap_or("");
        let division = q.get("division").and_then(|v| v.as_str())
            .or_else(|| q.get("rank").and_then(|v| v.as_str()))
            .unwrap_or("");
        let wins = q.get("wins").and_then(|v| v.as_i64()).unwrap_or(0);
        let losses = q.get("losses").and_then(|v| v.as_i64()).unwrap_or(0);
        let rank = if !tier.is_empty() && tier != "NONE" {
            format!("{} {}", tier, division)
        } else {
            String::new()
        };
        info!("Ranked stats for {}: {} ({}W {}L)", puuid.chars().take(8).collect::<String>(), rank, wins, losses);
        return (rank, wins, losses);
    }
    (String::new(), 0, 0)
}

/// Fetch account level by puuid.
pub async fn get_account_level(creds: &LcuCredentials, puuid: &str) -> i64 {
    let client = lcu_client();
    let url = lcu_url(creds, &format!("/lol-summoner/v2/summoners/puuid/{}", puuid));
    let resp = match client.get(&url).header("Authorization", auth_header(&creds.password)).send().await {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let raw: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return 0,
    };
    raw.get("summonerLevel").and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Calculate smurf score (0-100) from account signals.
pub fn analyze_smurf(
    account_level: i64,
    _rank: &str,
    wins: i64,
    losses: i64,
    matches: &[MatchHistoryEntry],
) -> SmurfAnalysis {
    let games_played = wins + losses;
    let win_rate = if games_played > 0 {
        wins as f64 / games_played as f64
    } else {
        0.0
    };

    let (avg_kda, unique_champions) = if !matches.is_empty() {
        let mut total_k = 0i64;
        let mut total_d = 0i64;
        let mut total_a = 0i64;
        let mut champs = std::collections::HashSet::new();
        for m in matches {
            total_k += m.kills;
            total_d += m.deaths;
            total_a += m.assists;
            champs.insert(m.champion_id);
        }
        let kda = if total_d == 0 {
            (total_k + total_a) as f64
        } else {
            (total_k + total_a) as f64 / total_d as f64
        };
        (kda, champs.len() as i64)
    } else {
        (0.0, 0)
    };

    let mut score: f64 = 0.0;

    // Factor 1: Low account level (max 25)
    score += if account_level < 35 {
        25.0
    } else if account_level < 50 {
        20.0
    } else if account_level < 80 {
        12.0
    } else if account_level < 120 {
        5.0
    } else {
        0.0
    };

    // Factor 2: High win rate (max 30)
    if games_played >= 10 {
        score += if win_rate > 0.70 {
            30.0
        } else if win_rate > 0.62 {
            22.0
        } else if win_rate > 0.55 {
            10.0
        } else {
            0.0
        };
    }

    // Factor 3: Few ranked games (max 15)
    if games_played > 0 {
        score += if games_played < 30 {
            15.0
        } else if games_played < 60 {
            8.0
        } else if games_played < 100 {
            3.0
        } else {
            0.0
        };
    }

    // Factor 4: High KDA (max 20)
    score += if avg_kda > 5.0 {
        20.0
    } else if avg_kda > 3.5 {
        15.0
    } else if avg_kda > 2.5 {
        8.0
    } else {
        0.0
    };

    // Factor 5: Low champion diversity (max 10)
    let match_count = matches.len() as i64;
    if match_count >= 5 {
        let ratio = unique_champions as f64 / match_count as f64;
        score += if ratio < 0.15 {
            10.0
        } else if ratio < 0.25 {
            7.0
        } else if ratio < 0.35 {
            3.0
        } else {
            0.0
        };
    }

    SmurfAnalysis {
        score: (score as u8).min(100),
        account_level,
        games_played,
        win_rate,
        avg_kda,
        unique_champions,
    }
}

/// Fetch match history for any player by puuid.
pub async fn get_player_match_history(creds: &LcuCredentials, puuid: &str) -> Result<Vec<MatchHistoryEntry>, String> {
    let client = lcu_client();
    let url = lcu_url(creds, &format!("/lol-match-history/v1/products/lol/{}/matches", puuid));
    let resp = client
        .get(&url)
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get player history: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Player history returned: {}", resp.status()));
    }

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse player history: {}", e))?;

    let mut entries = vec![];
    if let Some(games) = raw.get("games").and_then(|g| g.get("games")).and_then(|g| g.as_array()) {
        for game in games {
            let game_mode = game.get("gameMode").and_then(|v| v.as_str()).unwrap_or("CLASSIC").to_string();
            let queue_id = game.get("queueId").and_then(|v| v.as_i64()).unwrap_or(0);
            let duration = game.get("gameDuration").and_then(|v| v.as_i64()).unwrap_or(0);
            let timestamp = game.get("gameCreation").and_then(|v| v.as_i64()).unwrap_or(0);

            if let Some(participants) = game.get("participants").and_then(|p| p.as_array()) {
                if let Some(me) = participants.first() {
                    let stats = me.get("stats").unwrap_or(&serde_json::Value::Null);
                    let game_id = game.get("gameId").and_then(|v| v.as_i64()).unwrap_or(0);
                    entries.push(MatchHistoryEntry {
                        game_id,
                        champion_id: me.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
                        queue_id,
                        game_mode,
                        win: stats.get("win").and_then(|v| v.as_bool()).unwrap_or(false),
                        kills: stats.get("kills").and_then(|v| v.as_i64()).unwrap_or(0),
                        deaths: stats.get("deaths").and_then(|v| v.as_i64()).unwrap_or(0),
                        assists: stats.get("assists").and_then(|v| v.as_i64()).unwrap_or(0),
                        duration_secs: duration,
                        timestamp,
                        cs: stats.get("totalMinionsKilled").and_then(|v| v.as_i64()).unwrap_or(0)
                            + stats.get("neutralMinionsKilled").and_then(|v| v.as_i64()).unwrap_or(0),
                        vision_score: stats.get("visionScore").and_then(|v| v.as_i64()).unwrap_or(0),
                        gold_earned: stats.get("goldEarned").and_then(|v| v.as_i64()).unwrap_or(0),
                        total_damage: stats.get("totalDamageDealtToChampions").and_then(|v| v.as_i64()).unwrap_or(0),
                    });
                }
            }
        }
    }
    Ok(entries)
}

/// Fetch match history for current summoner.
pub async fn get_match_history(creds: &LcuCredentials) -> Result<Vec<MatchHistoryEntry>, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=50"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get match history: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Match history returned: {}", resp.status()));
    }

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse match history: {}", e))?;

    let mut entries = vec![];
    if let Some(games) = raw.get("games").and_then(|g| g.get("games")).and_then(|g| g.as_array()) {
        for game in games {
            let game_mode = game.get("gameMode").and_then(|v| v.as_str()).unwrap_or("CLASSIC").to_string();
            let queue_id = game.get("queueId").and_then(|v| v.as_i64()).unwrap_or(0);
            let duration = game.get("gameDuration").and_then(|v| v.as_i64()).unwrap_or(0);
            let timestamp = game.get("gameCreation").and_then(|v| v.as_i64()).unwrap_or(0);

            // Find the local player's participant data
            if let Some(participants) = game.get("participants").and_then(|p| p.as_array()) {
                if let Some(me) = participants.first() {
                    let stats = me.get("stats").unwrap_or(&serde_json::Value::Null);
                    let win = stats.get("win").and_then(|v| v.as_bool()).unwrap_or(false);
                    let champion_id = me.get("championId").and_then(|v| v.as_i64()).unwrap_or(0);
                    let kills = stats.get("kills").and_then(|v| v.as_i64()).unwrap_or(0);
                    let deaths = stats.get("deaths").and_then(|v| v.as_i64()).unwrap_or(0);
                    let assists = stats.get("assists").and_then(|v| v.as_i64()).unwrap_or(0);

                    let game_id = game.get("gameId").and_then(|v| v.as_i64()).unwrap_or(0);
                    entries.push(MatchHistoryEntry {
                        game_id,
                        champion_id,
                        queue_id,
                        game_mode,
                        win,
                        kills,
                        deaths,
                        assists,
                        duration_secs: duration,
                        timestamp,
                        cs: stats.get("totalMinionsKilled").and_then(|v| v.as_i64()).unwrap_or(0)
                            + stats.get("neutralMinionsKilled").and_then(|v| v.as_i64()).unwrap_or(0),
                        vision_score: stats.get("visionScore").and_then(|v| v.as_i64()).unwrap_or(0),
                        gold_earned: stats.get("goldEarned").and_then(|v| v.as_i64()).unwrap_or(0),
                        total_damage: stats.get("totalDamageDealtToChampions").and_then(|v| v.as_i64()).unwrap_or(0),
                    });
                }
            }
        }
    }

    info!("Match history: {} entries", entries.len());
    Ok(entries)
}

/// Fetch details for a past match by game ID.
pub async fn get_match_details(creds: &LcuCredentials, game_id: i64) -> Result<PostGameStats, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, &format!("/lol-match-history/v1/games/{}", game_id)))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get match details: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Match details returned: {}", resp.status()));
    }

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse match details: {}", e))?;

    let game_duration_secs = raw.get("gameDuration")
        .and_then(|v| v.as_i64())
        .or_else(|| raw.get("gameLength").and_then(|v| v.as_i64()))
        .unwrap_or(0);

    // Match details have a different structure: participants + participantIdentities
    let mut team_map: std::collections::HashMap<i64, Vec<PostGamePlayer>> = std::collections::HashMap::new();
    let mut winning_team: i64 = 0;

    // Get winning team from teams array
    if let Some(teams) = raw.get("teams").and_then(|t| t.as_array()) {
        for t in teams {
            let win = t.get("win").and_then(|v| v.as_str()).unwrap_or("") == "Win";
            if win {
                winning_team = t.get("teamId").and_then(|v| v.as_i64()).unwrap_or(0);
            }
        }
    }

    // Build identity map: participantId -> (name, puuid)
    let mut identities_map: std::collections::HashMap<i64, (String, String)> = std::collections::HashMap::new();
    if let Some(identities) = raw.get("participantIdentities").and_then(|p| p.as_array()) {
        for ident in identities {
            let pid = ident.get("participantId").and_then(|v| v.as_i64()).unwrap_or(0);
            let player = ident.get("player").unwrap_or(&serde_json::Value::Null);
            let name = player.get("gameName").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                .or_else(|| player.get("summonerName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                .unwrap_or("Unknown")
                .to_string();
            let puuid = player.get("puuid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            identities_map.insert(pid, (name, puuid));
        }
    }

    if let Some(participants) = raw.get("participants").and_then(|p| p.as_array()) {
        for p in participants {
            let pid = p.get("participantId").and_then(|v| v.as_i64()).unwrap_or(0);
            let team_id = p.get("teamId").and_then(|v| v.as_i64()).unwrap_or(0);
            let stats = p.get("stats").unwrap_or(&serde_json::Value::Null);

            let kills = stats.get("kills").and_then(|v| v.as_i64()).unwrap_or(0);
            let deaths = stats.get("deaths").and_then(|v| v.as_i64()).unwrap_or(0);
            let assists = stats.get("assists").and_then(|v| v.as_i64()).unwrap_or(0);
            let total_damage = stats.get("totalDamageDealtToChampions").and_then(|v| v.as_i64()).unwrap_or(0);
            let gold_earned = stats.get("goldEarned").and_then(|v| v.as_i64()).unwrap_or(0);
            let cs = stats.get("totalMinionsKilled").and_then(|v| v.as_i64()).unwrap_or(0)
                + stats.get("neutralMinionsKilled").and_then(|v| v.as_i64()).unwrap_or(0);
            let vision_score = stats.get("visionScore").and_then(|v| v.as_i64()).unwrap_or(0);

            let items: Vec<i64> = (0..6).filter_map(|i| {
                stats.get(&format!("item{}", i)).and_then(|v| v.as_i64()).filter(|&id| id > 0)
            }).collect();

            let timeline = p.get("timeline").unwrap_or(&serde_json::Value::Null);
            let lane = timeline.get("lane").and_then(|v| v.as_str()).unwrap_or("");
            let role = timeline.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let has_smite = p.get("spell1Id").and_then(|v| v.as_i64()).unwrap_or(0) == 11
                || p.get("spell2Id").and_then(|v| v.as_i64()).unwrap_or(0) == 11;
            let position = if has_smite {
                "JUNGLE"
            } else {
                match (lane, role) {
                    ("JUNGLE", _) => "TOP",  // JUNGLE without Smite = likely TOP
                    ("TOP", _) => "TOP",
                    ("MIDDLE" | "MID", _) => "MIDDLE",
                    ("BOTTOM" | "BOT", "DUO_SUPPORT") => "UTILITY",
                    ("BOTTOM" | "BOT", _) if cs < 100 && vision_score > 15 => "UTILITY",
                    ("BOTTOM" | "BOT", _) => "BOTTOM",
                    _ => lane,
                }
            }.to_uppercase();

            let (name, puuid) = identities_map.get(&pid)
                .cloned()
                .unwrap_or_else(|| ("Unknown".to_string(), String::new()));

            // Fetch rank for this player
            let rank = if !puuid.is_empty() {
                get_player_rank(creds, &puuid).await
            } else {
                String::new()
            };

            let mut player = PostGamePlayer {
                champion_id: p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
                summoner_name: name,
                position,
                rank,
                puuid: puuid.clone(),
                is_local: false,
                kills, deaths, assists, total_damage, gold_earned, cs, vision_score,
                wards_placed: stats.get("wardsPlaced").and_then(|v| v.as_i64()).unwrap_or(0),
                wards_killed: stats.get("wardsKilled").and_then(|v| v.as_i64()).unwrap_or(0),
                damage_share: 0.0,
                kill_participation: 0.0,
                double_kills: stats.get("doubleKills").and_then(|v| v.as_i64()).unwrap_or(0),
                triple_kills: stats.get("tripleKills").and_then(|v| v.as_i64()).unwrap_or(0),
                quadra_kills: stats.get("quadraKills").and_then(|v| v.as_i64()).unwrap_or(0),
                penta_kills: stats.get("pentaKills").and_then(|v| v.as_i64()).unwrap_or(0),
                mvp_score: 0.0,
                is_mvp: false,
                items,
                phase_stats: vec![],
            };

            player.mvp_score = kills as f64 * 4.0
                + assists as f64 * 2.0
                - deaths as f64 * 3.0
                + total_damage as f64 / 1000.0 * 1.0
                + cs as f64 * 0.1
                + vision_score as f64 * 0.2
                + (kills + assists) as f64 / (deaths.max(1)) as f64 * 5.0;

            team_map.entry(team_id).or_default().push(player);
        }
    }

    let mut teams = vec![];
    for (team_id, mut players) in team_map {
        // Calculate damage share and kill participation
        let team_dmg = players.iter().map(|p| p.total_damage).sum::<i64>().max(1);
        let team_kills = players.iter().map(|p| p.kills).sum::<i64>().max(1);
        for p in &mut players {
            p.damage_share = p.total_damage as f64 / team_dmg as f64;
            p.kill_participation = (p.kills + p.assists) as f64 / team_kills as f64;
        }

        // Mark MVP
        if let Some(max_score) = players.iter().map(|p| p.mvp_score).reduce(f64::max) {
            if let Some(mvp) = players.iter_mut().find(|p| (p.mvp_score - max_score).abs() < 0.01) {
                mvp.is_mvp = true;
            }
        }

        let count = players.len().max(1) as i64;
        teams.push(PostGameTeam {
            is_winner: team_id == winning_team,
            avg_damage: players.iter().map(|p| p.total_damage).sum::<i64>() / count,
            avg_gold: players.iter().map(|p| p.gold_earned).sum::<i64>() / count,
            avg_cs: players.iter().map(|p| p.cs).sum::<i64>() / count,
            avg_vision: players.iter().map(|p| p.vision_score).sum::<i64>() / count,
            players,
        });
    }

    // Sort teams: winning team first
    teams.sort_by(|a, b| b.is_winner.cmp(&a.is_winner));

    Ok(PostGameStats { teams, game_duration_secs, game_id, gold_timeline: vec![], death_events: vec![] })
}

/// Get the current queue ID from the gameflow session.
pub async fn get_current_queue(creds: &LcuCredentials) -> Result<(i64, String), String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-gameflow/v1/session"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get gameflow session: {}", e))?;

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse gameflow session: {}", e))?;

    let queue_id = raw.get("gameData")
        .and_then(|g| g.get("queue"))
        .and_then(|q| q.get("id"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let queue_name = raw.get("gameData")
        .and_then(|g| g.get("queue"))
        .and_then(|q| q.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("Normal")
        .to_string();

    Ok((queue_id, queue_name))
}

/// Get live game session info (players in current game).
pub async fn get_live_game(creds: &LcuCredentials, my_summoner_id: Option<i64>) -> Result<LiveGameState, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-gameflow/v1/session"))
        .header("Authorization", auth_header(&creds.password))
        .send()
        .await
        .map_err(|e| format!("Failed to get live game: {}", e))?;

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse live game: {}", e))?;

    let queue_name = raw.get("gameData")
        .and_then(|g| g.get("queue"))
        .and_then(|q| q.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("Game")
        .to_string();

    // Log gameData keys for debugging
    if let Some(gd) = raw.get("gameData").and_then(|g| g.as_object()) {
        let keys: Vec<&str> = gd.keys().map(|k| k.as_str()).collect();
        info!("Live game gameData keys: {:?}", keys);
    }

    let mut allies = vec![];
    let mut enemies = vec![];

    // Parse players with summoner IDs and puuids
    struct RawPlayer {
        player: LiveGamePlayer,
        summoner_id: i64,
        puuid: String,
        is_enemy: bool,
    }

    fn parse_players_raw(arr: &[serde_json::Value]) -> Vec<RawPlayer> {
        arr.iter().map(|p| {
            let sid = p.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
            let puuid = p.get("puuid").and_then(|v| v.as_str()).unwrap_or("").to_string();

            let name = p.get("riotIdGameName")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| p.get("summonerName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                .or_else(|| p.get("gameName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                .or_else(|| p.get("summonerInternalName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                .unwrap_or("")
                .to_string();

            let position = p.get("selectedPosition")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("")
                .to_uppercase();

            RawPlayer {
                player: LiveGamePlayer {
                    champion_id: p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
                    summoner_name: name,
                    rank: String::new(),
                    puuid: puuid.clone(),
                    position,
                    smurf: None,
                    ranked_wins: 0,
                    ranked_losses: 0,
                    ranked_win_rate: 0.0,
                    streak: 0,
                    champ_games: 0,
                    champ_wins: 0,
                    champ_kda: 0.0,
                    live: None,
                },
                summoner_id: sid,
                puuid,
                is_enemy: false,
            }
        }).collect()
    }

    let mut team_one_raw = vec![];
    let mut team_two_raw = vec![];
    let mut my_team_is_one = true;

    if let Some(arr) = raw.get("gameData").and_then(|g| g.get("teamOne")).and_then(|t| t.as_array()) {
        team_one_raw = parse_players_raw(arr);
        if let Some(sid) = my_summoner_id {
            if team_one_raw.iter().any(|r| r.summoner_id == sid) {
                my_team_is_one = true;
            }
        }
    }

    if let Some(arr) = raw.get("gameData").and_then(|g| g.get("teamTwo")).and_then(|t| t.as_array()) {
        team_two_raw = parse_players_raw(arr);
        if let Some(sid) = my_summoner_id {
            if team_two_raw.iter().any(|r| r.summoner_id == sid) {
                my_team_is_one = false;
            }
        }
    }

    // Mark enemy teams before merging
    for r in &mut team_one_raw {
        r.is_enemy = !my_team_is_one;
    }
    for r in &mut team_two_raw {
        r.is_enemy = my_team_is_one;
    }

    // Fetch ranks, smurf analysis, and resolve names in parallel
    let mut all_raw: Vec<RawPlayer> = team_one_raw.into_iter().chain(team_two_raw.into_iter()).collect();

    struct PlayerFetchResult {
        rank: String,
        wins: i64,
        losses: i64,
        name: String,
        smurf: Option<SmurfAnalysis>,
        streak: i32,
        champ_games: i32,
        champ_wins: i32,
        champ_kda: f64,
    }

    let mut futures = vec![];
    for raw in &all_raw {
        let puuid = raw.puuid.clone();
        let sid = raw.summoner_id;
        let champion_id = raw.player.champion_id;
        let needs_name = raw.player.summoner_name.is_empty();
        let is_enemy = raw.is_enemy;
        let creds = creds.clone();
        futures.push(tokio::spawn(async move {
            let (rank, wins, losses) = if !puuid.is_empty() {
                get_player_ranked_stats(&creds, &puuid).await
            } else {
                (String::new(), 0, 0)
            };
            let name = if needs_name && sid > 0 {
                get_summoner_name(&creds, sid).await
            } else {
                String::new()
            };

            // Fetch match history for all players (used for stats + smurf)
            let matches = if !puuid.is_empty() {
                get_player_match_history(&creds, &puuid).await.unwrap_or_default()
            } else {
                vec![]
            };

            // Streak: count consecutive wins or losses from most recent
            let streak = {
                let mut s: i32 = 0;
                for m in &matches {
                    if s == 0 {
                        s = if m.win { 1 } else { -1 };
                    } else if (s > 0 && m.win) || (s < 0 && !m.win) {
                        s += if m.win { 1 } else { -1 };
                    } else {
                        break;
                    }
                }
                s
            };

            // Stats on current champion
            let champ_matches: Vec<&MatchHistoryEntry> = matches.iter()
                .filter(|m| m.champion_id == champion_id)
                .collect();
            let champ_games = champ_matches.len() as i32;
            let champ_wins = champ_matches.iter().filter(|m| m.win).count() as i32;
            let champ_kda = if !champ_matches.is_empty() {
                let k: i64 = champ_matches.iter().map(|m| m.kills).sum();
                let d: i64 = champ_matches.iter().map(|m| m.deaths).sum();
                let a: i64 = champ_matches.iter().map(|m| m.assists).sum();
                if d == 0 { (k + a) as f64 } else { (k + a) as f64 / d as f64 }
            } else {
                0.0
            };

            // Smurf detection for enemies only
            let smurf = if is_enemy && !puuid.is_empty() {
                let level = get_account_level(&creds, &puuid).await;
                Some(analyze_smurf(level, &rank, wins, losses, &matches))
            } else {
                None
            };

            PlayerFetchResult { rank, wins, losses, name, smurf, streak, champ_games, champ_wins, champ_kda }
        }));
    }

    for (i, fut) in futures.into_iter().enumerate() {
        if let Ok(r) = fut.await {
            let p = &mut all_raw[i].player;
            p.rank = r.rank;
            p.smurf = r.smurf;
            p.ranked_wins = r.wins;
            p.ranked_losses = r.losses;
            let total = r.wins + r.losses;
            p.ranked_win_rate = if total > 0 { r.wins as f64 / total as f64 } else { 0.0 };
            p.streak = r.streak;
            p.champ_games = r.champ_games;
            p.champ_wins = r.champ_wins;
            p.champ_kda = r.champ_kda;
            if !r.name.is_empty() {
                p.summoner_name = r.name;
            }
        }
    }

    // Re-split: first N are team one, rest are team two
    let team_one_count = raw.get("gameData")
        .and_then(|g| g.get("teamOne"))
        .and_then(|t| t.as_array())
        .map(|a| a.len())
        .unwrap_or(5);

    let (t1, t2): (Vec<_>, Vec<_>) = all_raw.into_iter().enumerate()
        .partition(|(i, _)| *i < team_one_count);

    let team_one: Vec<LiveGamePlayer> = t1.into_iter().map(|(_, r)| r.player).collect();
    let team_two: Vec<LiveGamePlayer> = t2.into_iter().map(|(_, r)| r.player).collect();

    if my_team_is_one {
        allies = team_one;
        enemies = team_two;
    } else {
        allies = team_two;
        enemies = team_one;
    }

    info!("Live game: {} allies, {} enemies with ranks", allies.len(), enemies.len());
    Ok(LiveGameState { queue_name, allies, enemies, live_data: None, recommended_build: None })
}

// ============================================================
// Live Client Data API (https://127.0.0.1:2999) — real-time in-game data
// ============================================================

fn live_client_url(path: &str) -> String {
    format!("https://127.0.0.1:2999{}", path)
}

/// Fetch all live game data and update the LiveGameState with real-time stats.
pub async fn poll_live_game_data(live_state: &mut LiveGameState, my_name: &str) -> Result<(), String> {
    let client = lcu_client(); // reuse — accepts self-signed certs

    let resp = client.get(live_client_url("/liveclientdata/allgamedata"))
        .send().await
        .map_err(|e| format!("Live client API unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Live client API returned {}", resp.status()));
    }

    let raw: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse live client data: {}", e))?;

    let game_time = raw.get("gameData")
        .and_then(|g| g.get("gameTime"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    // Parse player list
    let players = raw.get("allPlayers").and_then(|p| p.as_array());

    // Build a lookup: summoner name -> live stats
    let mut player_stats: std::collections::HashMap<String, LivePlayerStats> = std::collections::HashMap::new();
    let mut player_teams: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut player_positions: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if let Some(players) = players {
        for p in players {
            let name = p.get("riotIdGameName")
                .or_else(|| p.get("summonerName"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let team = p.get("team").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let position = p.get("position").and_then(|v| v.as_str()).unwrap_or("").to_uppercase();

            let scores = p.get("scores").unwrap_or(&serde_json::Value::Null);
            let kills = scores.get("kills").and_then(|v| v.as_i64()).unwrap_or(0);
            let deaths = scores.get("deaths").and_then(|v| v.as_i64()).unwrap_or(0);
            let assists = scores.get("assists").and_then(|v| v.as_i64()).unwrap_or(0);
            let cs = scores.get("creepScore").and_then(|v| v.as_i64()).unwrap_or(0);

            let level = p.get("level").and_then(|v| v.as_i64()).unwrap_or(1);
            let current_gold = p.get("currentGold").and_then(|v| v.as_f64()).unwrap_or(0.0);

            let items_arr = p.get("items").and_then(|i| i.as_array());
            let items: Vec<i64> = items_arr
                .map(|arr| arr.iter()
                    .filter_map(|item| item.get("itemID").and_then(|v| v.as_i64()))
                    .collect())
                .unwrap_or_default();
            // Sum item prices directly from API (more reliable than Data Dragon lookup)
            let items_gold: f64 = items_arr
                .map(|arr| arr.iter()
                    .filter_map(|item| item.get("price").and_then(|v| v.as_f64()))
                    .sum())
                .unwrap_or(0.0);
            let total_gold = current_gold + items_gold;

            let spell1 = p.get("summonerSpells")
                .and_then(|s| s.get("summonerSpellOne"))
                .and_then(|s| s.get("rawDisplayName"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let spell2 = p.get("summonerSpells")
                .and_then(|s| s.get("summonerSpellTwo"))
                .and_then(|s| s.get("rawDisplayName"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let s1 = spell_name_to_id(spell1);
            let s2 = spell_name_to_id(spell2);

            // Detect jungle by Smite
            let resolved_pos = if !position.is_empty() {
                position.clone()
            } else if s1 == 11 || s2 == 11 {
                "JUNGLE".to_string()
            } else {
                String::new()
            };

            player_stats.insert(name.clone(), LivePlayerStats {
                kills, deaths, assists, cs, level, current_gold, total_gold, items,
                spell1_id: s1,
                spell2_id: s2,
            });
            player_teams.insert(name.clone(), team);
            if !resolved_pos.is_empty() {
                player_positions.insert(name, resolved_pos);
            }
        }
    }

    // Match live stats and positions to existing players by summoner name
    for player in live_state.allies.iter_mut().chain(live_state.enemies.iter_mut()) {
        if let Some(stats) = player_stats.remove(&player.summoner_name) {
            player.live = Some(stats);
        }
        if let Some(pos) = player_positions.remove(&player.summoner_name) {
            if player.position.is_empty() || !pos.is_empty() {
                player.position = pos;
            }
        }
    }

    // Calculate gold totals from matched players (allies/enemies already known)
    let ally_gold: f64 = live_state.allies.iter()
        .filter_map(|p| p.live.as_ref())
        .map(|l| l.current_gold)
        .sum();
    let enemy_gold: f64 = live_state.enemies.iter()
        .filter_map(|p| p.live.as_ref())
        .map(|l| l.current_gold)
        .sum();

    // Figure out which team is "my team" for event labeling
    let my_team = player_teams.get(my_name).cloned().unwrap_or_default();

    // Parse game events (objectives)
    let mut events = vec![];
    if let Some(ev_data) = raw.get("events").and_then(|e| e.get("Events")).and_then(|e| e.as_array()) {
        for ev in ev_data {
            let event_name = ev.get("EventName").and_then(|v| v.as_str()).unwrap_or("");
            let time = ev.get("EventTime").and_then(|v| v.as_f64()).unwrap_or(0.0);

            let (event_type, label) = match event_name {
                "DragonKill" => {
                    let dragon = ev.get("DragonType").and_then(|v| v.as_str()).unwrap_or("Dragon");
                    let killer = ev.get("KillerName").and_then(|v| v.as_str()).unwrap_or("");
                    let team = player_teams.get(killer).map(|t| if *t == my_team { "Ally" } else { "Enemy" }).unwrap_or("?");
                    ("DragonKill".to_string(), format!("{} {} killed", team, dragon))
                }
                "BaronKill" => {
                    let killer = ev.get("KillerName").and_then(|v| v.as_str()).unwrap_or("");
                    let team = player_teams.get(killer).map(|t| if *t == my_team { "Ally" } else { "Enemy" }).unwrap_or("?");
                    ("BaronKill".to_string(), format!("{} Baron killed", team))
                }
                "HeraldKill" | "RiftHeraldKill" => {
                    let killer = ev.get("KillerName").and_then(|v| v.as_str()).unwrap_or("");
                    let team = player_teams.get(killer).map(|t| if *t == my_team { "Ally" } else { "Enemy" }).unwrap_or("?");
                    ("HeraldKill".to_string(), format!("{} Herald killed", team))
                }
                "TurretKilled" => {
                    let killer = ev.get("KillerName").and_then(|v| v.as_str()).unwrap_or("");
                    let team = player_teams.get(killer).map(|t| if *t == my_team { "Ally" } else { "Enemy" }).unwrap_or("?");
                    ("TurretKilled".to_string(), format!("{} turret destroyed", team))
                }
                "InhibKilled" => {
                    let killer = ev.get("KillerName").and_then(|v| v.as_str()).unwrap_or("");
                    let team = player_teams.get(killer).map(|t| if *t == my_team { "Ally" } else { "Enemy" }).unwrap_or("?");
                    ("InhibKilled".to_string(), format!("{} inhibitor destroyed", team))
                }
                "Multikill" => {
                    let killer = ev.get("KillerName").and_then(|v| v.as_str()).unwrap_or("?");
                    let count = ev.get("KillStreak").and_then(|v| v.as_i64()).unwrap_or(2);
                    let kind = match count {
                        3 => "Triple Kill",
                        4 => "Quadra Kill",
                        5 => "Penta Kill",
                        _ => "Multi Kill",
                    };
                    ("Multikill".to_string(), format!("{} — {}", killer, kind))
                }
                "Ace" => {
                    let team_str = ev.get("AcingTeam").and_then(|v| v.as_str()).unwrap_or("?");
                    ("Ace".to_string(), format!("{} aced!", team_str))
                }
                _ => continue, // skip GameStart, MinionsSpawning, etc.
            };

            events.push(GameEvent { event_type, time, label });
        }
    }

    // Preserve existing snapshots and add new ones every ~30s
    let mut snapshots = live_state.live_data.as_ref()
        .map(|d| d.snapshots.clone())
        .unwrap_or_default();

    let last_snapshot_time = snapshots.last().map(|s| s.game_time).unwrap_or(0.0);
    if game_time - last_snapshot_time >= 30.0 || snapshots.is_empty() {
        info!("Recording snapshot at game_time={:.0}s ({} existing snapshots)", game_time, snapshots.len());
        for player in live_state.allies.iter().chain(live_state.enemies.iter()) {
            if let Some(live) = &player.live {
                snapshots.push(PlayerSnapshot {
                    game_time,
                    summoner_name: player.summoner_name.clone(),
                    cs: live.cs,
                    kills: live.kills,
                    deaths: live.deaths,
                    assists: live.assists,
                    gold: live.total_gold,
                });
            }
        }
    }

    live_state.live_data = Some(LiveGameData {
        game_time,
        ally_gold,
        enemy_gold,
        events,
        snapshots,
    });

    Ok(())
}

/// Compute per-phase stats from live game snapshots for a given player.
pub fn compute_phase_stats(snapshots: &[PlayerSnapshot], player_name: &str) -> Vec<PhaseStats> {
    let mine: Vec<&PlayerSnapshot> = snapshots.iter()
        .filter(|s| s.summoner_name == player_name)
        .collect();

    if mine.len() < 2 { return vec![]; }

    // Phase boundaries in seconds
    let phases = [
        ("Early (0-14m)", 0.0, 840.0),
        ("Mid (14-25m)", 840.0, 1500.0),
        ("Late (25m+)", 1500.0, f64::MAX),
    ];

    let mut result = vec![];

    for (label, start, end) in &phases {
        // Find first and last snapshot in this phase
        let in_phase: Vec<&&PlayerSnapshot> = mine.iter()
            .filter(|s| s.game_time >= *start && s.game_time < *end)
            .collect();

        if in_phase.len() < 2 { continue; }

        let first = in_phase.first().unwrap();
        let last = in_phase.last().unwrap();
        let duration_min = (last.game_time - first.game_time) / 60.0;
        if duration_min < 0.5 { continue; }

        let cs_delta = (last.cs - first.cs) as f64;
        let gold_delta = last.gold - first.gold;

        result.push(PhaseStats {
            phase: label.to_string(),
            cs_per_min: cs_delta / duration_min,
            gold_per_min: gold_delta / duration_min,
            kills: last.kills - first.kills,
            deaths: last.deaths - first.deaths,
            assists: last.assists - first.assists,
        });
    }

    result
}

/// Compute gold diff timeline and death impacts from snapshots.
pub fn compute_gold_timeline(
    snapshots: &[PlayerSnapshot],
    ally_names: &[String],
    enemy_names: &[String],
) -> (Vec<GoldDiffPoint>, Vec<DeathImpact>) {
    let ally_set: std::collections::HashSet<&str> = ally_names.iter().map(|s| s.as_str()).collect();
    let enemy_set: std::collections::HashSet<&str> = enemy_names.iter().map(|s| s.as_str()).collect();

    // Group snapshots by game_time
    let mut time_groups: std::collections::BTreeMap<i64, Vec<&PlayerSnapshot>> = std::collections::BTreeMap::new();
    for s in snapshots {
        let t = s.game_time as i64;
        time_groups.entry(t).or_default().push(s);
    }

    let mut timeline = vec![];
    let mut prev_snapshots: std::collections::HashMap<String, &PlayerSnapshot> = std::collections::HashMap::new();
    let mut deaths = vec![];

    for (_, group) in &time_groups {
        let mut ally_gold = 0.0;
        let mut enemy_gold = 0.0;
        let game_time = group.first().map(|s| s.game_time).unwrap_or(0.0);

        for s in group {
            if ally_set.contains(s.summoner_name.as_str()) {
                ally_gold += s.gold;
            } else if enemy_set.contains(s.summoner_name.as_str()) {
                enemy_gold += s.gold;
            }

            // Detect deaths by comparing with previous snapshot
            if let Some(prev) = prev_snapshots.get(s.summoner_name.as_str()) {
                if s.deaths > prev.deaths {
                    let is_ally = ally_set.contains(s.summoner_name.as_str());
                    deaths.push(DeathImpact {
                        game_time: s.game_time,
                        summoner_name: s.summoner_name.clone(),
                        is_ally,
                        gold_swing: 0.0, // filled below
                    });
                }
            }
            prev_snapshots.insert(s.summoner_name.clone(), s);
        }

        let diff = ally_gold - enemy_gold;
        timeline.push(GoldDiffPoint { game_time, gold_diff: diff });
    }

    // Compute gold swing for each death: diff at death time vs diff at previous snapshot
    for death in &mut deaths {
        let idx = timeline.iter().position(|p| p.game_time >= death.game_time);
        if let Some(i) = idx {
            let after = timeline[i].gold_diff;
            let before = if i > 0 { timeline[i - 1].gold_diff } else { 0.0 };
            death.gold_swing = if death.is_ally { after - before } else { before - after };
        }
    }

    (timeline, deaths)
}

fn spell_name_to_id(name: &str) -> i64 {
    match name {
        s if s.contains("Flash") => 4,
        s if s.contains("Ignite") => 14,
        s if s.contains("Teleport") => 12,
        s if s.contains("Exhaust") => 3,
        s if s.contains("Heal") => 7,
        s if s.contains("Barrier") => 21,
        s if s.contains("Cleanse") => 1,
        s if s.contains("Ghost") => 6,
        s if s.contains("Smite") => 11,
        s if s.contains("Clarity") => 13,
        s if s.contains("Mark") => 32, // ARAM snowball
        _ => 0,
    }
}
