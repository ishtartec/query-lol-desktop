import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  bans: number[];
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
  is_local: boolean;
  kills: number;
  deaths: number;
  assists: number;
  total_damage: number;
  gold_earned: number;
  cs: number;
  vision_score: number;
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

interface LiveGameState {
  queue_name: string;
  allies: LiveGamePlayer[];
  enemies: LiveGamePlayer[];
}

interface LiveGamePlayer {
  champion_id: number;
  summoner_name: string;
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
  match_history: MatchHistoryEntry[];
  live_game: LiveGameState | null;
  post_game: PostGameStats | null;
  game_mode: string;
  recommendations: PickRecommendation[];
  ban_phase_active: boolean;
  auto_apply: boolean;
  auto_lock: boolean;
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
  11: "Smite", 12: "Teleport", 14: "Ignite", 21: "Barrier",
};

const SPELL_KEYS: Record<number, string> = {
  1: "SummonerBoost", 3: "SummonerExhaust", 4: "SummonerFlash",
  6: "SummonerHaste", 7: "SummonerHeal", 11: "SummonerSmite",
  12: "SummonerTeleport", 14: "SummonerDot", 21: "SummonerBarrier",
};

const POSITION_LABELS: Record<string, string> = {
  top: "TOP", jungle: "JNG", middle: "MID", mid: "MID",
  bottom: "ADC", adc: "ADC", utility: "SUP", support: "SUP",
};

const SKILL_COLORS: Record<string, string> = {
  Q: "#4fc3f7", W: "#81c784", E: "#ffb74d", R: "#ef5350",
};

const STAT_SHARDS: Record<number, string> = {
  5001: "Health Scaling", 5002: "Armor", 5003: "Magic Resist",
  5005: "Attack Speed", 5007: "Ability Haste", 5008: "Adaptive Force",
  5010: "Move Speed", 5011: "Health", 5013: "Tenacity",
};

// --- Data Dragon cache ---

interface RuneData { id: number; name: string; icon: string; }

let championCache: Record<string, { key: string; name: string }> | null = null;
let runeCache: Map<number, RuneData> | null = null;
let runeStyleCache: Map<number, { name: string; icon: string }> | null = null;

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
          runeCache.set(rune.id, { id: rune.id, name: rune.name, icon: rune.icon });
        }
      }
    }
  } catch {}
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

