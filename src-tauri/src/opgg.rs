use crate::models::*;
use log::{info, warn};
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::time::Duration;

const OPGG_API_BASE: &str = "https://lol-api-champion.op.gg/api";

fn http_client() -> reqwest::Client {
    reqwest::Client::new()
}

/// GET + JSON parse with bounded retries. OP.GG occasionally returns HTML/empty
/// bodies under load — a short backoff fixes most transient failures without
/// surfacing them to the user.
async fn fetch_json_with_retry<T: DeserializeOwned>(url: &str) -> Result<T, String> {
    const MAX_ATTEMPTS: u32 = 3;
    let backoffs_ms = [600u64, 1500, 3000];
    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        let res: Result<T, String> = async {
            let resp = http_client()
                .get(url)
                .header("User-Agent", "QueryLoLDesktop/0.1")
                .send()
                .await
                .map_err(|e| format!("HTTP request failed: {}", e))?;
            resp.json::<T>()
                .await
                .map_err(|e| format!("Failed to parse OP.GG response: {}", e))
        }
        .await;
        match res {
            Ok(v) => {
                if attempt > 0 {
                    info!("OP.GG fetch succeeded on attempt {} for {}", attempt + 1, url);
                }
                return Ok(v);
            }
            Err(e) => {
                last_err = e;
                if attempt + 1 < MAX_ATTEMPTS {
                    let delay = backoffs_ms[attempt as usize];
                    warn!("OP.GG fetch attempt {} failed: {} — retrying in {}ms", attempt + 1, last_err, delay);
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
            }
        }
    }
    Err(last_err)
}

/// Fetch champion build, counters, and alternatives in a single API call.
pub async fn fetch_champion_data(
    region: &str,
    champion_id: i64,
    position: &str,
) -> Result<ChampionFetchResult, String> {
    let url = if position == "aram" {
        format!("{}/{}/champions/aram/{}/none", OPGG_API_BASE, region, champion_id)
    } else {
        format!("{}/{}/champions/ranked/{}/{}", OPGG_API_BASE, region, champion_id, position)
    };
    info!("Fetching champion data from OP.GG: {}", url);

    let data: OpggResponse = fetch_json_with_retry(&url).await?;

    // Build (first option)
    let runes = data.data.runes.first().map(|r| RuneBuild {
        primary_style_id: r.primary_page_id,
        sub_style_id: r.secondary_page_id,
        selected_perk_ids: r.primary_rune_ids.iter()
            .chain(r.secondary_rune_ids.iter())
            .chain(r.stat_mod_ids.iter())
            .copied()
            .collect(),
    });

    let summoner_spells = data.data.summoner_spells.first()
        .and_then(|s| if s.ids.len() >= 2 { Some([s.ids[0], s.ids[1]]) } else { None });

    let build = ChampionBuild {
        runes,
        summoner_spells,
        starter_items: data.data.starter_items.first().map(|s| s.ids.clone()).unwrap_or_default(),
        core_items: data.data.core_items.first().map(|c| c.ids.clone()).unwrap_or_default(),
        boots: data.data.boots.first().map(|b| b.ids.clone()).unwrap_or_default(),
        skill_order: data.data.skill_masteries.first().map(|s| s.ids.clone()).unwrap_or_default(),
    };

    // Counters
    let mut counters = HashMap::new();
    for c in &data.data.counters {
        if c.play > 0 {
            counters.insert(c.champion_id, c.win as f64 / c.play as f64);
        }
    }

    // Alternatives (up to 3 of each)
    let rune_alts: Vec<RuneOption> = data.data.runes.iter().take(3).map(|r| {
        RuneOption {
            build: RuneBuild {
                primary_style_id: r.primary_page_id,
                sub_style_id: r.secondary_page_id,
                selected_perk_ids: r.primary_rune_ids.iter()
                    .chain(r.secondary_rune_ids.iter())
                    .chain(r.stat_mod_ids.iter())
                    .copied()
                    .collect(),
            },
            win_rate: if r.play > 0 { r.win as f64 / r.play as f64 } else { 0.0 },
            pick_rate: r.pick_rate,
        }
    }).collect();

    let spell_alts: Vec<SpellOption> = data.data.summoner_spells.iter().take(3)
        .filter(|s| s.ids.len() >= 2)
        .map(|s| SpellOption {
            ids: [s.ids[0], s.ids[1]],
            win_rate: if s.play > 0 { s.win as f64 / s.play as f64 } else { 0.0 },
            pick_rate: s.pick_rate,
        }).collect();

    let item_alts: Vec<ItemOption> = data.data.core_items.iter().take(3).map(|c| {
        ItemOption {
            ids: c.ids.clone(),
            win_rate: if c.play > 0 { c.win as f64 / c.play as f64 } else { 0.0 },
            pick_rate: c.pick_rate,
            games: c.play,
        }
    }).collect();

    let starter_alts: Vec<ItemOption> = data.data.starter_items.iter().take(3).map(|s| {
        ItemOption {
            ids: s.ids.clone(),
            win_rate: if s.play > 0 { s.win as f64 / s.play as f64 } else { 0.0 },
            pick_rate: s.pick_rate,
            games: s.play,
        }
    }).collect();

    let boots_alts: Vec<ItemOption> = data.data.boots.iter().take(3).map(|b| {
        ItemOption {
            ids: b.ids.clone(),
            win_rate: if b.play > 0 { b.win as f64 / b.play as f64 } else { 0.0 },
            pick_rate: b.pick_rate,
            games: b.play,
        }
    }).collect();

    let alternatives = BuildAlternatives {
        runes: rune_alts,
        summoner_spells: spell_alts,
        core_items: item_alts,
        starter_items: starter_alts,
        boots: boots_alts,
    };

    info!("Champion data fetched: {} counters, {} rune options", counters.len(), alternatives.runes.len());

    Ok(ChampionFetchResult { build, counters, alternatives })
}

