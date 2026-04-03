import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
}

interface PostGameTeam {
  is_winner: boolean;
  players: PostGamePlayer[];
  avg_damage: number;
  avg_gold: number;
  avg_cs: number;
  avg_vision: number;
}

interface PostGameStats {
  teams: PostGameTeam[];
  game_duration_secs: number;
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
}

interface LivePlayerStats {
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  level: number;
  current_gold: number;
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
}

interface BuildAlternatives {
  runes: RuneOption[];
  summoner_spells: SpellOption[];
  core_items: ItemOption[];
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
  11: "Smite", 12: "Teleport", 14: "Ignite", 21: "Barrier", 32: "Mark",
};

const SPELL_KEYS: Record<number, string> = {
  1: "SummonerBoost", 3: "SummonerExhaust", 4: "SummonerFlash",
  6: "SummonerHaste", 7: "SummonerHeal", 11: "SummonerSmite",
  12: "SummonerTeleport", 14: "SummonerDot", 21: "SummonerBarrier",
  32: "SummonerSnowball",
};

const SPELL_COOLDOWNS: Record<number, number> = {
  1: 210, 3: 210, 4: 300, 6: 210, 7: 240,
  12: 360, 14: 180, 21: 180, 32: 80,
};

const POSITION_LABELS: Record<string, string> = {
  top: "TOP", jungle: "JNG", middle: "MID", mid: "MID",
  bottom: "ADC", adc: "ADC", utility: "SUP", support: "SUP",
};

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

function getItemName(id: number): string {
  return itemCache?.[id.toString()]?.name || `Item ${id}`;
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
    game_mode: "classic", recommendations: [], ban_phase_active: false,
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
      <header className="header">
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
          </div>
        </div>
      )}

      {/* Waiting / Match History */}
      {isConnected && !inChampSelect && !inGame && !inPostGame && (
        <section className="section-lobby">
          {state.match_history.length > 0 ? (
            <>
              <LobbyBackground history={state.match_history} />
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
          {/* Top: Draft Recommendations carousel */}
          {!hasChampion && state.recommendations.length > 0 && (
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
                        {p.position && <span className="cs-player-pos">{POSITION_LABELS[p.position] || p.position.toUpperCase()}</span>}
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
                        {POSITION_LABELS[state.assigned_position] || state.assigned_position.toUpperCase()}
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
                        <div className="card-header">
                          <h3 className="card-label">Items</h3>
                          {state.build_alternatives && state.build_alternatives.core_items.length > 1 && (
                            <AltTabs
                              options={state.build_alternatives.core_items}
                              category="items"
                              currentIds={state.build!.core_items}
                            />
                          )}
                        </div>
                        <div className="items-sections">
                          {state.build!.starter_items.length > 0 && (
                            <div className="items-group">
                              <span className="items-label">Start</span>
                              <div className="items-row">
                                {state.build!.starter_items.map(id => (
                                  <div key={id} className="item-slot"><ItemIcon id={id} size={32} /></div>
                                ))}
                              </div>
                            </div>
                          )}
                          {state.build!.boots.length > 0 && (
                            <div className="items-group">
                              <span className="items-label">Boots</span>
                              <div className="items-row">
                                {state.build!.boots.map(id => (
                                  <div key={id} className="item-slot"><ItemIcon id={id} size={32} /></div>
                                ))}
                              </div>
                            </div>
                          )}
                          {state.build!.core_items.length > 0 && (
                            <div className="items-group">
                              <span className="items-label">Core</span>
                              <div className="items-row">
                                {state.build!.core_items.map((id, i) => (
                                  <div key={id} className="items-row">
                                    <div className="item-slot" title={getItemName(id)}><img src={itemIconUrl(id)} alt="" /></div>
                                    {i < state.build!.core_items.length - 1 && <span className="item-arrow">&rarr;</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Prediction & Strategy (not ARAM) */}
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
                        {p.position && <span className="cs-player-pos">{POSITION_LABELS[p.position] || p.position.toUpperCase()}</span>}
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


// --- LP Chart ---

function LpChart({ history }: { history: LpEntry[] }) {
  const width = 400;
  const height = 80;
  const pad = { top: 8, bottom: 20, left: 8, right: 8 };

  const lps = history.map(h => h.lp);
  const minLp = Math.min(...lps) - 5;
  const maxLp = Math.max(...lps) + 5;
  const range = Math.max(maxLp - minLp, 10);

  const points = history.map((h, i) => {
    const x = pad.left + (i / Math.max(history.length - 1, 1)) * (width - pad.left - pad.right);
    const y = pad.top + (1 - (h.lp - minLp) / range) * (height - pad.top - pad.bottom);
    return { x, y, lp: h.lp, tier: h.tier, rank: h.rank };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  const first = history[0];
  const last = history[history.length - 1];
  const diff = last.lp - first.lp;
  const diffColor = diff >= 0 ? "var(--accent-green)" : "var(--accent-red)";

  return (
    <div className="lp-chart-container">
      <div className="lp-chart-header">
        <h3 className="section-title">LP Progress</h3>
        <span className="lp-diff" style={{ color: diffColor }}>
          {diff >= 0 ? "+" : ""}{diff} LP
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

  let filtered = history;
  if (modeFilter === "ranked") filtered = filtered.filter(m => m.queue_id === 420 || m.queue_id === 440);
  else if (modeFilter === "normal") filtered = filtered.filter(m => m.queue_id === 400 || m.queue_id === 430 || m.queue_id === 490);
  else if (modeFilter === "aram") filtered = filtered.filter(m => m.queue_id === 450 || m.queue_id === 900 || m.game_mode === "ARAM");
  if (champFilter) filtered = filtered.filter(m => m.champion_id === champFilter);
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
      <ChampionStatsBar history={filtered} filter={champFilter} onFilter={setChampFilter} />

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
  let gold = p.live.current_gold;
  for (const id of p.live.items) {
    const item = getItemData(id);
    if (item) gold += item.gold;
  }
  return gold;
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
          <span className="lane-pos">{m.pos}</span>
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
  const goldDiff = ld ? ld.ally_gold - ld.enemy_gold : 0;
  const recentEvents = ld?.events.slice(-5).reverse() ?? [];

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
          <span className="lg-gold-ally">{Math.round(ld.ally_gold).toLocaleString()}g</span>
          <div className="lg-gold-track">
            <div className="lg-gold-fill" style={{ width: `${ld.ally_gold / (ld.ally_gold + ld.enemy_gold + 1) * 100}%` }} />
          </div>
          <span className="lg-gold-enemy">{Math.round(ld.enemy_gold).toLocaleString()}g</span>
          <span className={`lg-gold-diff ${goldDiff > 0 ? "lg-wr-good" : goldDiff < 0 ? "lg-wr-bad" : ""}`}>
            {goldDiff > 0 ? "+" : ""}{Math.round(goldDiff).toLocaleString()}
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

      {/* Elo comparison for local player */}
      {stats.game_duration_secs > 0 && (() => {
        const local = stats.teams.flatMap(t => t.players).find(p => p.is_local);
        if (!local || !local.rank) return null;
        const tier = local.rank.split(" ")[0];
        if (!tier || !ELO_BENCHMARKS[tier.toUpperCase()]) return null;
        return <EloComparison player={local} duration={stats.game_duration_secs} tier={tier} />;
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
            {p.position && <> &middot; {POSITION_LABELS[p.position.toLowerCase()] || p.position}</>}
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

export default App;
