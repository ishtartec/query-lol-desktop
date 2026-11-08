//! Post-game mistake detection for the local player's own game.
//!
//! Runs once, when the game ends, over a 1-second trace of the local player
//! (`TraceSample`, recorded by `poll_live_game_data`) and the death times of
//! the Live Client event feed. The 30-second `PlayerSnapshot`s are too coarse
//! for this and carry total gold rather than gold in hand.
//!
//! Every rule flags only what the data states exactly — gold held when you
//! died, how soon after respawning you died again, how long the creep score
//! or vision score stood still — and the thresholds are set high enough that
//! a normal game rarely trips them. Few accurate items beat many guesses.
//!
//! Summoner's Rift only (`gameMode == "CLASSIC"`): in ARAM you can only shop
//! while dead, so dying with gold is how the mode works, and lane, vision and
//! early-death rules mean nothing there or in Arena and the Practice Tool.

use crate::models::Mistake;

/// One poll of the local player. Polls run about once a second.
#[derive(Debug, Clone, Default)]
pub struct TraceSample {
    /// Game time in seconds.
    pub t: f64,
    /// Gold in hand (`activePlayer.currentGold`), not total gold earned.
    pub gold: f64,
    pub dead: bool,
    /// `scores.wardScore`, which the Live Client keeps equal to vision score.
    pub ward_score: f64,
    pub cs: i64,
}

/// Gold in hand at death worth flagging: a finished-item component or more
/// (1300 is a B. F. Sword, a Needlessly Large Rod is 1200).
const UNSPENT_GOLD: f64 = 1300.0;
/// A death before this is a level 1-2 fight or invade, before the second
/// wave has even met in lane.
const EARLY_DEATH_SECS: f64 = 180.0;
/// Died again within this many seconds of respawning.
const QUICK_DEATH_SECS: f64 = 60.0;
/// Lane phase window for the creep score rule. Starts after the first wave
/// has reached every lane; ends where `compute_phase_stats` ends "Early".
const LANE_FROM: f64 = 90.0;
const LANE_UNTIL: f64 = 840.0;
/// Alive time in lane without a single last hit. A recall and the walk back
/// take 60-75 s, so this leaves room for a recall plus a missed wave.
const CS_GAP_SECS: f64 = 120.0;
/// Vision rule window and length: from 20:00, a stretch this long in which
/// the vision score never moved. Vision score accrues while any of your wards
/// stands, so a flat line means no ward of yours on the map at all.
const VISION_FROM: f64 = 1200.0;
const VISION_GAP_SECS: f64 = 480.0;
/// Polls further apart than this leave a hole in the trace (the app was busy
/// or the client paused); a stretch never spans one, and a death is matched
/// to a sample only when one lies this close.
const MAX_SAMPLE_GAP: f64 = 4.0;
/// Most items shown.
const MAX_ITEMS: usize = 5;

