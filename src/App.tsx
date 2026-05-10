import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// getCurrentWebviewWindow is used in main.tsx for overlay detection
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";

// --- Types ---

interface RuneBuild {
  primary_style_id: number;
  sub_style_id: number;
  selected_perk_ids: number[];
}

interface ChampionBuild {
  runes: RuneBuild | null;
  summoner_spells: [number, number] | null;
  starter_items: number[];
  core_items: number[];
  boots: number[];
  skill_order: string[];
}

interface DraftPlayer {
  champion_id: number;
  position: string;
  is_local: boolean;
}

interface DraftState {
  allies: DraftPlayer[];
  enemies: DraftPlayer[];
  ally_bans: number[];
  enemy_bans: number[];
}

interface PickRecommendation {
  champion_id: number;
  score: number;
  win_rate: number;
  counters_count: number;
  synergies_count: number;
}

interface PostGamePlayer {
  champion_id: number;
  summoner_name: string;
  position: string;
  rank: string;
  puuid: string;
  is_local: boolean;
  kills: number;
  deaths: number;
  assists: number;
  total_damage: number;
  gold_earned: number;
  cs: number;
  vision_score: number;
  wards_placed: number;
  wards_killed: number;
  damage_share: number;
  kill_participation: number;
  double_kills: number;
  triple_kills: number;
  quadra_kills: number;
  penta_kills: number;
  mvp_score: number;
  is_mvp: boolean;
  items: number[];
  phase_stats: PhaseStats[];
}

interface PhaseStats {
  phase: string;
  cs_per_min: number;
  gold_per_min: number;
  kills: number;
  deaths: number;
  assists: number;
}

interface PostGameTeam {
  is_winner: boolean;
  players: PostGamePlayer[];
  avg_damage: number;
  avg_gold: number;
  avg_cs: number;
  avg_vision: number;
}

interface GoldDiffPoint { game_time: number; gold_diff: number; }
interface DeathImpact { game_time: number; summoner_name: string; is_ally: boolean; gold_swing: number; }

interface PostGameStats {
  teams: PostGameTeam[];
  game_duration_secs: number;
  game_id: number;
  gold_timeline: GoldDiffPoint[];
  death_events: DeathImpact[];
}

interface MatchHistoryEntry {
  game_id: number;
  champion_id: number;
  queue_id: number;
  game_mode: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  duration_secs: number;
  timestamp: number;
  cs: number;
  vision_score: number;
  gold_earned: number;
  total_damage: number;
  position?: string;
}

interface LivePlayerStats {
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  level: number;
  current_gold: number;
  total_gold: number;
  items: number[];
  spell1_id: number;
  spell2_id: number;
  ward_score: number;
}

interface LiveGameData {
  game_time: number;
  ally_gold: number;
  enemy_gold: number;
  events: GameEvent[];
}

interface GameEvent {
  event_type: string;
  time: number;
  label: string;
}

interface LiveGameState {
  queue_name: string;
  allies: LiveGamePlayer[];
  enemies: LiveGamePlayer[];
  live_data: LiveGameData | null;
  recommended_build: ChampionBuild | null;
  recommended_alternatives: BuildAlternatives | null;
}

interface SmurfAnalysis {
  score: number;
  account_level: number;
  games_played: number;
  win_rate: number;
  avg_kda: number;
  unique_champions: number;
}

interface LiveGamePlayer {
  champion_id: number;
  summoner_name: string;
  rank: string;
  puuid: string;
  position: string;
  smurf: SmurfAnalysis | null;
  ranked_wins: number;
  ranked_losses: number;
  ranked_win_rate: number;
  streak: number;
  champ_games: number;
  champ_wins: number;
  champ_kda: number;
  live: LivePlayerStats | null;
}

interface BanSuggestion {
  champion_id: number;
  win_rate: number;
  pick_rate: number;
  ban_rate: number;
  score: number;
}

interface ComfortPick {
  champion_id: number;
  games_played: number;
  meta_win_rate: number;
}

interface LpEntry {
  timestamp: number;
  lp: number;
  tier: string;
  rank: string;
}

interface GamePrediction {
  ally_avg_wr: number;
  enemy_avg_wr: number;
  ally_early_score: number;
  ally_late_score: number;
  enemy_early_score: number;
  enemy_late_score: number;
  tip: string;
}

interface RankedInfo {
  tier: string;
  rank: string;
  lp: number;
  wins: number;
  losses: number;
}

interface RuneOption {
  build: RuneBuild;
  win_rate: number;
  pick_rate: number;
}

interface SpellOption {
  ids: [number, number];
  win_rate: number;
  pick_rate: number;
}

interface ItemOption {
  ids: number[];
  win_rate: number;
  pick_rate: number;
  games: number;
}

interface BuildAlternatives {
  runes: RuneOption[];
  summoner_spells: SpellOption[];
  core_items: ItemOption[];
  starter_items: ItemOption[];
  boots: ItemOption[];
}

interface AramBenchChampion {
  champion_id: number;
  win_rate: number;
}

interface AppState {
  status: "disconnected" | "connected" | "champ_select" | "in_game" | "post_game";
  summoner_name: string | null;
  champion_id: number | null;
  champion_name: string | null;
  assigned_position: string | null;
  build: ChampionBuild | null;
  build_alternatives: BuildAlternatives | null;
  counters: Record<string, number>;
  draft: DraftState | null;
  ranked: RankedInfo | null;
  lp_history: LpEntry[];
  ban_suggestions: BanSuggestion[];
  comfort_picks: ComfortPick[];
  prediction: GamePrediction | null;
  match_history: MatchHistoryEntry[];
  live_game: LiveGameState | null;
  post_game: PostGameStats | null;
  game_mode: string;
  aram_bench: AramBenchChampion[];
  recommendations: PickRecommendation[];
  ban_phase_active: boolean;
  auto_apply: boolean;
  auto_lock: boolean;
  auto_accept: boolean;
  tts_enabled: boolean;
  region: string;
}

// --- Constants ---

const DDRAGON = "https://ddragon.leagueoflegends.com/cdn";
let DDRAGON_VERSION = "16.9.1"; // fallback, updated dynamically

async function fetchLatestVersion() {
  try {
    const resp = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
    const versions: string[] = await resp.json();
    if (versions.length > 0) {
      DDRAGON_VERSION = versions[0];
      console.log("Data Dragon version:", DDRAGON_VERSION);
    }
  } catch { /* use fallback */ }
}

const REGIONS = [
  { value: "euw", label: "EUW" }, { value: "na", label: "NA" },
  { value: "kr", label: "KR" }, { value: "eune", label: "EUNE" },
  { value: "br", label: "BR" }, { value: "las", label: "LAS" },
  { value: "lan", label: "LAN" }, { value: "oce", label: "OCE" },
  { value: "tr", label: "TR" }, { value: "ru", label: "RU" },
  { value: "jp", label: "JP" },
];

const SPELL_NAMES: Record<number, string> = {
  1: "Cleanse", 3: "Exhaust", 4: "Flash", 6: "Ghost", 7: "Heal",
  11: "Smite", 12: "Teleport", 13: "Clarity", 14: "Ignite", 21: "Barrier", 32: "Mark",
};

const SPELL_KEYS: Record<number, string> = {
  1: "SummonerBoost", 3: "SummonerExhaust", 4: "SummonerFlash",
  6: "SummonerHaste", 7: "SummonerHeal", 11: "SummonerSmite",
  12: "SummonerTeleport", 13: "SummonerMana", 14: "SummonerDot", 21: "SummonerBarrier",
  32: "SummonerSnowball",
};

const SPELL_COOLDOWNS: Record<number, number> = {
  1: 210, 3: 210, 4: 300, 6: 210, 7: 240,
  12: 360, 13: 240, 14: 180, 21: 180, 32: 80,
};

const POSITION_LABELS: Record<string, string> = {
  top: "TOP", jungle: "JNG", middle: "MID", mid: "MID",
  bottom: "BOT", adc: "BOT", utility: "SUP", support: "SUP",
};

const POSITION_ICON_KEYS: Record<string, string> = {
  top: "top", jungle: "jungle", middle: "middle", mid: "middle",
  bottom: "bottom", adc: "bottom", utility: "utility", support: "utility",
  TOP: "top", JNG: "jungle", MID: "middle", BOT: "bottom", SUP: "utility",
  JUNGLE: "jungle", MIDDLE: "middle", BOTTOM: "bottom", UTILITY: "utility",
};

const POS_ICON_BASE = "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-champ-select/global/default/svg/";

// Canonical position order: top → jungle → middle → bottom → utility
const POSITION_ORDER: Record<string, number> = {
  top: 0, TOP: 0,
  jungle: 1, JUNGLE: 1, jng: 1, JNG: 1,
  middle: 2, MIDDLE: 2, mid: 2, MID: 2,
  bottom: 3, BOTTOM: 3, adc: 3, ADC: 3, bot: 3, BOT: 3,
  utility: 4, UTILITY: 4, support: 4, SUPPORT: 4, sup: 4, SUP: 4,
};

function sortByPosition<T extends { position: string }>(players: T[]): T[] {
  return [...players].sort((a, b) => {
    const ra = POSITION_ORDER[a.position] ?? POSITION_ORDER[a.position?.toLowerCase()] ?? 99;
    const rb = POSITION_ORDER[b.position] ?? POSITION_ORDER[b.position?.toLowerCase()] ?? 99;
    return ra - rb;
  });
}

// --- Champion traits for adaptive item recommendations ---

// Champions tagged by relevant trait (champion IDs)
const TRAIT_HEALERS = new Set([
  16,  // Soraka
  266, // Aatrox
  8,   // Vladimir
  36,  // Dr. Mundo
  106, // Volibear
  19,  // Warwick
  50,  // Swain
  154, // Zac
  57,  // Maokai
  427, // Ivern
  117, // Lulu (W heal)
  267, // Nami
  37,  // Sona
  350, // Bel'Veth
  145, // Rek'Sai (not really, remove)
  887, // Gwen
  86,  // Garen (passive)
  122, // Darius (Q heal)
  164, // Camille
  141, // Kayn (red form)
  876, // Lillia
  80,  // Pantheon
  5,   // Xin Zhao
  2,   // Olaf
  77,  // Udyr
  420, // Illaoi
  6,   // Urgot
  82,  // Mordekaiser
  83,  // Yorick
  240, // Kled
  58,  // Renekton
  23,  // Tryndamere
  11,  // Master Yi
  10,  // Kayle
  518, // Neeko
  62,  // Wukong
  777, // Yone
  157, // Yasuo
  39,  // Irelia
  114, // Fiora
  92,  // Riven
  245, // Ekko
  105, // Fizz
  131, // Diana
  84,  // Akali
  55,  // Katarina
  238, // Zed
  91,  // Talon
  121, // Kha'Zix
  107, // Rengar
  28,  // Evelynn
  360, // Samira
  119, // Draven
  498, // Xayah
  895, // Nilah
  904, // Zaahen (Q heal on-attack + E damage→heal + passive revive)
]);

// Champions with a hard, reliable engage tool (multi-target CC ult or long-range engage)
const TRAIT_ENGAGE = new Set([
  54, 79, 89, 12, 111, 57, 31, 516, 113, 526, 555, 412, 432, 53, 78, 154, 5,
  64, 35, 60, 9, 20, 32, 121, 234, 254, 421, 875, 39, 80, 875, 254, 240, 233,
  799, 904, 36, 86, 102, 106,
]);

// Frontline / tanky bodies that can soak damage in fights
const TRAIT_FRONTLINE = new Set([
  54, 14, 33, 36, 75, 31, 113, 154, 111, 89, 12, 201, 78, 57, 516, 526, 897, 875,
  223, 412, 86, 98, 102, 106, 120, 150, 6, 20, 22, 32, 234, 254, 421, 200, 41,
  48, 62, 240, 233, 799, 5, 64, 421, 233,
]);

// Reliable peel / disengage (slows, knockbacks, shields with CC)
const TRAIT_PEEL = new Set([
  117, 40, 432, 89, 111, 412, 53, 526, 497, 78, 16, 267, 902, 350, 888, 25,
  57, 154, 12, 201, 223, 99, 161, 142, 127, 30,
]);

// Late-game scaling carries — power compounds with items/levels
const TRAIT_SCALING = new Set([
  10, 38, 67, 96, 29, 13, 45, 75, 30, 8, 222, 51, 18, 887, 11, 23, 67, 145,
  157, 777, 114, 37, 104, 200, 17, 901, 221, 235, 268, 523, 4, 7, 55, 62, 803, 804,
]);

// Burst / high-priority targets
const TRAIT_BURST = new Set([
  84, 238, 91, 55, 105, 131, 245, 121, 107, 28, 7, 4, 246, 38, 45, 1, 99, 134,
  99, 142, 711, 800, 893, 910, 9, 35, 56, 141, 164, 234, 254, 950, 904, 360,
]);

const TRAIT_SHIELDERS = new Set([
  117, // Lulu
  43,  // Karma
  40,  // Janna
  497, // Rakan
  412, // Thresh
  201, // Braum
  25,  // Morgana
  61,  // Orianna
  134, // Syndra
  3,   // Galio
  54,  // Malphite (passive)
  78,  // Poppy
  98,  // Shen
  223, // Tahm Kench
  432, // Bard
  685, // Renata Glasc
  526, // Rell
  147, // Seraphine
  350, // Bel'Veth
  427, // Ivern
]);

// Champions with reliable hard CC (stuns/knockups/roots ≥1.0s, multi-target preferred)
const TRAIT_HARD_CC = new Set([
  54, 79, 89, 12, 111, 57, 31, 516, 113, 526, 555, 412, 432, 53, 78, 154, 5,
  64, 35, 60, 9, 20, 32, 121, 234, 254, 421, 39, 80, 240, 233, 799, 904, 36,
  102, 161, 90, 25, 99, 30, 555, 142, 134, 3, 526, 555, 875, 19, 26, 14,
]);

// Map champion ID to primary damage type: "ap" or "ad"
const CHAMP_DAMAGE_TYPE: Record<number, "ap" | "ad"> = {};
// AP champions
[1,3,4,7,8,9,10,13,16,17,25,26,27,28,30,31,34,37,38,40,42,43,45,50,54,55,57,60,61,63,68,69,74,76,79,82,84,85,90,96,99,101,103,105,112,113,115,117,127,131,134,136,142,143,147,150,154,161,163,245,246,267,268,350,353,360,427,432,497,517,518,526,555,685,711,800,876,887,888,893,901,902,910,950].forEach(id => CHAMP_DAMAGE_TYPE[id] = "ap");
// AD champions (rest default to AD for simplicity)

interface ItemRec {
  category: string;
  reason: string;
  priority: "high" | "medium";
  items: { id: number; name: string }[];
}

function analyzeEnemyComp(enemyIds: number[]): ItemRec[] {
  const recs: ItemRec[] = [];
  if (enemyIds.length === 0) return recs;

  const healers = enemyIds.filter(id => TRAIT_HEALERS.has(id));
  const shielders = enemyIds.filter(id => TRAIT_SHIELDERS.has(id));
  const apCount = enemyIds.filter(id => CHAMP_DAMAGE_TYPE[id] === "ap").length;
  const adCount = enemyIds.length - apCount;

  // Antiheal
  if (healers.length >= 2) {
    const names = healers.map(id => championCache?.[id.toString()]?.name || "?").join(", ");
    recs.push({
      category: "Antiheal",
      reason: `Heavy healing: ${names}`,
      priority: "high",
      items: [
        { id: 3165, name: "Morellonomicon" },
        { id: 3033, name: "Mortal Reminder" },
        { id: 3011, name: "Chemtech Putrifier" },
      ],
    });
  } else if (healers.length === 1) {
    const name = championCache?.[healers[0].toString()]?.name || "?";
    recs.push({
      category: "Antiheal",
      reason: `${name} has healing`,
      priority: "medium",
      items: [
        { id: 3165, name: "Morellonomicon" },
        { id: 3033, name: "Mortal Reminder" },
      ],
    });
  }

  // Heavy AP
  if (apCount >= 4) {
    recs.push({
      category: "Magic Resist",
      reason: `${apCount} AP champions — stack MR`,
      priority: "high",
      items: [
        { id: 3065, name: "Spirit Visage" },
        { id: 4401, name: "Force of Nature" },
        { id: 3111, name: "Mercury's Treads" },
      ],
    });
  } else if (apCount >= 3) {
    recs.push({
      category: "Magic Resist",
      reason: `${apCount} AP champions`,
      priority: "medium",
      items: [
        { id: 3111, name: "Mercury's Treads" },
        { id: 4401, name: "Force of Nature" },
      ],
    });
  }

  // Heavy AD
  if (adCount >= 4) {
    recs.push({
      category: "Armor",
      reason: `${adCount} AD champions — stack armor`,
      priority: "high",
      items: [
        { id: 3143, name: "Randuin's Omen" },
        { id: 3110, name: "Frozen Heart" },
        { id: 3047, name: "Plated Steelcaps" },
      ],
    });
  } else if (adCount >= 3) {
    recs.push({
      category: "Armor",
      reason: `${adCount} AD champions`,
      priority: "medium",
      items: [
        { id: 3047, name: "Plated Steelcaps" },
        { id: 3143, name: "Randuin's Omen" },
      ],
    });
  }

  // Shielders
  if (shielders.length >= 2) {
    const names = shielders.map(id => championCache?.[id.toString()]?.name || "?").join(", ");
    recs.push({
      category: "Anti-Shield",
      reason: `Heavy shielding: ${names}`,
      priority: "medium",
      items: [
        { id: 6609, name: "Serpent's Fang" },
      ],
    });
  }

  return recs;
}

// --- Champion power curves for matchup analysis ---

// Power levels: 1=weak, 2=below avg, 3=average, 4=strong, 5=dominant
interface PowerCurve { early: number; mid: number; late: number; spikes: number[]; }

// Default: average across all phases
const DEFAULT_CURVE: PowerCurve = { early: 3, mid: 3, late: 3, spikes: [6] };