/// Fetch counters for a specific champion (used by recommend_picks).
pub async fn fetch_counters(
    region: &str,
    champion_id: i64,
    position: &str,
) -> Result<HashMap<i64, f64>, String> {
    let url = format!(
        "{}/{}/champions/ranked/{}/{}",
        OPGG_API_BASE, region, champion_id, position
    );

    let data: OpggResponse = http_client()
        .get(&url)
        .header("User-Agent", "QueryLoLDesktop/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Parse: {}", e))?;

    let mut counters = HashMap::new();
    for c in &data.data.counters {
        if c.play > 0 {
            counters.insert(c.champion_id, c.win as f64 / c.play as f64);
        }
    }
    Ok(counters)
}

/// Fetch game_lengths data for a champion to analyze early/late power.
pub async fn fetch_game_lengths(
    region: &str,
    champion_id: i64,
    position: &str,
) -> Result<Vec<OpggGameLength>, String> {
    let url = format!("{}/{}/champions/ranked/{}/{}", OPGG_API_BASE, region, champion_id, position);
    let data: OpggResponse = http_client()
        .get(&url)
        .header("User-Agent", "QueryLoLDesktop/0.1")
        .send().await.map_err(|e| format!("HTTP: {}", e))?
        .json().await.map_err(|e| format!("Parse: {}", e))?;
    Ok(data.data.game_lengths)
}