fn clock(t: f64) -> String {
    let s = t.max(0.0) as i64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn thousands(n: f64) -> String {
    let s = (n.round() as i64).to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `deaths`: game times of the local player's deaths, from the event feed
/// (exact). Falls back to the trace's alive→dead transitions when the feed
/// named nobody we could match. `position` is the Live Client position
/// (TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY or empty).
pub fn detect(trace: &[TraceSample], deaths: &[f64], position: &str, game_mode: &str) -> Vec<Mistake> {
    if !game_mode.eq_ignore_ascii_case("CLASSIC") {
        return vec![];
    }
    let mut deaths: Vec<f64> = deaths.to_vec();
    if deaths.is_empty() {
        deaths = trace
            .windows(2)
            .filter(|w| w[1].dead && !w[0].dead && w[1].t - w[0].t <= MAX_SAMPLE_GAP)
            .map(|w| w[1].t)
            .collect();
    }
    deaths.sort_by(f64::total_cmp);

    let mut out = vec![];
    unspent_gold(trace, &deaths, &mut out);
    early_death(&deaths, &mut out);
    quick_deaths(trace, &deaths, &mut out);
    if matches!(position.to_uppercase().as_str(), "TOP" | "MIDDLE" | "MID" | "BOTTOM") {
        cs_gap(trace, &mut out);
    }
    vision_gap(trace, &mut out);

    // Most important first; the severities are on one rough scale (about
    // "points of regret"), commented at each rule.
    out.sort_by(|a, b| b.severity.total_cmp(&a.severity));
    out.truncate(MAX_ITEMS);
    out
}

/// Gold in hand when you died, from the last alive sample just before the
/// death. Not the first dead sample: you can shop while dead.
fn unspent_gold(trace: &[TraceSample], deaths: &[f64], out: &mut Vec<Mistake>) {
    for &d in deaths {
        let Some(s) = trace.iter().rev().find(|s| s.t <= d + 0.5 && !s.dead) else { continue };
        if d - s.t > MAX_SAMPLE_GAP || s.gold < UNSPENT_GOLD {
            continue;
        }
        let g = thousands(s.gold);
        out.push(Mistake {
            time: d,
            kind: "unspent_gold".into(),
            title: format!("Died with {g} gold unspent"),
            detail: "Gold in your pocket does nothing in a fight".into(),
            takeaway: format!("Back and spend before fighting: you died at {} holding {g} gold.", clock(d)),
            // 13 at the threshold, growing with the gold: 2,500 held is
            // worse than an early death.
            severity: s.gold / 100.0,
        });
    }
}

fn early_death(deaths: &[f64], out: &mut Vec<Mistake>) {
    let Some(&first) = deaths.first() else { return };
    if first >= EARLY_DEATH_SECS {
        return;
    }
    out.push(Mistake {
        time: first,
        kind: "early_death".into(),
        title: "First death before 3:00".into(),
        detail: "An early death costs the first levels and the lane".into(),
        takeaway: format!("Play the first minutes safer: your first death came at {}.", clock(first)),
        severity: 18.0,
    });
}

/// Respawns are the trace's dead→alive transitions; a death is flagged when
/// it follows the latest one within `QUICK_DEATH_SECS`.
fn quick_deaths(trace: &[TraceSample], deaths: &[f64], out: &mut Vec<Mistake>) {
    let respawns: Vec<f64> = trace
        .windows(2)
        .filter(|w| w[0].dead && !w[1].dead && w[1].t - w[0].t <= MAX_SAMPLE_GAP)
        .map(|w| w[1].t)
        .collect();
    for &d in deaths {
        let Some(&r) = respawns.iter().rev().find(|&&r| r < d) else { continue };
        let after = d - r;
        if after > QUICK_DEATH_SECS {
            continue;
        }
        out.push(Mistake {
            time: d,
            kind: "quick_death".into(),
            title: format!("Died again {}s after respawning", after.round() as i64),
            detail: "Walked back into the same fight".into(),
            takeaway: format!(
                "After a death, regroup before rejoining: at {} you died again {} s after respawning.",
                clock(d),
                after.round() as i64
            ),
            // 15 at a minute, up to 30 for an immediate re-death.
            severity: 15.0 + (QUICK_DEATH_SECS - after) / 4.0,
        });
    }
}

/// Stretches of alive time in lane phase with a flat creep score. A death or
/// a hole in the trace ends a stretch, so time spent dead never counts.
/// Only the longest is listed; the others are counted in its detail.
fn cs_gap(trace: &[TraceSample], out: &mut Vec<Mistake>) {
    let mut gaps: Vec<(f64, f64)> = vec![];
    let mut start: Option<&TraceSample> = None;
    let mut prev: Option<&TraceSample> = None;
    let close = |from: &TraceSample, to: f64, gaps: &mut Vec<(f64, f64)>| {
        if to - from.t >= CS_GAP_SECS {
            gaps.push((from.t, to - from.t));
        }
    };
    for s in trace.iter().filter(|s| s.t >= LANE_FROM && s.t <= LANE_UNTIL) {
        let broken = prev.is_some_and(|p| s.t - p.t > MAX_SAMPLE_GAP);
        match (start, prev) {
            (Some(st), Some(p)) if s.dead || broken || s.cs != st.cs => {
                close(st, if s.dead || broken { p.t } else { s.t }, &mut gaps);
                start = (!s.dead).then_some(s);
            }
            (None, _) if !s.dead => start = Some(s),
            _ => {}
        }
        prev = Some(s);
    }
    if let (Some(st), Some(p)) = (start, prev) {
        close(st, p.t, &mut gaps);
    }
    let Some(&(at, len)) = gaps.iter().max_by(|a, b| a.1.total_cmp(&b.1)) else { return };
    let others = gaps.len() - 1;
    out.push(Mistake {
        time: at,
        kind: "cs_gap".into(),
        title: format!("No CS for {} in lane", clock(len)),
        detail: if others > 0 {
            format!("{} more stretch{} over {} before 14:00", others, if others == 1 { "" } else { "es" }, clock(CS_GAP_SECS))
        } else {
            "Waves crashing without you are lost gold and experience".into()
        },
        takeaway: format!("Stay on your waves in lane: from {} you went {} without a last hit.", clock(at), clock(len)),
        // 8 at two minutes, a point per extra 15 s.
        severity: 8.0 + (len - CS_GAP_SECS) / 15.0,
    });
}

/// The longest stretch from 20:00 in which the vision score did not move.
fn vision_gap(trace: &[TraceSample], out: &mut Vec<Mistake>) {
    let mut best: Option<(f64, f64)> = None;
    let mut start: Option<&TraceSample> = None;
    let mut prev: Option<&TraceSample> = None;
    let consider = |from: f64, to: f64, best: &mut Option<(f64, f64)>| {
        if best.is_none_or(|(_, l)| to - from > l) {
            *best = Some((from, to - from));
        }
    };
    for s in trace.iter().filter(|s| s.t >= VISION_FROM) {
        let broken = prev.is_some_and(|p| s.t - p.t > MAX_SAMPLE_GAP);
        match (start, prev) {
            (Some(st), Some(p)) if broken => {
                consider(st.t, p.t, &mut best);
                start = Some(s);
            }
            (Some(st), _) if s.ward_score > st.ward_score + 0.01 => {
                consider(st.t, s.t, &mut best);
                start = Some(s);
            }
            (None, _) => start = Some(s),
            _ => {}
        }
        prev = Some(s);
    }
    if let (Some(st), Some(p)) = (start, prev) {
        consider(st.t, p.t, &mut best);
    }
    let Some((at, len)) = best.filter(|(_, l)| *l >= VISION_GAP_SECS) else { return };
    out.push(Mistake {
        time: at,
        kind: "no_vision".into(),
        title: format!("No vision for {} late in the game", clock(len)),
        detail: "Your vision score did not move: no ward of yours was up".into(),
        takeaway: format!("Keep a ward up in the late game: from {} your vision score stood still for {}.", clock(at), clock(len)),
        // 10 at eight minutes, a point per extra minute.
        severity: 10.0 + (len - VISION_GAP_SECS) / 60.0,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trace from `from` to `to` at 1 s, built by `f(t)`.
    fn trace(from: i64, to: i64, f: impl Fn(f64) -> TraceSample) -> Vec<TraceSample> {
        (from..=to).map(|t| { let mut s = f(t as f64); s.t = t as f64; s }).collect()
    }

    fn quiet(t: f64) -> TraceSample {
        // A clean game: a last hit every 10 s, vision every 30 s, little gold.
        TraceSample { t, gold: 300.0, dead: false, ward_score: (t / 30.0).floor(), cs: (t / 10.0) as i64 }
    }

    #[test]
    fn clean_game_has_no_mistakes() {
        let tr = trace(0, 1800, quiet);
        assert!(detect(&tr, &[600.0], "MIDDLE", "CLASSIC").is_empty());
    }

    #[test]
    fn other_modes_are_skipped() {
        let tr = trace(0, 600, |t| TraceSample { gold: 3000.0, ..quiet(t) });
        assert!(detect(&tr, &[100.0], "MIDDLE", "ARAM").is_empty());
    }

    #[test]
    fn unspent_gold_reads_the_last_alive_sample() {
        // Died at 1125 with 1520 gold, then shopped while dead.
        let tr = trace(0, 1800, |t| TraceSample {
            gold: if t < 1125.0 { 1520.0 } else { 100.0 },
            dead: (1125.0..1150.0).contains(&t),
            ..quiet(t)
        });
        let m = detect(&tr, &[1125.0], "TOP", "CLASSIC");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, "unspent_gold");
        assert_eq!(m[0].title, "Died with 1,520 gold unspent");
        assert!(m[0].takeaway.contains("18:45"));
    }

    #[test]
    fn early_and_quick_deaths() {
        // Died at 130, respawned at 150, died again at 175.
        let tr = trace(0, 900, |t| TraceSample {
            dead: (130.0..150.0).contains(&t) || (175.0..200.0).contains(&t),
            ..quiet(t)
        });
        let m = detect(&tr, &[130.0, 175.0], "UTILITY", "CLASSIC");
        let kinds: Vec<&str> = m.iter().map(|m| m.kind.as_str()).collect();
        assert_eq!(kinds, ["quick_death", "early_death"]);
        assert_eq!(m[0].title, "Died again 25s after respawning");
    }

    #[test]
    fn cs_gap_ignores_dead_time_and_supports() {
        // CS frozen 300-600, but dead 400-450: two stretches of 100 and 150.
        let f = |t: f64| TraceSample {
            cs: if (300.0..600.0).contains(&t) { 30 } else { (t / 10.0) as i64 },
            dead: (400.0..450.0).contains(&t),
            ..quiet(t)
        };
        let tr = trace(0, 900, f);
        let m = detect(&tr, &[400.0], "MIDDLE", "CLASSIC");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, "cs_gap");
        assert_eq!(m[0].time, 450.0);
        assert!(detect(&tr, &[400.0], "UTILITY", "CLASSIC").is_empty());
    }

    #[test]
    fn vision_gap_after_twenty_minutes() {
        let tr = trace(0, 2400, |t| TraceSample { ward_score: (t.min(1500.0) / 30.0).floor(), ..quiet(t) });
        let m = detect(&tr, &[], "BOTTOM", "CLASSIC");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, "no_vision");
        assert_eq!(m[0].time, 1500.0);
        assert_eq!(m[0].title, "No vision for 15:00 late in the game");
    }

    #[test]
    fn trace_holes_break_stretches() {
        // Polls missing from 1300 to 2400: no evidence of a flat line.
        let tr: Vec<_> = trace(0, 2400, |t| TraceSample { ward_score: 0.0, ..quiet(t) })
            .into_iter().filter(|s| s.t < 1300.0 || s.t > 2395.0).collect();
        assert!(detect(&tr, &[], "BOTTOM", "CLASSIC").iter().all(|m| m.kind != "no_vision"));
    }
}
