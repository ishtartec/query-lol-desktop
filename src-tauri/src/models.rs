use serde::{Deserialize, Deserializer, Serialize};

/// Treat an explicit JSON `null` as the type's default. `#[serde(default)]`
/// alone only covers *absent* keys — OP.GG sometimes sends `"win_rate": null`
/// for champions/positions without enough games, which would otherwise abort
/// the entire tier-list parse.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

// --- LCU connection ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LcuCredentials {
    pub port: u16,
    pub password: String,
}

// --- App state emitted to frontend ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Disconnected,
    Connected,
    ChampSelect,
    InGame,
    PostGame,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftPlayer {
    pub champion_id: i64,
    pub position: String,
    pub is_local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftState {
    pub allies: Vec<DraftPlayer>,
    pub enemies: Vec<DraftPlayer>,
    pub ally_bans: Vec<i64>,
    pub enemy_bans: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickRecommendation {
    pub champion_id: i64,
    pub score: f64,
    pub win_rate: f64,
    pub meta_wr: f64,
    pub counter_bonus: f64,
    pub comfort_score: f64,
    pub comfort_games: i32,
    pub counters_count: i32,
    pub synergies_count: i32,
    pub top_counter_targets: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub status: ConnectionStatus,
    pub summoner_name: Option<String>,
    #[serde(skip)]
    pub summoner_id: Option<i64>,
    #[serde(skip)]
    pub summoner_puuid: Option<String>,
    pub champion_id: Option<i64>,
    pub champion_name: Option<String>,
    pub assigned_position: Option<String>,
    pub build: Option<ChampionBuild>,
    pub build_alternatives: Option<BuildAlternatives>,
    pub counters: std::collections::HashMap<String, f64>,
    pub draft: Option<DraftState>,
    pub recommendations: Vec<PickRecommendation>,
    pub ranked: Option<RankedInfo>,
    pub lp_history: Vec<crate::config::LpEntry>,
    pub ban_suggestions: Vec<BanSuggestion>,
    pub ban_phase_active: bool,
    pub comfort_picks: Vec<ComfortPick>,
    pub match_history: Vec<MatchHistoryEntry>,
    pub live_game: Option<LiveGameState>,
    pub prediction: Option<GamePrediction>,
    pub post_game: Option<PostGameStats>,
    #[serde(skip)]
    pub viewing_past_match: bool,
    pub game_mode: String,
    pub aram_bench: Vec<AramBenchChampion>,
    pub auto_apply: bool,
    pub auto_lock: bool,
    pub auto_accept: bool,
    pub tts_enabled: bool,
    pub region: String,
    #[serde(skip)]
    pub overlay_position: String,
}

// --- Post-game stats ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostGameStats {
    pub teams: Vec<PostGameTeam>,
    pub game_duration_secs: i64,
    pub game_id: i64,
    pub gold_timeline: Vec<GoldDiffPoint>,
    pub death_events: Vec<DeathImpact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldDiffPoint {
    pub game_time: f64,
    pub gold_diff: f64, // ally - enemy
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeathImpact {
    pub game_time: f64,
    pub summoner_name: String,
    pub is_ally: bool,
    pub gold_swing: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostGameTeam {
    pub is_winner: bool,
    pub players: Vec<PostGamePlayer>,
    pub avg_damage: i64,
    pub avg_gold: i64,
    pub avg_cs: i64,
    pub avg_vision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostGamePlayer {
    pub champion_id: i64,
    pub summoner_name: String,
    pub position: String,
    pub rank: String,
    pub puuid: String,
    pub is_local: bool,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub total_damage: i64,
    pub gold_earned: i64,
    pub cs: i64,
    pub vision_score: i64,
    pub wards_placed: i64,
    pub wards_killed: i64,
    pub damage_share: f64,
    pub kill_participation: f64,
    pub double_kills: i64,
    pub triple_kills: i64,
    pub quadra_kills: i64,
    pub penta_kills: i64,
    pub mvp_score: f64,
    pub is_mvp: bool,
    pub items: Vec<i64>,
    pub phase_stats: Vec<PhaseStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseStats {
    pub phase: String,
    pub cs_per_min: f64,
    pub gold_per_min: f64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            status: ConnectionStatus::Disconnected,
            summoner_name: None,
            summoner_id: None,
            summoner_puuid: None,
            champion_id: None,
            champion_name: None,
            assigned_position: None,
            build: None,
            build_alternatives: None,
            counters: std::collections::HashMap::new(),
            draft: None,
            recommendations: vec![],
            ranked: None,
            lp_history: vec![],
            ban_suggestions: vec![],
            ban_phase_active: false,
            comfort_picks: vec![],
            match_history: vec![],
            prediction: None,
            live_game: None,
            post_game: None,
            viewing_past_match: false,
            game_mode: "classic".to_string(),
            aram_bench: vec![],
            auto_apply: true,
            auto_lock: false,
            auto_accept: false,
            tts_enabled: false,
            region: "euw".to_string(),
            overlay_position: "top-left".to_string(),
        }
    }
}

// --- Champ select session (LCU) ---

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampSelectSession {
    pub local_player_cell_id: i64,
    pub my_team: Vec<ChampSelectPlayer>,
    #[serde(default)]
    pub their_team: Vec<ChampSelectPlayer>,
    pub actions: Vec<Vec<ChampSelectAction>>,
    #[serde(default)]
    pub bench_champion_ids: Vec<i64>, // populated manually from benchChampions
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampSelectPlayer {
    pub cell_id: i64,
    pub champion_id: i64,
    #[allow(dead_code)]
    pub spell1_id: i64,
    #[allow(dead_code)]
    pub spell2_id: i64,
    pub assigned_position: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampSelectAction {
    pub actor_cell_id: i64,
    pub champion_id: i64,
    #[serde(rename = "type")]
    pub action_type: String,
    pub completed: bool,
    #[serde(default)]
    pub is_in_progress: bool,
    #[serde(default)]
    pub id: i64,
}

// --- OP.GG API responses ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggResponse {
    pub data: OpggChampionData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggChampionData {
    #[serde(default)]
    pub runes: Vec<OpggRune>,
    #[serde(default)]
    pub core_items: Vec<OpggCoreItems>,
    #[serde(default)]
    pub starter_items: Vec<OpggStarterItems>,
    #[serde(default)]
    pub boots: Vec<OpggBoots>,
    #[serde(default)]
    pub summoner_spells: Vec<OpggSummonerSpells>,
    #[serde(default)]
    pub skill_masteries: Vec<OpggSkillMastery>,
    #[serde(default)]
    pub counters: Vec<OpggCounter>,
    #[serde(default)]
    pub game_lengths: Vec<OpggGameLength>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggRune {
    pub id: i64,
    pub primary_page_id: i64,
    pub primary_rune_ids: Vec<i64>,
    pub secondary_page_id: i64,
    pub secondary_rune_ids: Vec<i64>,
    pub stat_mod_ids: Vec<i64>,
    pub play: i64,
    pub win: i64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggCoreItems {
    pub ids: Vec<i64>,
    pub play: i64,
    pub win: i64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggStarterItems {
    pub ids: Vec<i64>,
    pub play: i64,
    pub win: i64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggBoots {
    pub ids: Vec<i64>,
    pub play: i64,
    pub win: i64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggSummonerSpells {
    pub ids: Vec<i64>,
    pub play: i64,
    pub win: i64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggSkillMastery {
    pub ids: Vec<String>,
    pub play: i64,
    pub win: i64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggCounter {
    pub champion_id: i64,
    pub play: i64,
    pub win: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggGameLength {
    pub game_length: i64,
    pub rate: f64,
    #[serde(default)]
    pub average: f64,
}

// --- Game prediction ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamePrediction {
    pub ally_avg_wr: f64,
    pub enemy_avg_wr: f64,
    pub ally_early_score: f64,
    pub ally_late_score: f64,
    pub enemy_early_score: f64,
    pub enemy_late_score: f64,
    pub tip: String,
}

// --- OP.GG tier list ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggTierListResponse {
    pub data: Vec<OpggTierChampion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpggTierChampion {
    pub id: i64,
    // OP.GG occasionally omits these OR sends them as explicit `null`
    // (new/reworked champs, degraded payloads). `#[serde(default)]` alone only
    // covers absent keys, so we also map `null` to the default to keep a single
    // bad entry from failing the whole list.
    #[serde(default, deserialize_with = "null_as_default")]
    pub average_stats: OpggAverageStats,
    #[serde(default, deserialize_with = "null_as_default")]
    pub positions: Vec<OpggPositionStats>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpggAverageStats {
    #[serde(default, deserialize_with = "null_as_default")]
    pub win_rate: f64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub pick_rate: f64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub ban_rate: f64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub tier: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpggPositionStats {
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default)]
    pub stats: OpggPositionWinRate,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpggPositionWinRate {
    #[serde(default, deserialize_with = "null_as_default")]
    pub win_rate: f64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub pick_rate: f64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub tier: i64,
}

// --- Build recommendation (sent to frontend) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChampionBuild {
    pub runes: Option<RuneBuild>,
    pub summoner_spells: Option<[i64; 2]>,
    pub starter_items: Vec<i64>,
    pub core_items: Vec<i64>,
    pub boots: Vec<i64>,
    pub skill_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuneBuild {
    pub primary_style_id: i64,
    pub sub_style_id: i64,
    pub selected_perk_ids: Vec<i64>,
}

// --- Build alternatives ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildAlternatives {
    pub runes: Vec<RuneOption>,
    pub summoner_spells: Vec<SpellOption>,
    pub core_items: Vec<ItemOption>,
    pub starter_items: Vec<ItemOption>,
    pub boots: Vec<ItemOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuneOption {
    pub build: RuneBuild,
    pub win_rate: f64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpellOption {
    pub ids: [i64; 2],
    pub win_rate: f64,
    pub pick_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemOption {
    pub ids: Vec<i64>,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub games: i64,
}

// --- Fetch result from OP.GG (internal) ---

pub struct ChampionFetchResult {
    pub build: ChampionBuild,
    pub counters: std::collections::HashMap<i64, f64>,
    pub alternatives: BuildAlternatives,
}

// --- LCU rune page ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LcuRunePage {
    pub id: Option<i64>,
    pub name: String,
    pub primary_style_id: i64,
    pub sub_style_id: i64,
    pub selected_perk_ids: Vec<i64>,
    pub current: bool,
}

// --- Summoner ---

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LcuSummoner {
    pub display_name: Option<String>,
    pub game_name: Option<String>,
    #[allow(dead_code)]
    pub summoner_id: Option<i64>,
    #[serde(default)]
    pub puuid: Option<String>,
}

// --- Ranked info ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankedInfo {
    pub tier: String,
    pub rank: String,
    pub lp: i64,
    pub wins: i64,
    pub losses: i64,
}

// --- Ban suggestions ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BanSuggestion {
    pub champion_id: i64,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub ban_rate: f64,
    pub score: f64,
}

// --- Comfort picks ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComfortPick {
    pub champion_id: i64,
    pub games_played: i32,
    pub meta_win_rate: f64,
}

// --- Match history ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchHistoryEntry {
    pub game_id: i64,
    pub champion_id: i64,
    pub queue_id: i64,
    pub game_mode: String,
    pub win: bool,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub duration_secs: i64,
    pub timestamp: i64, // epoch ms
    pub cs: i64,
    pub vision_score: i64,
    pub gold_earned: i64,
    pub total_damage: i64,
    #[serde(default)]
    pub position: String, // TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY (empty if unknown)
    #[serde(default)]
    pub team_id: i64, // 100 / 200 — the queried player's side; used for premade detection
}

// --- ARAM bench ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AramBenchChampion {
    pub champion_id: i64,
    pub win_rate: f64,
}

// --- Live game ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveGameState {
    pub queue_name: String,
    pub allies: Vec<LiveGamePlayer>,
    pub enemies: Vec<LiveGamePlayer>,
    pub live_data: Option<LiveGameData>,
    pub recommended_build: Option<ChampionBuild>,
    #[serde(default)]
    pub recommended_alternatives: Option<BuildAlternatives>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveGamePlayer {
    pub champion_id: i64,
    pub summoner_name: String,
    pub rank: String,
    pub puuid: String,
    pub position: String,
    pub smurf: Option<SmurfAnalysis>,
    // Ranked stats
    pub ranked_wins: i64,
    pub ranked_losses: i64,
    pub ranked_win_rate: f64,
    // Recent form
    pub streak: i32,          // positive = win streak, negative = loss streak
    // Stats on current champion
    pub champ_games: i32,
    pub champ_wins: i32,
    pub champ_kda: f64,
    // Premade detection: same non-zero id = inferred party (duo/trio) within the team.
    // None = no premade signal. Assigned per team from shared recent match history.
    #[serde(default)]
    pub premade_group: Option<u8>,
    // Live in-game stats (updated during game)
    pub live: Option<LivePlayerStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LivePlayerStats {
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub cs: i64,
    pub level: i64,
    pub current_gold: f64,
    pub total_gold: f64,
    pub items: Vec<i64>,
    pub spell1_id: i64,
    pub spell2_id: i64,
    #[serde(default)]
    pub ward_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveGameData {
    pub game_time: f64,
    pub ally_gold: f64,
    pub enemy_gold: f64,
    pub events: Vec<GameEvent>,
    #[serde(skip)]
    pub snapshots: Vec<PlayerSnapshot>,
}

#[derive(Debug, Clone)]
pub struct PlayerSnapshot {
    pub game_time: f64,
    pub summoner_name: String,
    pub cs: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub gold: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameEvent {
    pub event_type: String,  // DragonKill, BaronKill, TurretKilled, ChampionKill, etc.
    pub time: f64,
    pub label: String,       // human-readable description
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmurfAnalysis {
    pub score: u8,
    pub account_level: i64,
    pub games_played: i64,
    pub win_rate: f64,
    pub avg_kda: f64,
    pub unique_champions: i64,
}
