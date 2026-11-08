//! Personal matchup record: the local player's own results with a champion
//! against one enemy champion, read from the LCU match history.
//!
//! The match list only carries the local player, so each game's opponents
//! come from `/lol-match-history/v1/games/{id}`. Those never change, so the
//! lineups are cached for the session and only games played with the
//! champion in question are looked up, at most `MAX_GAMES` of them.

use crate::lcu::{self, LineupPlayer};
use crate::models::LcuCredentials;
use crate::models::{MatchHistoryEntry, MatchupRecord, RecordStats};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Newest games with the champion that are checked for the opponent.
const MAX_GAMES: usize = 20;

static LINEUPS: LazyLock<Mutex<HashMap<i64, Vec<LineupPlayer>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Summoner's Rift modes with lanes. ARAM, Arena and the rotating modes have
/// no lane opponent, and a record from them says little about the matchup.
fn has_lanes(game_mode: &str) -> bool {
    matches!(game_mode, "CLASSIC" | "SWIFTPLAY")
}

pub fn note_key(champion_id: i64, enemy_champion_id: i64) -> String {
    format!("{}:{}", champion_id, enemy_champion_id)
}

async fn lineup(creds: &LcuCredentials, game_id: i64) -> Option<Vec<LineupPlayer>> {
    if let Some(l) = LINEUPS.lock().ok().and_then(|m| m.get(&game_id).cloned()) {
        return Some(l);
    }
    match lcu::get_game_lineup(creds, game_id).await {
        Ok(l) => {
            if let Ok(mut m) = LINEUPS.lock() {
                m.insert(game_id, l.clone());
            }
            Some(l)
        }
        Err(e) => {
            log::debug!("lineup for game {} failed: {}", game_id, e);
            None
        }
    }
}

fn add(stats: &mut RecordStats, g: &MatchHistoryEntry) {
    stats.games += 1;
    if g.win { stats.wins += 1; }
    stats.kills += g.kills;
    stats.deaths += g.deaths;
    stats.assists += g.assists;
}

pub async fn record(
    creds: &LcuCredentials,
    history: &[MatchHistoryEntry],
    champion_id: i64,
    enemy_champion_id: i64,
) -> MatchupRecord {
    let mut rec = MatchupRecord { champion_id, enemy_champion_id, ..Default::default() };
    let games = history.iter()
        .filter(|g| g.champion_id == champion_id && has_lanes(&g.game_mode))
        .take(MAX_GAMES);

    for g in games {
        let Some(players) = lineup(creds, g.game_id).await else { continue };
        rec.scanned += 1;
        // The local player is the one with this champion on their side (team
        // ids can be missing from the list; then any side matches).
        let me = players.iter().find(|p| {
            p.champion_id == champion_id && (g.team_id == 0 || p.team_id == g.team_id)
        });
        let Some(me) = me else { continue };
        let Some(enemy) = players.iter()
            .find(|p| p.team_id != me.team_id && p.champion_id == enemy_champion_id)
        else { continue };

        add(&mut rec.enemy_team, g);
        if !me.position.is_empty() && me.position == enemy.position {
            add(&mut rec.lane, g);
        }
    }
    rec
}