// Champions with notable power curves (only non-average ones listed)
const POWER_CURVES: Record<number, PowerCurve> = {
  // Early dominant
  266: { early: 5, mid: 3, late: 2, spikes: [1, 3] },      // Aatrox
  122: { early: 5, mid: 4, late: 2, spikes: [1, 6] },       // Darius
  80:  { early: 5, mid: 3, late: 1, spikes: [1, 3] },       // Pantheon
  58:  { early: 5, mid: 3, late: 2, spikes: [2, 3] },       // Renekton
  119: { early: 5, mid: 3, late: 2, spikes: [1, 2] },       // Draven
  236: { early: 4, mid: 3, late: 2, spikes: [2, 3] },       // Lucian
  104: { early: 4, mid: 3, late: 2, spikes: [3, 6] },       // Graves
  2:   { early: 5, mid: 3, late: 2, spikes: [1] },          // Olaf
  59:  { early: 4, mid: 3, late: 2, spikes: [2, 3] },       // Jarvan
  64:  { early: 4, mid: 3, late: 2, spikes: [2, 3, 6] },    // Lee Sin
  76:  { early: 4, mid: 3, late: 2, spikes: [3, 6] },       // Nidalee
  60:  { early: 4, mid: 3, late: 2, spikes: [3, 6] },       // Elise
  240: { early: 5, mid: 3, late: 2, spikes: [1, 4] },       // Kled
  420: { early: 4, mid: 4, late: 2, spikes: [1, 6] },       // Illaoi

  // Level 6 spikers
  84:  { early: 2, mid: 4, late: 3, spikes: [6] },          // Akali
  238: { early: 2, mid: 5, late: 2, spikes: [6] },          // Zed
  91:  { early: 2, mid: 5, late: 2, spikes: [6] },          // Talon
  55:  { early: 2, mid: 4, late: 3, spikes: [6, 11] },      // Katarina
  105: { early: 2, mid: 4, late: 3, spikes: [6] },          // Fizz
  131: { early: 2, mid: 4, late: 3, spikes: [6] },          // Diana
  245: { early: 2, mid: 4, late: 3, spikes: [6] },          // Ekko
  121: { early: 2, mid: 5, late: 3, spikes: [6, 11] },      // Kha'Zix
  107: { early: 2, mid: 5, late: 3, spikes: [6] },          // Rengar
  28:  { early: 1, mid: 5, late: 3, spikes: [6] },          // Evelynn
  54:  { early: 2, mid: 4, late: 4, spikes: [6] },          // Malphite
  555: { early: 3, mid: 5, late: 3, spikes: [6] },          // Pyke
  7:   { early: 2, mid: 4, late: 3, spikes: [6, 11] },      // LeBlanc
  4:   { early: 2, mid: 4, late: 3, spikes: [6, 11] },      // Twisted Fate
  246: { early: 2, mid: 4, late: 3, spikes: [3, 6] },       // Qiyana

  // Mid game power
  39:  { early: 3, mid: 5, late: 3, spikes: [6, 9] },       // Irelia
  777: { early: 3, mid: 5, late: 4, spikes: [6, 11] },      // Yone
  157: { early: 2, mid: 4, late: 5, spikes: [6, 11] },      // Yasuo
  92:  { early: 3, mid: 5, late: 3, spikes: [6, 11] },      // Riven
  114: { early: 3, mid: 4, late: 5, spikes: [1, 6, 11] },   // Fiora
  23:  { early: 3, mid: 3, late: 5, spikes: [6, 11] },      // Tryndamere
  5:   { early: 4, mid: 4, late: 2, spikes: [2, 3, 6] },    // Xin Zhao

  // Late game scalers
  10:  { early: 1, mid: 2, late: 5, spikes: [6, 11, 16] },  // Kayle
  38:  { early: 1, mid: 3, late: 5, spikes: [6, 11, 16] },  // Kassadin
  67:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Vayne
  96:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Kog'Maw
  29:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Twitch
  13:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Ryze
  45:  { early: 1, mid: 3, late: 5, spikes: [6, 11, 16] },  // Veigar
  75:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Nasus
  30:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Karthus
  8:   { early: 2, mid: 3, late: 5, spikes: [6, 9, 11] },   // Vladimir
  17:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Teemo (not really late but annoying)
  222: { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Jinx
  51:  { early: 3, mid: 3, late: 5, spikes: [6, 11] },      // Caitlyn
  18:  { early: 2, mid: 3, late: 5, spikes: [6, 11, 16] },  // Tristana
  498: { early: 3, mid: 3, late: 4, spikes: [6, 11] },      // Xayah
  81:  { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Ezreal
  887: { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Gwen
  200: { early: 1, mid: 3, late: 5, spikes: [6, 16] },      // Bel'Veth
  11:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Master Yi
  19:  { early: 4, mid: 3, late: 2, spikes: [1, 3, 6] },    // Warwick

  // Tanks (scale with levels)
  31:  { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Cho'Gath
  113: { early: 3, mid: 4, late: 4, spikes: [6] },          // Sejuani
  154: { early: 3, mid: 4, late: 3, spikes: [6] },          // Zac
  111: { early: 3, mid: 4, late: 4, spikes: [6] },          // Nautilus
  89:  { early: 4, mid: 4, late: 3, spikes: [2, 3, 6] },    // Leona
  12:  { early: 3, mid: 4, late: 4, spikes: [6] },          // Alistar
  201: { early: 3, mid: 4, late: 3, spikes: [1, 6] },       // Braum
  78:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Poppy
  57:  { early: 3, mid: 4, late: 4, spikes: [6] },          // Maokai
  516: { early: 3, mid: 4, late: 4, spikes: [6] },          // Ornn

  // Enchanters
  16:  { early: 3, mid: 3, late: 4, spikes: [6, 11] },      // Soraka
  117: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Lulu
  40:  { early: 3, mid: 3, late: 4, spikes: [6] },          // Janna
  267: { early: 3, mid: 3, late: 3, spikes: [6] },          // Nami
  37:  { early: 2, mid: 3, late: 5, spikes: [6, 11, 16] },  // Sona
  43:  { early: 4, mid: 3, late: 3, spikes: [1, 6] },       // Karma

  // Mages
  99:  { early: 3, mid: 4, late: 3, spikes: [6, 11] },      // Lux
  161: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Vel'Koz
  101: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Xerath
  112: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Viktor
  134: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Syndra
  61:  { early: 3, mid: 4, late: 4, spikes: [6, 9] },       // Orianna
  69:  { early: 4, mid: 4, late: 4, spikes: [1, 6, 11] },   // Cassiopeia
  3:   { early: 3, mid: 4, late: 3, spikes: [6] },          // Galio
  127: { early: 3, mid: 4, late: 3, spikes: [6, 11] },      // Lissandra
  50:  { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Swain
  90:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Malzahar
  1:   { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Annie
  25:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Morgana
  63:  { early: 4, mid: 4, late: 3, spikes: [3, 6] },       // Brand
  143: { early: 3, mid: 4, late: 3, spikes: [6] },          // Zyra

  // Expanded coverage (heuristics by archetype)

  // Tank-Fighter / Juggernauts
  6:   { early: 3, mid: 4, late: 3, spikes: [6, 11] },      // Urgot
  14:  { early: 2, mid: 3, late: 4, spikes: [6, 11] },      // Sion
  20:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Nunu
  33:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Rammus
  36:  { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Dr. Mundo
  48:  { early: 4, mid: 4, late: 3, spikes: [2, 6] },       // Trundle
  62:  { early: 4, mid: 4, late: 3, spikes: [2, 6] },       // Wukong
  72:  { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Skarner
  77:  { early: 4, mid: 4, late: 3, spikes: [1, 6] },       // Udyr
  83:  { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Yorick
  86:  { early: 4, mid: 4, late: 2, spikes: [3, 6] },       // Garen
  98:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Shen
  102: { early: 3, mid: 4, late: 3, spikes: [6] },          // Shyvana
  106: { early: 4, mid: 4, late: 3, spikes: [1, 6] },       // Volibear
  120: { early: 3, mid: 4, late: 3, spikes: [3, 6] },       // Hecarim
  150: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Gnar
  421: { early: 4, mid: 4, late: 3, spikes: [3, 6] },       // Rek'Sai
  875: { early: 4, mid: 4, late: 3, spikes: [2, 6] },       // Sett
  897: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // K'Sante

  // Assassins / Skirmishers
  35:  { early: 3, mid: 4, late: 3, spikes: [3, 6] },       // Shaco
  56:  { early: 2, mid: 5, late: 3, spikes: [6] },          // Nocturne
  141: { early: 3, mid: 5, late: 3, spikes: [6, 11] },      // Kayn
  164: { early: 3, mid: 5, late: 3, spikes: [6, 11] },      // Camille
  233: { early: 4, mid: 4, late: 2, spikes: [3, 6] },       // Briar
  234: { early: 2, mid: 5, late: 3, spikes: [6, 11] },      // Viego
  254: { early: 3, mid: 4, late: 3, spikes: [6, 11] },      // Vi
  799: { early: 3, mid: 5, late: 3, spikes: [6, 11] },      // Ambessa
  895: { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Nilah
  904: { early: 3, mid: 5, late: 3, spikes: [6, 11] },      // Zaahen
  950: { early: 2, mid: 4, late: 3, spikes: [6, 11] },      // Naafiri

  // Mages (burst / control / artillery)
  9:   { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Fiddlesticks
  34:  { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Anivia
  74:  { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Heimerdinger
  85:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Kennen
  103: { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Ahri
  115: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Ziggs
  136: { early: 1, mid: 3, late: 5, spikes: [6, 11, 16] },  // Aurelion Sol
  142: { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Zoe
  147: { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Seraphine
  163: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Taliyah
  517: { early: 3, mid: 4, late: 4, spikes: [6] },          // Sylas
  518: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Neeko
  711: { early: 3, mid: 4, late: 3, spikes: [6] },          // Vex
  800: { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Mel
  876: { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Lillia
  893: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Aurora
  910: { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Hwei

  // Battle mages / Tank-Mages
  27:  { early: 2, mid: 4, late: 4, spikes: [6] },          // Singed
  68:  { early: 2, mid: 4, late: 3, spikes: [6] },          // Rumble
  79:  { early: 3, mid: 4, late: 4, spikes: [6] },          // Gragas
  82:  { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Mordekaiser

  // Marksmen (hyperscaling / utility)
  15:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Sivir
  21:  { early: 3, mid: 4, late: 3, spikes: [6, 11] },      // Miss Fortune
  22:  { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Ashe
  42:  { early: 2, mid: 4, late: 4, spikes: [6, 11] },      // Corki
  110: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Varus
  133: { early: 3, mid: 4, late: 3, spikes: [6] },          // Quinn
  145: { early: 2, mid: 4, late: 5, spikes: [6, 11] },      // Kai'Sa
  166: { early: 3, mid: 4, late: 3, spikes: [6] },          // Akshan
  202: { early: 3, mid: 4, late: 4, spikes: [6, 11] },      // Jhin
  203: { early: 3, mid: 3, late: 5, spikes: [6, 11] },      // Kindred
  221: { early: 1, mid: 3, late: 5, spikes: [6, 11] },      // Zeri
  235: { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Senna
  268: { early: 2, mid: 4, late: 5, spikes: [6, 11] },      // Azir
  360: { early: 2, mid: 4, late: 5, spikes: [6, 11] },      // Samira
  429: { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Kalista
  523: { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Aphelios
  804: { early: 2, mid: 3, late: 5, spikes: [6, 11] },      // Yunara
  901: { early: 1, mid: 3, late: 5, spikes: [6, 11] },      // Smolder

  // Fighter-Marksman hybrid
  126: { early: 4, mid: 4, late: 3, spikes: [2, 3, 6] },    // Jayce

  // Bruisers (pure Fighter)
  24:  { early: 3, mid: 5, late: 3, spikes: [3, 6, 11] },   // Jax
  41:  { early: 4, mid: 4, late: 4, spikes: [1, 6] },       // Gangplank

  // Supports (enchanters / engage / catchers)
  26:  { early: 3, mid: 3, late: 4, spikes: [6, 11] },      // Zilean
  32:  { early: 3, mid: 4, late: 3, spikes: [6] },          // Amumu
  44:  { early: 4, mid: 4, late: 3, spikes: [6] },          // Taric
  53:  { early: 4, mid: 3, late: 3, spikes: [6] },          // Blitzcrank
  223: { early: 3, mid: 4, late: 3, spikes: [6] },          // Tahm Kench
  350: { early: 2, mid: 3, late: 4, spikes: [6, 11] },      // Yuumi
  412: { early: 4, mid: 3, late: 3, spikes: [6] },          // Thresh
  427: { early: 3, mid: 3, late: 4, spikes: [6, 11] },      // Ivern
  432: { early: 3, mid: 3, late: 4, spikes: [6, 11] },      // Bard
  497: { early: 3, mid: 4, late: 3, spikes: [6] },          // Rakan
  526: { early: 3, mid: 4, late: 3, spikes: [6] },          // Rell
  888: { early: 3, mid: 3, late: 4, spikes: [6, 11] },      // Renata Glasc
  902: { early: 3, mid: 3, late: 4, spikes: [6, 11] },      // Milio
};

function getCurve(id: number): PowerCurve {
  return POWER_CURVES[id] || DEFAULT_CURVE;
}

// --- Primary-role hints for pairing lane opponents in champ select ---
// Riot's draft API leaves enemy `position` empty until lock-in, so when the
// user is in pick phase we infer roles from champion identity. Each champion
// lists its 1-2 most common positions (popular flex picks include both).
type Role = "top" | "jungle" | "middle" | "bottom" | "utility";
const CHAMP_ROLES: Record<number, Role[]> = {
  // Top
  266: ["top"], 122: ["top"], 86: ["top"], 39: ["top", "middle"], 114: ["top"],
  150: ["top"], 92: ["top", "middle"], 41: ["top"], 240: ["top"], 24: ["top", "jungle"],
  98: ["top"], 14: ["top"], 23: ["top"], 8: ["top", "middle"], 67: ["top", "bottom"],
  516: ["top"], 6: ["top"], 887: ["top", "middle"], 102: ["top", "jungle"],
  17: ["top", "middle"], 78: ["top", "utility"], 420: ["top"], 13: ["middle", "top"],
  126: ["top", "middle"], 27: ["top"], 36: ["top"], 58: ["top"], 54: ["top", "utility"],
  31: ["top", "jungle"], 75: ["top", "jungle"], 82: ["top"], 83: ["top"], 56: ["top", "middle"],
  897: ["top"], 50: ["top", "middle", "utility"], 875: ["top"], 60: ["top", "jungle"],
  // Jungle
  121: ["jungle"], 64: ["jungle"], 19: ["jungle"], 11: ["jungle"], 2: ["jungle", "top"],
  421: ["jungle"], 79: ["jungle"], 5: ["jungle"], 113: ["jungle"], 76: ["jungle"],
  77: ["jungle", "top"], 33: ["jungle", "top"], 9: ["jungle", "middle"], 28: ["jungle"],
  104: ["jungle"], 107: ["jungle"], 141: ["jungle"], 234: ["jungle"], 35: ["jungle"],
  154: ["jungle"], 254: ["jungle"], 203: ["jungle"], 200: ["jungle"],
  62: ["jungle", "top"], 245: ["jungle", "middle"], 32: ["jungle", "utility"],
  876: ["jungle"], 427: ["jungle"], 120: ["jungle"], 72: ["jungle", "middle"], 233: ["jungle"],
  // Mid
  1: ["middle"], 4: ["middle"], 7: ["middle"], 38: ["middle"], 45: ["middle"],
  55: ["middle"], 61: ["middle"], 84: ["middle"], 91: ["middle"], 99: ["middle", "utility"],
  101: ["middle"], 103: ["middle"], 105: ["middle"], 112: ["middle"], 115: ["middle"],
  131: ["middle"], 134: ["middle"], 142: ["middle"], 143: ["middle", "utility"], 157: ["middle", "top"],
  161: ["middle"], 163: ["middle"], 238: ["middle"], 246: ["middle"], 268: ["middle"],
  517: ["middle"], 518: ["middle", "top"], 711: ["middle"],
  777: ["middle", "top"], 800: ["middle"], 901: ["middle"], 950: ["middle", "jungle"],
  136: ["middle"], 893: ["middle", "top"], 910: ["middle"], 25: ["middle", "utility"],
  // Bottom (ADC)
  18: ["bottom"], 22: ["bottom"], 29: ["bottom"], 51: ["bottom"], 81: ["bottom"],
  96: ["bottom"], 110: ["bottom"], 119: ["bottom"], 145: ["bottom", "middle"],
  202: ["bottom"], 222: ["bottom"], 236: ["bottom"], 360: ["bottom", "middle"],
  429: ["bottom"], 498: ["bottom"], 523: ["bottom"],
  21: ["bottom"], 42: ["bottom", "middle"], 15: ["bottom"], 895: ["bottom"], 904: ["bottom", "top"],
  // Support (utility)
  12: ["utility"], 16: ["utility"], 37: ["utility", "middle"], 40: ["utility"],
  43: ["utility", "middle"], 53: ["utility"], 89: ["utility"], 111: ["utility", "jungle"],
  117: ["utility"], 201: ["utility"], 223: ["utility", "top"], 267: ["utility"],
  412: ["utility"], 432: ["utility"], 497: ["utility"], 526: ["utility"], 555: ["utility", "middle"],
  147: ["utility", "middle"], 685: ["utility"], 902: ["utility"], 888: ["utility"],
  44: ["utility"], 90: ["utility", "middle"], 235: ["utility", "bottom"], 350: ["utility"],
  3: ["middle", "utility"], 30: ["utility", "middle"], 80: ["utility", "top", "middle"],
};

function getChampRoles(id: number): Role[] {
  return CHAMP_ROLES[id] || [];
}

// Pick the most-likely lane opponent for a given ally. Strategy:
//   1. exact position match (works once enemy locks in or LCU exposes role)
//   2. infer enemy roles from champion identity, prefer those whose role list
//      contains the ally's position
//   3. fallback to first visible enemy
function pickLaneOpponent(myPos: string | null | undefined, enemies: DraftPlayer[]): DraftPlayer | null {
  const visible = enemies.filter(e => e.champion_id > 0);
  if (visible.length === 0) return null;
  const pos = (myPos || "").toLowerCase();
  if (pos) {
    const direct = visible.find(e => (e.position || "").toLowerCase() === pos);
    if (direct) return direct;
    // Prefer enemies whose primary champion role matches the lane
    const byPrimary = visible.find(e => getChampRoles(e.champion_id)[0] === pos);
    if (byPrimary) return byPrimary;
    // Fall back to any role match
    const bySecondary = visible.find(e => getChampRoles(e.champion_id).includes(pos as Role));
    if (bySecondary) return bySecondary;
  }
  return visible[0];
}

// Rough estimate when OP.GG has no counter data for a matchup.
// Maps weighted curve deltas into a [38%, 62%] WR range.
function estimateWinRate(myId: number, enemyId: number): number {
  const my = getCurve(myId);
  const en = getCurve(enemyId);
  const earlyDiff = my.early - en.early;
  const midDiff = my.mid - en.mid;
  const lateDiff = my.late - en.late;
  const avg = (earlyDiff + midDiff + lateDiff * 1.1) / 3.1;
  const wr = 0.5 + 0.04 * avg;
  return Math.max(0.38, Math.min(0.62, wr));
}

// --- Level-by-level plan ---

// Smooth curve interpolation using 3 anchor points: lv2=early, lv8=mid, lv15=late
function interpolateCurve(curve: PowerCurve, level: number): number {
  if (level <= 2) return curve.early;
  if (level >= 15) return curve.late;
  if (level <= 8) {
    const t = (level - 2) / 6;
    return curve.early + (curve.mid - curve.early) * t;
  }
  const t = (level - 8) / 7;
  return curve.mid + (curve.late - curve.mid) * t;
}

type PlanCategory = "dominant" | "strong" | "even" | "careful" | "weak" | "hard-weak";

interface LevelPlanEntry {
  level: number;
  advantage: number;         // signed, typically [-3, +3]
  category: PlanCategory;
  action: string;            // 2-3 word headline
  detail: string;            // 1-sentence coach tip
  isSpike: boolean;          // your spike
  isEnemySpike: boolean;     // their spike (warning)
  spikeIcon?: "sword" | "ult" | "crown";
}

function classifyAdvantage(adv: number): PlanCategory {
  if (adv >= 2.2) return "dominant";
  if (adv >= 1.0) return "strong";
  if (adv > -1.0) return "even";
  if (adv > -2.2) return "careful";
  if (adv > -3.5) return "weak";
  return "hard-weak";
}

type PositionRole = "top" | "jungle" | "middle" | "bottom" | "utility" | "unknown";

function normalizePosition(pos?: string): PositionRole {
  if (!pos) return "unknown";
  const p = pos.toLowerCase();
  if (p.startsWith("top")) return "top";
  if (p.startsWith("jun")) return "jungle";
  if (p.startsWith("mid")) return "middle";
  if (p.startsWith("bot") || p === "adc") return "bottom";
  if (p.startsWith("uti") || p.startsWith("sup")) return "utility";
  return "unknown";
}

function evenActionByPhase(level: number, role: PositionRole, bothSpike: boolean): { action: string; detail: string } {
  if (bothSpike) {
    return { action: "Mutual trade", detail: "Both have a spike here — only commit if their cooldowns are out or your jungler is close." };
  }
  if (role === "jungle") {
    if (level <= 3) return { action: "Full clear", detail: "Clean clear to lvl 3 — set up a gank in the lane with prio." };
    if (level <= 5) return { action: "Scuttle + track", detail: "Contest scuttle, track the enemy jungler via wards." };
    if (level === 6) return { action: "Ult ready + obj", detail: "Use ult in the first fight. Set up first dragon/herald." };
    if (level <= 10) return { action: "Obj or dive", detail: "Rotate to objectives. If a lane has prio, look for dives." };
    if (level <= 13) return { action: "Group for obj", detail: "Mid-game: baron, elemental drake, ping team to group." };
    return { action: "Setup fights", detail: "Control vision around the major objective, look for picks first." };
  }
  if (role === "utility") {
    if (level <= 2) return { action: "Pathing + ward", detail: "Tri-bush or river bush by side. Vision control from min 2." };
    if (level === 3) return { action: "First trade", detail: "Both at lvl 3 — look for a short trade if the enemy misses a skill." };
    if (level <= 5) return { action: "Poke + wave", detail: "Safe poke, manage wave to avoid jungle dives." };
    if (level === 6) return { action: "Ults ready", detail: "Everyone has ult — set up coordinated engage with the ADC." };
    if (level <= 8) return { action: "Roam mid", detail: "If the wave is pushed, roam mid to help with ult." };
    if (level <= 10) return { action: "Dragon prep", detail: "Ward river, prep for first dragon. Don't die in vision." };
    if (level === 11) return { action: "Ult rank 2", detail: "Second ult point — look for 5v5 fights around objectives." };
    if (level <= 14) return { action: "Obj vision", detail: "Baron/elemental drake nearby — control pinks + wards." };
    return { action: "Peel teamfight", detail: "Late game: peel for the ADC, react to enemy frontline." };
  }
  // Lane (top / mid / bot carry)
  if (level <= 2) return { action: "Farm safe", detail: "Lvl 1-2 no commitment — respect enemy cooldowns." };
  if (level === 3) return { action: "Lvl 3 spike", detail: "First trade window with full kit. Punish bad positioning." };
  if (level <= 5) return { action: "Farm + prio", detail: "Clean last-hits, win the push to first item if possible." };
  if (level === 6) return { action: "Ult ready", detail: "Both have ult — play reactive until they use theirs first." };
  if (level <= 9) return { action: "Wave + roam", detail: "First item complete — prio wave and look for roams." };
  if (level === 10) return { action: "Item 2 spike", detail: "Reaching second item — major powerspike, look for a window." };
  if (level === 11) return { action: "R rank 2", detail: "Second ult rank + item 2 — force a fight if obj is close." };
  if (level <= 14) return { action: "Group for obj", detail: "Mid-game: group with team for objectives, don't isolate." };
  if (level === 16) return { action: "R rank 3", detail: "Ult maxed. Full build — look for a decisive teamfight." };
  return { action: "Teamfight", detail: "Late game: positioning decides everything. Stay with team." };
}

function actionForLane(level: number, cat: PlanCategory, role: PositionRole, isUltLevel: boolean, yourUltStronger: boolean, bothSpike: boolean): { action: string; detail: string } {
  if (cat === "even") return evenActionByPhase(level, role, bothSpike);

  if (role === "jungle") {
    if (cat === "dominant") {
      if (level <= 3) return { action: "Invade", detail: "Full clear into the enemy side — you have the tempo and stats." };
      if (level <= 6) return { action: "Gank + contest", detail: "Gank the lane with prio, contest scuttle with the lead." };
      if (level <= 10) return { action: "Dive + obj", detail: "Dive towers in lanes ahead, secure dragon." };
      if (level <= 14) return { action: "Force baron", detail: "Control baron vision, force obj — your lead scales." };
      return { action: "Force elder", detail: "Elder/baron — commit, your lead decides late game." };
    }
    if (cat === "strong") {
      if (level <= 3) return { action: "Full clear +", detail: "Fast clear, prio scuttle, set up first gank." };
      if (level <= 5) return { action: "Gank strong side", detail: "Look for ganks in the lane with prio — your tempo is better." };
      if (level === 6) return { action: "Gank with ult", detail: "Use ult to close a gank in the favorable lane." };
      if (level <= 10) return { action: "Rotate to obj", detail: "Prio dragon/herald. Opportunistic ganks when waves are slow." };
      if (level <= 14) return { action: "Setup baron", detail: "Baron vision control, ping team to group." };
      return { action: "Pick + obj", detail: "Late: look for picks before the major objective." };
    }
    if (cat === "careful") {
      if (level <= 3) return { action: "Defensive clear", detail: "Clear without invading — don't give first blood to counter-jungle." };
      if (level <= 6) return { action: "Counter-gank", detail: "Farm + wait for enemy ganks to react." };
      if (level <= 10) return { action: "Track + vision", detail: "Deep wards, track enemy jungler, avoid skirmishes." };
      if (level <= 14) return { action: "Ward obj", detail: "Vision around enemy obj — don't contest without team." };
      return { action: "Peel + flank", detail: "Wait for enemy engage, reactive flank — don't open." };
    }
    if (cat === "weak") {
      if (level <= 6) return { action: "Powerfarm", detail: "Fast clear — don't contest scuttle without prio." };
      if (level <= 10) return { action: "Cede minor obj", detail: "Don't force dragon without team, farm to core items." };
      if (level <= 14) return { action: "Farm + split", detail: "Reach core items, wait for an enemy mistake." };
      return { action: "Reactive picks", detail: "Only fight with numbers advantage or decisive obj." };
    }
    // hard-weak
    if (level <= 10) return { action: "Farm hidden", detail: "Way behind — farm safe jungle, don't die." };
    return { action: "Teamfight only", detail: "Only show up for crucial fights — anywhere else is risk." };
  }

  if (role === "utility") {
    if (cat === "dominant") {
      if (level <= 2) return { action: "Engage lvl 2", detail: "Hit lvl 2 first — look for all-in with your ADC." };
      if (level <= 5) return { action: "All-in bot", detail: "Long trades with the ADC — you dominate this window." };
      if (level === 6) return { action: "ENGAGE + R", detail: "Open with ult — your kit dominates this window." };
      if (level <= 10) return { action: "Roam + pick", detail: "Roam mid after push to force another kill." };
      if (level === 11) return { action: "Force 5v5", detail: "R rank 2 — look for teamfight around the objective." };
      if (level <= 14) return { action: "Open obj", detail: "Initiate fights at dragon/baron — your damage decides." };
      return { action: "Pick teamfight", detail: "Late: pick before fights, leverage frontline." };
    }
    if (cat === "strong") {
      if (level <= 2) return { action: "Poke + wave", detail: "Short trades — you win HP exchanges." };
      if (level <= 5) return { action: "Pressure bot", detail: "Pick or engage when ADC has full cooldowns." };
      if (level === 6) return { action: "Engage with ult", detail: "Lead + ult — coordinated all-in with the ADC." };
      if (level <= 10) return { action: "Roam + vision", detail: "Prio wave and roam mid — control the next objective." };
      if (level === 11) return { action: "Fight obj", detail: "R rank 2 + item — force fight around dragon/herald." };
      if (level <= 14) return { action: "Engage + peel", detail: "Open fights from a safe flank, peel for the carry." };
      return { action: "Pick + peel", detail: "Late: pick before fight, peel backline." };
    }
    if (cat === "careful") {
      if (level <= 2) return { action: "Defensive ward", detail: "Tri-bush or river — don't push into enemy bush." };
      if (level <= 5) return { action: "Protect ADC", detail: "Stay backline, wait for their support to burn CC." };
      if (level === 6) return { action: "Respect their R", detail: "Let them spend ult before committing." };
      if (level <= 10) return { action: "Ward + peel", detail: "Defensive vision, react to enemy engage." };
      if (level <= 14) return { action: "Backline peel", detail: "Behind the carry, engage only reactively." };
      return { action: "Peel teamfight", detail: "Protect the ADC late — don't open fights." };
    }
    if (cat === "weak") {
      if (level <= 5) return { action: "Pure peel", detail: "Don't trade, protect the ADC in lane." };
      if (level <= 10) return { action: "Ward safe", detail: "Defensive wards only, avoid skirmishes." };
      if (level <= 14) return { action: "Kite + peel", detail: "Behind the ADC, react to engage — don't open." };
      return { action: "Peel only", detail: "Your job is keeping the carry alive, not initiating." };
    }
    // hard-weak
    if (level <= 10) return { action: "Ultra-safe", detail: "Defensive wards, cede prio, don't die." };
    return { action: "Pure backline", detail: "Behind the carry, only reactive peel." };
  }

  // Lane (top / mid / bot carry)
  if (cat === "dominant") {
    if (level <= 2) return { action: "Lvl 2 all-in", detail: "Hit lvl 2 first — all-in with stat advantage." };
    if (level === 3) return { action: "Lvl 3 kill", detail: "Full kit — long trade comes out ahead." };
    if (level <= 5) return { action: "Push + trade", detail: "Pressure wave, look for trades up to the item lead." };
    if (level === 6) return { action: isUltLevel && yourUltStronger ? "ALL-IN with R" : "Solokill", detail: isUltLevel && yourUltStronger ? "Your ult wins the 1v1 — commit if their cooldowns are out." : "Look for all-in when their abilities are on cooldown." };
    if (level <= 10) return { action: "Solokill + roam", detail: "Big lead — look for kills, roam mid after push." };
    if (level === 11) return { action: "Force 2v2", detail: "R rank 2 + item — force fight, win the map." };
    if (level <= 14) return { action: "Split or dive", detail: "Push side lane or dive towers if team has the lead." };
    return { action: "End game", detail: "Full build + lead — close out decisive fights." };
  }
  if (cat === "strong") {
    if (level <= 2) return { action: "Lvl 2 spike", detail: "First window — trade with superior stats." };
    if (level === 3) return { action: "Trade lvl 3", detail: "Full kit — punish enemy cooldowns." };
    if (level <= 5) return { action: "Push prio", detail: "Push wave, win first tower if obj is safe." };
    if (level === 6) return { action: "All-in with R", detail: "Lead + ult — force all-in when their cooldowns are out." };
    if (level <= 9) return { action: "Push + roam", detail: "Prio wave, roam mid/jungle with your lead." };
    if (level === 10) return { action: "Item 2 spike", detail: "Second item complete — fight before they get there." };
    if (level === 11) return { action: "R rank 2 + obj", detail: "Force fight around dragon/herald." };
    if (level <= 14) return { action: "Side lane prio", detail: "Push side, rotate to obj when TP is ready." };
    return { action: "Teamfight", detail: "Late: positioning — your lead decides the fight." };
  }
  if (cat === "careful") {
    if (level <= 2) return { action: "Last-hit safe", detail: "No trades — just farm until you have a window." };
    if (level === 3) return { action: "Respect lvl 3", detail: "Their kit + lvl 3 can punish — don't approach." };
    if (level <= 5) return { action: "Defensive farm", detail: "No extended trades. Wait for jungler or their key cooldown." };
    if (level === 6) return { action: "Watch their R", detail: "Respect their ult — play under tower." };
    if (level <= 10) return { action: "Wait for jungler", detail: "Ask for prio, don't reveal cooldowns without help." };
    if (level <= 14) return { action: "Group safe", detail: "Only fight with team, don't isolate." };
    return { action: "Backline + peel", detail: "Play safe, let team initiate." };
  }
  if (cat === "weak") {
    if (level <= 5) return { action: "Freeze + farm", detail: "Freeze near tower, ask for a gank." };
    if (level === 6) return { action: "Avoid their ult", detail: "Don't commit — cede if they threaten." };
    if (level <= 10) return { action: "Farm opposite side", detail: "Farm the wave farthest from them." };
    if (level <= 14) return { action: "Group for obj", detail: "Don't go alone — only fight with numbers favor." };
    return { action: "Peel / kite", detail: "Your opponent dominates — kite at range, play reactive." };
  }
  // hard-weak
  if (level <= 5) return { action: "Freeze + ward", detail: "Deep wards, cede the wave, wait for jungler — don't die." };
  if (level <= 10) return { action: "Cede prio", detail: "Way behind — don't push, don't risk, minimal farm." };
  return { action: "Teamfight only", detail: "Stay out of fights — wait for the team to engage." };
}

function hasStrongUlt(championId: number): boolean {
  // Champions whose ultimate is a definitive fight-winner in the 1v1
  const strongUlts = new Set([
    122, 157, 777, 39, 92, 114, 23, 266, 238, 91, 84, 105, 131, 55, 245, 121, 107, 28,
    54, 555, 7, 4, 246, 64, 76, 60, 11, 19, 67, 96, 29, 30, 45, 222, 18,
    // Mages with decisive ults
    268, 101, 112, 134, 61, 69, 99, 161, 136, 142, 103,
    // Tanks/engage
    89, 12, 111, 57, 31, 516, 113,
    // New additions
    800, 893, 910, 517,
  ]);
  return strongUlts.has(championId);
}

// Level plan doesn't apply to ARAM (no real lane matchup).
// Other rotating modes (Arena, TFT, URF) don't surface this overlay anyway.
function isAramQueue(queueName: string): boolean {
  const q = queueName.toLowerCase();
  return q.includes("aram") || q.includes("howling abyss") || q.includes("all random");
}

// Predict champion respawn delay from the wiki formula:
// BRW (base respawn wait) by level × time factor that ramps after minute 15.
function predictRespawn(level: number, gameTime: number): number {
  const brw = [10, 10, 10, 12, 12, 14, 16, 20, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];
  const idx = Math.max(1, Math.min(18, level));
  const base = brw[idx - 1];
  let factor = 0;
  if (gameTime > 15 * 60) {
    if (gameTime <= 25 * 60) {
      factor = ((gameTime - 15 * 60) / 30) * 0.00425;
    } else {
      factor = 0.1425 + ((gameTime - 25 * 60) / 30) * 0.003;
    }
    factor = Math.min(0.5, factor);
  }
  return base * (1 + factor);
}

function buildLevelPlan(yourId: number, enemyId: number, position?: string): LevelPlanEntry[] {
  const your = getCurve(yourId);
  const enemy = getCurve(enemyId);
  const role = normalizePosition(position);
  const yourUltWins = hasStrongUlt(yourId) && !hasStrongUlt(enemyId);
  const enemyUltWins = hasStrongUlt(enemyId) && !hasStrongUlt(yourId);

  const plan: LevelPlanEntry[] = [];
  for (let level = 1; level <= 18; level++) {
    const base = interpolateCurve(your, level) - interpolateCurve(enemy, level);
    const yourSpike = your.spikes.includes(level);
    const enemySpike = enemy.spikes.includes(level);
    const bothSpike = yourSpike && enemySpike;
    let advantage = base;
    if (yourSpike) advantage += 1.3;
    if (enemySpike) advantage -= 1.3;
    const isUlt = level === 6 || level === 11 || level === 16;
    if (isUlt) {
      if (yourUltWins) advantage += 0.8;
      if (enemyUltWins) advantage -= 0.8;
    }
    const cat = classifyAdvantage(advantage);
    const { action, detail } = actionForLane(level, cat, role, isUlt, yourUltWins, bothSpike);

    let spikeIcon: LevelPlanEntry["spikeIcon"] | undefined;
    if (isUlt && yourUltWins) spikeIcon = "ult";
    else if (yourSpike) spikeIcon = "sword";
    else if (level === 16) spikeIcon = "crown";

    plan.push({
      level,
      advantage: Math.round(advantage * 10) / 10,
      category: cat,
      action,
      detail,
      isSpike: yourSpike,
      isEnemySpike: enemySpike && !yourSpike,
      spikeIcon: yourSpike ? spikeIcon : (enemySpike ? "sword" : spikeIcon),
    });
  }
  return plan;
}

interface MatchupPhase { range: string; advantage: "you" | "enemy" | "even"; tip: string; }

function analyzeMatchup(myId: number, enemyId: number, counterWr?: number): { phases: MatchupPhase[]; summary: string } {
  const my = getCurve(myId);
  const en = getCurve(enemyId);
  const myName = championCache?.[myId.toString()]?.name || "You";
  const enName = championCache?.[enemyId.toString()]?.name || "Enemy";

  const phases: MatchupPhase[] = [];

  // Early (1-5)
  const earlyDiff = my.early - en.early;
  if (earlyDiff >= 2) phases.push({ range: "Lv 1-5", advantage: "you", tip: `${myName} dominates early — play aggressive` });
  else if (earlyDiff <= -2) phases.push({ range: "Lv 1-5", advantage: "enemy", tip: `${enName} is stronger early — farm safely` });
  else if (earlyDiff >= 1) phases.push({ range: "Lv 1-5", advantage: "you", tip: "Slight early advantage — look for trades" });
  else if (earlyDiff <= -1) phases.push({ range: "Lv 1-5", advantage: "enemy", tip: "Slight early disadvantage — trade carefully" });
  else phases.push({ range: "Lv 1-5", advantage: "even", tip: "Even early — skill matchup" });

  // Level 6 spike check
  const myHas6 = my.spikes.includes(6);
  const enHas6 = en.spikes.includes(6);
  if (myHas6 && !enHas6) phases.push({ range: "Lv 6", advantage: "you", tip: `${myName} power spike — look for all-in` });
  else if (!myHas6 && enHas6) phases.push({ range: "Lv 6", advantage: "enemy", tip: `${enName} power spike — respect ult` });

  // Mid (6-11)
  const midDiff = my.mid - en.mid;
  if (midDiff >= 2) phases.push({ range: "Lv 6-11", advantage: "you", tip: "Strong mid game — roam and skirmish" });
  else if (midDiff <= -2) phases.push({ range: "Lv 6-11", advantage: "enemy", tip: "Enemy stronger mid game — avoid solo fights" });
  else if (Math.abs(midDiff) <= 0) phases.push({ range: "Lv 6-11", advantage: "even", tip: "Even mid game — focus on objectives" });

  // Late (16+)
  const lateDiff = my.late - en.late;
  if (lateDiff >= 2) phases.push({ range: "Late", advantage: "you", tip: `${myName} outscales — play for late` });
  else if (lateDiff <= -2) phases.push({ range: "Late", advantage: "enemy", tip: `${enName} outscales — end early` });

  // Summary
  let summary = "";
  if (my.late >= 4 && en.late <= 2) summary = "You outscale — survive early, win late";
  else if (en.late >= 4 && my.late <= 2) summary = "Enemy outscales — press your lead early";
  else if (my.early >= 4 && en.early <= 2) summary = "You win early — snowball your advantage";
  else if (counterWr && counterWr > 0.53) summary = "Favorable matchup — play confidently";
  else if (counterWr && counterWr < 0.47) summary = "Unfavorable matchup — play safe and outfarm";
  else summary = "Skill matchup — punish mistakes";

  return { phases, summary };
}

// --- Win probability model ---
// Logistic curve calibrated from League analytics:
// gold_diff is the dominant predictor (~80% of signal)
// Adjusted by game time (early gold matters more) and objectives
function estimateWinProbability(
  goldDiff: number,
  gameTimeSecs: number,
  allyDragons: number,
  enemyDragons: number,
  allyBaronActive: boolean,
  enemyBaronActive: boolean,
): number {
  const mins = Math.max(gameTimeSecs / 60, 1);

  // Gold advantage decays in impact over time (early leads matter more)
  // At 10min, 1000g = ~6% swing. At 30min, 1000g = ~3% swing
  const timeDecay = Math.max(0.3, 1.0 - (mins - 10) * 0.02);
  const goldFactor = (goldDiff / 1000) * 0.06 * timeDecay;

  // Dragon advantage: each dragon ≈ 2% swing, soul (4+) = extra 5%
  const dragonDiff = allyDragons - enemyDragons;
  const dragonFactor = dragonDiff * 0.02 + (allyDragons >= 4 ? 0.05 : 0) - (enemyDragons >= 4 ? 0.05 : 0);

  // Baron buff: ~8% swing while active
  const baronFactor = (allyBaronActive ? 0.08 : 0) - (enemyBaronActive ? 0.08 : 0);

  // Combine into logistic
  const z = goldFactor + dragonFactor + baronFactor;
  return 1 / (1 + Math.exp(-z * 10)); // scale for sharper curve
}

// --- Upcoming objective spawn windows ---
type ObjectiveKind = "dragon" | "baron" | "voidgrubs" | "herald";
interface ObjectiveSpawn {
  kind: ObjectiveKind;
  label: string;
  eta: number;          // seconds until spawn (negative if spawned)
  spawnTime: number;    // absolute spawn time (game seconds)
  lastTeam?: "ally" | "enemy" | null;  // who took last instance (if any)
}

// Returns upcoming spawn windows sorted by ETA. Includes objectives whose ETA
// is within ±15s of "spawned" (so we can flash a "LIVE" chip briefly).
// Timings reflect Season 2026 patch:
//   - Dragon: first 5:00, respawn 5:00 after kill
//   - Voidgrubs: first 8:00, single spawn, despawn at 14:45
//   - Rift Herald: first 15:00, single spawn, despawn at 19:45
//   - Baron Nashor: first 20:00, respawn 6:00 after kill
function computeObjectiveSpawns(events: GameEvent[], gameTime: number): ObjectiveSpawn[] {
  const out: ObjectiveSpawn[] = [];

  // Dragon
  const dragonKills = events.filter(e => e.event_type === "DragonKill" && !e.label.includes("Elder"));
  const elderKills = events.filter(e => e.event_type === "DragonKill" && e.label.includes("Elder"));
  if (dragonKills.length === 0) {
    out.push({ kind: "dragon", label: "Drake", eta: 300 - gameTime, spawnTime: 300 });
  } else {
    const last = dragonKills[dragonKills.length - 1];
    const team = last.label.startsWith("Ally") ? "ally" : last.label.startsWith("Enemy") ? "enemy" : null;
    const isElderTime = dragonKills.length >= 4 || elderKills.length > 0;
    out.push({
      kind: "dragon",
      label: isElderTime ? "Elder" : "Drake",
      eta: last.time + 300 - gameTime,
      spawnTime: last.time + 300,
      lastTeam: team,
    });
  }

  // Baron: first 20:00, respawn 6:00 after kill
  const baronKills = events.filter(e => e.event_type === "BaronKill");
  if (baronKills.length === 0) {
    if (gameTime < 1200 + 60) {
      out.push({ kind: "baron", label: "Baron", eta: 1200 - gameTime, spawnTime: 1200 });
    }
  } else {
    const last = baronKills[baronKills.length - 1];
    const team = last.label.startsWith("Ally") ? "ally" : last.label.startsWith("Enemy") ? "enemy" : null;
    out.push({
      kind: "baron",
      label: "Baron",
      eta: last.time + 360 - gameTime,
      spawnTime: last.time + 360,
      lastTeam: team,
    });
  }

  // Voidgrubs: single spawn at 8:00, despawn at 14:45 (only show window before despawn).
  // We don't have a Voidgrub kill event from the live client — suppress once gameTime > 14:45.
  if (gameTime < 885) {
    const eta = 480 - gameTime;
    if (eta > -15) {
      out.push({ kind: "voidgrubs", label: "Voidgrubs", eta, spawnTime: 480 });
    }
  }

  // Rift Herald: single spawn at 15:00, despawn at 19:45.
  const heraldKills = events.filter(e => e.event_type === "HeraldKill");
  if (heraldKills.length === 0 && gameTime < 1185) {
    const eta = 900 - gameTime;
    if (eta > -15) {
      out.push({ kind: "herald", label: "Herald", eta, spawnTime: 900 });
    }
  }

  return out
    .filter(o => o.eta > -15 && o.eta < 600)
    .sort((a, b) => a.eta - b.eta);
}

function getObjectiveState(events: GameEvent[], gameTime: number) {
  let allyDragons = 0, enemyDragons = 0;
  let allyBaronActive = false, enemyBaronActive = false;
  for (const ev of events) {
    if (ev.event_type === "DragonKill") {
      if (ev.label.startsWith("Ally")) allyDragons++; else enemyDragons++;
    }
    if (ev.event_type === "BaronKill") {
      const remaining = 180 - (gameTime - ev.time);
      if (remaining > 0) {
        if (ev.label.startsWith("Ally")) allyBaronActive = true; else enemyBaronActive = true;
      }
    }
  }
  return { allyDragons, enemyDragons, allyBaronActive, enemyBaronActive };
}

function positionIconUrl(pos: string): string {
  const key = POSITION_ICON_KEYS[pos] || POSITION_ICON_KEYS[pos.toLowerCase()];
  return key ? `${POS_ICON_BASE}position-${key}.svg` : "";
}

const SKILL_COLORS: Record<string, string> = {
  Q: "#4fc3f7", W: "#81c784", E: "#ffb74d", R: "#ef5350",
};

const STAT_SHARDS: Record<number, { name: string; icon: string }> = {
  5001: { name: "Health Scaling", icon: "statmodshealthscalingicon.png" },
  5002: { name: "Armor", icon: "statmodsarmoricon.png" },
  5003: { name: "Magic Resist", icon: "statmodsmagicresicon.png" },
  5005: { name: "Attack Speed", icon: "statmodsattackspeedicon.png" },
  5007: { name: "Ability Haste", icon: "statmodscdrscalingicon.png" },
  5008: { name: "Adaptive Force", icon: "statmodsadaptiveforceicon.png" },
  5010: { name: "Move Speed", icon: "statmodsmovementspeedicon.png" },
  5011: { name: "Health", icon: "statmodshealthplusicon.png" },
  5013: { name: "Tenacity", icon: "statmodstenacityicon.png" },
};

const SHARD_ICON_BASE = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perk-images/statmods/";

// --- Data Dragon cache ---

interface RuneData { id: number; name: string; icon: string; shortDesc: string; }
interface ItemData { name: string; description: string; plaintext: string; gold: number; }

let championCache: Record<string, { key: string; name: string }> | null = null;
let runeCache: Map<number, RuneData> | null = null;
let runeStyleCache: Map<number, { name: string; icon: string }> | null = null;
let itemCache: Record<string, ItemData> | null = null;

async function loadChampionData() {
  if (championCache) return championCache;
  try {
    const resp = await fetch(`${DDRAGON}/${DDRAGON_VERSION}/data/en_US/champion.json`);
    const json = await resp.json();
    const byId: Record<string, { key: string; name: string }> = {};
    for (const champ of Object.values(json.data) as any[]) {
      byId[champ.key] = { key: champ.id, name: champ.name };
    }
    championCache = byId;
    return byId;
  } catch { return {}; }
}

async function loadRuneData() {
  if (runeCache && runeStyleCache) return;
  try {
    const resp = await fetch(`${DDRAGON}/${DDRAGON_VERSION}/data/en_US/runesReforged.json`);
    const styles = await resp.json();
    runeCache = new Map();
    runeStyleCache = new Map();
    for (const style of styles) {
      runeStyleCache.set(style.id, { name: style.name, icon: style.icon });
      for (const slot of style.slots) {
        for (const rune of slot.runes) {
          runeCache.set(rune.id, { id: rune.id, name: rune.name, icon: rune.icon, shortDesc: rune.shortDesc || "" });
        }
      }
    }
  } catch {}
}

async function loadItemData() {
  if (itemCache) return itemCache;
  try {
    const resp = await fetch(`${DDRAGON}/${DDRAGON_VERSION}/data/en_US/item.json`);
    const json = await resp.json();
    const byId: Record<string, ItemData> = {};
    for (const [id, item] of Object.entries(json.data) as any[]) {
      byId[id] = { name: item.name, description: item.description || "", plaintext: item.plaintext || "", gold: item.gold?.total || 0 };
    }
    itemCache = byId;
    return byId;
  } catch { return {}; }
}

function getItemData(id: number): ItemData | null {
  return itemCache?.[id.toString()] || null;
}

// --- Build sequence helper ---
type BuildSlotState = "owned" | "next" | "future";
type BuildSlotCategory = "starter" | "boots" | "core";
interface BuildSlot {
  id: number;
  name: string;
  goldCost: number;
  state: BuildSlotState;
  category: BuildSlotCategory;
  progressPct?: number;  // 0-100 when state === "next"
  goldNeeded?: number;   // remaining gold when state === "next"
}

// Builds the ordered display sequence: boots + core items (up to 4).
// Starter is omitted — it's a transient phase-0 buy. Boots[0] is treated as
// the typical primary boot pick. Core items keep OP.GG order.
function computeBuildSequence(
  build: ChampionBuild | null | undefined,
  ownedItems: number[],
  currentGold: number,
): BuildSlot[] {
  if (!build) return [];
  const slots: { id: number; category: BuildSlotCategory }[] = [];
  if (build.boots[0]) slots.push({ id: build.boots[0], category: "boots" });
  for (const id of build.core_items.slice(0, 4)) {
    slots.push({ id, category: "core" });
  }
  const owned = new Set(ownedItems);
  let nextAssigned = false;
  return slots.map(s => {
    const item = getItemData(s.id);
    const name = item?.name ?? "";
    const goldCost = item?.gold ?? 0;
    let state: BuildSlotState;
    if (owned.has(s.id)) {
      state = "owned";
    } else if (!nextAssigned) {
      state = "next";
      nextAssigned = true;
    } else {
      state = "future";
    }
    const out: BuildSlot = { id: s.id, name, goldCost, state, category: s.category };
    if (state === "next" && goldCost > 0) {
      const need = Math.max(0, goldCost - currentGold);
      out.goldNeeded = Math.ceil(need);
      out.progressPct = Math.min(100, Math.round((currentGold / goldCost) * 100));
    }
    return out;
  });
}

// --- Threat-response suggestion ---
// Given enemy live stats + my role + my owned items, suggest one situational
// defensive item that addresses the dominant threat. Returns null if none.

type ThreatKind = "antiheal" | "mr-squishy" | "mr-bruiser" | "armor-squishy" | "armor-bruiser" | "tenacity" | "anti-shield";
interface ThreatSuggestion {
  kind: ThreatKind;
  itemId: number;
  itemName: string;
  reason: string;
  topEnemyChamp?: string;
}

// Item DB for situational pick by role/profile.
// Squishy = ADC / mage. Bruiser = top/jungle fighter / tank.
const THREAT_ITEMS = {
  antiheal_ad: { id: 3033, name: "Mortal Reminder" },
  antiheal_ap: { id: 3165, name: "Morellonomicon" },
  antiheal_sup: { id: 3011, name: "Chemtech Putrifier" },
  mr_squishy_ad: { id: 3156, name: "Maw of Malmortius" },
  mr_squishy_ap: { id: 4645, name: "Shadowflame" },
  mr_squishy_generic: { id: 3814, name: "Edge of Night" },
  mr_bruiser: { id: 4401, name: "Force of Nature" },
  mr_tank: { id: 3065, name: "Spirit Visage" },
  mr_aphunt: { id: 6035, name: "Silvermere Dawn" },
  armor_squishy: { id: 3814, name: "Edge of Night" },
  armor_squishy_ad: { id: 3026, name: "Guardian Angel" },
  armor_bruiser: { id: 3143, name: "Randuin's Omen" },
  armor_tank: { id: 3110, name: "Frozen Heart" },
  armor_thorns: { id: 3075, name: "Thornmail" },
  tenacity_boots: { id: 3111, name: "Mercury's Treads" },
  tenacity_squishy: { id: 6035, name: "Silvermere Dawn" },
  anti_shield: { id: 6609, name: "Serpent's Fang" },
};

// Items the user might already own that satisfy a threat category.
// Used to skip suggestions when player already has coverage.
const OWNED_COVERAGE: Record<ThreatKind, number[]> = {
  "antiheal": [3033, 3165, 3011, 6664, 6675, 8001 /* Executioner's */ , 3123, 3036],
  "mr-squishy": [3156, 4645, 3814, 6035, 3157 /* Zhonya — counts as panic but not MR */],
  "mr-bruiser": [4401, 3065, 3001 /* Abyssal Mask */, 3194 /* Adaptive Helm */, 6035],
  "armor-squishy": [3026, 3814, 3047, 6035],
  "armor-bruiser": [3143, 3110, 3075, 3742 /* Dead Man's */, 3193 /* Gargoyle */],
  "tenacity": [3111, 6035, 3742, 3194],
  "anti-shield": [6609],
};

function isCarryRole(pos: string): boolean {
  const p = pos.toLowerCase();
  return p.startsWith("bot") || p.startsWith("ad") || p.startsWith("mid");
}
function isBruiserRole(pos: string): boolean {
  const p = pos.toLowerCase();
  return p.startsWith("top") || p.startsWith("jun");
}
function isSupportRole(pos: string): boolean {
  const p = pos.toLowerCase();
  return p.startsWith("uti") || p.startsWith("sup");
}

function suggestThreatResponse(
  enemies: LiveGamePlayer[],
  myItems: number[],
  myPosition: string,
  myChampionId: number,
  gameTime: number,
): ThreatSuggestion | null {
  if (gameTime < 8 * 60) return null;
  const enemiesWithLive = enemies.filter(e => e.live != null);
  if (enemiesWithLive.length < 3) return null;
  const owned = new Set(myItems);

  // Threat score per enemy: weighted KDA × level. Caps at level/18 = 1.
  const scored = enemiesWithLive.map(e => {
    const l = e.live!;
    const kda = l.kills + l.assists * 0.5 - l.deaths * 0.6;
    const lvlFactor = 0.5 + (l.level / 18) * 0.5;
    const goldFactor = Math.max(0.5, Math.min(1.6, l.total_gold / Math.max(1, gameTime / 60 * 380)));
    return { player: e, score: Math.max(0.1, kda * lvlFactor * goldFactor), apMain: CHAMP_DAMAGE_TYPE[e.champion_id] === "ap" };
  });
  const totalScore = scored.reduce((a, b) => a + b.score, 0) || 1;
  const apThreat = scored.filter(s => s.apMain).reduce((a, b) => a + b.score, 0) / totalScore;
  const adThreat = 1 - apThreat;
  const topEnemy = scored.slice().sort((a, b) => b.score - a.score)[0];
  const topEnemyName = championCache?.[topEnemy.player.champion_id.toString()]?.name || "enemy";

  // 1) Antiheal — high priority, needed once enemies have items
  const healers = enemies.filter(e => TRAIT_HEALERS.has(e.champion_id));
  if (healers.length >= 1 && !owned.has(THREAT_ITEMS.antiheal_ad.id)
    && !OWNED_COVERAGE.antiheal.some(id => owned.has(id))) {
    const myIsAp = CHAMP_DAMAGE_TYPE[myChampionId] === "ap";
    const isSup = isSupportRole(myPosition);
    const pick = isSup ? THREAT_ITEMS.antiheal_sup : (myIsAp ? THREAT_ITEMS.antiheal_ap : THREAT_ITEMS.antiheal_ad);
    const names = healers.slice(0, 2).map(e => championCache?.[e.champion_id.toString()]?.name || "?").join(", ");
    return { kind: "antiheal", itemId: pick.id, itemName: pick.name, reason: `Heavy healing (${names})` };
  }

  // 2) Heavy AP threat
  if (apThreat >= 0.55 && !OWNED_COVERAGE["mr-squishy"].some(id => owned.has(id))
    && !OWNED_COVERAGE["mr-bruiser"].some(id => owned.has(id))) {
    let pick;
    if (isCarryRole(myPosition)) {
      pick = CHAMP_DAMAGE_TYPE[myChampionId] === "ap" ? THREAT_ITEMS.mr_squishy_ap : THREAT_ITEMS.mr_squishy_ad;
    } else if (isBruiserRole(myPosition)) {
      pick = THREAT_ITEMS.mr_bruiser;
    } else {
      pick = THREAT_ITEMS.mr_squishy_generic;
    }
    const kind = isBruiserRole(myPosition) ? "mr-bruiser" : "mr-squishy";
    return {
      kind: kind as ThreatKind,
      itemId: pick.id, itemName: pick.name,
      reason: `${Math.round(apThreat * 100)}% AP threat · ${topEnemyName} carrying`,
      topEnemyChamp: topEnemyName,
    };
  }

  // 3) Heavy AD threat
  if (adThreat >= 0.65 && !OWNED_COVERAGE["armor-squishy"].some(id => owned.has(id))
    && !OWNED_COVERAGE["armor-bruiser"].some(id => owned.has(id))) {
    let pick;
    if (isCarryRole(myPosition)) {
      pick = CHAMP_DAMAGE_TYPE[myChampionId] === "ap" ? THREAT_ITEMS.armor_squishy : THREAT_ITEMS.armor_squishy_ad;
    } else if (isBruiserRole(myPosition)) {
      pick = THREAT_ITEMS.armor_bruiser;
    } else {
      pick = THREAT_ITEMS.armor_squishy;
    }
    const kind = isBruiserRole(myPosition) ? "armor-bruiser" : "armor-squishy";
    return {
      kind: kind as ThreatKind,
      itemId: pick.id, itemName: pick.name,
      reason: `${Math.round(adThreat * 100)}% AD threat · ${topEnemyName} carrying`,
      topEnemyChamp: topEnemyName,
    };
  }

  // 4) Heavy hard CC
  const ccCount = enemies.filter(e => TRAIT_HARD_CC.has(e.champion_id)).length;
  if (ccCount >= 3 && !OWNED_COVERAGE.tenacity.some(id => owned.has(id))) {
    return {
      kind: "tenacity",
      itemId: THREAT_ITEMS.tenacity_boots.id,
      itemName: THREAT_ITEMS.tenacity_boots.name,
      reason: `${ccCount} hard-CC champs — get tenacity`,
    };
  }

  // 5) Heavy shielding
  const shielders = enemies.filter(e => TRAIT_SHIELDERS.has(e.champion_id)).length;
  if (shielders >= 2 && !owned.has(THREAT_ITEMS.anti_shield.id)
    && (isCarryRole(myPosition) || isSupportRole(myPosition))) {
    return {
      kind: "anti-shield",
      itemId: THREAT_ITEMS.anti_shield.id,
      itemName: THREAT_ITEMS.anti_shield.name,
      reason: `${shielders} shielders enemy team`,
    };
  }

  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function splashUrl(championKey: string): string {
  return `${DDRAGON}/img/champion/splash/${championKey}_0.jpg`;
}

function rankEmblemUrl(tier: string): string {
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/${tier.toLowerCase()}.png`;
}

function runeIconUrl(iconPath: string): string { return `${DDRAGON}/img/${iconPath}`; }
function championIconUrl(key: string): string { return `${DDRAGON}/${DDRAGON_VERSION}/img/champion/${key}.png`; }
function spellIconUrl(id: number): string { const k = SPELL_KEYS[id]; return k ? `${DDRAGON}/${DDRAGON_VERSION}/img/spell/${k}.png` : ""; }
function itemIconUrl(id: number): string { return `${DDRAGON}/${DDRAGON_VERSION}/img/item/${id}.png`; }

function useChampionName(id: number | null): { key: string; name: string } | null {
  const [info, setInfo] = useState<{ key: string; name: string } | null>(null);
  useEffect(() => {
    if (id && id > 0) {
      loadChampionData().then(d => setInfo(d[id.toString()] || null));
    } else {
      setInfo(null);
    }
  }, [id]);
  return info;
}

// --- Tooltip Components ---

function Tooltip({ children, content }: { children: React.ReactNode; content: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);

  function handleEnter(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.top });
    setShow(true);
  }

  return (
    <div className="tt-wrap" ref={ref} onMouseEnter={handleEnter} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div className="tt-box" style={{ left: pos.x, top: pos.y }}>
          {content}
        </div>
      )}
    </div>
  );
}

function ItemIcon({ id, size = 32, className }: { id: number; size?: number; className?: string }) {
  const item = getItemData(id);
  const img = <img src={itemIconUrl(id)} alt={item?.name || ""} style={{ width: size, height: size }} className={className} />;
  if (!item) return img;
  return (
    <Tooltip content={
      <div className="tt-item">
        <span className="tt-name">{item.name}</span>
        {item.gold > 0 && <span className="tt-gold">{item.gold}g</span>}
        {item.plaintext && <p className="tt-desc">{item.plaintext}</p>}
        {!item.plaintext && item.description && <p className="tt-desc">{stripHtml(item.description)}</p>}
      </div>
    }>
      {img}
    </Tooltip>
  );
}

function BuildSequencePanel({ slots, nextSlot, currentGold, threat, alternatives, currentCoreIds }: {
  slots: BuildSlot[];
  nextSlot: BuildSlot | undefined;
  currentGold: number;
  threat?: ThreatSuggestion | null;
  alternatives?: ItemOption[];
  currentCoreIds?: number[];
}) {
  // Top-3 alternative core paths sorted by WR, hide options matching the current build exactly.
  const currentSig = (currentCoreIds ?? []).slice(0, 3).join(",");
  const altList = (alternatives ?? [])
    .filter(a => a.games >= 50)
    .map(a => ({ ...a, sig: a.ids.slice(0, 3).join(",") }))
    .sort((a, b) => b.win_rate - a.win_rate)
    .slice(0, 4);
  const visibleAlts = altList.filter(a => a.sig !== currentSig).slice(0, 3);
  return (
    <div className="bs-panel">
      <div className="bs-header">
        <span className="bs-title">RECOMMENDED BUILD</span>
        <span className="bs-gold">{Math.round(currentGold).toLocaleString()}g</span>
      </div>
      <div className="bs-strip">
        {slots.map((slot, i) => (
          <div key={slot.id + "_" + i} className={`bs-slot bs-slot-${slot.state} bs-slot-${slot.category}`}>
            <div className="bs-icon-wrap">
              <img src={itemIconUrl(slot.id)} alt={slot.name} className="bs-icon" />
              {slot.state === "owned" && <span className="bs-check">✓</span>}
              {slot.state === "next" && (
                <span className="bs-progress-ring" style={{ background: `conic-gradient(var(--accent-gold) ${(slot.progressPct ?? 0) * 3.6}deg, transparent 0deg)` }} />
              )}
            </div>
            <span className="bs-name" title={slot.name}>{slot.name || `#${slot.id}`}</span>
            {slot.state === "next" && slot.goldNeeded != null && slot.goldNeeded > 0 && (
              <span className="bs-need">{slot.goldNeeded}g</span>
            )}
            {slot.state === "next" && slot.goldNeeded === 0 && (
              <span className="bs-ready">READY</span>
            )}
          </div>
        ))}
      </div>
      {nextSlot && nextSlot.goldCost > 0 && (
        <div className="bs-progress-bar-wrap">
          <div className="bs-progress-bar" style={{ width: `${nextSlot.progressPct ?? 0}%` }} />
        </div>
      )}
      {threat && (
        <div className={`bs-threat bs-threat-${threat.kind}`}>
          <img src={itemIconUrl(threat.itemId)} alt={threat.itemName} className="bs-threat-icon" />
          <div className="bs-threat-text">
            <span className="bs-threat-label">CONSIDER · {threat.itemName}</span>
            <span className="bs-threat-reason">{threat.reason}</span>
          </div>
        </div>
      )}
      {visibleAlts.length > 0 && (
        <div className="bs-alts">
          <span className="bs-alts-label">ALT PATHS</span>
          <div className="bs-alts-list">
            {visibleAlts.map((alt, i) => (
              <div key={i} className="bs-alt">
                <div className="bs-alt-icons">
                  {alt.ids.slice(0, 3).map((id, j) => (
                    <img key={j} src={itemIconUrl(id)} alt="" className="bs-alt-icon" title={getItemData(id)?.name} />
                  ))}
                </div>
                <div className="bs-alt-meta">
                  <span className={`bs-alt-wr ${alt.win_rate >= 0.52 ? "bs-alt-wr-good" : alt.win_rate < 0.48 ? "bs-alt-wr-bad" : ""}`}>
                    {(alt.win_rate * 100).toFixed(1)}%
                  </span>
                  <span className="bs-alt-games">{alt.games >= 1000 ? `${(alt.games / 1000).toFixed(1)}k` : alt.games}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RuneIcon({ id, size = 28 }: { id: number; size?: number }) {
  const rune = runeCache?.get(id);
  if (!rune) return <span className="rune-id">{id}</span>;
  const img = <img src={runeIconUrl(rune.icon)} alt={rune.name} style={{ width: size, height: size }} />;
  return (
    <Tooltip content={
      <div className="tt-item">
        <span className="tt-name">{rune.name}</span>
        {rune.shortDesc && <p className="tt-desc">{stripHtml(rune.shortDesc)}</p>}
      </div>
    }>
      {img}
    </Tooltip>
  );
}

// --- Components ---

function PositionIcon({ pos, size = 14 }: { pos: string; size?: number }) {
  const url = positionIconUrl(pos);
  if (!url) return null;
  const label = POSITION_LABELS[pos] || POSITION_LABELS[pos.toLowerCase()] || pos;
  return <img src={url} alt={label} className="pos-icon" style={{ width: size, height: size }} title={label} />;
}

function RankEmblem({ rank, size = 20 }: { rank: string; size?: number }) {
  if (!rank) return null;
  const tier = rank.split(' ')[0]?.toLowerCase();
  if (!tier || tier === 'unranked' || tier === 'none') return null;
  return (
    <img
      src={rankEmblemUrl(tier)}
      alt={rank}
      title={rank}
      className="rank-emblem"
      style={{ width: size, height: size }}
    />
  );
}

function ChampionIcon({ championId, size = 36, className = "" }: { championId: number; size?: number; className?: string }) {
  const info = useChampionName(championId);
  if (!info || championId <= 0) {
    return <div className={`champ-icon-empty ${className}`} style={{ width: size, height: size }} />;
  }
  return (
    <img
      src={championIconUrl(info.key)}
      alt={info.name}
      title={info.name}
      className={`champ-icon ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

function App() {
  const [state, setState] = useState<AppState>({
    status: "disconnected", summoner_name: null, champion_id: null,
    champion_name: null, assigned_position: null, build: null,
    build_alternatives: null, counters: {},
    draft: null, ranked: null, lp_history: [], ban_suggestions: [], comfort_picks: [], prediction: null,
    match_history: [], live_game: null, post_game: null,
    game_mode: "classic", aram_bench: [], recommendations: [], ban_phase_active: false,
    auto_apply: true, auto_lock: false, auto_accept: false, tts_enabled: false, region: "euw",
  });
  const [runesLoaded, setRunesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playerProfile, setPlayerProfile] = useState<{ name: string; rank: string; matches: MatchHistoryEntry[] } | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; update: Awaited<ReturnType<typeof check>> } | null>(null);
  const [updating, setUpdating] = useState(false);
  const errorTimeout = useRef<number | null>(null);

  const championInfo = useChampionName(state.champion_id);

  useEffect(() => {
    invoke<AppState>("get_state").then(setState);
    fetchLatestVersion().then(() => {
      loadChampionData();
      loadRuneData().then(() => setRunesLoaded(true));
      loadItemData();
    });
    const unlisten = listen<AppState>("app-state-changed", (e) => setState(e.payload));
    // Check for updates
    check().then(update => {
      if (update) setUpdateAvailable({ version: update.version, update });
    }).catch(() => {});
    return () => { unlisten.then(fn => fn()); };
  }, []);

  function showError(msg: string) {
    setError(msg);
    if (errorTimeout.current) clearTimeout(errorTimeout.current);
    errorTimeout.current = window.setTimeout(() => setError(null), 5000);
  }

  async function viewPlayer(puuid: string) {
    if (!puuid || profileLoading) return;
    setProfileLoading(true);
    try {
      const profile = await invoke<{ name: string; rank: string; matches: MatchHistoryEntry[] }>("view_player_profile", { puuid });
      setPlayerProfile(profile);
    } catch (e: any) { showError(String(e)); }
    setProfileLoading(false);
  }

  async function handleApply() {
    try { await invoke("apply_build_now"); } catch (e: any) { showError(String(e)); }
  }

  async function handleUpdate() {
    if (!updateAvailable?.update) return;
    setUpdating(true);
    try {
      await updateAvailable.update.downloadAndInstall();
      await relaunch();
    } catch (e: any) {
      showError(`Update failed: ${String(e)}`);
      setUpdating(false);
    }
  }

  const isConnected = state.status !== "disconnected";
  const inChampSelect = state.status === "champ_select";
  const inGame = state.status === "in_game";
  const inPostGame = state.status === "post_game";
  const hasChampion = state.champion_id && state.champion_id > 0 && championInfo;
  const hasBuild = state.build;

  return (
    <main className="app">
      {updateAvailable && (
        <div className="update-banner">
          <span>v{updateAvailable.version} available</span>
          <button onClick={handleUpdate} disabled={updating} className="update-btn">
            {updating ? "Updating..." : "Update & Restart"}
          </button>
        </div>
      )}
      {/* Header */}
      <header className="header" data-tauri-drag-region>
        <div className="header-left">
          <div className="logo">Q</div>
          <span className="app-title">QueryLoL</span>
        </div>
        <div className="header-right">
          <span className={`status-dot status-${state.status}`} />
          {isConnected && state.summoner_name && (
            <span className="summoner-name">{state.summoner_name}</span>
          )}
          {isConnected && state.ranked && state.ranked.tier !== "UNRANKED" && (
            <span className={`ranked-badge rank-${state.ranked.tier.toLowerCase()}`}>
              <RankEmblem rank={state.ranked.tier} size={18} />
              {state.ranked.tier} {state.ranked.rank} &middot; {state.ranked.lp} LP
            </span>
          )}
        </div>
      </header>

      {/* Disconnected - waiting for LoL client */}
      {!isConnected && (
        <section className="section-connect">
          <div className="connect-card">
            <div className="hero-logo">Q</div>
            <h1 className="hero-title">QueryLoL</h1>
            <p className="hero-subtitle">Auto-builds &middot; Counters &middot; Pick recommendations</p>

            <div className="scanning-indicator">
              <div className="scanning-dot" />
              <span className="scanning-text">Scanning for League Client</span>
            </div>

            <div className="connect-controls">
              <select className="select" value={state.region}
                onChange={(e) => invoke("set_region", { region: e.target.value })}>
                {REGIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>

            <div className="hero-features">
              <div className="hero-feature">
                <svg className="hero-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span>Optimal runes, spells &amp; items — auto-applied</span>
              </div>
              <div className="hero-feature">
                <svg className="hero-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <span>Counter-based pick &amp; ban suggestions</span>
              </div>
              <div className="hero-feature">
                <svg className="hero-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span>Post-game analysis with MVP &amp; stats</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Toolbar */}
      {isConnected && (
        <div className="toolbar">
          <select className="select select-sm" value={state.region}
            onChange={(e) => invoke("set_region", { region: e.target.value })}>
            {REGIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <div className="toolbar-toggles">
            <label className="toggle-label">
              <input type="checkbox" checked={state.auto_apply}
                onChange={() => invoke("set_auto_apply", { enabled: !state.auto_apply })} />
              <span className="toggle-slider" />
              Auto-apply
            </label>
            <label className="toggle-label">
              <input type="checkbox" checked={state.auto_lock}
                onChange={() => invoke("set_auto_lock", { enabled: !state.auto_lock })} />
              <span className="toggle-slider" />
              Auto-lock
            </label>
            <label className="toggle-label">
              <input type="checkbox" checked={state.auto_accept}
                onChange={() => invoke("set_auto_accept", { enabled: !state.auto_accept })} />
              <span className="toggle-slider" />
              Auto-accept
            </label>
            <label className="toggle-label" title="Voice alerts during the game (Flash up, recall ready, enemy missing)">
              <input type="checkbox" checked={state.tts_enabled}
                onChange={() => invoke("set_tts_enabled", { enabled: !state.tts_enabled })} />
              <span className="toggle-slider" />
              Voice cues
            </label>
            <select className="select select-sm overlay-pos-select"
              defaultValue="top-left"
              onChange={(e) => invoke("set_overlay_position", { position: e.target.value })}
              title="Overlay position (hold TAB in-game)">
              <option value="off">Overlay: Off</option>
              <option value="top-left">Overlay: Top-Left</option>
              <option value="top-right">Overlay: Top-Right</option>
              <option value="bottom-left">Overlay: Bottom-Left</option>
              <option value="bottom-right">Overlay: Bottom-Right</option>
              <option value="center">Overlay: Center</option>
            </select>
          </div>
        </div>
      )}

      {/* Waiting / Match History */}
      {isConnected && !inChampSelect && !inGame && !inPostGame && (
        <section className="section-lobby">
          {state.match_history.length > 0 ? (
            <>
              <LobbyBackground history={state.match_history} />
              <DailySummary history={state.match_history} lpHistory={state.lp_history} />
              <TiltGate history={state.match_history} />
              <ChampionImprovement history={state.match_history} />
              {state.ranked && <ImprovementPanel history={state.match_history} ranked={state.ranked} />}
              {state.lp_history.length >= 2 && <LpChart history={state.lp_history} />}
              <MatchHistoryView history={state.match_history} />
            </>
          ) : (
            <div className="section-waiting">
              <div className="pulse-ring" />
              <p className="waiting-text">Waiting for champion select...</p>
            </div>
          )}
        </section>
      )}

      {/* Live Game */}
      {inGame && state.live_game && (
        <LiveGameView game={state.live_game} onViewPlayer={viewPlayer} />
      )}

      {/* Champ select */}
      {inChampSelect && (
        <div className="champ-select-layout">
          {/* Top: ARAM bench or Draft Recommendations */}
          {state.game_mode === "aram" && state.aram_bench.length > 0 ? (
            <div className="cs-recs-bar aram-bench-bar">
              <span className="cs-recs-label">ARAM Bench</span>
              <div className="cs-recs-scroll">
                {[...state.aram_bench]
                  .filter(champ => !state.draft?.allies.some(a => a.champion_id === champ.champion_id))
                  .sort((a, b) => b.win_rate - a.win_rate)
                  .map(champ => (
                    <div key={champ.champion_id} className="aram-bench-chip aram-bench-available"
                      onClick={() => invoke("swap_aram_bench", { championId: champ.champion_id })}
                      title="Click to swap">
                      <ChampionIcon championId={champ.champion_id} size={32} />
                      <div className="aram-bench-info">
                        <ChampionNameLabel championId={champ.champion_id} fallback="..." />
                        <span className={`aram-bench-wr ${champ.win_rate >= 0.52 ? "lg-wr-good" : champ.win_rate < 0.48 ? "lg-wr-bad" : ""}`}>
                          {(champ.win_rate * 100).toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ) : !hasChampion && state.recommendations.length > 0 && (
            <div className="cs-recs-bar">
              <span className="cs-recs-label">Recommended</span>
              <div className="cs-recs-scroll">
                {state.recommendations.map(rec => (
                  <div key={rec.champion_id} className="cs-rec-chip rec-clickable"
                    onClick={() => invoke("pick_champion", { championId: rec.champion_id })}>
                    <ChampionIcon championId={rec.champion_id} size={32} />
                    <div className="cs-rec-chip-info">
                      <ChampionNameLabel championId={rec.champion_id} fallback="..." />
                      <span className="cs-rec-chip-score">{(rec.score * 100).toFixed(0)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="cs-main">
            {/* Left: Allies */}
            <div className="cs-left">
              {state.draft && (
                <div className="cs-team">
                  <h4 className="cs-team-label cs-team-ally">Your Team</h4>
                  {state.draft.allies.map((p, i) => (
                    <div key={i} className={`cs-player ${p.is_local ? "cs-player-local" : ""}`}>
                      <ChampionIcon championId={p.champion_id} size={36} />
                      <div className="cs-player-info">
                        <ChampionNameLabel championId={p.champion_id} fallback={p.is_local ? "You" : "..."} />
                        {p.position && <span className="cs-player-pos"><PositionIcon pos={p.position} size={12} /> {POSITION_LABELS[p.position] || p.position.toUpperCase()}</span>}
                      </div>
                    </div>
                  ))}
                  {state.draft.ally_bans.length > 0 && (
                    <div className="cs-bans">
                      <span className="cs-bans-label">Bans</span>
                      <div className="cs-bans-list">
                        {state.draft.ally_bans.map((id, i) => (
                          <ChampionIcon key={i} championId={id} size={28} className="ban-icon" />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Center: Build */}
            <div className="cs-center">

              {!hasChampion && (
                <div className="cs-empty">
                  <div className="pulse-ring pulse-ring-sm" />
                  <p className="waiting-text">Pick a champion...</p>
                </div>
              )}

            {hasChampion && championInfo && (
              <section className="section-build">
                <div className="champion-card" style={{
                  backgroundImage: `url(${splashUrl(championInfo.key)})`,
                }}>
                  <div className="champion-avatar">
                    <img src={championIconUrl(championInfo.key)} alt={championInfo.name} />
                  </div>
                  <div className="champion-info">
                    <h2 className="champion-name">{championInfo.name}</h2>
                    {state.assigned_position && (
                      <span className="position-tag">
                        <PositionIcon pos={state.assigned_position} size={14} /> {POSITION_LABELS[state.assigned_position] || state.assigned_position.toUpperCase()}
                      </span>
                    )}
                  </div>
                  {hasBuild && !state.auto_apply && (
                    <button onClick={handleApply} className="btn-apply">Apply</button>
                  )}
                  {hasBuild && state.auto_apply && <span className="applied-badge">Applied</span>}
                </div>

                {!hasBuild && (
                  <div className="loading-build"><div className="spinner" /><span>Fetching optimal build...</span></div>
                )}

                {hasBuild && (
                  <div className="build-grid">
                    <div className="build-row-top">
                      {state.build!.summoner_spells && (
                        <div className="build-card">
                          <div className="card-header">
                            <h3 className="card-label">Spells</h3>
                            {state.build_alternatives && state.build_alternatives.summoner_spells.length > 1 && (
                              <AltTabs
                                options={state.build_alternatives.summoner_spells}
                                category="spells"
                                currentIds={state.build!.summoner_spells!}
                              />
                            )}
                          </div>
                          <div className="spells-row">
                            {state.build!.summoner_spells!.map(id => (
                              <div key={id} className="spell-slot" title={SPELL_NAMES[id]}>
                                <img src={spellIconUrl(id)} alt={SPELL_NAMES[id]} />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {state.build!.skill_order.length > 0 && (
                        <div className="build-card">
                          <h3 className="card-label">Skill Priority</h3>
                          <div className="skills-row">
                            {state.build!.skill_order.map((skill, i) => (
                              <span key={i} className="skill-pip" style={{
                                background: SKILL_COLORS[skill] || "#555",
                                opacity: 1 - i * 0.2, fontSize: i === 0 ? 14 : 12,
                              }}>{skill}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {state.build!.runes && runesLoaded && (
                      <div className="build-card">
                        <div className="card-header">
                          <h3 className="card-label">Runes</h3>
                          {state.build_alternatives && state.build_alternatives.runes.length > 1 && (
                            <AltTabs
                              options={state.build_alternatives.runes}
                              category="runes"
                              currentBuild={state.build!.runes!}
                            />
                          )}
                        </div>
                        <RuneDisplay runes={state.build!.runes!} />
                      </div>
                    )}

                    {(state.build!.starter_items.length > 0 || state.build!.core_items.length > 0) && (
                      <div className="build-card">
                        <h3 className="card-label">Items</h3>
                        <div className="items-sections">
                          {/* Start + Boots side by side */}
                          <div className="items-top-row">
                            {state.build_alternatives && state.build_alternatives.starter_items.length > 0 ? (
                              <div className="items-group items-half">
                                <span className="items-label">Start</span>
                                {state.build_alternatives.starter_items.slice(0, 2).map((opt, oi) => (
                                  <div key={oi} className="item-option-row">
                                    <div className="item-option-icons">
                                      {opt.ids.map(id => <ItemIcon key={id} id={id} size={22} />)}
                                    </div>
                                    <span className="item-opt-pr">{(opt.pick_rate * 100).toFixed(0)}%</span>
                                    <span className={`item-opt-wr ${opt.win_rate >= 0.52 ? "lg-wr-good" : opt.win_rate < 0.48 ? "lg-wr-bad" : ""}`}>
                                      {(opt.win_rate * 100).toFixed(1)}%
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : state.build!.starter_items.length > 0 && (
                              <div className="items-group items-half">
                                <span className="items-label">Start</span>
                                <div className="items-row">
                                  {state.build!.starter_items.map(id => <ItemIcon key={id} id={id} size={22} />)}
                                </div>
                              </div>
                            )}
                            {state.build_alternatives && state.build_alternatives.boots.length > 0 ? (
                              <div className="items-group items-half">
                                <span className="items-label">Boots</span>
                                {state.build_alternatives.boots.slice(0, 2).map((opt, oi) => (
                                  <div key={oi} className="item-option-row">
                                    <div className="item-option-icons">
                                      {opt.ids.map(id => <ItemIcon key={id} id={id} size={22} />)}
                                    </div>
                                    <span className="item-opt-pr">{(opt.pick_rate * 100).toFixed(0)}%</span>
                                    <span className={`item-opt-wr ${opt.win_rate >= 0.52 ? "lg-wr-good" : opt.win_rate < 0.48 ? "lg-wr-bad" : ""}`}>
                                      {(opt.win_rate * 100).toFixed(1)}%
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : state.build!.boots.length > 0 && (
                              <div className="items-group items-half">
                                <span className="items-label">Boots</span>
                                <div className="items-row">
                                  {state.build!.boots.map(id => <ItemIcon key={id} id={id} size={22} />)}
                                </div>
                              </div>
                            )}
                          </div>
                          {/* Core builds with alternatives */}
                          <div className="items-group">
                            <span className="items-label">Core</span>
                            {state.build_alternatives && state.build_alternatives.core_items.length > 0 ? (
                              state.build_alternatives.core_items.slice(0, 3).map((opt, oi) => (
                                <div key={oi} className={`item-option-row ${oi === 0 ? "item-option-active" : ""}`}
                                  onClick={() => invoke("select_build_option", { category: "items", index: oi })}
                                  style={{ cursor: "pointer" }}>
                                  <div className="item-option-icons">
                                    {opt.ids.map((id, ii) => (
                                      <span key={id} className="item-core-slot">
                                        <ItemIcon id={id} size={22} />
                                        {ii < opt.ids.length - 1 && <span className="item-arrow-sm">&rarr;</span>}
                                      </span>
                                    ))}
                                  </div>
                                  <span className="item-opt-pr">{(opt.pick_rate * 100).toFixed(0)}%</span>
                                  <span className={`item-opt-wr ${opt.win_rate >= 0.52 ? "lg-wr-good" : opt.win_rate < 0.48 ? "lg-wr-bad" : ""}`}>
                                    {(opt.win_rate * 100).toFixed(1)}%
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="items-row">
                                {state.build!.core_items.map((id, i) => (
                                  <div key={id} className="items-row">
                                    <ItemIcon id={id} size={32} />
                                    {i < state.build!.core_items.length - 1 && <span className="item-arrow">&rarr;</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Prediction & Strategy (not ARAM) */}
            {state.draft && <DamageCompBar allies={state.draft.allies} enemies={state.draft.enemies} />}
            {state.draft && state.game_mode !== "aram" && <CompCallouts allies={state.draft.allies} />}
            {state.draft && state.game_mode !== "aram" && <AllLanesMatchup allies={state.draft.allies} enemies={state.draft.enemies} />}
            {state.draft && state.game_mode !== "aram" && state.assigned_position && hasChampion && (
              <TrinketRecommendation myPos={state.assigned_position} enemies={state.draft.enemies} />
            )}
            {state.draft && state.game_mode !== "aram" && state.assigned_position && hasChampion && (
              <WardPlacement myPos={state.assigned_position} enemies={state.draft.enemies} />
            )}

            {state.prediction && state.game_mode !== "aram" && (
              <div className="prediction-card">
                <div className="prediction-header">
                  <h3 className="card-label">Game Analysis</h3>
                  <div className="prediction-wr">
                    <span className="pred-team pred-ally">{(state.prediction.ally_avg_wr * 100).toFixed(1)}%</span>
                    <span className="pred-vs">vs</span>
                    <span className="pred-team pred-enemy">{(state.prediction.enemy_avg_wr * 100).toFixed(1)}%</span>
                  </div>
                </div>
                <div className="prediction-bars">
                  <div className="pred-bar-row">
                    <span className="pred-bar-label">Early</span>
                    <div className="pred-bar">
                      <div className="pred-bar-ally" style={{ width: `${state.prediction.ally_early_score * 100}%` }} />
                    </div>
                    <div className="pred-bar">
                      <div className="pred-bar-enemy" style={{ width: `${state.prediction.enemy_early_score * 100}%` }} />
                    </div>
                  </div>
                  <div className="pred-bar-row">
                    <span className="pred-bar-label">Late</span>
                    <div className="pred-bar">
                      <div className="pred-bar-ally" style={{ width: `${state.prediction.ally_late_score * 100}%` }} />
                    </div>
                    <div className="pred-bar">
                      <div className="pred-bar-enemy" style={{ width: `${state.prediction.enemy_late_score * 100}%` }} />
                    </div>
                  </div>
                </div>
                <p className="prediction-tip">{state.prediction.tip}</p>
              </div>
            )}

            {/* Adaptive item recommendations */}
            {state.draft && state.draft.enemies.filter(e => e.champion_id > 0).length >= 2 && (() => {
              const enemyIds = state.draft.enemies.filter(e => e.champion_id > 0).map(e => e.champion_id);
              const recs = analyzeEnemyComp(enemyIds);
              if (recs.length === 0) return null;
              return (
                <div className="item-recs-panel">
                  <h4 className="item-recs-title">Situational Items</h4>
                  {recs.map((r, i) => (
                    <div key={i} className={`item-rec ${r.priority === "high" ? "item-rec-high" : "item-rec-medium"}`}>
                      <div className="item-rec-header">
                        <span className="item-rec-cat">{r.category}</span>
                        <span className="item-rec-reason">{r.reason}</span>
                      </div>
                      <div className="item-rec-items">
                        {r.items.map((item, j) => (
                          <ItemIcon key={j} id={item.id} size={24} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Matchup analysis by level */}
            {state.champion_id && state.draft && (() => {
              const myId = state.champion_id!;
              const visibleEnemies = state.draft.enemies.filter(e => e.champion_id > 0);
              if (visibleEnemies.length === 0) return null;
              const myPos = state.assigned_position;
              const laneOpponent = pickLaneOpponent(myPos, state.draft.enemies);
              if (!laneOpponent) return null;
              const wr = state.counters[laneOpponent.champion_id.toString()];
              const analysis = analyzeMatchup(myId, laneOpponent.champion_id, wr);
              return (
                <>
                  <div className="matchup-panel">
                    <div className="matchup-header">
                      <ChampionIcon championId={myId} size={24} />
                      <span className="matchup-vs">vs</span>
                      <ChampionIcon championId={laneOpponent.champion_id} size={24} />
                      <span className="matchup-summary">{analysis.summary}</span>
                    </div>
                    <div className="matchup-phases">
                      {analysis.phases.map((p, i) => (
                        <div key={i} className={`matchup-phase matchup-${p.advantage}`}>
                          <span className="matchup-range">{p.range}</span>
                          <span className="matchup-tip">{p.tip}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {state.game_mode !== "aram" && (
                    <LevelPlanTimeline yourId={myId} enemyId={laneOpponent.champion_id} position={myPos ?? undefined} />
                  )}
                </>
              );
            })()}
          </div>

          {/* Right: Enemies */}
          <div className="cs-right">
            {state.draft && (
              <div className="cs-team">
                <h4 className="cs-team-label cs-team-enemy">Enemy Team</h4>
                {state.draft.enemies.length > 0 ? state.draft.enemies.map((p, i) => {
                  const realWr = hasChampion && p.champion_id > 0 ? state.counters[p.champion_id.toString()] : undefined;
                  const wr = realWr;
                  const estimated = realWr === undefined && hasChampion && p.champion_id > 0
                    ? estimateWinRate(state.champion_id!, p.champion_id)
                    : undefined;
                  return (
                    <div key={i} className="cs-player">
                      <ChampionIcon championId={p.champion_id} size={36} />
                      <div className="cs-player-info">
                        <ChampionNameLabel championId={p.champion_id} fallback="..." />
                        {p.position && <span className="cs-player-pos"><PositionIcon pos={p.position} size={12} /> {POSITION_LABELS[p.position] || p.position.toUpperCase()}</span>}
                      </div>
                      {wr !== undefined && (
                        <span className={`matchup-badge ${wr > 0.5 ? "matchup-good" : "matchup-bad"}`}>
                          {(wr * 100).toFixed(1)}%
                        </span>
                      )}
                      {wr === undefined && estimated !== undefined && (
                        <span
                          className={`matchup-badge matchup-estimated ${estimated > 0.5 ? "matchup-good" : "matchup-bad"}`}
                          title="Estimación basada en curvas de poder — OP.GG no tiene datos suficientes para este matchup"
                        >
                          ~{(estimated * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  );
                }) : (
                  <div className="cs-player-empty">Waiting for picks...</div>
                )}

                {state.draft.enemy_bans.length > 0 && (
                  <div className="cs-bans">
                    <span className="cs-bans-label">Bans</span>
                    <div className="cs-bans-list">
                      {state.draft.enemy_bans.map((id, i) => (
                        <ChampionIcon key={i} championId={id} size={28} className="ban-icon" />
                      ))}
                    </div>
                  </div>
                )}

                {/* Ban suggestions under enemies */}
                {!hasChampion && state.ban_phase_active && state.ban_suggestions.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <h4 className="cs-team-label" style={{ color: "var(--accent-red)", marginBottom: 6 }}>Ban These</h4>
                    {state.ban_suggestions.map(ban => (
                      <BanCard key={ban.champion_id} ban={ban} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          </div> {/* close cs-main */}
        </div>
      )}

      {/* Post-game summary */}
      {inPostGame && state.post_game && (
        <PostGameView stats={state.post_game} showBack={true} onViewPlayer={viewPlayer} />
      )}

      {/* Loading overlay */}
      {profileLoading && !playerProfile && (
        <div className="profile-overlay">
          <div className="profile-panel" style={{ textAlign: "center", padding: 48 }}>
            <div className="spinner" style={{ margin: "0 auto 12px" }} />
            <p className="waiting-text">Loading player profile...</p>
          </div>
        </div>
      )}

      {/* Player Profile Overlay */}
      {playerProfile && (
        <div className="profile-overlay">
          <div className="profile-panel">
            <div className="profile-header">
              <div className="profile-info">
                <h2 className="profile-name">{playerProfile.name || "Unknown"}</h2>
                {playerProfile.rank && (
                  <span className={`ranked-badge rank-${playerProfile.rank.split(' ')[0]?.toLowerCase()}`}>
                    <RankEmblem rank={playerProfile.rank} size={16} />
                    {playerProfile.rank}
                  </span>
                )}
              </div>
              <button className="btn-back" onClick={() => setPlayerProfile(null)}>Close</button>
            </div>
            {playerProfile.matches.length > 0 ? (
              <MatchHistoryView history={playerProfile.matches} />
            ) : (
              <p className="waiting-text">No match history available</p>
            )}
          </div>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="toast-error">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="toast-close">&times;</button>
        </div>
      )}
    </main>
  );
}

// --- Components ---

function ChampionNameLabel({ championId, fallback }: { championId: number; fallback: string }) {
  const info = useChampionName(championId);
  return <span className="draft-champ-name">{info?.name || fallback}</span>;
}

// --- Recommendation Card ---


// --- Daily Summary ---

function startOfTodayMs(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function formatPlayedDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function DailySummary({ history, lpHistory }: { history: MatchHistoryEntry[]; lpHistory: LpEntry[] }) {
  const todayStart = startOfTodayMs();
  const today = history.filter(m => m.timestamp >= todayStart && m.duration_secs > 60);
  if (today.length === 0) return null;

  const wins = today.filter(m => m.win).length;
  const losses = today.length - wins;
  const winRate = (wins / today.length) * 100;
  const totalSecs = today.reduce((s, m) => s + m.duration_secs, 0);

  // Best KDA today
  const bestKda = today.reduce<{ kda: number; champ: number; k: number; d: number; a: number } | null>(
    (best, m) => {
      const kda = (m.kills + m.assists) / Math.max(1, m.deaths);
      if (!best || kda > best.kda) return { kda, champ: m.champion_id, k: m.kills, d: m.deaths, a: m.assists };
      return best;
    },
    null,
  );

  // Streak (consecutive same-result from the latest game backward)
  let streak = 0;
  let streakIsWin = false;
  if (today.length > 0) {
    const sorted = [...today].sort((a, b) => b.timestamp - a.timestamp);
    streakIsWin = sorted[0].win;
    for (const m of sorted) {
      if (m.win === streakIsWin) streak++;
      else break;
    }
  }

  // LP net today
  const todaysLp = lpHistory.filter(e => e.timestamp >= todayStart);
  let lpNet: number | null = null;
  if (todaysLp.length >= 2) {
    const sortedLp = [...todaysLp].sort((a, b) => a.timestamp - b.timestamp);
    const last = sortedLp[sortedLp.length - 1];
    const first = sortedLp[0];
    lpNet = absoluteLp(last.tier, last.rank, last.lp) - absoluteLp(first.tier, first.rank, first.lp);
  }

  // Game time threshold colors: > 3h yellow, > 5h red
  const timeWarn = totalSecs > 5 * 3600 ? "danger" : totalSecs > 3 * 3600 ? "warn" : "";

  return (
    <div className="daily-summary">
      <div className="daily-header">
        <span className="daily-title">Today</span>
        <span className={`daily-time ${timeWarn ? `daily-time-${timeWarn}` : ""}`}>
          {formatPlayedDuration(totalSecs)} played
          {totalSecs > 5 * 3600 && <span className="daily-time-tip"> · consider a break</span>}
        </span>
      </div>
      <div className="daily-stats">
        <div className="daily-stat">
          <span className="daily-stat-value">{today.length}</span>
          <span className="daily-stat-label">Games</span>
        </div>
        <div className="daily-stat">
          <span className={`daily-stat-value ${winRate >= 55 ? "lg-wr-good" : winRate < 45 ? "lg-wr-bad" : ""}`}>
            {winRate.toFixed(0)}%
          </span>
          <span className="daily-stat-label">{wins}W {losses}L</span>
        </div>
        {streak > 1 && (
          <div className="daily-stat">
            <span className={`daily-stat-value ${streakIsWin ? "lg-wr-good" : "lg-wr-bad"}`}>
              {streakIsWin ? `${streak}W` : `${streak}L`}
            </span>
            <span className="daily-stat-label">Streak</span>
          </div>
        )}
        {lpNet !== null && (
          <div className="daily-stat">
            <span className={`daily-stat-value ${lpNet > 0 ? "lg-wr-good" : lpNet < 0 ? "lg-wr-bad" : ""}`}>
              {lpNet > 0 ? "+" : ""}{lpNet}
            </span>
            <span className="daily-stat-label">LP</span>
          </div>
        )}
        {bestKda && (
          <div className="daily-stat daily-stat-mvp">
            <ChampionIcon championId={bestKda.champ} size={28} />
            <div className="daily-mvp-info">
              <span className="daily-stat-value">
                {bestKda.k}/{bestKda.d}/{bestKda.a}
              </span>
              <span className="daily-stat-label">Best KDA</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Champion-specific improvement ---

interface ChampStats {
  games: number;
  winRate: number;
  kda: number;
  csPerMin: number;
  goldPerMin: number;
}

function computeChampStats(games: MatchHistoryEntry[]): ChampStats | null {
  const valid = games.filter(g => g.duration_secs > 60 && g.gold_earned > 0);
  if (valid.length === 0) return null;
  let wins = 0, kdaSum = 0, csPerMinSum = 0, goldPerMinSum = 0;
  for (const g of valid) {
    if (g.win) wins++;
    const minutes = g.duration_secs / 60;
    kdaSum += (g.kills + g.assists) / Math.max(1, g.deaths);
    csPerMinSum += g.cs / minutes;
    goldPerMinSum += g.gold_earned / minutes;
  }
  return {
    games: valid.length,
    winRate: wins / valid.length,
    kda: kdaSum / valid.length,
    csPerMin: csPerMinSum / valid.length,
    goldPerMin: goldPerMinSum / valid.length,
  };
}

function deltaPct(value: number, baseline: number): number {
  if (baseline === 0) return 0;
  return ((value - baseline) / baseline) * 100;
}

function ChampionImprovement({ history }: { history: MatchHistoryEntry[] }) {
  const byChamp = new Map<number, MatchHistoryEntry[]>();
  for (const m of history) {
    if (m.duration_secs < 60 || m.gold_earned === 0) continue;
    const arr = byChamp.get(m.champion_id) || [];
    arr.push(m);
    byChamp.set(m.champion_id, arr);
  }

  const allEntries: { id: number; games: MatchHistoryEntry[]; stats: ChampStats }[] = [];
  for (const [id, games] of byChamp.entries()) {
    const stats = computeChampStats(games);
    if (!stats || stats.games < 3) continue;
    allEntries.push({ id, games, stats });
  }
  if (allEntries.length === 0) return null;

  // Top 3 by games played
  const top = allEntries.sort((a, b) => b.stats.games - a.stats.games).slice(0, 3);

  // Baseline: across ALL games (not filtered by champion)
  const baseline = computeChampStats(history);
  if (!baseline) return null;

  return (
    <div className="champ-improvement">
      <div className="champ-improvement-header">
        <span className="champ-improvement-title">Top Champions vs Your Baseline</span>
        <span className="champ-improvement-baseline">
          KDA {baseline.kda.toFixed(1)} · CS/min {baseline.csPerMin.toFixed(1)} · Gold/min {baseline.goldPerMin.toFixed(0)}
        </span>
      </div>
      <div className="champ-improvement-list">
        {top.map(c => {
          const wrDelta = deltaPct(c.stats.winRate, baseline.winRate);
          const kdaDelta = deltaPct(c.stats.kda, baseline.kda);
          const csDelta = deltaPct(c.stats.csPerMin, baseline.csPerMin);
          const goldDelta = deltaPct(c.stats.goldPerMin, baseline.goldPerMin);
          return (
            <div key={c.id} className="champ-improvement-row">
              <ChampionIcon championId={c.id} size={34} />
              <div className="champ-improvement-info">
                <div className="champ-improvement-name">
                  <ChampionNameLabel championId={c.id} fallback={`Champ ${c.id}`} />
                  <span className="champ-improvement-games">{c.stats.games} games</span>
                  <span className={`champ-improvement-wr ${c.stats.winRate >= 0.55 ? "lg-wr-good" : c.stats.winRate < 0.45 ? "lg-wr-bad" : ""}`}>
                    {(c.stats.winRate * 100).toFixed(0)}% WR
                  </span>
                </div>
                <div className="champ-improvement-metrics">
                  <ImprovementMetric label="KDA" value={c.stats.kda.toFixed(1)} delta={kdaDelta} />
                  <ImprovementMetric label="CS/min" value={c.stats.csPerMin.toFixed(1)} delta={csDelta} />
                  <ImprovementMetric label="Gold/min" value={c.stats.goldPerMin.toFixed(0)} delta={goldDelta} />
                  <ImprovementMetric label="WR" value={`${(c.stats.winRate * 100).toFixed(0)}%`} delta={wrDelta} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ImprovementMetric({ label, value, delta }: { label: string; value: string; delta: number }) {
  const sign = delta > 0 ? "+" : "";
  const tone = delta >= 5 ? "good" : delta <= -5 ? "bad" : "neutral";
  return (
    <div className={`improvement-metric improvement-metric-${tone}`}>
      <span className="improvement-metric-label">{label}</span>
      <span className="improvement-metric-value">{value}</span>
      <span className="improvement-metric-delta">{sign}{delta.toFixed(0)}%</span>
    </div>
  );
}

// --- Tilt detection ---

function TiltGate({ history }: { history: MatchHistoryEntry[] }) {
  // Look at ranked games (queues 420 = solo, 440 = flex) in the last 2 hours
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const ranked = history
    .filter(m => (m.queue_id === 420 || m.queue_id === 440) && m.timestamp >= twoHoursAgo && m.duration_secs > 60)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (ranked.length < 3) return null;
  // Count consecutive losses from most recent backward
  let streakLoss = 0;
  for (const m of ranked) {
    if (!m.win) streakLoss++;
    else break;
  }
  if (streakLoss < 3) return null;

  // Compute personal historic winrate after a 3-loss streak
  const allRanked = history
    .filter(m => (m.queue_id === 420 || m.queue_id === 440) && m.duration_secs > 60)
    .sort((a, b) => a.timestamp - b.timestamp);
  let postStreakWins = 0;
  let postStreakTotal = 0;
  let consecLoss = 0;
  for (let i = 0; i < allRanked.length; i++) {
    const m = allRanked[i];
    if (consecLoss >= 3 && i < allRanked.length) {
      postStreakTotal++;
      if (m.win) postStreakWins++;
      consecLoss = m.win ? 0 : consecLoss + 1;
    } else {
      consecLoss = m.win ? 0 : consecLoss + 1;
    }
  }
  const baseTotal = allRanked.length;
  const baseWins = allRanked.filter(m => m.win).length;
  const baseWr = baseTotal > 0 ? (baseWins / baseTotal) * 100 : 0;
  const tiltedWr = postStreakTotal >= 5 ? (postStreakWins / postStreakTotal) * 100 : null;

  return (
    <div className="tilt-gate">
      <div className="tilt-icon">⚠</div>
      <div className="tilt-content">
        <div className="tilt-title">{streakLoss} losses in a row in ranked</div>
        <div className="tilt-body">
          {tiltedWr !== null
            ? `Your historical winrate after a 3-loss streak drops from ${baseWr.toFixed(0)}% to ${tiltedWr.toFixed(0)}%. Consider taking a 30-minute break.`
            : `Consider taking a 30-minute break before queueing again.`}
        </div>
      </div>
    </div>
  );
}

// --- Improvement Priorities ---

// Tips per role + metric. Generic tips fall back to the global bucket.
const ROLE_TIPS: Record<string, Record<string, string>> = {
  TOP: {
    "CS/min": "Trade efficiently between waves so you can last-hit on cooldown",
    "Vision/min": "Ward tri/river before lvl 6, deep ward after Herald",
    "KDA": "Avoid all-ins without flash up — top deaths cost dragon tempo",
    "Gold/min": "Plate gold + lane prio is your biggest income lever",
    "Deaths": "Track enemy jungler — most top deaths come from missed gank tracking",
  },
  JUNGLE: {
    "CS/min": "Full-clear before ganking unless lane is shoving in — don't power-farm camps off cooldown",
    "Vision/min": "Buy a control ward every back, ward objectives 30s before spawn",
    "KDA": "Don't 1v1 lanes when behind — path to scuttle and reset tempo",
    "Gold/min": "Counter-jungle when lanes have prio, take scuttle and rift Herald",
    "Deaths": "Track enemy jungler — invades cost games more than missed ganks",
  },
  MIDDLE: {
    "CS/min": "Practice mid-wave management — push for plates / jungle invade with prio",
    "Vision/min": "Pixel ward + side-river bushes after lvl 6 to track jungler",
    "KDA": "Pick safer trades when down — mid spikes hard with first item",
    "Gold/min": "Side-roams + plate gold compound — don't overstay for last cs",
    "Deaths": "Don't fight without summs/ult unless you have prio + jungle nearby",
  },
  BOTTOM: {
    "CS/min": "Focus on last-hitting under tower — top ADCs have 9+ CS/min by 14m",
    "Vision/min": "Drop yellow ward in tri/river while support roams",
    "KDA": "Position behind frontline — being alive in fights > getting kills",
    "Gold/min": "First two items break the matchup — race the enemy ADC's spike",
    "Deaths": "Don't auto-attack into enemy engage range without flash up",
  },
  UTILITY: {
    "Vision/min": "Buy a control ward every recall, oracle lens after 9, sweep before objectives",
    "KDA": "Engage only when ADC has resources — selfless deaths still lose tempo",
    "Gold/min": "Take support quest items, don't steal lane farm — your gold/min is normal",
    "KP": "Roam mid when bot wave is shoved — your impact is map-wide",
    "Deaths": "Vision saves lives — wards block hooks and engage",
  },
};

function getTip(role: string, metric: string, fallback: string): string {
  return ROLE_TIPS[role.toUpperCase()]?.[metric] ?? fallback;
}

function inferMainRole(games: MatchHistoryEntry[]): { role: string | null; confidence: number } {
  const counts: Record<string, number> = { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0 };
  let resolved = 0;
  for (const m of games) {
    const pos = (m.position || "").toUpperCase();
    if (pos in counts) {
      counts[pos]++;
      resolved++;
    }
  }
  // Fallback: infer from champion identity for older matches missing position
  if (resolved < games.length * 0.4) {
    for (const m of games) {
      const pos = (m.position || "").toUpperCase();
      if (pos in counts) continue; // already counted
      const champRoles = getChampRoles(m.champion_id);
      if (champRoles.length > 0) {
        const primary = champRoles[0].toUpperCase();
        if (primary in counts) {
          counts[primary]++;
          resolved++;
        }
      }
    }
  }
  if (resolved === 0) return { role: null, confidence: 0 };
  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const [topRole, topCount] = sorted[0];
  if (topCount === 0) return { role: null, confidence: 0 };
  return { role: topRole, confidence: topCount / resolved };
}

function ImprovementPanel({ history, ranked }: { history: MatchHistoryEntry[]; ranked: RankedInfo }) {
  const tierKey = ranked.tier.toUpperCase();
  const tierLabel = ranked.tier.charAt(0).toUpperCase() + ranked.tier.slice(1).toLowerCase();

  // Prefer ranked (solo/duo + flex). If we have <5, fall back to ranked +
  // normal draft / quickplay (still on Summoner's Rift) so players who don't
  // grind ranked still get feedback.
  const isRifted = (m: MatchHistoryEntry) =>
    m.queue_id === 420 || m.queue_id === 440 ||
    m.queue_id === 400 || m.queue_id === 430 || m.queue_id === 490;
  const validBase = (m: MatchHistoryEntry) => m.duration_secs > 300 && m.gold_earned > 0;

  const rankedOnly = history.filter(m => (m.queue_id === 420 || m.queue_id === 440) && validBase(m));
  const games = rankedOnly.length >= 5 ? rankedOnly : history.filter(m => isRifted(m) && validBase(m));
  const usingNormals = rankedOnly.length < 5;
  if (games.length < 5) return null;

  // Infer main role and adjust the benchmark accordingly. Confidence ≥0.5 (50%
  // of games on one role) to avoid mislabeling a true autofill / split player.
  const { role, confidence } = inferMainRole(games);
  const useRole = role && confidence >= 0.5 ? role : null;
  const bench = useRole
    ? getRoleAdjustedBenchmark(ranked.tier, useRole)
    : (ELO_BENCHMARKS[tierKey] || ELO_BENCHMARKS.GOLD);
  const roleLabel = useRole ?? null;

  // For supports, deprioritize CS/min — it's not a real lever and the benchmark
  // gap dwarfs other actionable metrics.
  const isSupport = useRole === "UTILITY";

  const n = games.length;
  const totalMins = games.reduce((s, m) => s + m.duration_secs / 60, 0);

  const avgCsMin = games.reduce((s, m) => s + m.cs, 0) / totalMins;
  const avgVisionMin = games.reduce((s, m) => s + m.vision_score, 0) / totalMins;
  const avgDeaths = games.reduce((s, m) => s + m.deaths, 0) / n;
  const totalK = games.reduce((s, m) => s + m.kills, 0);
  const totalD = games.reduce((s, m) => s + m.deaths, 0);
  const totalA = games.reduce((s, m) => s + m.assists, 0);
  const avgKda = totalD === 0 ? totalK + totalA : (totalK + totalA) / totalD;
  const avgGoldMin = games.reduce((s, m) => s + m.gold_earned, 0) / totalMins;

  type Priority = { metric: string; gap: number; yours: string; target: string; tip: string };
  const priorities: Priority[] = [];
  const r = roleLabel ?? "";

  const check = (val: number, ref_val: number, metric: string, yourFmt: string, refFmt: string, fallback: string) => {
    const gap = (ref_val - val) / ref_val;
    if (gap > 0.05) priorities.push({ metric, gap, yours: yourFmt, target: refFmt, tip: getTip(r, metric, fallback) });
  };

  if (!isSupport) {
    check(avgCsMin, bench.cs_min, "CS/min", avgCsMin.toFixed(1), bench.cs_min.toFixed(1), "Practice last-hitting in practice tool");
  }
  check(avgVisionMin, bench.vision_min, "Vision/min", avgVisionMin.toFixed(2), bench.vision_min.toFixed(2), "Buy control wards, use trinket on cooldown");
  check(avgKda, bench.kda, "KDA", avgKda.toFixed(1), bench.kda.toFixed(1), "Focus on dying less in trades and teamfights");
  check(avgGoldMin, bench.gold_min, "Gold/min", Math.round(avgGoldMin).toString(), Math.round(bench.gold_min).toString(), "Improve CS and look for plate gold");

  if (avgDeaths > 5.5) {
    priorities.push({ metric: "Deaths", gap: (avgDeaths - 4.5) / 4.5, yours: avgDeaths.toFixed(1) + "/game", target: "<5", tip: getTip(r, "Deaths", "Review positioning and map awareness") });
  }

  priorities.sort((a, b) => b.gap - a.gap);
  const top3 = priorities.slice(0, 3);

  const sampleLabel = usingNormals ? `${n} recent SR games` : `${n} ranked games`;
  const subText = roleLabel
    ? `vs ${tierLabel} ${roleLabel} avg · ${sampleLabel}`
    : `vs ${tierLabel} avg · ${sampleLabel}`;

  // Empty state: every flagged metric is at or above the role-adjusted target.
  // Surface the closest-to-target metric instead of hiding the panel entirely
  // so the user always has feedback on what's happening.
  if (top3.length === 0) {
    const allMetrics = [
      { metric: "Vision/min", val: avgVisionMin, ref: bench.vision_min, fmt: (v: number) => v.toFixed(2) },
      { metric: "KDA", val: avgKda, ref: bench.kda, fmt: (v: number) => v.toFixed(1) },
      { metric: "Gold/min", val: avgGoldMin, ref: bench.gold_min, fmt: (v: number) => Math.round(v).toString() },
    ];
    const closest = allMetrics
      .map(m => ({ ...m, lead: (m.val - m.ref) / m.ref }))
      .sort((a, b) => a.lead - b.lead)[0];
    return (
      <div className="improve-panel">
        <h4 className="improve-title">Areas to Improve <span className="improve-sub">{subText}</span></h4>
        <div className="improve-empty">
          <div className="improve-empty-title">
            <span className="improve-empty-check">✓</span>
            On track across the board for {tierLabel}{roleLabel ? ` ${roleLabel}` : ""}
          </div>
          <div className="improve-empty-body">
            Closest to baseline: <strong>{closest.metric}</strong> at {closest.fmt(closest.val)} (target {closest.fmt(closest.ref)}, +{(closest.lead * 100).toFixed(0)}%).
            Focus on macro: objective tempo, warding before fights, and teamfight positioning.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="improve-panel">
      <h4 className="improve-title">Areas to Improve <span className="improve-sub">{subText}</span></h4>
      {top3.map((p, i) => (
        <div key={i} className="improve-row">
          <span className="improve-metric">{p.metric}</span>
          <div className="improve-bar-track">
            <div className="improve-bar-fill" style={{ width: `${Math.min((1 - p.gap) * 100, 100)}%` }} />
          </div>
          <span className="improve-values">
            <span className="improve-yours">{p.yours}</span>
            <span className="improve-sep">/</span>
            <span className="improve-target">{p.target}</span>
          </span>
          <span className="improve-tip">{p.tip}</span>
        </div>
      ))}
    </div>
  );
}

// --- LP Chart ---

// Convert tier + rank + LP to absolute LP value for charting
function absoluteLp(tier: string, rank: string, lp: number): number {
  const tiers: Record<string, number> = {
    IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200,
    PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400,
    MASTER: 2800, GRANDMASTER: 3200, CHALLENGER: 3600,
  };
  const divisions: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };
  const t = tiers[tier.toUpperCase()] ?? 1200;
  const d = divisions[rank.toUpperCase()] ?? 0;
  return t + d + lp;
}

function LpChart({ history }: { history: LpEntry[] }) {
  const width = 400;
  const height = 48;
  const pad = { top: 6, bottom: 14, left: 8, right: 8 };

  const absLps = history.map(h => absoluteLp(h.tier, h.rank, h.lp));
  const minLp = Math.min(...absLps) - 15;
  const maxLp = Math.max(...absLps) + 15;
  const range = Math.max(maxLp - minLp, 20);

  const points = history.map((h, i) => {
    const abs = absoluteLp(h.tier, h.rank, h.lp);
    const x = pad.left + (i / Math.max(history.length - 1, 1)) * (width - pad.left - pad.right);
    const y = pad.top + (1 - (abs - minLp) / range) * (height - pad.top - pad.bottom);
    return { x, y, lp: h.lp, tier: h.tier, rank: h.rank };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  const first = history[0];
  const last = history[history.length - 1];
  const absFirst = absoluteLp(first.tier, first.rank, first.lp);
  const absLast = absoluteLp(last.tier, last.rank, last.lp);
  const diff = absLast - absFirst;
  const diffColor = diff >= 0 ? "var(--accent-green)" : "var(--accent-red)";

  return (
    <div className="lp-chart-container">
      <div className="lp-chart-header">
        <h3 className="section-title">LP Progress</h3>
        <span className="lp-diff" style={{ color: diffColor }}>
          {diff >= 0 ? "+" : ""}{diff} LP {first.tier !== last.tier || first.rank !== last.rank ? `(${last.tier} ${last.rank})` : ""}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="lp-chart-svg">
        {/* Grid line at current LP */}
        <line x1={pad.left} y1={points[points.length-1].y} x2={width - pad.right} y2={points[points.length-1].y}
          stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="4 2" opacity="0.6" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="var(--accent-gold)" strokeWidth="2" strokeLinejoin="round" />

        {/* Dots */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={i === points.length - 1 ? 3 : 1.8}
            fill={i === points.length - 1 ? "var(--accent-gold)" : "var(--bg-card)"}
            stroke="var(--accent-gold)" strokeWidth="1.2" />
        ))}

        {/* Current LP label */}
        <text x={width - pad.right} y={height - 2} textAnchor="end"
          fill="var(--text-secondary)" fontSize="9" fontWeight="600">
          {last.lp} LP
        </text>
      </svg>
    </div>
  );
}

// --- Match History View ---

function MatchHistoryView({ history }: { history: MatchHistoryEntry[] }) {
  const [champFilter, setChampFilter] = useState<number | null>(null);
  const [modeFilter, setModeFilter] = useState<string>("all");
  const [showAll, setShowAll] = useState(false);

  let modeFiltered = history;
  if (modeFilter === "ranked") modeFiltered = modeFiltered.filter(m => m.queue_id === 420 || m.queue_id === 440);
  else if (modeFilter === "normal") modeFiltered = modeFiltered.filter(m => m.queue_id === 400 || m.queue_id === 430 || m.queue_id === 490);
  else if (modeFilter === "aram") modeFiltered = modeFiltered.filter(m => m.queue_id === 450 || m.queue_id === 900 || m.game_mode === "ARAM");
  const filtered = champFilter ? modeFiltered.filter(m => m.champion_id === champFilter) : modeFiltered;
  const visible = showAll ? filtered : filtered.slice(0, 10);

  const wins = filtered.filter(h => h.win).length;
  const losses = filtered.length - wins;
  const wr = filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(0) : "0";

  // Calculate current streak
  let streakCount = 0;
  let streakWin = filtered.length > 0 ? filtered[0].win : true;
  for (const m of filtered) {
    if (m.win === streakWin) streakCount++;
    else break;
  }

  return (
    <div className="mh-layout">
      <div className="mh-header">
        <h3 className="section-title">Recent Matches</h3>
        <div className="mh-summary">
          {streakCount >= 2 && (
            <span className={`mh-streak ${streakWin ? "streak-win" : "streak-loss"}`}>
              {streakCount} {streakWin ? "Win" : "Loss"} Streak
            </span>
          )}
          <span className="mh-wl">
            <span className="mh-wins">{wins}W</span> <span className="mh-losses">{losses}L</span>
          </span>
          <span className="mh-wr">{wr}% WR</span>
        </div>
      </div>
      {/* Mode filter tabs */}
      <div className="mh-mode-tabs">
        {["all", "ranked", "normal", "aram"].map(mode => (
          <button key={mode} className={`mh-mode-tab ${modeFilter === mode ? "mh-mode-active" : ""}`}
            onClick={() => { setModeFilter(mode); setShowAll(false); }}>
            {mode === "all" ? "All" : mode === "ranked" ? "Ranked" : mode === "normal" ? "Normal" : "ARAM"}
            {mode !== "all" && (
              <span className="mh-mode-count">
                {mode === "ranked" ? history.filter(m => m.queue_id === 420 || m.queue_id === 440).length
                  : mode === "normal" ? history.filter(m => m.queue_id === 400 || m.queue_id === 430 || m.queue_id === 490).length
                  : history.filter(m => m.queue_id === 450 || m.queue_id === 900 || m.game_mode === "ARAM").length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Champion Stats */}
      <ChampionStatsBar history={modeFiltered} filter={champFilter} onFilter={setChampFilter} />

      <div className="mh-trend">
        {filtered.slice(0, 15).map((m, i) => (
          <div key={i} className={`mh-trend-dot ${m.win ? "trend-win" : "trend-loss"}`} title={m.win ? "Win" : "Loss"} />
        ))}
      </div>
      <div className="mh-list">
        {visible.map((m, i) => (
          <MatchHistoryRow key={i} match={m} />
        ))}
        {!showAll && filtered.length > 10 && (
          <button className="btn-show-more" onClick={() => setShowAll(true)}>
            Show {filtered.length - 10} more matches
          </button>
        )}
        {showAll && filtered.length > 10 && (
          <button className="btn-show-more" onClick={() => setShowAll(false)}>
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

function MatchHistoryRow({ match: m }: { match: MatchHistoryEntry }) {
  const champInfo = useChampionName(m.champion_id);
  const kda = m.deaths === 0 ? "Perfect" : ((m.kills + m.assists) / m.deaths).toFixed(1);
  const mins = Math.floor(m.duration_secs / 60);
  const ago = timeAgo(m.timestamp);
  const total = m.kills + m.deaths + m.assists || 1;

  return (
    <div className={`mh-row ${m.win ? "mh-row-win" : "mh-row-loss"}`}
      onClick={() => invoke("view_match_details", { gameId: m.game_id })}
      style={{ cursor: "pointer" }}>
      <div className={`mh-result ${m.win ? "win" : "loss"}`}>{m.win ? "W" : "L"}</div>
      <ChampionIcon championId={m.champion_id} size={36} />
      <div className="mh-info">
        <span className="mh-champ">{champInfo?.name || "..."}</span>
        <span className="mh-mode">{queueLabel(m.queue_id, m.game_mode)}</span>
      </div>
      <div className="mh-kda-col">
        <span className="pg-kda">
          <span className="pg-k">{m.kills}</span>
          <span className="pg-sep">/</span>
          <span className="pg-d">{m.deaths}</span>
          <span className="pg-sep">/</span>
          <span className="pg-a">{m.assists}</span>
        </span>
        <span className="pg-kda-ratio">{kda} KDA</span>
      </div>
      <div className="mh-kda-bar">
        <div className="mh-kda-bar-k" style={{ width: `${(m.kills / total) * 100}%` }} />
        <div className="mh-kda-bar-d" style={{ width: `${(m.deaths / total) * 100}%` }} />
        <div className="mh-kda-bar-a" style={{ width: `${(m.assists / total) * 100}%` }} />
      </div>
      <span className="mh-duration">{mins}m</span>
      <div className="mh-spacer" />
      <span className="mh-ago">{ago}</span>
    </div>
  );
}

function queueLabel(queueId: number, gameMode: string): string {
  // Common queue IDs
  if (queueId === 420) return "Ranked Solo";
  if (queueId === 440) return "Ranked Flex";
  if (queueId === 450 || queueId === 900) return "ARAM";
  if (queueId === 400) return "Normal Draft";
  if (queueId === 430) return "Normal Blind";
  if (queueId === 490) return "Quickplay";
  if (gameMode === "ARAM") return "ARAM";
  if (gameMode === "CLASSIC") return "Normal";
  return gameMode;
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Live Game View ---

function formatGameTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ObjectiveTimers({ events, gameTime }: { events: GameEvent[]; gameTime: number }) {
  const buffs: { label: string; remaining: number; team: "ally" | "enemy" }[] = [];

  // Baron buff: 180s
  const lastBaron = [...events].reverse().find(e => e.event_type === "BaronKill");
  if (lastBaron) {
    const remaining = 180 - (gameTime - lastBaron.time);
    if (remaining > 0) {
      const team = lastBaron.label.startsWith("Ally") ? "ally" as const : "enemy" as const;
      buffs.push({ label: "Baron", remaining, team });
    }
  }

  // Elder Dragon buff: 150s
  const lastDragon = [...events].reverse().find(e => e.event_type === "DragonKill" && e.label.includes("Elder"));
  if (lastDragon) {
    const remaining = 150 - (gameTime - lastDragon.time);
    if (remaining > 0) {
      const team = lastDragon.label.startsWith("Ally") ? "ally" as const : "enemy" as const;
      buffs.push({ label: "Elder", remaining, team });
    }
  }

  // Dragon soul: count dragon kills per team (4+ = soul)
  const allyDragons = events.filter(e => e.event_type === "DragonKill" && e.label.startsWith("Ally")).length;
  const enemyDragons = events.filter(e => e.event_type === "DragonKill" && e.label.startsWith("Enemy")).length;
  if (allyDragons >= 4) buffs.push({ label: "Dragon Soul", remaining: Infinity, team: "ally" });
  else if (enemyDragons >= 4) buffs.push({ label: "Dragon Soul", remaining: Infinity, team: "enemy" });

  if (buffs.length === 0) return null;

  return (
    <div className="obj-timers">
      {buffs.map((b, i) => (
        <span key={i} className={`obj-timer obj-timer-${b.team} ${b.remaining < 30 ? "obj-timer-urgent" : ""}`}>
          {b.team === "ally" ? "Ally" : "Enemy"} {b.label}
          {b.remaining < Infinity && ` ${formatGameTime(b.remaining)}`}
        </span>
      ))}
    </div>
  );
}

function SpikeIcon({ kind }: { kind: "sword" | "ult" | "crown" }) {
  if (kind === "sword") {
    return (
      <svg className="lp-spike-icon" viewBox="0 0 24 24" width="10" height="10" aria-hidden>
        <path d="M14.5 2.5 L21.5 9.5 L18 13 L11 6 Z M11 6 L3 14 L3 18 L7 18 L15 10 Z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "ult") {
    return (
      <svg className="lp-spike-icon" viewBox="0 0 24 24" width="10" height="10" aria-hidden>
        <path d="M12 2 L14.5 9 L22 9 L16 13.5 L18.3 21 L12 16.5 L5.7 21 L8 13.5 L2 9 L9.5 9 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="lp-spike-icon" viewBox="0 0 24 24" width="10" height="10" aria-hidden>
      <path d="M3 19 L5 7 L9.5 11 L12 4 L14.5 11 L19 7 L21 19 Z" fill="currentColor" />
    </svg>
  );
}

function LevelPlanTimeline({ yourId, enemyId, position }: { yourId: number; enemyId: number; position?: string }) {
  const plan = useMemo(() => buildLevelPlan(yourId, enemyId, position), [yourId, enemyId, position]);
  const [hovered, setHovered] = useState<number | null>(null);

  // Pre-select "most interesting" level for default view: biggest your-spike or strongest advantage
  const defaultLevel = useMemo(() => {
    const sorted = [...plan].sort((a, b) => {
      const priA = (a.isSpike ? 10 : 0) + a.advantage;
      const priB = (b.isSpike ? 10 : 0) + b.advantage;
      return priB - priA;
    });
    return sorted[0]?.level ?? 6;
  }, [plan]);

  const focused = plan.find(p => p.level === (hovered ?? defaultLevel)) ?? plan[5];
  const maxAbs = Math.max(1, ...plan.map(e => Math.abs(e.advantage)));

  return (
    <div className="level-plan">
      <div className="level-plan-header">
        <span className="level-plan-title">
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden><path d="M12 2 L14.5 9 L22 9 L16 13.5 L18.3 21 L12 16.5 L5.7 21 L8 13.5 L2 9 L9.5 9 Z" fill="currentColor"/></svg>
          Level plan
        </span>
        <span className="level-plan-vs">
          <ChampionIcon championId={yourId} size={18} />
          <span className="lp-vs-label">vs</span>
          <ChampionIcon championId={enemyId} size={18} />
        </span>
      </div>
      <div className="level-plan-body">
        <div className="level-plan-timeline">
          {plan.map((entry, idx) => {
            const prev = idx > 0 ? plan[idx - 1] : null;
            const connectorCat = prev ? (entry.category === prev.category ? entry.category : entry.category) : entry.category;
            const isFocus = (hovered ?? defaultLevel) === entry.level;
            const advRatio = Math.min(1, Math.abs(entry.advantage) / maxAbs);
            return (
              <div
                key={entry.level}
                className={`lp-row lp-cat-${entry.category} ${isFocus ? "lp-focus" : ""} ${entry.isSpike ? "lp-spike" : ""} ${entry.isEnemySpike ? "lp-enemy-spike" : ""}`}
                onMouseEnter={() => setHovered(entry.level)}
                onMouseLeave={() => setHovered(null)}
              >
                {prev && <div className={`lp-connector lp-cat-${connectorCat}`} />}
                <div className="lp-node-wrap">
                  <div className={`lp-node ${entry.isSpike || entry.isEnemySpike ? "lp-node-hex" : ""}`}>
                    <span className="lp-level-num">{entry.level}</span>
                    {entry.spikeIcon && <span className="lp-node-icon"><SpikeIcon kind={entry.spikeIcon} /></span>}
                  </div>
                </div>
                <span className="lp-action">{entry.action}</span>
                <div className="lp-adv-track">
                  <div className="lp-adv-center" />
                  <div
                    className="lp-adv-fill"
                    style={{
                      width: `${advRatio * 50}%`,
                      left: entry.advantage >= 0 ? "50%" : `${50 - advRatio * 50}%`,
                    }}
                  />
                </div>
                <span className="lp-adv-num">
                  {entry.advantage > 0 ? "+" : ""}
                  {entry.advantage.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="level-plan-detail">
          <div className={`lp-detail-card lp-cat-${focused.category}`}>
            <div className="lp-detail-head">
              <span className="lp-detail-level">Level {focused.level}</span>
              <span className={`lp-detail-adv lp-cat-${focused.category}`}>
                {focused.advantage > 0 ? "+" : ""}
                {focused.advantage.toFixed(1)}
              </span>
            </div>
            <div className="lp-detail-action">{focused.action}</div>
            <p className="lp-detail-text">{focused.detail}</p>
            {focused.isEnemySpike && !focused.isSpike && (
              <div className="lp-detail-warn">⚠ Enemy spike window</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface CompCallout {
  tone: "good" | "warn";
  text: string;
}

// All-lanes matchup panel: predicts each ally-vs-enemy lane outcome
interface LaneMatchup {
  position: string;
  ally: DraftPlayer;
  enemy: DraftPlayer;
  verdict: "favored" | "even" | "unfavored";
  earlyDelta: number;
  lateDelta: number;
}

// Trinket recommendation
type TrinketKind = "yellow" | "sweeping" | "blue";
const TRINKET_INFO: Record<TrinketKind, { name: string; desc: string }> = {
  yellow: { name: "Stealth Ward", desc: "1 charge, places a stealth ward (90s vision)" },
  sweeping: { name: "Oracle Lens", desc: "Reveals & disables nearby invisible wards & traps" },
  blue: { name: "Farsight Alteration", desc: "Long-range scouting ward that doesn't grant vision around it" },
};

function recommendTrinket(myPos: string, enemies: DraftPlayer[]): { kind: TrinketKind; reason: string } {
  const pos = (myPos || "").toLowerCase();
  const enemyIds = enemies.filter(e => e.champion_id > 0).map(e => e.champion_id);
  const hasInvisThreat = enemyIds.some(id =>
    [28, 35, 60, 107, 121, 91, 17, 76, 234, 5, 350, 432].includes(id)
  );
  // Long-range / poke laners: blue trinket helps scout
  const isPokeLaner = (pos.startsWith("top") || pos.startsWith("mid")) &&
    enemyIds.some(id => [110, 81, 161, 101, 134, 99, 115, 51, 202, 142, 8].includes(id));

  if (pos.startsWith("uti") || pos.startsWith("sup")) {
    if (hasInvisThreat) return { kind: "sweeping", reason: "Invisibility threats — clear enemy wards & trinkets" };
    return { kind: "sweeping", reason: "Support: clear enemy vision around bot/objective" };
  }
  if (pos.startsWith("jun")) {
    return { kind: "sweeping", reason: "Jungle: clear vision before invades and objectives" };
  }
  if (isPokeLaner) {
    return { kind: "blue", reason: "Long-range matchup — scout safely from distance" };
  }
  if (hasInvisThreat) {
    return { kind: "sweeping", reason: "Invisibility threats — clear enemy traps after lvl 9" };
  }
  return { kind: "yellow", reason: "Default lane control — ward bushes and objectives" };
}

// Ward placement tips by role + enemy jungler archetype
type JunglerStyle = "ganker" | "farmer" | "invader";
const JUNGLER_STYLES: Record<number, JunglerStyle> = {
  // Gankers: high CC, fast clear-to-gank
  64: "ganker", 60: "ganker", 5: "ganker", 113: "ganker", 79: "ganker", 78: "ganker",
  111: "ganker", 154: "ganker", 421: "ganker", 254: "ganker", 234: "ganker",
  240: "ganker", 32: "ganker", 102: "ganker", 120: "ganker", 233: "ganker",
  // Farmers: scale with full clears, contest mid-late
  76: "farmer", 11: "farmer", 19: "farmer", 36: "farmer", 9: "farmer", 75: "farmer",
  62: "farmer", 6: "farmer", 200: "farmer", 35: "farmer", 121: "farmer",
  // Invaders: contest enemy buffs early
  107: "invader", 28: "invader", 91: "invader", 141: "invader",
  77: "invader", 2: "invader", 245: "invader", 80: "invader",
};

function getJunglerStyle(id: number): JunglerStyle {
  return JUNGLER_STYLES[id] || "farmer";
}

interface WardTip { time: string; spot: string; }

function getWardTips(myPos: string, enemyJunglerId: number | null): WardTip[] {
  const pos = (myPos || "").toLowerCase();
  const style = enemyJunglerId ? getJunglerStyle(enemyJunglerId) : "farmer";

  if (pos.startsWith("top")) {
    if (style === "ganker") return [
      { time: "0:30", spot: "Tri-bush (blue side) / River bush (red side)" },
      { time: "3:00", spot: "Lane bush opposite to your side" },
      { time: "5:30", spot: "Deep ward in their jungle entrance" },
    ];
    if (style === "invader") return [
      { time: "0:30", spot: "River bush — they may invade top early" },
      { time: "2:00", spot: "Their topside jungle entrance" },
      { time: "5:30", spot: "Tri-bush + river when herald spawns" },
    ];
    return [
      { time: "1:00", spot: "River bush near tri" },
      { time: "5:00", spot: "Deep ward by their raptors / Krugs" },
      { time: "7:00", spot: "Set up Herald vision" },
    ];
  }
  if (pos.startsWith("jun")) return [
    { time: "0:00", spot: "Watch lvl 1 invade — ward your strong-side buff" },
    { time: "3:00", spot: "Scuttle bush before contesting" },
    { time: "4:30", spot: "Track enemy jungle path via wards on routes" },
  ];
  if (pos.startsWith("mid") || pos === "middle") {
    if (style === "ganker") return [
      { time: "1:30", spot: "Side river bush facing the strongest gank lane" },
      { time: "3:30", spot: "Pixel bush in your river" },
      { time: "6:00", spot: "Drop control ward in their bot/top river when ahead" },
    ];
    return [
      { time: "1:30", spot: "Lane bush on the side jungle is pathing toward" },
      { time: "5:00", spot: "Scuttle bush + raptors deep ward" },
      { time: "7:30", spot: "Setup vision for first dragon" },
    ];
  }
  if (pos.startsWith("bot") || pos === "adc") return [
    { time: "0:30", spot: "Tri-bush (blue side) / River bush (red side)" },
    { time: "3:00", spot: "Pixel bush before lvl 6 to spot jungler" },
    { time: "6:00", spot: "Dragon pit + control ward on river" },
  ];
  if (pos.startsWith("uti") || pos.startsWith("sup")) return [
    { time: "0:00", spot: "Lane bush before minions spawn" },
    { time: "2:30", spot: "Pixel bush / tri-bush to spot ganks" },
    { time: "4:30", spot: "River + control ward in dragon pit" },
    { time: "8:00", spot: "Track scuttle, ward enemy jungle entrances" },
  ];
  return [];
}

function WardPlacement({ myPos, enemies }: { myPos: string; enemies: DraftPlayer[] }) {
  const enemyJgl = enemies.find(e => e.champion_id > 0 && (e.position || "").toLowerCase().startsWith("jun"));
  const tips = getWardTips(myPos, enemyJgl?.champion_id ?? null);
  if (tips.length === 0) return null;
  return (
    <div className="ward-placement">
      <div className="ward-placement-header">
        <span className="ward-placement-title">Ward Placement</span>
        {enemyJgl && (
          <span className="ward-placement-vs">
            vs {getJunglerStyle(enemyJgl.champion_id)} jungler
          </span>
        )}
      </div>
      <div className="ward-placement-list">
        {tips.map((t, i) => (
          <div key={i} className="ward-tip">
            <span className="ward-tip-time">{t.time}</span>
            <span className="ward-tip-spot">{t.spot}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrinketRecommendation({ myPos, enemies }: { myPos: string; enemies: DraftPlayer[] }) {
  const visibleEnemies = enemies.filter(e => e.champion_id > 0);
  if (visibleEnemies.length === 0) return null;
  const rec = recommendTrinket(myPos, enemies);
  const info = TRINKET_INFO[rec.kind];
  return (
    <div className={`trinket-rec trinket-${rec.kind}`}>
      <div className="trinket-rec-icon">{rec.kind === "yellow" ? "👁" : rec.kind === "sweeping" ? "🔍" : "🔭"}</div>
      <div className="trinket-rec-info">
        <div className="trinket-rec-name">{info.name}</div>
        <div className="trinket-rec-reason">{rec.reason}</div>
      </div>
    </div>
  );
}

function pairLanes(allies: DraftPlayer[], enemies: DraftPlayer[]): LaneMatchup[] {
  const positions: Role[] = ["top", "jungle", "middle", "bottom", "utility"];
  const pairs: LaneMatchup[] = [];
  // Track which enemies have been paired so we don't double-assign.
  const usedEnemyIds = new Set<number>();
  // Helper: pick best enemy for a given ally pos, skipping already-used.
  const pickForPos = (pos: Role): DraftPlayer | null => {
    const visible = enemies.filter(p => p.champion_id > 0 && !usedEnemyIds.has(p.champion_id));
    if (visible.length === 0) return null;
    const direct = visible.find(p => (p.position || "").toLowerCase() === pos);
    if (direct) return direct;
    const byPrimary = visible.find(p => getChampRoles(p.champion_id)[0] === pos);
    if (byPrimary) return byPrimary;
    const bySecondary = visible.find(p => getChampRoles(p.champion_id).includes(pos));
    if (bySecondary) return bySecondary;
    return null;
  };
  for (const pos of positions) {
    const a = allies.find(p => p.champion_id > 0 && (p.position || "").toLowerCase() === pos);
    if (!a) continue;
    const e = pickForPos(pos);
    if (!e) continue;
    usedEnemyIds.add(e.champion_id);
    const ac = getCurve(a.champion_id);
    const ec = getCurve(e.champion_id);
    const earlyDelta = ac.early - ec.early;
    const lateDelta = ac.late - ec.late;
    const avg = (earlyDelta + (ac.mid - ec.mid) + lateDelta) / 3;
    const verdict: LaneMatchup["verdict"] = avg >= 0.7 ? "favored" : avg <= -0.7 ? "unfavored" : "even";
    pairs.push({ position: pos, ally: a, enemy: e, verdict, earlyDelta, lateDelta });
  }
  return pairs;
}

function AllLanesMatchup({ allies, enemies }: { allies: DraftPlayer[]; enemies: DraftPlayer[] }) {
  const pairs = pairLanes(allies, enemies);
  if (pairs.length === 0) return null;
  return (
    <div className="all-lanes">
      <div className="all-lanes-title">Lane matchups</div>
      <div className="all-lanes-list">
        {pairs.map(p => (
          <div key={p.position} className={`all-lanes-row all-lanes-${p.verdict}`}>
            <span className="all-lanes-pos">
              <PositionIcon pos={p.position} size={12} /> {POSITION_LABELS[p.position] || p.position.toUpperCase()}
            </span>
            <ChampionIcon championId={p.ally.champion_id} size={24} />
            <span className="all-lanes-vs">vs</span>
            <ChampionIcon championId={p.enemy.champion_id} size={24} />
            <span className={`all-lanes-verdict all-lanes-verdict-${p.verdict}`}>
              {p.verdict === "favored" ? "FAVORED" : p.verdict === "unfavored" ? "UNFAVORED" : "EVEN"}
            </span>
            <span className="all-lanes-delta" title="Early / Late delta">
              E {p.earlyDelta > 0 ? "+" : ""}{p.earlyDelta} · L {p.lateDelta > 0 ? "+" : ""}{p.lateDelta}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function analyzeAllyComp(allyIds: number[]): CompCallout[] {
  if (allyIds.length < 3) return [];
  const callouts: CompCallout[] = [];

  const engage = allyIds.filter(id => TRAIT_ENGAGE.has(id));
  const frontline = allyIds.filter(id => TRAIT_FRONTLINE.has(id));
  const peel = allyIds.filter(id => TRAIT_PEEL.has(id));
  const scaling = allyIds.filter(id => TRAIT_SCALING.has(id));
  const burst = allyIds.filter(id => TRAIT_BURST.has(id));

  // Strengths
  if (engage.length >= 2) callouts.push({ tone: "good", text: `Strong engage (${engage.length} champs) — initiate teamfights` });
  if (frontline.length >= 2) callouts.push({ tone: "good", text: `Solid frontline (${frontline.length}) — peel-friendly comp` });
  if (scaling.length >= 2) callouts.push({ tone: "good", text: `Heavy scaling (${scaling.length}) — play for late game` });
  if (burst.length >= 3) callouts.push({ tone: "good", text: `Burst comp — pick threats and end fights fast` });

  // Gaps
  if (engage.length === 0) callouts.push({ tone: "warn", text: "No reliable engage — wait for enemy initiation" });
  if (frontline.length === 0) callouts.push({ tone: "warn", text: "No frontline — carries exposed in teamfights" });
  if (peel.length === 0 && scaling.length >= 2) callouts.push({ tone: "warn", text: "Scaling carries with no peel — vulnerable to dive" });

  return callouts.slice(0, 4);
}

function CompCallouts({ allies }: { allies: DraftPlayer[] }) {
  const ids = allies.filter(a => a.champion_id > 0).map(a => a.champion_id);
  const callouts = analyzeAllyComp(ids);
  if (callouts.length === 0) return null;
  return (
    <div className="comp-callouts">
      <div className="comp-callouts-title">Team Composition</div>
      <div className="comp-callouts-list">
        {callouts.map((c, i) => (
          <div key={i} className={`comp-callout comp-callout-${c.tone}`}>
            <span className="comp-callout-icon">{c.tone === "good" ? "✓" : "⚠"}</span>
            <span className="comp-callout-text">{c.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DamageCompBar({ allies, enemies }: { allies: DraftPlayer[]; enemies: DraftPlayer[] }) {
  function calc(players: DraftPlayer[]) {
    const picked = players.filter(p => p.champion_id > 0);
    if (picked.length === 0) return { ap: 0, ad: 0, total: 0 };
    const ap = picked.filter(p => CHAMP_DAMAGE_TYPE[p.champion_id] === "ap").length;
    return { ap, ad: picked.length - ap, total: picked.length };
  }
  const ally = calc(allies);
  const enemy = calc(enemies);
  if (ally.total === 0 && enemy.total === 0) return null;

  function Bar({ label, data, color }: { label: string; data: { ap: number; ad: number; total: number }; color: string }) {
    if (data.total === 0) return null;
    const adPct = Math.round((data.ad / data.total) * 100);
    const apPct = 100 - adPct;
    const heavy = adPct >= 80 ? "Heavy AD" : apPct >= 80 ? "Heavy AP" : null;
    return (
      <div className="dmg-row">
        <span className="dmg-label" style={{ color }}>{label}</span>
        <div className="dmg-bar">
          <div className="dmg-ad" style={{ width: `${adPct}%` }}>{adPct > 15 ? `${adPct}% AD` : ""}</div>
          <div className="dmg-ap" style={{ width: `${apPct}%` }}>{apPct > 15 ? `${apPct}% AP` : ""}</div>
        </div>
        {heavy && <span className="dmg-warn">{heavy}</span>}
      </div>
    );
  }

  return (
    <div className="dmg-comp">
      <Bar label="Ally" data={ally} color="var(--accent-blue)" />
      <Bar label="Enemy" data={enemy} color="var(--accent-red)" />
    </div>
  );
}

function getPlayerLabels(p: LiveGamePlayer): { text: string; cls: string }[] {
  const labels: { text: string; cls: string }[] = [];
  if (p.smurf && p.smurf.games_played >= 10 && p.smurf.unique_champions <= 3) labels.push({ text: "OTP", cls: "label-otp" });
  if (p.champ_games === 0) labels.push({ text: "1st TIME", cls: "label-autofill" });
  if (p.streak >= 4) labels.push({ text: `${p.streak}W Streak`, cls: "label-winstreak" });
  else if (p.streak <= -4) labels.push({ text: "TILTED", cls: "label-tilted" });
  else if (p.streak <= -3) labels.push({ text: `${Math.abs(p.streak)}L Streak`, cls: "label-lossstreak" });
  else if (p.streak >= 3) labels.push({ text: `${p.streak}W Streak`, cls: "label-winstreak" });
  if (p.ranked_losses > 0 && p.ranked_win_rate >= 0.58 && (p.ranked_wins + p.ranked_losses) >= 20) labels.push({ text: "HIGH WR", cls: "label-highwr" });
  return labels;
}

interface SpellCdProps {
  gameTime: number;
  spellTimers: Map<string, number>; // key: "name_spellId" -> game_time when used
  onSpellClick?: (playerName: string, spellId: number) => void;
}

function SpellCdIcon({ spellId, playerName, gameTime, spellTimers, onSpellClick }: { spellId: number; playerName: string } & SpellCdProps) {
  const key = `${playerName}_${spellId}`;
  const usedAt = spellTimers.get(key);
  const cd = SPELL_COOLDOWNS[spellId] || 300;
  const remaining = usedAt != null ? Math.max(0, cd - (gameTime - usedAt)) : 0;
  const onCd = remaining > 0;
  const pct = onCd ? remaining / cd : 0;
  const spellKey = SPELL_KEYS[spellId];
  const spellName = SPELL_NAMES[spellId] || "Spell";

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (onCd) {
      // Click again to cancel timer
      spellTimers.delete(key);
    } else {
      onSpellClick?.(playerName, spellId);
    }
  }

  return (
    <div className={`spell-cd-wrap ${onCd ? "spell-on-cd" : ""}`} onClick={handleClick} title={onCd ? `${spellName}: ${Math.ceil(remaining)}s` : `Click when ${spellName} is used`}>
      {spellKey && <img src={spellIconUrl(spellId)} alt={spellName} className="spell-cd-img" />}
      {onCd && (
        <>
          <svg className="spell-cd-ring" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="none" stroke="var(--accent-red)" strokeWidth="2" strokeDasharray={`${pct * 62.83} 62.83`} strokeLinecap="round" transform="rotate(-90 12 12)" opacity="0.8" />
          </svg>
          <span className="spell-cd-text">{Math.ceil(remaining)}</span>
        </>
      )}
    </div>
  );
}

function SpellStaticIcon({ spellId }: { spellId: number }) {
  const spellKey = SPELL_KEYS[spellId];
  const spellName = SPELL_NAMES[spellId] || "Spell";
  if (!spellKey) return <div className="spell-cd-wrap" title={spellName} />;
  return (
    <div className="spell-cd-wrap" title={spellName}>
      <img src={spellIconUrl(spellId)} alt={spellName} className="spell-cd-img" />
    </div>
  );
}

function LiveGamePlayerCard({ p, onViewPlayer, isEnemy, spellCd }: { p: LiveGamePlayer; onViewPlayer?: (puuid: string) => void; isEnemy?: boolean; spellCd?: SpellCdProps }) {
  const totalGames = p.ranked_wins + p.ranked_losses;
  const champWr = p.champ_games > 0 ? (p.champ_wins / p.champ_games * 100) : 0;
  const live = p.live;
  return (
    <div className="lg-player" onClick={() => onViewPlayer?.(p.puuid)} style={{ cursor: p.puuid ? "pointer" : "default" }}>
      <div className="lg-champ-col">
        <ChampionIcon championId={p.champion_id} size={40} />
        {live && <span className="lg-level">{live.level}</span>}
      </div>
      <div className="lg-player-info">
        <span className="lg-player-name">
          {p.summoner_name}
          {p.smurf && p.smurf.score >= 50 && (
            <span
              className={`smurf-badge ${p.smurf.score >= 75 ? "smurf-high" : "smurf-medium"}`}
              title={`Smurf Score: ${p.smurf.score}/100\nLevel: ${p.smurf.account_level}\nWin Rate: ${(p.smurf.win_rate * 100).toFixed(0)}%\nGames: ${p.smurf.games_played}\nKDA: ${p.smurf.avg_kda.toFixed(1)}\nChampions: ${p.smurf.unique_champions}`}
            >
              SMURF
            </span>
          )}
        </span>
        <span className="lg-player-sub">
          {p.rank && <>
            <RankEmblem rank={p.rank} size={14} />
            <span className={`lg-rank rank-${p.rank.split(' ')[0]?.toLowerCase()}`}>{p.rank}</span>
          </>}
          {totalGames > 0 && p.ranked_losses > 0 && <span className="lg-ranked-wl">{p.ranked_wins}W {p.ranked_losses}L</span>}
          {totalGames > 0 && p.ranked_losses > 0 && (
            <span className={`lg-wr ${p.ranked_win_rate >= 0.52 ? "lg-wr-good" : p.ranked_win_rate < 0.48 ? "lg-wr-bad" : ""}`}>
              {(p.ranked_win_rate * 100).toFixed(0)}%
            </span>
          )}
          {getPlayerLabels(p).map((l, li) => (
            <span key={li} className={`player-label ${l.cls}`}>{l.text}</span>
          ))}
        </span>
      </div>
      {live && (live.spell1_id > 0 || live.spell2_id > 0) && (
        <div className="lg-spells">
          {isEnemy && spellCd ? (
            <>
              <SpellCdIcon spellId={live.spell1_id} playerName={p.summoner_name} {...spellCd} />
              <SpellCdIcon spellId={live.spell2_id} playerName={p.summoner_name} {...spellCd} />
            </>
          ) : (
            <>
              <SpellStaticIcon spellId={live.spell1_id} />
              <SpellStaticIcon spellId={live.spell2_id} />
            </>
          )}
        </div>
      )}
      {live ? (
        <div className="lg-player-live">
          <span className="lg-live-kda">
            <span className="lg-live-k">{live.kills}</span>/<span className="lg-live-d">{live.deaths}</span>/<span className="lg-live-a">{live.assists}</span>
          </span>
          <span className="lg-live-cs">{live.cs} CS</span>
          <div className="lg-live-items">
            {live.items.filter(id => id > 0).map((id, j) => (
              <ItemIcon key={j} id={id} size={18} className="lg-item-icon" />
            ))}
          </div>
        </div>
      ) : (
        <div className="lg-player-stats">
          {p.champ_games > 0 ? (
            <div className="lg-champ-stats">
              <span className={`lg-champ-wr ${champWr >= 55 ? "lg-wr-good" : champWr < 45 ? "lg-wr-bad" : ""}`}>
                {champWr.toFixed(0)}%
              </span>
              <span className="lg-champ-detail">{p.champ_games}G {p.champ_kda.toFixed(1)} KDA</span>
            </div>
          ) : (
            <div className="lg-champ-stats">
              <span className="lg-champ-detail lg-first-time">1st time</span>
            </div>
          )}
          {p.streak !== 0 && (
            <span className={`lg-streak ${p.streak > 0 ? "lg-streak-win" : "lg-streak-loss"}`}>
              {p.streak > 0 ? `${p.streak}W` : `${Math.abs(p.streak)}L`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function playerTotalGold(p: LiveGamePlayer): number {
  if (!p.live) return 0;
  return p.live.total_gold;
}

function normPos(pos: string): string {
  const u = pos.toUpperCase();
  if (u === "MID" || u === "MIDDLE") return "MID";
  if (u === "ADC" || u === "BOTTOM") return "BOT";
  if (u === "UTILITY" || u === "SUPPORT") return "SUP";
  if (u === "JUNGLE") return "JNG";
  if (u === "TOP") return "TOP";
  return u;
}

function LaneMatchups({ allies, enemies }: { allies: LiveGamePlayer[]; enemies: LiveGamePlayer[] }) {
  // Pair by normalized position
  const pairs: { pos: string; ally: LiveGamePlayer; enemy: LiveGamePlayer; diff: number }[] = [];
  const usedEnemies = new Set<number>();

  for (const ally of allies) {
    if (!ally.position || !ally.live) continue;
    const allyPos = normPos(ally.position);
    const enemyIdx = enemies.findIndex((e, i) => !usedEnemies.has(i) && e.position && normPos(e.position) === allyPos && e.live);
    if (enemyIdx >= 0) {
      usedEnemies.add(enemyIdx);
      const enemy = enemies[enemyIdx];
      const diff = playerTotalGold(ally) - playerTotalGold(enemy);
      pairs.push({ pos: allyPos, ally, enemy, diff });
    }
  }

  // Sort by position order
  const posOrder = ["TOP", "JNG", "MID", "BOT", "SUP"];
  pairs.sort((a, b) => posOrder.indexOf(a.pos) - posOrder.indexOf(b.pos));

  if (pairs.length === 0) return null;

  return (
    <div className="lane-matchups">
      {pairs.map((m, i) => (
        <div key={i} className="lane-row">
          <ChampionIcon championId={m.ally.champion_id} size={20} />
          <PositionIcon pos={m.pos} size={14} />
          <span className={`lane-diff ${m.diff > 300 ? "lg-wr-good" : m.diff < -300 ? "lg-wr-bad" : ""}`}>
            {m.diff > 0 ? "+" : ""}{Math.round(m.diff).toLocaleString()}g
          </span>
          <ChampionIcon championId={m.enemy.champion_id} size={20} />
        </div>
      ))}
    </div>
  );
}

// Alert dispatch with cooldown-based dedup and optional TTS audio cue.
// Same `key` won't re-fire visually or audibly within `cooldownMs` (default 30s).
interface AlertOptions {
  type?: "info" | "warning";
  cooldownMs?: number;
  speak?: string; // text to read aloud (defaults to `text`)
  noSpeak?: boolean; // visual only
}
function useAlertManager(
  setAlerts: React.Dispatch<React.SetStateAction<{ id: string; text: string; type: "info" | "warning"; time: number }[]>>,
) {
  const cooldowns = useRef<Map<string, number>>(new Map());
  return useMemo(() => ({
    push(key: string, text: string, gameTime: number, opts: AlertOptions = {}) {
      const cdMs = opts.cooldownMs ?? 30_000;
      const now = Date.now();
      const last = cooldowns.current.get(key) ?? 0;
      if (now - last < cdMs) return;
      cooldowns.current.set(key, now);
      setAlerts(prev => [{
        id: `${key}_${gameTime}`,
        text,
        type: opts.type ?? "info",
        time: gameTime,
      }, ...prev].slice(0, 5));
      if (!opts.noSpeak) {
        invoke("speak", { text: opts.speak ?? text }).catch(() => {});
      }
    },
  }), [setAlerts]);
}

function LiveGameView({ game, onViewPlayer }: { game: LiveGameState; onViewPlayer?: (puuid: string) => void }) {
  const ld = game.live_data;
  // Calculate total gold from players (unspent + items) instead of backend values
  const allyGold = game.allies.reduce((s, p) => s + playerTotalGold(p), 0);
  const enemyGold = game.enemies.reduce((s, p) => s + playerTotalGold(p), 0);
  const goldDiff = allyGold - enemyGold;
  const recentEvents = ld?.events.slice(-5).reverse() ?? [];
  const objState = ld ? getObjectiveState(ld.events, ld.game_time) : null;
  const winProb = ld && objState ? estimateWinProbability(goldDiff, ld.game_time, objState.allyDragons, objState.enemyDragons, objState.allyBaronActive, objState.enemyBaronActive) : 0.5;

  // Spell cooldown tracking (persists across re-renders)
  const spellTimers = useRef<Map<string, number>>(new Map()).current;
  const gameTime = ld?.game_time ?? 0;

  function handleSpellClick(playerName: string, spellId: number) {
    spellTimers.set(`${playerName}_${spellId}`, gameTime);
  }

  const spellCd: SpellCdProps = { gameTime, spellTimers, onSpellClick: handleSpellClick };

  // Power spike alerts
  const prevEnemyItems = useRef<Map<string, Set<number>>>(new Map());
  const [alerts, setAlerts] = useState<{ id: string; text: string; type: "info" | "warning"; time: number }[]>([]);
  const alertManager = useAlertManager(setAlerts);

  // Find local player
  const localPlayer = game.allies.find(p => p.live != null) ?? game.allies[0];
  const localLive = localPlayer?.live;
  const build = game.recommended_build;

  // Build the full recommended sequence for local player
  const buildSlots = localLive ? computeBuildSequence(build, localLive.items, localLive.current_gold) : [];
  const nextSlot = buildSlots.find(s => s.state === "next");

  // Threat-response suggestion (situational defensive item)
  const threatSuggestion = (localLive && localPlayer && ld)
    ? suggestThreatResponse(game.enemies, localLive.items, localPlayer.position || "", localPlayer.champion_id, ld.game_time)
    : null;

  // Detect enemy item completions
  useEffect(() => {
    if (!ld) return;
    for (const enemy of game.enemies) {
      if (!enemy.live) continue;
      const key = enemy.summoner_name;
      const prev = prevEnemyItems.current.get(key) || new Set();
      const current = new Set(enemy.live.items);
      for (const id of current) {
        if (!prev.has(id)) {
          const item = getItemData(id);
          if (item && item.gold >= 2500) {
            const champName = championCache?.[enemy.champion_id.toString()]?.name || enemy.summoner_name;
            alertManager.push(
              `item_${key}_${id}`,
              `${champName} completed ${item.name}`,
              gameTime,
              {
                type: "warning",
                cooldownMs: 60_000,
                speak: `${champName} completed ${item.name}`,
              },
            );
          }
        }
      }
      prevEnemyItems.current.set(key, current);
    }
    // Auto-dismiss alerts older than 15 seconds
    setAlerts(prev => prev.filter(a => gameTime - a.time < 15));
  }, [gameTime, game.enemies, ld, alertManager]);

  return (
    <div className="lg-layout">
      <div className="lg-header">
        <h3 className="section-title">In Game</h3>
        <div className="lg-header-right">
          {ld && <span className="lg-timer">{formatGameTime(ld.game_time)}</span>}
          <span className="lg-queue">{game.queue_name}</span>
        </div>
      </div>

      {ld && (
        <div className="lg-gold-bar">
          <span className="lg-gold-ally">{Math.round(allyGold).toLocaleString()}g</span>
          <div className="lg-gold-track">
            <div className="lg-gold-fill" style={{ width: `${allyGold / (allyGold + enemyGold + 1) * 100}%` }} />
          </div>
          <span className="lg-gold-enemy">{Math.round(enemyGold).toLocaleString()}g</span>
          <span className={`lg-gold-diff ${goldDiff > 0 ? "lg-wr-good" : goldDiff < 0 ? "lg-wr-bad" : ""}`}>
            {goldDiff > 0 ? "+" : ""}{Math.round(goldDiff).toLocaleString()}
          </span>
          <span className={`lg-win-prob ${winProb > 0.55 ? "lg-wr-good" : winProb < 0.45 ? "lg-wr-bad" : ""}`}>
            {(winProb * 100).toFixed(0)}%
          </span>
        </div>
      )}

      {ld && <LaneMatchups allies={game.allies} enemies={game.enemies} />}

      {buildSlots.length > 0 && (
        <BuildSequencePanel
          slots={buildSlots}
          nextSlot={nextSlot}
          currentGold={localLive?.current_gold ?? 0}
          threat={threatSuggestion}
          alternatives={game.recommended_alternatives?.core_items ?? []}
          currentCoreIds={build?.core_items ?? []}
        />
      )}

      {alerts.length > 0 && (
        <div className="lg-alerts">
          {alerts.map(a => (
            <div key={a.id} className={`lg-alert lg-alert-${a.type}`}>
              {a.text}
            </div>
          ))}
        </div>
      )}

      <div className="lg-teams">
        <div className="lg-team">
          <h4 className="draft-team-label" style={{ color: "var(--accent-blue)" }}>Your Team</h4>
          <div className="lg-players">
            {sortByPosition(game.allies).map((p, i) => (
              <LiveGamePlayerCard key={i} p={p} onViewPlayer={onViewPlayer} />
            ))}
          </div>
        </div>
        <div className="lg-vs">VS</div>
        <div className="lg-team">
          <h4 className="draft-team-label" style={{ color: "var(--accent-red)" }}>Enemy Team</h4>
          <div className="lg-players">
            {sortByPosition(game.enemies).map((p, i) => (
              <LiveGamePlayerCard key={i} p={p} onViewPlayer={onViewPlayer} isEnemy spellCd={spellCd} />
            ))}
          </div>
        </div>
      </div>

      {ld && <ObjectiveTimers events={ld.events} gameTime={ld.game_time} />}

      {recentEvents.length > 0 && (
        <div className="lg-events">
          <h4 className="lg-events-title">Objectives</h4>
          {recentEvents.map((ev, i) => (
            <div key={i} className={`lg-event lg-event-${ev.event_type.toLowerCase()}`}>
              <span className="lg-event-time">{formatGameTime(ev.time)}</span>
              <span className="lg-event-label">{ev.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Ban Card ---

function BanCard({ ban }: { ban: BanSuggestion }) {
  const info = useChampionName(ban.champion_id);
  return (
    <div className="rec-card ban-card rec-clickable" onClick={() => invoke("ban_champion", { championId: ban.champion_id })} title="Click to ban">
      <ChampionIcon championId={ban.champion_id} size={36} className="rec-icon" />
      <div className="rec-info">
        <span className="rec-name">{info?.name || "..."}</span>
        <div className="rec-stats">
          <span className="rec-wr">{(ban.win_rate * 100).toFixed(1)}% WR</span>
          <span className="ban-pr">{(ban.pick_rate * 100).toFixed(1)}% PR</span>
        </div>
      </div>
      <span className="ban-threat">BAN</span>
    </div>
  );
}

// --- Comfort Card ---


// --- Lobby Hero (splash art of most played champion) ---

function LobbyBackground({ history }: { history: MatchHistoryEntry[] }) {
  const counts: Record<number, number> = {};
  for (const m of history) {
    counts[m.champion_id] = (counts[m.champion_id] || 0) + 1;
  }
  const topChampId = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)[0]?.[0];

  const champInfo = useChampionName(topChampId ? Number(topChampId) : null);

  if (!champInfo) return null;

  return (
    <div className="lobby-bg" style={{
      backgroundImage: `url(${splashUrl(champInfo.key)})`,
    }} />
  );
}

// --- Champion Stats Bar ---

function ChampionStatsBar({ history, filter, onFilter }: {
  history: MatchHistoryEntry[];
  filter: number | null;
  onFilter: (id: number | null) => void;
}) {
  // Group by champion
  const stats: Record<number, { games: number; wins: number; kills: number; deaths: number; assists: number }> = {};
  for (const m of history) {
    if (!stats[m.champion_id]) {
      stats[m.champion_id] = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    }
    const s = stats[m.champion_id];
    s.games++;
    if (m.win) s.wins++;
    s.kills += m.kills;
    s.deaths += m.deaths;
    s.assists += m.assists;
  }

  const sorted = Object.entries(stats)
    .map(([id, s]) => ({ id: Number(id), ...s }))
    .sort((a, b) => {
      // Score: prioritize games played but boost high WR
      const scoreA = a.games * (a.wins / a.games);
      const scoreB = b.games * (b.wins / b.games);
      return scoreB - scoreA;
    })
    .slice(0, 5);

  if (sorted.length <= 1) return null;

  return (
    <div className="champ-stats-bar">
      {filter && (
        <button className="cs-filter-clear" onClick={() => onFilter(null)}>All</button>
      )}
      {sorted.map(s => {
        const wr = ((s.wins / s.games) * 100).toFixed(0);
        const isActive = filter === s.id;
        return (
          <div
            key={s.id}
            className={`champ-stat-chip ${isActive ? "champ-stat-active" : ""}`}
            onClick={() => onFilter(isActive ? null : s.id)}
          >
            <ChampionIcon championId={s.id} size={24} />
            <div className="champ-stat-info">
              <span className="champ-stat-games">{s.games}g</span>
              <span className={`champ-stat-wr ${Number(wr) >= 50 ? "pg-above" : "pg-below"}`}>{wr}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Post Game View ---

const POS_ORDER: Record<string, number> = {
  TOP: 0, JUNGLE: 1, MIDDLE: 2, MID: 2, BOTTOM: 3, ADC: 3, UTILITY: 4, SUPPORT: 4,
};

// --- Elo Benchmarks (per tier, averaged across roles) ---
// Source: community analytics averages for ranked solo queue
const ELO_BENCHMARKS: Record<string, { cs_min: number; vision_min: number; kda: number; dmg_share: number; kp: number; gold_min: number }> = {
  IRON:         { cs_min: 4.0, vision_min: 0.30, kda: 1.6, dmg_share: 0.20, kp: 0.45, gold_min: 280 },
  BRONZE:       { cs_min: 4.5, vision_min: 0.35, kda: 1.9, dmg_share: 0.20, kp: 0.48, gold_min: 300 },
  SILVER:       { cs_min: 5.0, vision_min: 0.40, kda: 2.2, dmg_share: 0.20, kp: 0.50, gold_min: 320 },
  GOLD:         { cs_min: 5.5, vision_min: 0.48, kda: 2.5, dmg_share: 0.20, kp: 0.52, gold_min: 340 },
  PLATINUM:     { cs_min: 6.0, vision_min: 0.55, kda: 2.7, dmg_share: 0.20, kp: 0.54, gold_min: 360 },
  EMERALD:      { cs_min: 6.5, vision_min: 0.60, kda: 2.9, dmg_share: 0.20, kp: 0.55, gold_min: 375 },
  DIAMOND:      { cs_min: 7.0, vision_min: 0.68, kda: 3.1, dmg_share: 0.20, kp: 0.57, gold_min: 390 },
  MASTER:       { cs_min: 7.5, vision_min: 0.75, kda: 3.3, dmg_share: 0.20, kp: 0.58, gold_min: 410 },
  GRANDMASTER:  { cs_min: 7.8, vision_min: 0.80, kda: 3.5, dmg_share: 0.20, kp: 0.60, gold_min: 425 },
  CHALLENGER:   { cs_min: 8.0, vision_min: 0.85, kda: 3.7, dmg_share: 0.20, kp: 0.62, gold_min: 440 },
};

// Role multipliers applied on top of the tier benchmark. The tier values above
// are role-averaged; a Yuumi SUP with 3 vision/min compared against the raw
// gold-tier 0.48 produces a misleading +500% — supports should be compared
// against the support baseline (~1.7 vision/min in Gold).
type RoleKey = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";
const ROLE_MULTIPLIERS: Record<RoleKey, { cs_min: number; vision_min: number; kda: number; dmg_share: number; kp: number; gold_min: number }> = {
  TOP:     { cs_min: 1.20, vision_min: 0.95, kda: 0.95, dmg_share: 1.10, kp: 0.92, gold_min: 1.05 },
  JUNGLE:  { cs_min: 0.85, vision_min: 1.45, kda: 1.05, dmg_share: 1.00, kp: 1.20, gold_min: 1.00 },
  MIDDLE:  { cs_min: 1.30, vision_min: 1.00, kda: 1.10, dmg_share: 1.30, kp: 1.05, gold_min: 1.12 },
  BOTTOM:  { cs_min: 1.45, vision_min: 0.95, kda: 1.15, dmg_share: 1.55, kp: 1.05, gold_min: 1.22 },
  UTILITY: { cs_min: 0.18, vision_min: 3.50, kda: 1.00, dmg_share: 0.40, kp: 1.20, gold_min: 0.78 },
};

function normalizeRoleKey(position: string): RoleKey | null {
  const p = position.toUpperCase();
  if (p === "TOP") return "TOP";
  if (p === "JUNGLE" || p === "JNG" || p === "JUN") return "JUNGLE";
  if (p === "MIDDLE" || p === "MID") return "MIDDLE";
  if (p === "BOTTOM" || p === "ADC" || p === "BOT") return "BOTTOM";
  if (p === "UTILITY" || p === "SUPPORT" || p === "SUP") return "UTILITY";
  return null;
}

function getRoleAdjustedBenchmark(tier: string, position: string) {
  const base = ELO_BENCHMARKS[tier.toUpperCase()] || ELO_BENCHMARKS.GOLD;
  const role = normalizeRoleKey(position);
  if (!role) return base;
  const mult = ROLE_MULTIPLIERS[role];
  return {
    cs_min:     base.cs_min * mult.cs_min,
    vision_min: base.vision_min * mult.vision_min,
    kda:        base.kda * mult.kda,
    dmg_share:  base.dmg_share * mult.dmg_share,
    kp:         base.kp * mult.kp,
    gold_min:   base.gold_min * mult.gold_min,
  };
}

// --- Unified performance panel: vs-elo comparison + phase trend in one ---
function PerformancePanel({ player, duration, tier, phases }: {
  player: PostGamePlayer;
  duration: number;
  tier: string;
  phases: PhaseStats[];
}) {
  const bench = getRoleAdjustedBenchmark(tier, player.position || "");
  const roleLabel = (player.position || "").toUpperCase() || "ALL ROLES";
  const mins = Math.max(duration / 60, 1);

  // Per-phase derived series (used in tiles where data is available)
  const phaseLabels = phases.map(p => p.phase);
  const phaseKda = phases.map(p => p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths);
  const phaseCs = phases.map(p => p.cs_per_min);
  const phaseGold = phases.map(p => p.gold_per_min);
  const phaseKDAStr = phases.map(p => `${p.kills}/${p.deaths}/${p.assists}`);

  type Tile = {
    label: string;
    value: number;
    avg: number;
    fmt: (v: number) => string;
    phaseValues?: number[];
    phaseFmt?: (v: number) => string;
    phaseLabelOverride?: string[];
  };

  const tiles: Tile[] = [
    { label: "KDA", value: player.deaths === 0 ? (player.kills + player.assists) : (player.kills + player.assists) / player.deaths,
      avg: bench.kda, fmt: v => v.toFixed(1),
      phaseValues: phaseKda, phaseFmt: v => v.toFixed(1), phaseLabelOverride: phaseKDAStr },
    { label: "CS/min", value: player.cs / mins, avg: bench.cs_min, fmt: v => v.toFixed(1),
      phaseValues: phaseCs, phaseFmt: v => v.toFixed(1) },
    { label: "Gold/min", value: player.gold_earned / mins, avg: bench.gold_min, fmt: v => Math.round(v).toString(),
      phaseValues: phaseGold, phaseFmt: v => Math.round(v).toString() },
    { label: "Vision/min", value: player.vision_score / mins, avg: bench.vision_min, fmt: v => v.toFixed(2) },
    { label: "DMG share", value: player.damage_share, avg: bench.dmg_share, fmt: v => `${(v * 100).toFixed(0)}%` },
    { label: "KP", value: player.kill_participation, avg: bench.kp, fmt: v => `${(v * 100).toFixed(0)}%` },
  ];

  // Diverging bar: width is |diff| capped at the visible side (50%).
  // Cap range at ±100% — anything beyond shows an "off-scale" ▶▶ marker.
  const CAP = 1.0;
  const renderBar = (diff: number, cls: string) => {
    const clipped = Math.max(-CAP, Math.min(CAP, diff));
    const widthPct = Math.abs(clipped) * 50; // 50% of full track per side
    const offScale = Math.abs(diff) > CAP;
    const positive = diff >= 0;
    const fillStyle = positive
      ? { left: "50%", width: `${widthPct}%` }
      : { right: "50%", width: `${widthPct}%` };
    return (
      <div className="perf-bar">
        <div className="perf-bar-track">
          <div className={`perf-bar-fill ${cls}`} style={fillStyle} />
          <div className="perf-bar-axis" />
        </div>
        {offScale && <span className={`perf-bar-overflow ${positive ? "perf-overflow-right" : "perf-overflow-left"}`}>{positive ? "▶" : "◀"}</span>}
      </div>
    );
  };

  return (
    <div className="perf-panel">
      <h4 className="perf-title">
        Performance · <span className="perf-title-tier">{tier} {roleLabel}</span>
        <span className="perf-title-hint">vs role average</span>
      </h4>
      <div className="perf-grid">
        {tiles.map((t, i) => {
          const pct = t.avg > 0 ? t.value / t.avg : 1;
          const diff = pct - 1;
          const cls = diff > 0.1 ? "perf-above" : diff < -0.1 ? "perf-below" : "perf-even";
          return (
            <div key={i} className={`perf-tile ${cls}`}>
              <div className="perf-tile-head">
                <span className="perf-tile-label">{t.label}</span>
                <span className={`perf-tile-delta ${cls}`}>
                  {diff > 0 ? "+" : ""}{(diff * 100).toFixed(0)}%
                </span>
              </div>
              <div className="perf-tile-row">
                <span className={`perf-tile-value ${cls}`}>{t.fmt(t.value)}</span>
                <span className="perf-tile-avg">avg {t.fmt(t.avg)}</span>
              </div>
              {renderBar(diff, cls)}
              {t.phaseValues && phaseLabels.length > 0 && (
                <div className="perf-phase-row">
                  {t.phaseValues.map((v, pi) => {
                    const label = phaseLabels[pi]?.charAt(0) ?? "";
                    const display = t.phaseLabelOverride ? t.phaseLabelOverride[pi] : t.phaseFmt!(v);
                    return (
                      <div key={pi} className="perf-phase-cell" title={phaseLabels[pi]}>
                        <span className="perf-phase-tag">{label}</span>
                        <span className="perf-phase-val">{display}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GoldDiffTimeline({ timeline, deaths, duration }: { timeline: GoldDiffPoint[]; deaths: DeathImpact[]; duration: number }) {
  if (timeline.length < 3) return null;

  const width = 600;
  const height = 120;
  const pad = { top: 10, bottom: 20, left: 30, right: 30 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const maxAbs = Math.max(...timeline.map(p => Math.abs(p.gold_diff)), 1000);
  const maxTime = timeline[timeline.length - 1].game_time || duration;

  const toX = (t: number) => pad.left + (t / maxTime) * w;
  const toY = (g: number) => pad.top + h / 2 - (g / maxAbs) * (h / 2);
  const toYProb = (p: number) => pad.top + h - (p * h); // 0% at bottom, 100% at top

  // Compute win probability for each point
  const winProbPoints = timeline.map(p => {
    const prob = estimateWinProbability(p.gold_diff, p.game_time, 0, 0, false, false);
    return `${toX(p.game_time)},${toYProb(prob)}`;
  });

  // Build SVG path
  const points = timeline.map(p => `${toX(p.game_time)},${toY(p.gold_diff)}`);
  const areaAbove = `M${points[0]} ${points.join(" L")} L${toX(timeline[timeline.length - 1].game_time)},${toY(0)} L${toX(timeline[0].game_time)},${toY(0)} Z`;

  return (
    <div className="gold-timeline-panel">
      <h4 className="gold-timeline-title">Gold Advantage</h4>
      <svg viewBox={`0 0 ${width} ${height}`} className="gold-timeline-svg">
        {/* Zero line */}
        <line x1={pad.left} x2={width - pad.right} y1={toY(0)} y2={toY(0)} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="4,4" opacity="0.4" />

        {/* Gold diff area */}
        <defs>
          <linearGradient id="goldGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity="0.3" />
            <stop offset="50%" stopColor="transparent" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--accent-red)" stopOpacity="0.3" />
          </linearGradient>
        </defs>
        <path d={areaAbove} fill="url(#goldGrad)" />

        {/* Gold diff line */}
        <polyline points={points.join(" ")} fill="none" stroke="var(--text-primary)" strokeWidth="1.5" opacity="0.8" />

        {/* Win probability line */}
        <polyline points={winProbPoints.join(" ")} fill="none" stroke="var(--accent-gold)" strokeWidth="1.5" opacity="0.6" strokeDasharray="3,2" />
        {/* 50% reference line */}
        <line x1={pad.left} x2={width - pad.right} y1={toYProb(0.5)} y2={toYProb(0.5)} stroke="var(--accent-gold)" strokeWidth="0.5" opacity="0.2" strokeDasharray="2,4" />
        {/* Win prob axis labels */}
        <text x={width - pad.right + 4} y={toYProb(0.5) + 3} fontSize="7" fill="var(--accent-gold)" opacity="0.5">50%</text>
        <text x={width - pad.right + 4} y={pad.top + 4} fontSize="7" fill="var(--accent-gold)" opacity="0.5">Win</text>

        {/* Death markers */}
        {deaths.map((d, i) => (
          <circle key={i} cx={toX(d.game_time)} cy={toY(0)} r="3"
            fill={d.is_ally ? "var(--accent-red)" : "var(--accent-blue)"}
            opacity="0.7">
            <title>{d.summoner_name} died ({d.gold_swing > 0 ? "+" : ""}{Math.round(d.gold_swing)}g swing)</title>
          </circle>
        ))}

        {/* Time labels */}
        {[5, 10, 15, 20, 25, 30, 35, 40].filter(m => m * 60 < maxTime).map(m => (
          <text key={m} x={toX(m * 60)} y={height - 4} textAnchor="middle" fontSize="8" fill="var(--text-muted)">{m}m</text>
        ))}
      </svg>
    </div>
  );
}

function PostGameView({ stats, showBack, onViewPlayer }: { stats: PostGameStats; showBack?: boolean; onViewPlayer?: (puuid: string) => void }) {
  const sorted = [...stats.teams].sort((a, b) => (b.is_winner ? 1 : 0) - (a.is_winner ? 1 : 0));

  const maxDamage = Math.max(
    ...stats.teams.flatMap(t => t.players.map(p => p.total_damage)),
    1
  );

  return (
    <div className="postgame-layout">
      <div className="postgame-title-row">
        {showBack && (
          <button className="btn-back" onClick={() => invoke("back_to_lobby")}>&larr; Back</button>
        )}
        <h3 className="section-title">Match Summary</h3>
      </div>
      <div className="postgame-teams">
        {sorted.map((team, ti) => {
          const players = [...team.players].sort(
            (a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9)
          );
          return (
            <div key={ti} className={`postgame-team ${team.is_winner ? "postgame-win" : "postgame-loss"}`}>
              <div className="postgame-team-header">
                <span className={`postgame-result ${team.is_winner ? "win" : "loss"}`}>
                  {team.is_winner ? "Victory" : "Defeat"}
                </span>
                <span className="postgame-team-kda">
                  {players.reduce((s, p) => s + p.kills, 0)} / {players.reduce((s, p) => s + p.deaths, 0)} / {players.reduce((s, p) => s + p.assists, 0)}
                </span>
              </div>
              <div className="pg-col-headers">
                <span className="pg-col-h pg-h-player">Player</span>
                <span className="pg-col-h pg-h-kda">KDA</span>
                <span className="pg-col-h pg-h-dmg">Damage</span>
                <span className="pg-col-h pg-h-pct">DMG%</span>
                <span className="pg-col-h pg-h-pct">KP</span>
                <span className="pg-col-h pg-h-cs">CS</span>
                <span className="pg-col-h pg-h-vis">Vision</span>
                <span className="pg-col-h pg-h-gold">Gold</span>
                <span className="pg-col-h pg-h-items">Items</span>
              </div>
              {players.map((p, pi) => (
                <PostGameRow key={pi} player={p} maxDamage={maxDamage} team={team} onViewPlayer={onViewPlayer} />
              ))}
            </div>
          );
        })}
      </div>

      {stats.gold_timeline.length > 0 && (
        <GoldDiffTimeline timeline={stats.gold_timeline} deaths={stats.death_events} duration={stats.game_duration_secs} />
      )}

      {/* Unified performance panel (vs role-elo benchmark + phase trends) */}
      {stats.game_duration_secs > 0 && (() => {
        const local = stats.teams.flatMap(t => t.players).find(p => p.is_local);
        if (!local || !local.rank) return null;
        const tier = local.rank.split(" ")[0];
        if (!tier || !ELO_BENCHMARKS[tier.toUpperCase()]) return null;
        return <PerformancePanel player={local} duration={stats.game_duration_secs} tier={tier} phases={local.phase_stats} />;
      })()}
    </div>
  );
}

function StatCell({ value, avg, format }: { value: number; avg: number; format: string }) {
  const cls = value > avg * 1.15 ? "pg-above" : value < avg * 0.85 ? "pg-below" : "";
  const display = format === "k" ? formatNumber(value) : value.toString();
  return <span className={`pg-stat ${cls}`}>{display}</span>;
}

function PostGameRow({ player: p, maxDamage, team, onViewPlayer }: { player: PostGamePlayer; maxDamage: number; team: PostGameTeam; onViewPlayer?: (puuid: string) => void }) {
  const champInfo = useChampionName(p.champion_id);
  const kda = p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(1);
  const dmgPct = (p.total_damage / maxDamage) * 100;

  return (
    <div className={`postgame-row ${p.is_local ? "postgame-row-local" : ""} ${p.is_mvp ? "postgame-row-mvp" : ""}`}>
      <div className="pg-player">
        <ChampionIcon championId={p.champion_id} size={32} />
        <div className="pg-player-info">
          <span className={`pg-player-name ${onViewPlayer ? "pg-player-link" : ""}`} onClick={(e) => { if (onViewPlayer && p.puuid) { e.stopPropagation(); onViewPlayer(p.puuid); } }}>
            {p.summoner_name !== "Unknown" ? p.summoner_name : (champInfo?.name || "Unknown")}
            {p.is_mvp && <span className="mvp-badge">MVP</span>}
          </span>
          <span className="pg-champ-name">
            {champInfo?.name || ""}
            {p.position && <> &middot; <PositionIcon pos={p.position} size={12} /> {POSITION_LABELS[p.position.toLowerCase()] || p.position}</>}
            {p.rank && <> &middot; <RankEmblem rank={p.rank} size={12} /> <span className={`pg-rank rank-${p.rank.split(' ')[0]?.toLowerCase()}`}>{p.rank}</span></>}
          </span>
        </div>
      </div>
      <div className="pg-col-kda">
        <span className="pg-kda">
          <span className="pg-k">{p.kills}</span>
          <span className="pg-sep">/</span>
          <span className="pg-d">{p.deaths}</span>
          <span className="pg-sep">/</span>
          <span className="pg-a">{p.assists}</span>
        </span>
        <span className="pg-kda-ratio">{kda} KDA</span>
      </div>
      <div className="pg-col-dmg">
        <StatCell value={p.total_damage} avg={team.avg_damage} format="k" />
        <div className="pg-dmg-bar">
          <div className="pg-dmg-fill" style={{ width: `${dmgPct}%` }} />
        </div>
      </div>
      <div className="pg-col-pct" title="Damage Share">
        <span className={`pg-pct ${p.damage_share > 0.30 ? "pg-above" : p.damage_share < 0.10 ? "pg-below" : ""}`}>
          {(p.damage_share * 100).toFixed(0)}%
        </span>
      </div>
      <div className="pg-col-pct" title="Kill Participation">
        <span className={`pg-pct ${p.kill_participation > 0.70 ? "pg-above" : p.kill_participation < 0.30 ? "pg-below" : ""}`}>
          {(p.kill_participation * 100).toFixed(0)}%
        </span>
      </div>
      <div className="pg-col-cs">
        <StatCell value={p.cs} avg={team.avg_cs} format="" />
      </div>
      <div className="pg-col-vision" title={`Placed: ${p.wards_placed} | Killed: ${p.wards_killed}`}>
        <StatCell value={p.vision_score} avg={team.avg_vision} format="" />
      </div>
      <div className="pg-col-gold">
        <StatCell value={p.gold_earned} avg={team.avg_gold} format="k" />
      </div>
      {(p.penta_kills > 0 || p.quadra_kills > 0 || p.triple_kills > 0) && (
        <span className={`multikill-badge ${p.penta_kills > 0 ? "mk-penta" : p.quadra_kills > 0 ? "mk-quadra" : "mk-triple"}`}>
          {p.penta_kills > 0 ? "PENTA" : p.quadra_kills > 0 ? "QUADRA" : "TRIPLE"}
        </span>
      )}
      <div className="pg-col-items">
        <div className="pg-items-row">
          {p.items.map((id, ii) => (
            <div key={ii} className="pg-item">
              <ItemIcon id={id} size={24} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toString();
}

// --- Alt Tabs ---

function AltTabs({ options, category, currentIds, currentBuild }: {
  options: { win_rate: number; pick_rate: number }[];
  category: string;
  currentIds?: number[] | [number, number];
  currentBuild?: RuneBuild;
}) {
  // Determine active index by matching current build against options
  let activeIndex = 0;
  if (category === "runes" && currentBuild) {
    const opts = options as RuneOption[];
    activeIndex = opts.findIndex(o =>
      o.build.primary_style_id === currentBuild.primary_style_id &&
      o.build.sub_style_id === currentBuild.sub_style_id
    );
    if (activeIndex < 0) activeIndex = 0;
  } else if (category === "spells" && currentIds) {
    const opts = options as SpellOption[];
    activeIndex = opts.findIndex(o => o.ids[0] === currentIds[0] && o.ids[1] === currentIds[1]);
    if (activeIndex < 0) activeIndex = 0;
  } else if (category === "items" && currentIds) {
    const opts = options as ItemOption[];
    activeIndex = opts.findIndex(o => JSON.stringify(o.ids) === JSON.stringify(currentIds));
    if (activeIndex < 0) activeIndex = 0;
  }

  // Tag each option by style: most popular, best WR, alt
  const popularIdx = options.reduce((maxI, o, i, arr) =>
    o.pick_rate > arr[maxI].pick_rate ? i : maxI, 0);
  const bestWrIdx = options.reduce((maxI, o, i, arr) =>
    o.win_rate > arr[maxI].win_rate ? i : maxI, 0);

  function styleLabel(i: number): string | null {
    if (options.length < 2) return null;
    if (i === popularIdx) return "Popular";
    if (i === bestWrIdx) return "Best WR";
    return null;
  }

  return (
    <div className="alt-tabs">
      {options.map((opt, i) => {
        const label = styleLabel(i);
        return (
          <button
            key={i}
            className={`alt-tab ${i === activeIndex ? "alt-tab-active" : ""}`}
            onClick={() => invoke("select_build_option", { category, index: i })}
            title={label ? `${label} — ${(opt.win_rate * 100).toFixed(1)}% WR / ${(opt.pick_rate * 100).toFixed(1)}% pick` : `${(opt.win_rate * 100).toFixed(1)}% WR / ${(opt.pick_rate * 100).toFixed(1)}% pick`}
          >
            <span className="alt-tab-wr">{(opt.win_rate * 100).toFixed(1)}%</span>
            {label && <span className="alt-tab-style">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

// --- Rune Display ---

function RuneDisplay({ runes }: { runes: RuneBuild }) {
  const primaryStyle = runeStyleCache?.get(runes.primary_style_id);
  const subStyle = runeStyleCache?.get(runes.sub_style_id);
  const primaryPerks = runes.selected_perk_ids.slice(0, 4);
  const secondaryPerks = runes.selected_perk_ids.slice(4, 6);
  const statShards = runes.selected_perk_ids.slice(6, 9);

  return (
    <div className="runes-layout">
      <div className="rune-tree">
        {primaryStyle && (
          <div className="rune-tree-header">
            <img src={runeIconUrl(primaryStyle.icon)} alt={primaryStyle.name} className="tree-icon" />
            <span>{primaryStyle.name}</span>
          </div>
        )}
        <div className="rune-slots">
          {primaryPerks.map((id, i) => (
            <div key={id} className={`rune-pip ${i === 0 ? "keystone" : ""}`}>
              <RuneIcon id={id} size={i === 0 ? 32 : 28} />
            </div>
          ))}
        </div>
      </div>
      <div className="rune-divider" />
      <div className="rune-tree">
        {subStyle && (
          <div className="rune-tree-header">
            <img src={runeIconUrl(subStyle.icon)} alt={subStyle.name} className="tree-icon" />
            <span>{subStyle.name}</span>
          </div>
        )}
        <div className="rune-slots">
          {secondaryPerks.map(id => (
            <div key={id} className="rune-pip">
              <RuneIcon id={id} size={28} />
            </div>
          ))}
        </div>
      </div>
      {statShards.length > 0 && (
        <>
          <div className="rune-divider" />
          <div className="rune-tree">
            <div className="rune-tree-header"><span>Shards</span></div>
            <div className="rune-slots rune-slots-shards">
              {statShards.map((id, i) => {
                const shard = STAT_SHARDS[id];
                return (
                  <div key={`${id}-${i}`} className="shard-chip" title={shard?.name || `${id}`}>
                    {shard && <img src={`${SHARD_ICON_BASE}${shard.icon}`} alt={shard.name} className="shard-icon" />}
                    <span>{shard?.name || id}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Overlay Window ---

function OverlayApp() {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    // Poll state every second (more reliable than event listener for overlay)
    const poll = setInterval(() => {
      invoke<AppState>("get_state").then(setState).catch(() => {});
    }, 1000);
    // Also listen for events
    invoke<AppState>("get_state").then(setState);
    const unlisten = listen<AppState>("app-state-changed", (e) => setState(e.payload));
    fetchLatestVersion().then(() => { loadChampionData(); loadItemData(); });
    return () => { clearInterval(poll); unlisten.then(fn => fn()); };
  }, []);

  // --- All hooks below this line MUST be called unconditionally on every render.
  //     Effects guard internally on missing state instead of using an early return. ---

  // Roam / missing tracker
  const enemyTrack = useRef<Map<string, {
    csHistory: { t: number; cs: number }[];
    lastDeath: number;
    prevDeaths: number;
    missingSince: number | null;
  }>>(new Map());
  const missingTtsCd = useRef<Map<string, number>>(new Map());
  const [missing, setMissing] = useState<Array<{ key: string; pos: string; champId: number; durationSec: number }>>([]);

  useEffect(() => {
    const game = state?.live_game;
    const ld = game?.live_data;
    if (!game || !ld || isAramQueue(game.queue_name)) {
      setMissing([]);
      return;
    }
    const gameTime = ld.game_time;
    if (gameTime < 90) return;
    const updates: Array<{ key: string; pos: string; champId: number; durationSec: number }> = [];

    for (const enemy of game.enemies) {
      if (!enemy.live || !enemy.position) continue;
      const posLower = enemy.position.toLowerCase();
      const trackable = posLower.startsWith("top") || posLower.startsWith("mid")
        || posLower.startsWith("bot") || posLower === "adc" || posLower === "middle";
      if (!trackable) continue;

      const key = enemy.summoner_name || `${posLower}_${enemy.champion_id}`;
      let track = enemyTrack.current.get(key);
      if (!track) {
        track = { csHistory: [], lastDeath: -100, prevDeaths: enemy.live.deaths, missingSince: null };
        enemyTrack.current.set(key, track);
      }
      if (enemy.live.deaths > track.prevDeaths) track.lastDeath = gameTime;
      track.prevDeaths = enemy.live.deaths;

      track.csHistory.push({ t: gameTime, cs: enemy.live.cs });
      track.csHistory = track.csHistory.filter(s => s.t > gameTime - 60);

      const past = track.csHistory.find(s => s.t <= gameTime - 25);
      if (!past) continue;

      const csDelta = enemy.live.cs - past.cs;
      const recentlyDead = gameTime - track.lastDeath < 25;
      const isMissing = csDelta < 1 && !recentlyDead;
      const posLabel = posLower.startsWith("top") ? "TOP"
        : (posLower.startsWith("mid") || posLower === "middle") ? "MID"
        : "BOT";

      if (isMissing) {
        if (track.missingSince === null) track.missingSince = gameTime - 25;
        const duration = Math.round(gameTime - track.missingSince);
        if (duration >= 8) {
          updates.push({ key, pos: posLabel, champId: enemy.champion_id, durationSec: duration });
          const lastTts = missingTtsCd.current.get(key) ?? -100;
          if (gameTime - lastTts > 45) {
            missingTtsCd.current.set(key, gameTime);
            const champName = championCache?.[enemy.champion_id.toString()]?.name;
            const text = champName ? `${champName} missing` : `${posLabel} missing`;
            invoke("speak", { text }).catch(() => {});
          }
        }
      } else {
        track.missingSince = null;
      }
    }
    setMissing(updates);
  }, [state]);

  // Death timer prediction
  const deathTrack = useRef<Map<string, { prevDeaths: number; deathTime: number; level: number; deathLevel: number }>>(new Map());
  const [deadEnemies, setDeadEnemies] = useState<Array<{ key: string; pos: string; champId: number; remaining: number }>>([]);

  useEffect(() => {
    const game = state?.live_game;
    const ld = game?.live_data;
    if (!game || !ld || isAramQueue(game.queue_name)) {
      setDeadEnemies([]);
      return;
    }
    const gameTime = ld.game_time;
    const dead: Array<{ key: string; pos: string; champId: number; remaining: number }> = [];

    for (const enemy of game.enemies) {
      if (!enemy.live) continue;
      const key = enemy.summoner_name || `${enemy.position}_${enemy.champion_id}`;
      let track = deathTrack.current.get(key);
      if (!track) {
        track = { prevDeaths: enemy.live.deaths, deathTime: -1000, level: enemy.live.level, deathLevel: 1 };
        deathTrack.current.set(key, track);
      }
      if (enemy.live.deaths > track.prevDeaths) {
        track.deathTime = gameTime;
        track.deathLevel = enemy.live.level;
      }
      track.prevDeaths = enemy.live.deaths;
      track.level = enemy.live.level;

      const respawn = predictRespawn(track.deathLevel, track.deathTime);
      const remaining = (track.deathTime + respawn) - gameTime;
      if (remaining > 0 && remaining < respawn + 1) {
        const posLower = (enemy.position || "").toLowerCase();
        const posLabel = posLower.startsWith("top") ? "TOP"
          : (posLower.startsWith("mid") || posLower === "middle") ? "MID"
          : posLower.startsWith("jun") ? "JNG"
          : (posLower.startsWith("uti") || posLower.startsWith("sup")) ? "SUP"
          : "BOT";
        dead.push({ key, pos: posLabel, champId: enemy.champion_id, remaining: Math.ceil(remaining) });
      }
    }
    setDeadEnemies(dead);
  }, [state]);

  // Recall TTS & jungler tracking refs
  const recallTtsCd = useRef<number>(-100);
  const jglLastSeenRef = useRef<{ time: number; reason: string; kdaSum: number }>({ time: 0, reason: "spawn", kdaSum: 0 });

  useEffect(() => {
    const game = state?.live_game;
    const ld = game?.live_data;
    if (!game || !ld) return;
    const enemyJgl = game.enemies.find(e => (e.position || "").toLowerCase().startsWith("jun"));
    if (!enemyJgl?.live) return;
    const k = enemyJgl.live.kills + enemyJgl.live.assists + enemyJgl.live.deaths;
    if (k > jglLastSeenRef.current.kdaSum) {
      jglLastSeenRef.current = {
        time: ld.game_time,
        reason: enemyJgl.live.deaths > 0 ? "dead" : "kill/assist",
        kdaSum: k,
      };
    } else {
      jglLastSeenRef.current.kdaSum = k;
    }
  }, [state]);

  // Recall TTS — fire once per session when an item becomes affordable.
  useEffect(() => {
    const game = state?.live_game;
    const ld = game?.live_data;
    if (!game || !ld || !state?.summoner_name) return;
    const target = state.summoner_name.toLowerCase();
    const targetShort = target.split("#")[0];
    const me = game.allies.find(a => {
      const n = a.summoner_name.toLowerCase();
      return n === target || n === targetShort || n.startsWith(targetShort + "#") || n.split("#")[0] === targetShort;
    });
    if (!me?.live || !game.recommended_build) return;
    const owned = new Set(me.live.items);
    const targets = [...game.recommended_build.boots.slice(0, 1), ...game.recommended_build.core_items].filter(id => !owned.has(id));
    for (const id of targets) {
      const item = getItemData(id);
      if (item && item.gold > 0 && item.gold < 4500) {
        const need = item.gold - me.live.current_gold;
        if (need <= 0) {
          const gameTime = ld.game_time;
          if (gameTime - recallTtsCd.current >= 90) {
            recallTtsCd.current = gameTime;
            invoke("speak", { text: `Recall ready, ${item.name}` }).catch(() => {});
          }
        }
        break;
      }
    }
  }, [state]);

  // Jungle TTS — speak on guess transitions and after long absence
  const jglPrevGuess = useRef<string>("");
  const jglUnknownTtsCd = useRef<number>(-100);
  useEffect(() => {
    const game = state?.live_game;
    const ld = game?.live_data;
    if (!game || !ld || isAramQueue(game.queue_name)) return;
    const enemyJgl = game.enemies.find(e => (e.position || "").toLowerCase().startsWith("jun"));
    if (!enemyJgl) return;
    const gameTime = ld.game_time;
    const lastSeen = jglLastSeenRef.current.time || 0;
    const elapsed = Math.max(0, gameTime - lastSeen);

    let guess = "farm";
    if (gameTime < 3 * 60) guess = "first-clear";
    else if (elapsed >= 60) guess = "unknown-long";
    else if (elapsed >= 30) guess = "moving";
    else guess = "farm";

    // Transition: farm/first-clear → moving (likely setup gank or obj)
    if (jglPrevGuess.current === "farm" && guess === "moving") {
      invoke("speak", { text: "Watch for ganks, jungler rotating" }).catch(() => {});
    }
    // Long absence — say once per 90s
    if (guess === "unknown-long" && gameTime - jglUnknownTtsCd.current > 90) {
      jglUnknownTtsCd.current = gameTime;
      invoke("speak", { text: "Enemy jungler unknown, place wards" }).catch(() => {});
    }
    jglPrevGuess.current = guess;
  }, [state]);

  // Vision target TTS — periodic reminder when far below benchmark
  const visionTtsCd = useRef<number>(-100);
  useEffect(() => {
    const game = state?.live_game;
    const ld = game?.live_data;
    if (!game || !ld || !state?.summoner_name || isAramQueue(game.queue_name)) return;
    const gameTime = ld.game_time;
    if (gameTime < 6 * 60) return;
    const target = state.summoner_name.toLowerCase();
    const targetShort = target.split("#")[0];
    const me = game.allies.find(a => {
      const n = a.summoner_name.toLowerCase();
      return n === target || n === targetShort || n.startsWith(targetShort + "#") || n.split("#")[0] === targetShort;
    });
    if (!me?.live) return;
    const minutes = gameTime / 60;
    const posLower = (me.position || "").toLowerCase();
    const benchmark = (posLower.startsWith("uti") || posLower.startsWith("sup")) ? 1.5
      : posLower.startsWith("jun") ? 0.9
      : 0.6;
    const targetVision = minutes * benchmark;
    if (targetVision < 5) return;
    const ratio = me.live.ward_score / targetVision;
    if (ratio < 0.5 && gameTime - visionTtsCd.current > 180) {
      visionTtsCd.current = gameTime;
      invoke("speak", { text: "Place wards" }).catch(() => {});
    }
  }, [state]);

  // Objective spawn TTS — fire once per cycle when ETA crosses 30s.
  // Keyed by spawnTime so each individual respawn instance triggers exactly once.
  const objSpoken = useRef<Set<number>>(new Set()).current;
  useEffect(() => {
    const game = state?.live_game;
    const ld = game?.live_data;
    if (!game || !ld || isAramQueue(game.queue_name)) return;
    const spawns = computeObjectiveSpawns(ld.events, ld.game_time);
    for (const s of spawns) {
      if (s.eta > 0 && s.eta <= 30 && !objSpoken.has(s.spawnTime)) {
        objSpoken.add(s.spawnTime);
        // Inject jungler context
        const jglElapsed = Math.max(0, ld.game_time - (jglLastSeenRef.current.time || 0));
        const ctx = jglElapsed >= 45 ? `, enemy jungler unseen ${Math.round(jglElapsed)} seconds` : "";
        invoke("speak", { text: `${s.label} spawning in 30 seconds${ctx}` }).catch(() => {});
      }
    }
  }, [state]);

  if (!state || !state.live_game) return <div className="overlay"><span style={{ color: "var(--text-muted)", fontSize: 11 }}>Waiting for game data...</span></div>;
  const game = state.live_game;
  const ld = game.live_data;
  const allyKills = game.allies.reduce((s, p) => s + (p.live?.kills ?? 0), 0);
  const enemyKills = game.enemies.reduce((s, p) => s + (p.live?.kills ?? 0), 0);

  // Build lane matchups: pair allies and enemies by position, fallback by index
  const matchups: { ally: LiveGamePlayer; enemy: LiveGamePlayer; allyGold: number; enemyGold: number; diff: number }[] = [];
  const usedEnemies = new Set<number>();

  // First pass: match by position
  for (const ally of game.allies) {
    const allyPos = ally.position ? normPos(ally.position) : "";
    if (!allyPos) continue;
    const enemyIdx = game.enemies.findIndex((e, i) => !usedEnemies.has(i) && e.position && normPos(e.position) === allyPos);
    if (enemyIdx >= 0) {
      usedEnemies.add(enemyIdx);
      const ag = playerTotalGold(ally);
      const eg = playerTotalGold(game.enemies[enemyIdx]);
      matchups.push({ ally, enemy: game.enemies[enemyIdx], allyGold: ag, enemyGold: eg, diff: ag - eg });
    }
  }

  // Second pass: pair remaining by index
  for (const ally of game.allies) {
    if (matchups.some(m => m.ally === ally)) continue;
    const enemyIdx = game.enemies.findIndex((_, i) => !usedEnemies.has(i));
    if (enemyIdx >= 0) {
      usedEnemies.add(enemyIdx);
      const ag = playerTotalGold(ally);
      const eg = playerTotalGold(game.enemies[enemyIdx]);
      matchups.push({ ally, enemy: game.enemies[enemyIdx], allyGold: ag, enemyGold: eg, diff: ag - eg });
    }
  }

  const totalAllyGold = matchups.reduce((s, m) => s + m.allyGold, 0);
  const totalEnemyGold = matchups.reduce((s, m) => s + m.enemyGold, 0);
  const totalDiff = totalAllyGold - totalEnemyGold;
  const ovObjState = ld ? getObjectiveState(ld.events, ld.game_time) : null;
  const ovWinProb = ld && ovObjState ? estimateWinProbability(totalDiff, ld.game_time, ovObjState.allyDragons, ovObjState.enemyDragons, ovObjState.allyBaronActive, ovObjState.enemyBaronActive) : 0.5;

  // Compact level plan (local player vs lane opponent)
  let me: LiveGamePlayer | null = null;
  if (state.summoner_name && game.allies.length > 0) {
    const target = state.summoner_name.toLowerCase();
    const targetShort = target.split("#")[0];
    me = game.allies.find(a => {
      const n = a.summoner_name.toLowerCase();
      return n === target || n === targetShort || n.startsWith(targetShort + "#") || n.split("#")[0] === targetShort;
    }) ?? null;
  }
  // Fallback: if we can't identify the local player, don't block the plan — use the first ally.
  // This keeps the feature visible even when the name matching fails (logs/debug).
  if (!me && game.allies.length > 0) me = game.allies[0];

  let myEnemy: LiveGamePlayer | null = null;
  if (me) {
    const matched = matchups.find(m => m.ally === me);
    myEnemy = matched ? matched.enemy : (game.enemies[0] ?? null);
  }

  const myPlan = me && myEnemy && me.champion_id > 0 && myEnemy.champion_id > 0 && !isAramQueue(game.queue_name)
    ? buildLevelPlan(me.champion_id, myEnemy.champion_id, me.position)
    : null;
  const currentLevel = Math.max(1, me?.live?.level ?? 1);
  const currentEntry = myPlan
    ? myPlan[Math.max(0, Math.min(17, currentLevel - 1))]
    : null;
  const nextSpike = myPlan
    ? myPlan.slice(currentLevel).find(e => (e.isSpike || e.isEnemySpike) && e.level - currentLevel <= 4)
    : null;

  // --- Recall optimizer (computed values, no hooks) ---
  const recall: { item: string; gold: number; affordable: boolean } | null = (() => {
    if (!me?.live || !game.recommended_build) return null;
    const owned = new Set(me.live.items);
    const targets = [...game.recommended_build.boots.slice(0, 1), ...game.recommended_build.core_items].filter(id => !owned.has(id));
    for (const id of targets) {
      const item = getItemData(id);
      if (item && item.gold > 0 && item.gold < 4500) {
        const need = item.gold - me.live.current_gold;
        return { item: item.name, gold: Math.ceil(need), affordable: need <= 0 };
      }
    }
    return null;
  })();

  // --- Build sequence strip (overlay) ---
  const ovBuildSlots = me?.live ? computeBuildSequence(game.recommended_build, me.live.items, me.live.current_gold) : [];

  // --- Threat-response suggestion (overlay) ---
  const ovThreat = (me?.live && ld)
    ? suggestThreatResponse(game.enemies, me.live.items, me.position || "", me.champion_id, ld.game_time)
    : null;

  // --- Upcoming objective spawns ---
  const ovSpawns = ld ? computeObjectiveSpawns(ld.events, ld.game_time) : [];
  // Show only the next 2 (current LIVE, next imminent) and only when relevant (≤90s or just spawned)
  const ovSpawnsVisible = ovSpawns.filter(s => s.eta <= 90).slice(0, 2);

  // Recall TTS effect was moved above the early return (see top of OverlayApp).

  // --- Wave state advisor ---
  const waveAdvice: { text: string; tone: "good" | "bad" | "neutral" } | null = (() => {
    if (!ld || isAramQueue(game.queue_name)) return null;
    const gameTime = ld.game_time;
    if (gameTime < 120 || gameTime > 14 * 60) return null; // lane phase only
    if (!me?.live || !myEnemy?.live) return null;
    const csDiff = me.live.cs - myEnemy.live.cs;
    if (csDiff >= 18) return { text: "Push prio · roam", tone: "good" };
    if (csDiff >= 8) return { text: "Push wave", tone: "good" };
    if (csDiff <= -18) return { text: "Freeze near tower", tone: "bad" };
    if (csDiff <= -8) return { text: "Last-hit safe", tone: "bad" };
    return { text: "Hold wave", tone: "neutral" };
  })();

  // --- Vision target advisor ---
  const visionAdvice: { current: number; target: number; lagging: boolean } | null = (() => {
    if (!ld || !me?.live || isAramQueue(game.queue_name)) return null;
    const gameTime = ld.game_time;
    if (gameTime < 5 * 60) return null;
    const minutes = gameTime / 60;
    const posLower = (me.position || "").toLowerCase();
    // Gold elo benchmarks (vision/min): SUP 1.5, JNG 0.9, others 0.6
    const benchmark = (posLower.startsWith("uti") || posLower.startsWith("sup")) ? 1.5
      : posLower.startsWith("jun") ? 0.9
      : 0.6;
    const target = Math.round(minutes * benchmark);
    const current = Math.round(me.live.ward_score);
    return { current, target, lagging: current < target * 0.7 && target >= 5 };
  })();

  // --- Jungle tracker (computed only — ref + tracking effect live above the early return) ---
  const enemyJungler = game.enemies.find(e => (e.position || "").toLowerCase().startsWith("jun"));
  const jglInfo: { lastSeenSec: number; guess: string } | null = (() => {
    if (!enemyJungler || !ld || isAramQueue(game.queue_name)) return null;
    const gameTime = ld.game_time;
    const lastSeen = jglLastSeenRef.current.time || 0;
    const elapsed = Math.max(0, Math.round(gameTime - lastSeen));
    let guess = "farming";
    // Heuristics by minute: dragon/herald spawn at 5:00, scuttle 3:30
    if (gameTime < 3 * 60) guess = "first clear";
    else if (gameTime < 4 * 60) guess = "scuttle";
    else if (gameTime > 5 * 60 && gameTime < 18 * 60 && elapsed < 30) guess = "farming";
    else if (elapsed >= 30 && elapsed < 60) guess = "possible gank/obj";
    else if (elapsed >= 60) guess = "obj/invading";
    return { lastSeenSec: elapsed, guess };
  })();

  return (
    <div className="overlay">
      {/* Header: ally kills + win prob + gold diff + enemy kills */}
      <div className="ov-header">
        <span className="ov-score-ally">{allyKills}</span>
        <div className="ov-center">
          <span className={`ov-win-prob ${ovWinProb > 0.55 ? "lg-wr-good" : ovWinProb < 0.45 ? "lg-wr-bad" : ""}`}>
            {(ovWinProb * 100).toFixed(0)}%
          </span>
          <span className={`ov-total-diff ${totalDiff > 0 ? "lg-wr-good" : totalDiff < 0 ? "lg-wr-bad" : ""}`}>
            {totalDiff > 0 ? "◀◀" : totalDiff < 0 ? "▶▶" : "="} {Math.abs(Math.round(totalDiff)).toLocaleString()}
          </span>
          {ld && <span className="ov-timer">{formatGameTime(ld.game_time)}</span>}
        </div>
        <span className="ov-score-enemy">{enemyKills}</span>
      </div>

      {/* Lane matchups */}
      <div className="ov-lanes">
        {matchups.map((m, i) => (
          <div key={i} className="ov-lane">
            <div className="ov-lane-player ov-lane-ally">
              <div className="ov-champ">
                <ChampionIcon championId={m.ally.champion_id} size={28} />
                {m.ally.live && <span className="ov-champ-lvl">{m.ally.live.level}</span>}
              </div>
              <span className="ov-lane-gold">{Math.round(m.allyGold).toLocaleString()}</span>
            </div>
            <div className="ov-lane-center">
              <span className={`ov-lane-diff ${m.diff > 200 ? "lg-wr-good" : m.diff < -200 ? "lg-wr-bad" : ""}`}>
                {m.diff > 0 ? "◀ " : m.diff < 0 ? " ▶" : ""}{Math.abs(Math.round(m.diff)).toLocaleString()}
              </span>
            </div>
            <div className="ov-lane-player ov-lane-enemy">
              <span className="ov-lane-gold">{Math.round(m.enemyGold).toLocaleString()}</span>
              <div className="ov-champ">
                {m.enemy.live && <span className="ov-champ-lvl">{m.enemy.live.level}</span>}
                <ChampionIcon championId={m.enemy.champion_id} size={28} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Missing enemy laners + dead enemies */}
      {(missing.length > 0 || deadEnemies.length > 0) && (
        <div className="ov-missing">
          {missing.map(m => (
            <span key={`mia_${m.key}`} className="ov-missing-tag">
              <span className="ov-missing-icon">⚠</span>
              <span className="ov-missing-pos">{m.pos}</span>
              <span className="ov-missing-label">MIA</span>
              <span className="ov-missing-dur">{Math.floor(m.durationSec / 60)}:{(m.durationSec % 60).toString().padStart(2, "0")}</span>
            </span>
          ))}
          {deadEnemies.map(d => (
            <span key={`dead_${d.key}`} className="ov-dead-tag">
              <span className="ov-missing-icon">💀</span>
              <span className="ov-missing-pos">{d.pos}</span>
              <span className="ov-missing-dur">{d.remaining}s</span>
            </span>
          ))}
        </div>
      )}

      {/* Tactical line: recall + wave + jungle + vision (compact) */}
      {(recall || waveAdvice || jglInfo || (visionAdvice && visionAdvice.lagging)) && (
        <div className="ov-tactical">
          {recall && (
            <span className={`ov-tac-chip ov-tac-recall ${recall.affordable ? "ov-tac-ready" : ""}`}
                  title={recall.affordable ? `Recall ready · ${recall.item}` : `${recall.gold}g a ${recall.item}`}>
              {recall.affordable ? "B" : `${recall.gold}g`} {recall.item}
            </span>
          )}
          {waveAdvice && (
            <span className={`ov-tac-chip ov-tac-${waveAdvice.tone}`} title="Wave state advisor">
              {waveAdvice.text}
            </span>
          )}
          {jglInfo && enemyJungler && (
            <span className="ov-tac-chip ov-tac-jgl"
                  title={`Last seen ${jglInfo.lastSeenSec}s ago`}>
              JGL: {jglInfo.guess}
            </span>
          )}
          {visionAdvice && visionAdvice.lagging && (
            <span className="ov-tac-chip ov-tac-vision" title={`Vision ${visionAdvice.current} / target ${visionAdvice.target}`}>
              Ward · {visionAdvice.current}/{visionAdvice.target}
            </span>
          )}
        </div>
      )}

      {/* Upcoming objective spawns */}
      {ovSpawnsVisible.length > 0 && (
        <div className="ov-objs">
          {ovSpawnsVisible.map((s, i) => {
            const live = s.eta <= 0;
            const urgent = s.eta > 0 && s.eta <= 30;
            const remaining = live
              ? "LIVE"
              : `${Math.floor(s.eta / 60)}:${(Math.round(s.eta) % 60).toString().padStart(2, "0")}`;
            const icon = s.kind === "dragon" ? "🐉" : s.kind === "baron" ? "👹" : s.kind === "voidgrubs" ? "🐛" : "👁";
            const teamCls = s.lastTeam === "ally" ? "ov-obj-ally-last" : s.lastTeam === "enemy" ? "ov-obj-enemy-last" : "";
            return (
              <span key={`${s.kind}_${i}`}
                className={`ov-obj-chip ov-obj-${s.kind} ${live ? "ov-obj-live" : ""} ${urgent ? "ov-obj-urgent" : ""} ${teamCls}`}
                title={s.lastTeam ? `Last taken by ${s.lastTeam === "ally" ? "your team" : "enemy"}` : `Next ${s.label}`}>
                <span className="ov-obj-icon">{icon}</span>
                <span className="ov-obj-label">{s.label}</span>
                <span className="ov-obj-eta">{remaining}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Compact build strip */}
      {ovBuildSlots.length > 0 && (
        <div className="ov-build">
          {ovBuildSlots.map((slot, i) => (
            <div key={slot.id + "_" + i} className={`ov-build-slot ov-build-${slot.state}`} title={slot.name}>
              <img src={itemIconUrl(slot.id)} alt="" className="ov-build-icon" />
              {slot.state === "owned" && <span className="ov-build-check">✓</span>}
              {slot.state === "next" && (
                <span className="ov-build-ring" style={{ background: `conic-gradient(var(--accent-gold) ${(slot.progressPct ?? 0) * 3.6}deg, transparent 0deg)` }} />
              )}
              {slot.state === "next" && slot.goldNeeded != null && slot.goldNeeded > 0 && (
                <span className="ov-build-need">{slot.goldNeeded}g</span>
              )}
              {slot.state === "next" && slot.goldNeeded === 0 && (
                <span className="ov-build-ready">B</span>
              )}
            </div>
          ))}
          {ovThreat && (
            <div className={`ov-build-threat ov-threat-${ovThreat.kind}`} title={`${ovThreat.itemName} · ${ovThreat.reason}`}>
              <img src={itemIconUrl(ovThreat.itemId)} alt="" className="ov-build-icon" />
              <span className="ov-build-threat-tag">!</span>
            </div>
          )}
        </div>
      )}

      {/* Compact level plan — current + next 4 levels */}
      {myPlan && currentEntry && (
        <div className="ov-plan">
          <div className="ov-plan-header">
            <span className="ov-plan-header-title">PLAN</span>
            {nextSpike && (
              <span className={`ov-plan-next ${nextSpike.isSpike ? "ov-plan-next-you" : "ov-plan-next-enemy"}`}>
                ⚡ Lv {nextSpike.level}
              </span>
            )}
          </div>
          {myPlan.slice(currentLevel - 1, currentLevel - 1 + 5).map((entry) => {
            const isNow = entry.level === currentLevel;
            return (
              <div
                key={entry.level}
                className={`ov-plan-row ov-plan-cat-${entry.category} ${isNow ? "ov-plan-row-now" : ""} ${entry.isSpike ? "ov-plan-row-spike" : ""} ${entry.isEnemySpike ? "ov-plan-row-espike" : ""}`}
              >
                <span className="ov-plan-lvl">{entry.level}</span>
                <span className="ov-plan-action">{entry.action}</span>
                {(entry.isSpike || entry.isEnemySpike) && (
                  <span className="ov-plan-bolt">⚡</span>
                )}
                <span className="ov-plan-adv">
                  {entry.advantage > 0 ? "+" : ""}{entry.advantage.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Objective timers */}
      {ld && <ObjectiveTimers events={ld.events} gameTime={ld.game_time} />}
    </div>
  );
}

// Router: main app or overlay based on window label (set in main.tsx)
function AppRouter() {
  const isOverlay = (window as any).__QUERYLOL_OVERLAY__ === true;
  return isOverlay ? <OverlayApp /> : <App />;
}

export default AppRouter;