/// Generate game prediction based on both teams' champions.
pub async fn generate_prediction(
    region: &str,
    allies: &[(i64, String)],   // (champion_id, position)
    enemies: &[(i64, String)],
) -> Result<GamePrediction, String> {
    // Fetch game_lengths for all champions in parallel
    let mut futures = vec![];
    let all_champs: Vec<(i64, String, bool)> = allies.iter()
        .map(|(id, pos)| (*id, pos.clone(), true))
        .chain(enemies.iter().map(|(id, pos)| (*id, pos.clone(), false)))
        .filter(|(id, _, _)| *id > 0)
        .collect();

    for (champ_id, pos, _) in &all_champs {
        let r = region.to_string();
        let cid = *champ_id;
        let p = if pos.is_empty() { "mid".to_string() } else { pos.clone() };
        futures.push(tokio::spawn(async move {
            fetch_game_lengths(&r, cid, &p).await.unwrap_or_default()
        }));
    }

    let mut results = vec![];
    for fut in futures {
        results.push(fut.await.unwrap_or_default());
    }

    let mut ally_wr_sum = 0.0;
    let mut ally_count = 0;
    let mut ally_early = 0.0;
    let mut ally_late = 0.0;
    let mut enemy_wr_sum = 0.0;
    let mut enemy_count = 0;
    let mut enemy_early = 0.0;
    let mut enemy_late = 0.0;

    for (i, (_, _, is_ally)) in all_champs.iter().enumerate() {
        let gl = &results[i];
        let early_wr = gl.iter().find(|g| g.game_length == 0).map(|g| g.rate).unwrap_or(0.5);
        let late_wr = gl.iter().find(|g| g.game_length >= 35).map(|g| g.rate)
            .or_else(|| gl.iter().find(|g| g.game_length >= 30).map(|g| g.rate))
            .unwrap_or(0.5);
        let avg_wr = gl.iter().map(|g| g.rate).sum::<f64>() / gl.len().max(1) as f64;

        if *is_ally {
            ally_wr_sum += if avg_wr > 0.0 { avg_wr } else { 0.5 };
            ally_early += early_wr;
            ally_late += late_wr;
            ally_count += 1;
        } else {
            enemy_wr_sum += if avg_wr > 0.0 { avg_wr } else { 0.5 };
            enemy_early += early_wr;
            enemy_late += late_wr;
            enemy_count += 1;
        }
    }

    let ally_avg_wr = if ally_count > 0 { ally_wr_sum / ally_count as f64 } else { 0.5 };
    let enemy_avg_wr = if enemy_count > 0 { enemy_wr_sum / enemy_count as f64 } else { 0.5 };
    let ally_early_score = if ally_count > 0 { ally_early / ally_count as f64 } else { 0.5 };
    let ally_late_score = if ally_count > 0 { ally_late / ally_count as f64 } else { 0.5 };
    let enemy_early_score = if enemy_count > 0 { enemy_early / enemy_count as f64 } else { 0.5 };
    let enemy_late_score = if enemy_count > 0 { enemy_late / enemy_count as f64 } else { 0.5 };

    // Generate strategic tip
    let ally_scales = ally_late_score > ally_early_score + 0.02;
    let enemy_scales = enemy_late_score > enemy_early_score + 0.02;
    let ally_early_advantage = ally_early_score > enemy_early_score + 0.01;
    let ally_late_advantage = ally_late_score > enemy_late_score + 0.01;

    let tip = if ally_early_advantage && !ally_late_advantage {
        "Your team is stronger early. Force fights and take early objectives. Close out before 30 min.".to_string()
    } else if !ally_early_advantage && ally_late_advantage {
        "Your team outscales. Play safe early, farm up, and focus objectives after 25 min.".to_string()
    } else if ally_early_advantage && ally_late_advantage {
        "Your team is favored at all stages. Play aggressive and snowball your lead.".to_string()
    } else if enemy_scales && !ally_scales {
        "Enemy team scales better. Prioritize early dragons and rift herald. Force fights before 25 min.".to_string()
    } else if ally_scales && !enemy_scales {
        "Your team scales better. Avoid risky early fights. Prioritize farming and late-game objectives.".to_string()
    } else {
        "Teams are evenly matched. Focus on vision control and pick opportunities.".to_string()
    };

    Ok(GamePrediction {
        ally_avg_wr,
        enemy_avg_wr,
        ally_early_score,
        ally_late_score,
        enemy_early_score,
        enemy_late_score,
        tip,
    })
}

