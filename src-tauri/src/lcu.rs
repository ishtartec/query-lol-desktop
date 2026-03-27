use crate::models::*;
use base64::Engine;
use log::info;
use std::path::PathBuf;

/// Try to find and parse the League client lockfile.
pub fn read_lockfile() -> Option<LcuCredentials> {
    let possible_paths = vec![
        Some(PathBuf::from("/Applications/League of Legends.app/Contents/LoL/lockfile")),
        dirs_lockfile(),
    ];

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

fn dirs_lockfile() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(home)
        .join("Library/Application Support/Riot Games/League of Legends/lockfile");
    if path.exists() { Some(path) } else { None }
}

fn read_from_process() -> Option<LcuCredentials> {
    let output = std::process::Command::new("ps")
        .args(["-A", "-o", "args="])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        if !line.contains("LeagueClientUx") {
            continue;
        }
        let port = extract_arg(line, "--app-port=")?;
        let token = extract_arg(line, "--remoting-auth-token=")?;

        info!("Found LCU via process args (port: {})", port);
        return Some(LcuCredentials {
            port: port.parse().ok()?,
            password: token,
        });
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

                    players.push(PostGamePlayer {
                        champion_id: rp.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
                        summoner_name: name.to_string(),
                        position,
                        is_local: rp.get("isLocalPlayer").and_then(|v| v.as_bool()).unwrap_or(false),
                        kills: stats.get("CHAMPIONS_KILLED").and_then(|v| v.as_i64()).unwrap_or(0),
                        deaths: stats.get("NUM_DEATHS").and_then(|v| v.as_i64()).unwrap_or(0),
                        assists: stats.get("ASSISTS").and_then(|v| v.as_i64()).unwrap_or(0),
                        total_damage: stats.get("TOTAL_DAMAGE_DEALT_TO_CHAMPIONS").and_then(|v| v.as_i64()).unwrap_or(0),
                        gold_earned: stats.get("GOLD_EARNED").and_then(|v| v.as_i64()).unwrap_or(0),
                        cs: stats.get("MINIONS_KILLED").and_then(|v| v.as_i64()).unwrap_or(0)
                            + stats.get("NEUTRAL_MINIONS_KILLED").and_then(|v| v.as_i64()).unwrap_or(0),
                        vision_score: stats.get("VISION_SCORE").and_then(|v| v.as_i64()).unwrap_or(0),
                        items,
                    });
                }
            }

            teams.push(PostGameTeam { is_winner, players });
        }
    }

    info!("Post-game stats parsed: {} teams", teams.len());
    Ok(PostGameStats { teams })
}

/// Extract full draft state from champ select session.
pub fn extract_draft_state(session: &ChampSelectSession) -> DraftState {
    let my_cell = session.local_player_cell_id;

    // Build a map of cell_id -> champion_id from actions (pre-lock picks)
    let mut action_picks: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    let mut bans: Vec<i64> = vec![];

    for action_group in &session.actions {
        for action in action_group {
            if action.action_type == "pick" && action.champion_id > 0 {
                action_picks.insert(action.actor_cell_id, action.champion_id);
            }
            if action.action_type == "ban" && action.champion_id > 0 && action.completed {
                bans.push(action.champion_id);
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

    bans.dedup();

    DraftState { allies, enemies, bans }
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

/// Fetch match history for current summoner (last 10 games).
pub async fn get_match_history(creds: &LcuCredentials) -> Result<Vec<MatchHistoryEntry>, String> {
    let client = lcu_client();
    let resp = client
        .get(lcu_url(creds, "/lol-match-history/v1/products/lol/current-summoner/matches"))
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
        for game in games.iter().take(10) {
            let game_mode = game.get("gameMode").and_then(|v| v.as_str()).unwrap_or("CLASSIC").to_string();
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

                    entries.push(MatchHistoryEntry {
                        champion_id,
                        game_mode,
                        win,
                        kills,
                        deaths,
                        assists,
                        duration_secs: duration,
                        timestamp,
                    });
                }
            }
        }
    }

    info!("Match history: {} entries", entries.len());
    Ok(entries)
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

    // Parse teamOne and teamTwo, then figure out which is ours
    let mut team_one = vec![];
    let mut team_two = vec![];
    let mut my_team_is_one = true;

    fn parse_players(arr: &[serde_json::Value]) -> Vec<(LiveGamePlayer, i64)> {
        arr.iter().map(|p| {
            let sid = p.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
            let player = LiveGamePlayer {
                champion_id: p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
                summoner_name: p.get("riotIdGameName")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .or_else(|| p.get("summonerName").and_then(|v| v.as_str()))
                    .unwrap_or("Unknown")
                    .to_string(),
            };
            (player, sid)
        }).collect()
    }

    if let Some(arr) = raw.get("gameData").and_then(|g| g.get("teamOne")).and_then(|t| t.as_array()) {
        let parsed = parse_players(arr);
        // Check if our summoner is in this team
        if let Some(sid) = my_summoner_id {
            if parsed.iter().any(|(_, id)| *id == sid) {
                my_team_is_one = true;
            }
        }
        team_one = parsed.into_iter().map(|(p, _)| p).collect();
    }

    if let Some(arr) = raw.get("gameData").and_then(|g| g.get("teamTwo")).and_then(|t| t.as_array()) {
        let parsed = parse_players(arr);
        if let Some(sid) = my_summoner_id {
            if parsed.iter().any(|(_, id)| *id == sid) {
                my_team_is_one = false;
            }
        }
        team_two = parsed.into_iter().map(|(p, _)| p).collect();
    }

    if my_team_is_one {
        allies = team_one;
        enemies = team_two;
    } else {
        allies = team_two;
        enemies = team_one;
    }

    Ok(LiveGameState { queue_name, allies, enemies })
}