// --- Components ---

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
    draft: null, ranked: null, lp_history: [], ban_suggestions: [], comfort_picks: [],
    match_history: [], live_game: null, post_game: null,
    game_mode: "classic", recommendations: [], ban_phase_active: false,
    auto_apply: true, auto_lock: false, region: "euw",
  });
  const [runesLoaded, setRunesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorTimeout = useRef<number | null>(null);

  const championInfo = useChampionName(state.champion_id);

  useEffect(() => {
    invoke<AppState>("get_state").then(setState);
    fetchLatestVersion().then(() => {
      loadChampionData();
      loadRuneData().then(() => setRunesLoaded(true));
    });
    const unlisten = listen<AppState>("app-state-changed", (e) => setState(e.payload));
    return () => { unlisten.then(fn => fn()); };
  }, []);

  function showError(msg: string) {
    setError(msg);
    if (errorTimeout.current) clearTimeout(errorTimeout.current);
    errorTimeout.current = window.setTimeout(() => setError(null), 5000);
  }

  async function handleApply() {
    try { await invoke("apply_build_now"); } catch (e: any) { showError(String(e)); }
  }

  const isConnected = state.status !== "disconnected";
  const inChampSelect = state.status === "champ_select";
  const inGame = state.status === "in_game";
  const inPostGame = state.status === "post_game";
  const hasChampion = state.champion_id && state.champion_id > 0 && championInfo;
  const hasBuild = state.build;

  return (
    <main className="app">
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
              {state.ranked.tier} {state.ranked.rank} &middot; {state.ranked.lp} LP
            </span>
          )}
        </div>
      </header>

      {/* Disconnected - waiting for LoL client */}
      {!isConnected && (
        <section className="section-connect">
          <div className="connect-card">
            <div className="connect-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h2>Waiting for League Client</h2>
            <p className="hint">Launch the League of Legends client to get started</p>
            <div className="connect-controls">
              <select className="select" value={state.region}
                onChange={(e) => invoke("set_region", { region: e.target.value })}>
                {REGIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="pulse-ring" style={{ marginTop: 20 }} />
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
          </div>
        </div>
      )}

      {/* Waiting / Match History */}
      {isConnected && !inChampSelect && !inGame && !inPostGame && (
        <section className="section-lobby">
          {state.match_history.length > 0 ? (
            <>
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
        <LiveGameView game={state.live_game} />
      )}

      {/* Champ select: 3-column landscape layout */}
      {inChampSelect && (
        <div className="champ-select-layout">
          {/* Left: Draft */}
          <div className="cs-left">
            {state.draft && <DraftView draft={state.draft} counters={state.counters} myChampionId={state.champion_id} />}
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
                <div className="champion-card">
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
                                  <div key={id} className="item-slot"><img src={itemIconUrl(id)} alt="" /></div>
                                ))}
                              </div>
                            </div>
                          )}
                          {state.build!.boots.length > 0 && (
                            <div className="items-group">
                              <span className="items-label">Boots</span>
                              <div className="items-row">
                                {state.build!.boots.map(id => (
                                  <div key={id} className="item-slot"><img src={itemIconUrl(id)} alt="" /></div>
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
                                    <div className="item-slot"><img src={itemIconUrl(id)} alt="" /></div>
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
          </div>

          {/* Right: Recommendations */}
          <div className="cs-right">
            {/* Ban suggestions */}
            {!hasChampion && state.ban_phase_active && state.ban_suggestions.length > 0 && (
              <section className="section-recs" style={{ marginBottom: 14 }}>
                <h3 className="section-title">Ban Suggestions</h3>
                <div className="recs-list">
                  {state.ban_suggestions.map(ban => (
                    <BanCard key={ban.champion_id} ban={ban} />
                  ))}
                </div>
              </section>
            )}

            {/* Comfort picks */}
            {!hasChampion && state.comfort_picks.length > 0 && (
              <section className="section-recs" style={{ marginBottom: 14 }}>
                <h3 className="section-title">Your Champions</h3>
                <div className="recs-list">
                  {state.comfort_picks.map(cp => (
                    <ComfortCard key={cp.champion_id} pick={cp} />
                  ))}
                </div>
              </section>
            )}

            {/* Recommended picks */}
            {!hasChampion && state.recommendations.length > 0 && (
              <section className="section-recs">
                <h3 className="section-title">Meta Picks</h3>
                <div className="recs-list">
                  {state.recommendations.map(rec => (
                    <RecCard key={rec.champion_id} rec={rec} />
                  ))}
                </div>
              </section>
            )}

            {hasChampion && (
              <section className="section-recs">
                <h3 className="section-title">Items in Shop</h3>
                <p className="waiting-text" style={{ fontSize: 11 }}>
                  Items pushed to the LoL client shop as "QueryLoL Recommended"
                </p>
              </section>
            )}
          </div>
        </div>
      )}

      {/* Post-game summary */}
      {inPostGame && state.post_game && (
        <PostGameView stats={state.post_game} showBack={true} />
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

// --- Draft View ---

function normalizePosition(pos: string): string {
  const map: Record<string, string> = { middle: "mid", bottom: "adc", utility: "support" };
  return map[pos] || pos;
}

function DraftView({ draft, counters, myChampionId }: {
  draft: DraftState;
  counters: Record<string, number>;
  myChampionId: number | null;
}) {
  const myPos = draft.allies.find(a => a.is_local)?.position || "";
  const laneOpponentId = draft.enemies.find(
    e => e.champion_id > 0 && normalizePosition(e.position) === normalizePosition(myPos)
  )?.champion_id;

  const hasCounters = myChampionId && myChampionId > 0 && Object.keys(counters).length > 0;

  return (
    <div className="draft-panel">
      <div className="draft-teams">
        <div className="draft-team draft-team-ally">
          <h4 className="draft-team-label">Your Team</h4>
          <div className="draft-slots">
            {draft.allies.map((p, i) => (
              <div key={i} className={`draft-slot ${p.is_local ? "draft-slot-local" : ""}`}>
                <ChampionIcon championId={p.champion_id} size={32} />
                <div className="draft-slot-info">
                  <ChampionNameLabel championId={p.champion_id} fallback={p.is_local ? "You" : "..."} />
                  {p.position && <span className="draft-pos">{POSITION_LABELS[p.position] || p.position.toUpperCase()}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="draft-vs">VS</div>

        <div className="draft-team draft-team-enemy">
          <h4 className="draft-team-label">Enemy Team</h4>
          <div className="draft-slots">
            {draft.enemies.length > 0 ? draft.enemies.map((p, i) => {
              const wr = hasCounters && p.champion_id > 0 ? counters[p.champion_id.toString()] : undefined;
              const isLaneOpponent = p.champion_id === laneOpponentId && laneOpponentId > 0;
              return (
                <div key={i} className={`draft-slot ${isLaneOpponent ? "draft-slot-lane" : ""}`}>
                  <ChampionIcon championId={p.champion_id} size={32} />
                  <div className="draft-slot-info">
                    <ChampionNameLabel championId={p.champion_id} fallback="..." />
                    {p.position && <span className="draft-pos">{POSITION_LABELS[p.position] || p.position.toUpperCase()}</span>}
                  </div>
                  {wr !== undefined && (
                    <span className={`matchup-badge ${wr > 0.5 ? "matchup-good" : "matchup-bad"}`}>
                      {(wr * 100).toFixed(1)}%
                    </span>
                  )}
                </div>
              );
            }) : (
              <div className="draft-empty">No enemy picks visible</div>
            )}
          </div>
        </div>
      </div>

      {draft.bans.length > 0 && (
        <div className="draft-bans">
          <span className="draft-bans-label">Bans</span>
          <div className="draft-bans-list">
            {draft.bans.map((id, i) => (
              <ChampionIcon key={i} championId={id} size={22} className="ban-icon" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChampionNameLabel({ championId, fallback }: { championId: number; fallback: string }) {
  const info = useChampionName(championId);
  return <span className="draft-champ-name">{info?.name || fallback}</span>;
}

// --- Recommendation Card ---

function RecCard({ rec }: { rec: PickRecommendation }) {
  const info = useChampionName(rec.champion_id);
  return (
    <div className="rec-card rec-clickable" onClick={() => invoke("pick_champion", { championId: rec.champion_id })} title="Click to pick">
      <ChampionIcon championId={rec.champion_id} size={40} className="rec-icon" />
      <div className="rec-info">
        <span className="rec-name">{info?.name || `#${rec.champion_id}`}</span>
        <div className="rec-stats">
          <span className="rec-wr">{(rec.win_rate * 100).toFixed(1)}% WR</span>
          {rec.counters_count > 0 && (
            <span className="rec-counter">Counters {rec.counters_count}</span>
          )}
        </div>
      </div>
      <div className="rec-score">{(rec.score * 100).toFixed(0)}</div>
    </div>
  );
}

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
          stroke="var(--border)" strokeWidth="1" strokeDasharray="4 2" />

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
  const wins = history.filter(h => h.win).length;
  const losses = history.length - wins;
  const wr = history.length > 0 ? ((wins / history.length) * 100).toFixed(0) : "0";

  // Calculate current streak
  let streakCount = 0;
  let streakWin = history.length > 0 ? history[0].win : true;
  for (const m of history) {
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
      <div className="mh-trend">
        {history.map((m, i) => (
          <div key={i} className={`mh-trend-dot ${m.win ? "trend-win" : "trend-loss"}`} title={m.win ? "Win" : "Loss"} />
        ))}
      </div>
      <div className="mh-list">
        {history.map((m, i) => (
          <MatchHistoryRow key={i} match={m} />
        ))}
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

function LiveGameView({ game }: { game: LiveGameState }) {
  return (
    <div className="lg-layout">
      <div className="lg-header">
        <h3 className="section-title">In Game</h3>
        <span className="lg-queue">{game.queue_name}</span>
      </div>
      <div className="lg-teams">
        <div className="lg-team">
          <h4 className="draft-team-label" style={{ color: "var(--accent-blue)" }}>Your Team</h4>
          <div className="lg-players">
            {game.allies.map((p, i) => (
              <div key={i} className="lg-player">
                <ChampionIcon championId={p.champion_id} size={36} />
                <div className="lg-player-info">
                  <span className="lg-player-name">{p.summoner_name}</span>
                  <ChampionNameLabel championId={p.champion_id} fallback="" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lg-vs">VS</div>
        <div className="lg-team">
          <h4 className="draft-team-label" style={{ color: "var(--accent-red)" }}>Enemy Team</h4>
          <div className="lg-players">
            {game.enemies.map((p, i) => (
              <div key={i} className="lg-player">
                <ChampionIcon championId={p.champion_id} size={36} />
                <div className="lg-player-info">
                  <span className="lg-player-name">{p.summoner_name}</span>
                  <ChampionNameLabel championId={p.champion_id} fallback="" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
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

function ComfortCard({ pick }: { pick: ComfortPick }) {
  const info = useChampionName(pick.champion_id);
  const isMeta = pick.meta_win_rate > 0.51;
  return (
    <div className="rec-card comfort-card rec-clickable" onClick={() => invoke("pick_champion", { championId: pick.champion_id })} title="Click to pick">
      <ChampionIcon championId={pick.champion_id} size={36} className="rec-icon" />
      <div className="rec-info">
        <span className="rec-name">{info?.name || "..."}</span>
        <div className="rec-stats">
          <span className="rec-wr">{(pick.meta_win_rate * 100).toFixed(1)}% WR</span>
          <span className="comfort-games">{pick.games_played} games</span>
          {isMeta && <span className="best-pick-badge">Best Pick</span>}
        </div>
      </div>
      <span className="comfort-badge">MAIN</span>
    </div>
  );
}

// --- Post Game View ---

const POS_ORDER: Record<string, number> = {
  TOP: 0, JUNGLE: 1, MIDDLE: 2, MID: 2, BOTTOM: 3, ADC: 3, UTILITY: 4, SUPPORT: 4,
};

function PostGameView({ stats, showBack }: { stats: PostGameStats; showBack?: boolean }) {
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
              {players.map((p, pi) => (
                <PostGameRow key={pi} player={p} maxDamage={maxDamage} team={team} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatCell({ value, avg, format }: { value: number; avg: number; format: string }) {
  const cls = value > avg * 1.15 ? "pg-above" : value < avg * 0.85 ? "pg-below" : "";
  const display = format === "k" ? formatNumber(value) : value.toString();
  return <span className={`pg-stat ${cls}`}>{display}</span>;
}

function PostGameRow({ player: p, maxDamage, team }: { player: PostGamePlayer; maxDamage: number; team: PostGameTeam }) {
  const champInfo = useChampionName(p.champion_id);
  const kda = p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(1);
  const dmgPct = (p.total_damage / maxDamage) * 100;

  return (
    <div className={`postgame-row ${p.is_local ? "postgame-row-local" : ""} ${p.is_mvp ? "postgame-row-mvp" : ""}`}>
      <div className="pg-player">
        <ChampionIcon championId={p.champion_id} size={32} />
        <div className="pg-player-info">
          <span className="pg-player-name">
            {p.summoner_name !== "Unknown" ? p.summoner_name : (champInfo?.name || "Unknown")}
            {p.is_mvp && <span className="mvp-badge">MVP</span>}
          </span>
          <span className="pg-champ-name">
            {champInfo?.name || ""}
            {p.position && <> &middot; {POSITION_LABELS[p.position.toLowerCase()] || p.position}</>}
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
      <div className="pg-col-cs">
        <StatCell value={p.cs} avg={team.avg_cs} format="" />
      </div>
      <div className="pg-col-vision">
        <StatCell value={p.vision_score} avg={team.avg_vision} format="" />
      </div>
      <div className="pg-col-gold">
        <StatCell value={p.gold_earned} avg={team.avg_gold} format="k" />
      </div>
      <div className="pg-col-items">
        <div className="pg-items-row">
          {p.items.map((id, ii) => (
            <div key={ii} className="pg-item">
              <img src={itemIconUrl(id)} alt="" />
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
          {primaryPerks.map((id, i) => {
            const rune = runeCache?.get(id);
            return (
              <div key={id} className={`rune-pip ${i === 0 ? "keystone" : ""}`} title={rune?.name || `${id}`}>
                {rune ? <img src={runeIconUrl(rune.icon)} alt={rune.name} /> : <span className="rune-id">{id}</span>}
              </div>
            );
          })}
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
          {secondaryPerks.map(id => {
            const rune = runeCache?.get(id);
            return (
              <div key={id} className="rune-pip" title={rune?.name || `${id}`}>
                {rune ? <img src={runeIconUrl(rune.icon)} alt={rune.name} /> : <span className="rune-id">{id}</span>}
              </div>
            );
          })}
        </div>
      </div>
      {statShards.length > 0 && (
        <>
          <div className="rune-divider" />
          <div className="rune-tree">
            <div className="rune-tree-header"><span>Shards</span></div>
            <div className="rune-slots rune-slots-shards">
              {statShards.map((id, i) => (
                <div key={`${id}-${i}`} className="shard-chip">{STAT_SHARDS[id] || id}</div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
