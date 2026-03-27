use crate::models::*;
use log::info;
use std::collections::HashMap;

const OPGG_API_BASE: &str = "https://lol-api-champion.op.gg/api";

fn http_client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Fetch champion build, counters, and alternatives in a single API call.
pub async fn fetch_champion_data(
    region: &str,
    champion_id: i64,
    position: &str,
) -> Result<ChampionFetchResult, String> {
    let url = format!(
        "{}/{}/champions/ranked/{}/{}",
        OPGG_API_BASE, region, champion_id, position
    );
    info!("Fetching champion data from OP.GG: {}", url);

    let data: OpggResponse = http_client()
        .get(&url)
        .header("User-Agent", "QueryLoLDesktop/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse OP.GG response: {}", e))?;

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
        }
    }).collect();

    let alternatives = BuildAlternatives {
        runes: rune_alts,
        summoner_spells: spell_alts,
        core_items: item_alts,
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

/// Fetch tier list for a position.
pub async fn fetch_tier_list(
    region: &str,
    position: &str,
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
            if pos.stats.pick_rate > 0.005 {
                results.push((champ.id, pos.stats.win_rate, pos.stats.tier));
            }
        }
    }
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

/// Generate pick recommendations.
pub async fn recommend_picks(
    region: &str,
    position: &str,
    enemy_champion_ids: &[i64],
    banned_ids: &[i64],
    ally_champion_ids: &[i64],
) -> Result<Vec<PickRecommendation>, String> {
    let tier_list = fetch_tier_list(region, position).await?;

    let mut enemy_counter_data: Vec<HashMap<i64, f64>> = vec![];
    for &enemy_id in enemy_champion_ids {
        if enemy_id > 0 {
            if let Ok(counters) = fetch_counters(region, enemy_id, "").await {
                enemy_counter_data.push(counters);
            }
        }
    }

    let all_picked: Vec<i64> = enemy_champion_ids.iter()
        .chain(ally_champion_ids.iter())
        .copied()
        .filter(|&id| id > 0)
        .collect();

    let mut recommendations: Vec<PickRecommendation> = vec![];

    for (champ_id, win_rate, _tier) in &tier_list {
        if banned_ids.contains(champ_id) || all_picked.contains(champ_id) {
            continue;
        }

        let mut counter_bonus: f64 = 0.0;
        let mut counters_count: i32 = 0;

        for enemy_counters in &enemy_counter_data {
            if let Some(&enemy_wr_vs_us) = enemy_counters.get(champ_id) {
                let advantage = 0.5 - enemy_wr_vs_us;
                counter_bonus += advantage;
                if advantage > 0.0 {
                    counters_count += 1;
                }
            }
        }

        let score = *win_rate + counter_bonus * 0.3;

        recommendations.push(PickRecommendation {
            champion_id: *champ_id,
            score,
            win_rate: *win_rate,
            counters_count,
            synergies_count: 0,
        });
    }

    recommendations.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    recommendations.truncate(5);
    Ok(recommendations)
}
