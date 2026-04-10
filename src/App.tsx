import { useEffect, useState, useRef } from "react";
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
  region: string;
}

// --- Constants ---

const DDRAGON = "https://ddragon.leagueoflegends.com/cdn";
let DDRAGON_VERSION = "16.6.1"; // fallback, updated dynamically

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

// Map champion ID to primary damage type: "ap" or "ad"
const CHAMP_DAMAGE_TYPE: Record<number, "ap" | "ad"> = {};
// AP champions
[1,3,4,7,8,9,10,13,17,25,26,27,28,30,31,34,37,38,40,42,43,45,50,55,61,63,68,69,74,76,79,82,84,85,90,96,99,101,103,105,112,113,115,117,127,131,134,142,143,147,150,161,163,245,246,267,268,350,353,360,427,432,497,518,526,555,685,711,876,887,901,902,950].forEach(id => CHAMP_DAMAGE_TYPE[id] = "ap");
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
};

function getCurve(id: number): PowerCurve {
  return POWER_CURVES[id] || DEFAULT_CURVE;
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
    auto_apply: true, auto_lock: false, auto_accept: false, region: "euw",
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
              <span className="cs-recs-label">ARAM Win Rates</span>
              <div className="cs-recs-scroll">
                {[...state.aram_bench]
                  .sort((a, b) => b.win_rate - a.win_rate)
                  .map(champ => {
                    const isOnBench = !state.draft?.allies.some(a => a.champion_id === champ.champion_id);
                    return (
                      <div key={champ.champion_id} className={`aram-bench-chip ${isOnBench ? "aram-bench-available" : "aram-bench-picked"}`}>
                        <ChampionIcon championId={champ.champion_id} size={32} />
                        <div className="aram-bench-info">
                          <ChampionNameLabel championId={champ.champion_id} fallback="..." />
                          <span className={`aram-bench-wr ${champ.win_rate >= 0.52 ? "lg-wr-good" : champ.win_rate < 0.48 ? "lg-wr-bad" : ""}`}>
                            {(champ.win_rate * 100).toFixed(1)}%
                          </span>
                        </div>
                        {isOnBench && <span className="aram-bench-tag">Bench</span>}
                      </div>
                    );
                  })}
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
              // Show analysis for the lane opponent (same position) or first visible enemy
              const myPos = state.assigned_position;
              const laneOpponent = myPos
                ? visibleEnemies.find(e => e.position === myPos) || visibleEnemies[0]
                : visibleEnemies[0];
              const wr = state.counters[laneOpponent.champion_id.toString()];
              const analysis = analyzeMatchup(myId, laneOpponent.champion_id, wr);
              return (
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
              );
            })()}
          </div>

          {/* Right: Enemies */}
          <div className="cs-right">
            {state.draft && (
              <div className="cs-team">
                <h4 className="cs-team-label cs-team-enemy">Enemy Team</h4>
                {state.draft.enemies.length > 0 ? state.draft.enemies.map((p, i) => {
                  const wr = hasChampion && p.champion_id > 0 ? state.counters[p.champion_id.toString()] : undefined;
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


// --- Improvement Priorities ---

function ImprovementPanel({ history, ranked }: { history: MatchHistoryEntry[]; ranked: RankedInfo }) {
  const tierKey = ranked.tier.toUpperCase();
  const tierLabel = ranked.tier.charAt(0).toUpperCase() + ranked.tier.slice(1).toLowerCase();
  const bench = ELO_BENCHMARKS[tierKey] || ELO_BENCHMARKS.GOLD;

  // Filter ranked games with enough data (must have gold > 0 to ensure stats were populated)
  const games = history.filter(m =>
    (m.queue_id === 420 || m.queue_id === 440) && m.duration_secs > 300 && m.gold_earned > 0
  );
  if (games.length < 5) return null;

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

  const check = (val: number, ref_val: number, metric: string, yourFmt: string, refFmt: string, tip: string) => {
    const gap = (ref_val - val) / ref_val;
    if (gap > 0.05) priorities.push({ metric, gap, yours: yourFmt, target: refFmt, tip });
  };

  check(avgCsMin, bench.cs_min, "CS/min", avgCsMin.toFixed(1), bench.cs_min.toString(), "Practice last-hitting in practice tool");
  check(avgVisionMin, bench.vision_min, "Vision/min", avgVisionMin.toFixed(2), bench.vision_min.toString(), "Buy control wards, use trinket on cooldown");
  check(avgKda, bench.kda, "KDA", avgKda.toFixed(1), bench.kda.toString(), "Focus on dying less in trades and teamfights");
  check(avgGoldMin, bench.gold_min, "Gold/min", Math.round(avgGoldMin).toString(), bench.gold_min.toString(), "Improve CS and look for plate gold");

  if (avgDeaths > 5.5) {
    priorities.push({ metric: "Deaths", gap: (avgDeaths - 4.5) / 4.5, yours: avgDeaths.toFixed(1) + "/game", target: "<5", tip: "Review positioning and map awareness" });
  }

  priorities.sort((a, b) => b.gap - a.gap);
  const top3 = priorities.slice(0, 3);

  if (top3.length === 0) return null;

  return (
    <div className="improve-panel">
      <h4 className="improve-title">Areas to Improve <span className="improve-sub">vs {tierLabel} avg · {n} ranked games</span></h4>
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
  const height = 80;
  const pad = { top: 8, bottom: 20, left: 8, right: 8 };

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
          <circle key={i} cx={p.x} cy={p.y} r={i === points.length - 1 ? 4 : 2.5}
            fill={i === points.length - 1 ? "var(--accent-gold)" : "var(--bg-card)"}
            stroke="var(--accent-gold)" strokeWidth="1.5" />
        ))}

        {/* Current LP label */}
        <text x={width - pad.right} y={height - 4} textAnchor="end"
          fill="var(--text-secondary)" fontSize="10" fontWeight="600">
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
      {isEnemy && live && spellCd && (
        <div className="lg-spells">
          <SpellCdIcon spellId={live.spell1_id} playerName={p.summoner_name} {...spellCd} />
          <SpellCdIcon spellId={live.spell2_id} playerName={p.summoner_name} {...spellCd} />
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

  // Find local player
  const localPlayer = game.allies.find(p => p.live != null) ?? game.allies[0];
  const localLive = localPlayer?.live;
  const build = game.recommended_build;

  // Compute gold-to-next-item for local player
  const goldToItem: { name: string; gold: number; itemId: number } | null = (() => {
    if (!localLive || !build) return null;
    const ownedIds = new Set(localLive.items);
    const coreIds = [...build.core_items, ...build.boots];
    for (const id of coreIds) {
      if (!ownedIds.has(id)) {
        const item = getItemData(id);
        if (item && item.gold > 0) {
          const remaining = item.gold - localLive.current_gold;
          if (remaining > 0 && remaining < 1500) {
            return { name: item.name, gold: Math.round(remaining), itemId: id };
          }
        }
      }
    }
    return null;
  })();

  // Detect enemy item completions
  useEffect(() => {
    if (!ld) return;
    const newAlerts: typeof alerts = [];
    for (const enemy of game.enemies) {
      if (!enemy.live) continue;
      const key = enemy.summoner_name;
      const prev = prevEnemyItems.current.get(key) || new Set();
      const current = new Set(enemy.live.items);
      for (const id of current) {
        if (!prev.has(id)) {
          const item = getItemData(id);
          if (item && item.gold >= 2500) {
            newAlerts.push({
              id: `${key}_${id}_${gameTime}`,
              text: `${enemy.summoner_name} completed ${item.name}`,
              type: "warning",
              time: gameTime,
            });
          }
        }
      }
      prevEnemyItems.current.set(key, current);
    }
    if (newAlerts.length > 0) {
      setAlerts(prev => [...newAlerts, ...prev].slice(0, 5));
    }
    // Auto-dismiss alerts older than 15 seconds
    setAlerts(prev => prev.filter(a => gameTime - a.time < 15));
  }, [gameTime, game.enemies, ld]);

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

      {(goldToItem || alerts.length > 0) && (
        <div className="lg-alerts">
          {goldToItem && (
            <div className="lg-alert lg-alert-info">
              <span className="lg-alert-gold">{goldToItem.gold}g</span> to <span className="lg-alert-item">{goldToItem.name}</span>
            </div>
          )}
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
            {game.allies.map((p, i) => (
              <LiveGamePlayerCard key={i} p={p} onViewPlayer={onViewPlayer} />
            ))}
          </div>
        </div>
        <div className="lg-vs">VS</div>
        <div className="lg-team">
          <h4 className="draft-team-label" style={{ color: "var(--accent-red)" }}>Enemy Team</h4>
          <div className="lg-players">
            {game.enemies.map((p, i) => (
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

function EloComparison({ player, duration, tier }: { player: PostGamePlayer; duration: number; tier: string }) {
  const bench = ELO_BENCHMARKS[tier.toUpperCase()] || ELO_BENCHMARKS.GOLD;
  const mins = Math.max(duration / 60, 1);

  const metrics = [
    { label: "CS/min", value: player.cs / mins, avg: bench.cs_min, fmt: (v: number) => v.toFixed(1) },
    { label: "Vision/min", value: player.vision_score / mins, avg: bench.vision_min, fmt: (v: number) => v.toFixed(2) },
    { label: "KDA", value: player.deaths === 0 ? (player.kills + player.assists) : (player.kills + player.assists) / player.deaths, avg: bench.kda, fmt: (v: number) => v.toFixed(1) },
    { label: "DMG%", value: player.damage_share, avg: bench.dmg_share, fmt: (v: number) => `${(v * 100).toFixed(0)}%` },
    { label: "KP", value: player.kill_participation, avg: bench.kp, fmt: (v: number) => `${(v * 100).toFixed(0)}%` },
    { label: "Gold/min", value: player.gold_earned / mins, avg: bench.gold_min, fmt: (v: number) => Math.round(v).toString() },
  ];

  return (
    <div className="elo-panel">
      <h4 className="elo-title">Your Performance vs {tier} Average</h4>
      <div className="elo-metrics">
        {metrics.map((m, i) => {
          const pct = m.avg > 0 ? m.value / m.avg : 1;
          const diff = pct - 1;
          const cls = diff > 0.1 ? "elo-above" : diff < -0.1 ? "elo-below" : "elo-even";
          return (
            <div key={i} className="elo-row">
              <span className="elo-label">{m.label}</span>
              <div className="elo-bar-track">
                <div className={`elo-bar-fill ${cls}`} style={{ width: `${Math.min(pct * 100, 150)}%` }} />
                <div className="elo-bar-avg" />
              </div>
              <span className={`elo-value ${cls}`}>{m.fmt(m.value)}</span>
              <span className={`elo-diff ${cls}`}>
                {diff > 0 ? "+" : ""}{(diff * 100).toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PhaseBreakdown({ phases }: { phases: PhaseStats[] }) {
  if (phases.length === 0) return null;
  const metrics: { label: string; values: number[]; fmt: (v: number) => string }[] = [
    { label: "KDA", values: phases.map(p => p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths), fmt: v => v.toFixed(1) },
    { label: "K/D/A", values: phases.map(() => 0), fmt: () => "" }, // special row
    { label: "CS/min", values: phases.map(p => p.cs_per_min), fmt: v => v.toFixed(1) },
    { label: "Gold/min", values: phases.map(p => p.gold_per_min), fmt: v => Math.round(v).toString() },
  ];

  return (
    <div className="phase-panel">
      <h4 className="phase-title">Performance by Phase</h4>
      <div className="phase-grid">
        <div className="phase-row phase-header-row">
          <span className="phase-metric-label" />
          {phases.map((p, i) => <span key={i} className="phase-col-header">{p.phase}</span>)}
        </div>
        {/* KDA row */}
        <div className="phase-row">
          <span className="phase-metric-label">KDA</span>
          {phases.map((p, i) => (
            <div key={i} className="phase-cell">
              <span className="phase-kda">
                <span className="lg-live-k">{p.kills}</span>/<span className="lg-live-d">{p.deaths}</span>/<span className="lg-live-a">{p.assists}</span>
              </span>
            </div>
          ))}
        </div>
        {/* Metric rows */}
        {metrics.filter(m => m.label !== "KDA" && m.label !== "K/D/A").map((m, mi) => {
          const max = Math.max(...m.values, 1);
          return (
            <div key={mi} className="phase-row">
              <span className="phase-metric-label">{m.label}</span>
              {m.values.map((v, vi) => (
                <div key={vi} className="phase-cell">
                  <div className="phase-bar-track">
                    <div className="phase-bar-fill" style={{ width: `${(v / max) * 100}%` }} />
                  </div>
                  <span className="phase-val">{m.fmt(v)}</span>
                </div>
              ))}
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

      {/* Elo comparison for local player */}
      {stats.game_duration_secs > 0 && (() => {
        const local = stats.teams.flatMap(t => t.players).find(p => p.is_local);
        if (!local || !local.rank) return null;
        const tier = local.rank.split(" ")[0];
        if (!tier || !ELO_BENCHMARKS[tier.toUpperCase()]) return null;
        return <EloComparison player={local} duration={stats.game_duration_secs} tier={tier} />;
      })()}

      {/* Phase breakdown for local player */}
      {(() => {
        const local = stats.teams.flatMap(t => t.players).find(p => p.is_local);
        if (!local || local.phase_stats.length === 0) return null;
        return <PhaseBreakdown phases={local.phase_stats} />;
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

  return (
    <div className="alt-tabs">
      {options.map((opt, i) => (
        <button
          key={i}
          className={`alt-tab ${i === activeIndex ? "alt-tab-active" : ""}`}
          onClick={() => invoke("select_build_option", { category, index: i })}
        >
          <span className="alt-tab-wr">{(opt.win_rate * 100).toFixed(1)}%</span>
        </button>
      ))}
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