/// Fetch tier list for a position. Champions in `always_include` bypass the
/// minimum pick-rate filter (used to surface comfort picks even if off-meta).
pub async fn fetch_tier_list(
    region: &str,
    position: &str,
    always_include: &std::collections::HashSet<i64>,
) -> Result<Vec<(i64, f64, i64)>, String> {
    let url = format!("{}/{}/champions/ranked", OPGG_API_BASE, region);
    info!("Fetching tier list from OP.GG: {}", url);

    let data: OpggTierListResponse = http_client()
        .get(&url)
        .header("User-Agent", "QueryLoLDesktop/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Parse: {}", e))?;

    let mut results = vec![];
    for champ in &data.data {
        if let Some(pos) = champ.positions.iter().find(|p| p.name.to_lowercase() == position) {
            if pos.stats.pick_rate > 0.005 || always_include.contains(&champ.id) {
                results.push((champ.id, pos.stats.win_rate, pos.stats.tier));
            }
        }
    }
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

/// Fetch ban suggestions for a position (high threat champions).
pub async fn fetch_ban_suggestions(
    region: &str,
    position: &str,
) -> Result<Vec<BanSuggestion>, String> {
    let url = format!("{}/{}/champions/ranked", OPGG_API_BASE, region);

    let data: OpggTierListResponse = http_client()
        .get(&url)
        .header("User-Agent", "QueryLoLDesktop/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Parse: {}", e))?;

    let mut suggestions: Vec<BanSuggestion> = vec![];
    for champ in &data.data {
        if let Some(pos) = champ.positions.iter().find(|p| p.name.to_lowercase() == position) {
            let wr = pos.stats.win_rate;
            let pr = pos.stats.pick_rate;
            let br = champ.average_stats.ban_rate;

            // Only suggest if meaningful pick rate and good win rate
            if pr > 0.02 && wr > 0.50 {
                let score = wr * 0.4 + pr * 0.3 + br * 0.3;
                suggestions.push(BanSuggestion {
                    champion_id: champ.id,
                    win_rate: wr,
                    pick_rate: pr,
                    ban_rate: br,
                    score,
                });
            }
        }
    }

    suggestions.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    suggestions.truncate(3);
    Ok(suggestions)
}

/// Fetch win rate for specific champions from the tier list (for comfort picks).
pub async fn fetch_champion_win_rates(
    region: &str,
    position: &str,
    champion_ids: &[i64],
) -> Result<HashMap<i64, f64>, String> {
    let url = format!("{}/{}/champions/ranked", OPGG_API_BASE, region);

    let data: OpggTierListResponse = http_client()
        .get(&url)
        .header("User-Agent", "QueryLoLDesktop/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Parse: {}", e))?;

    let mut rates = HashMap::new();
    for champ in &data.data {
        if champion_ids.contains(&champ.id) {
            // Try position-specific, fallback to average
            if let Some(pos) = champ.positions.iter().find(|p| p.name.to_lowercase() == position) {
                rates.insert(champ.id, pos.stats.win_rate);
            } else {
                rates.insert(champ.id, champ.average_stats.win_rate);
            }
        }
    }
    Ok(rates)
}

/// Fetch ARAM win rates for a set of champion IDs.
pub async fn fetch_aram_win_rates(
    region: &str,
    champion_ids: &[i64],
) -> Result<HashMap<i64, f64>, String> {
    let url = format!("{}/{}/champions/aram", OPGG_API_BASE, region);

    let data: OpggTierListResponse = http_client()
        .get(&url)
        .header("User-Agent", "QueryLoLDesktop/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Parse: {}", e))?;

    let mut rates = HashMap::new();
    for champ in &data.data {
        if champion_ids.contains(&champ.id) {
            rates.insert(champ.id, champ.average_stats.win_rate);
        }
    }
    Ok(rates)
}

/// Generate pick recommendations with a breakdown of meta / counter / comfort
/// signals. The frontend folds in team-comp synergy on top of this output and
/// computes the final ranked score.
///
/// `comfort_map` maps champion_id → games played recently (from match history).
/// `ban_suggestion_ids` is used as a proxy threat list when no enemy has locked
/// in yet (first-pick fallback), so even early picks get some counter signal.
pub async fn recommend_picks(
    region: &str,
    position: &str,
    enemies_with_pos: &[(i64, String)],
    banned_ids: &[i64],
    ally_champion_ids: &[i64],
    comfort_map: &HashMap<i64, i32>,
    ban_suggestion_ids: &[i64],
) -> Result<Vec<PickRecommendation>, String> {
    let comfort_ids: std::collections::HashSet<i64> = comfort_map.keys().copied().collect();
    let tier_list = fetch_tier_list(region, position, &comfort_ids).await?;

    // Resolve threats: real locked enemies first, otherwise fall back to the
    // top ban-suggestion champions (treated as if they were enemies in our lane).
    let threats: Vec<(i64, String)> = if !enemies_with_pos.is_empty() {
        enemies_with_pos.to_vec()
    } else {
        ban_suggestion_ids.iter().take(3)
            .map(|id| (*id, position.to_string()))
            .collect()
    };

    let mut threat_counter_data: Vec<(i64, HashMap<i64, f64>)> = vec![];
    for (threat_id, threat_pos) in &threats {
        if *threat_id > 0 {
            let pos = if threat_pos.is_empty() { "mid" } else { threat_pos };
            if let Ok(counters) = fetch_counters(region, *threat_id, pos).await {
                threat_counter_data.push((*threat_id, counters));
            }
        }
    }

    let all_picked: Vec<i64> = enemies_with_pos.iter()
        .map(|(id, _)| *id)
        .chain(ally_champion_ids.iter().copied())
        .filter(|&id| id > 0)
        .collect();

    let mut recommendations: Vec<PickRecommendation> = vec![];

    for (champ_id, win_rate, _tier) in &tier_list {
        if banned_ids.contains(champ_id) || all_picked.contains(champ_id) {
            continue;
        }

        // Per-threat counter advantage; remember which threats we counter hardest
        // so the frontend can render "Counters Zed" style reason chips.
        let mut per_threat: Vec<(i64, f64)> = vec![];
        for (threat_id, threat_counters) in &threat_counter_data {
            if let Some(&enemy_wr_vs_us) = threat_counters.get(champ_id) {
                let advantage = 0.5 - enemy_wr_vs_us;
                per_threat.push((*threat_id, advantage));
            }
        }
        let counter_bonus: f64 = per_threat.iter().map(|(_, a)| *a).sum();
        let counters_count: i32 = per_threat.iter().filter(|(_, a)| *a > 0.0).count() as i32;

        let mut top_targets: Vec<(i64, f64)> = per_threat.iter()
            .filter(|(_, a)| *a > 0.0).copied().collect();
        top_targets.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_counter_targets: Vec<i64> = top_targets.iter().take(2).map(|(id, _)| *id).collect();

        let comfort_games = comfort_map.get(champ_id).copied().unwrap_or(0);
        // 5 games → max comfort; ramps linearly below that.
        let comfort_score = (comfort_games as f64 / 5.0).min(1.0);

        let score = *win_rate + counter_bonus * 0.3;

        recommendations.push(PickRecommendation {
            champion_id: *champ_id,
            score,
            win_rate: *win_rate,
            meta_wr: *win_rate,
            counter_bonus,
            comfort_score,
            comfort_games,
            counters_count,
            synergies_count: 0,
            top_counter_targets,
        });
    }

    recommendations.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    recommendations.truncate(12);
    Ok(recommendations)
}
