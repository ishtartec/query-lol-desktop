# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Toolchain

- **Node 22** (active LTS) + **pnpm 11** via corepack. Pinned in `package.json` `packageManager` field; CI uses `pnpm/action-setup@v4` without explicit version so it reads from there.
- **pnpm build approval**: lives in `pnpm-workspace.yaml` as `allowBuilds: { esbuild: true }`. The legacy `pnpm.onlyBuiltDependencies` field in `package.json` is silently ignored by pnpm 11 — `strictDepBuilds` will then exit 1 in CI even though local installs succeed (because of inherited global config). If you add a new dep with a postinstall script, approve it here.

## Build & Development Commands

```bash
# Start Tauri app in dev mode (Rust backend + Vite hot-reload frontend)
pnpm tauri dev

# Build production binary
pnpm tauri build

# Frontend-only dev server (no Tauri shell, runs on localhost:1420)
pnpm dev

# Type-check frontend only
npx tsc --noEmit

# Rust type-check only
cd src-tauri && cargo check

# Release a new version (bumps version in 3 files, commits, tags, pushes)
./scripts/release.sh 0.X.0
```

There are no tests configured in this project.

## Architecture

**QueryLoL Desktop** is a League of Legends companion app built with Tauri 2 (Rust backend) and React 19 (TypeScript frontend). Supports Windows and macOS.

### Backend (src-tauri/src/)

- **lib.rs** — Tauri app setup, command handlers (~15 commands), `watcher_loop` (LCU connection), `poll_loop` (1s game phase polling), and `overlay_loop` (50ms TAB key polling via device_query). Manages phase transitions: lobby → champ select → in-game → post-game.
- **lcu.rs** — League Client Update (LCU) API integration. Connects via lockfile (platform-specific paths for macOS/Windows). Handles: game state, applying runes/spells/items, pick/ban, match history, post-game stats, live game data, ARAM bench swap. Also contains `poll_live_game_data()` for the Live Client Data API (port 2999), `compute_phase_stats()`/`compute_gold_timeline()` from snapshot data, `get_match_timeline()` (gold chart for history matches, from the LCU timeline endpoint rather than live snapshots), and `derive_position_from_history()` (timeline lane + Smite heuristic, used for both match details and match history entries). `get_live_game()` resolves the local player's team via `summoner_id` first, falling back to summoner-name match — important on Riot-ID clients where the LCU returns `summonerId: 0`.
- **opgg.rs** — OP.GG API integration. Fetches builds, counters, ban suggestions, pick recommendations, game predictions, ARAM win rates. `fetch_champion_data()` retries up to 3× with backoff (600ms / 1.5s / 3s) to absorb transient OP.GG outages during champ select. The response carries more than we parse — `OpggChampionData` has `#[serde(default)]` on every field, so unmapped keys (`rune_pages`, `mythic_items`, `last_items`, `trends`, `skill_evolves`) are dropped silently rather than erroring.
- **models.rs** — All serde-serializable data structures. `PostGamePlayer` carries the physical/magic/true damage split, damage taken, self-mitigated and champion level, read through `stat_i64()` because the end-of-game block uses SCREAMING_SNAKE keys while match details use camelCase. Key types: `AppState`, `LiveGameState` (carries `recommended_build` and `recommended_alternatives` for the in-game build panel), `LivePlayerStats`, `PostGameStats`, `MatchHistoryEntry` (now includes `position`), `PlayerSnapshot`, `AramBenchChampion`.
- **config.rs** — Persistent user config (region, toggles, LP history) saved to `{app_data_dir}/config.json`.

### Frontend (src/)

- **main.tsx** — Entry point. Detects overlay vs main window via `getCurrentWebviewWindow().label` and renders the appropriate component.
- **App.tsx** — Single-file containing all components (~4800 lines). Includes: champion select views, live game with spell tracking, post-game analysis, overlay, tooltips, ARAM bench, improvement panel, matchup analysis, damage composition, win probability model, and all static data. Key static maps: `CHAMP_DAMAGE_TYPE`, `POWER_CURVES`, `CHAMP_ROLES` (primary + flex roles per champion, used by `pickLaneOpponent` and `pairLanes` to match enemies during draft when their `position` field is empty), trait sets (`TRAIT_HEALERS`, `TRAIT_HARD_CC`, `TRAIT_ENGAGE`, etc.), `ELO_BENCHMARKS` + `ROLE_MULTIPLIERS` (role-adjusted post-game / lobby benchmarks), `ROLE_TIPS` (per-role improvement tips), `THREAT_ITEMS` (situational defensive items by archetype). `suggestThreatResponse` scores all five branches (antiheal / MR / armor / tenacity / anti-shield) as "what share of the enemy team is this threat" and returns the highest, rather than returning on the first match. The old first-match-wins order made antiheal fire whenever a single enemy was in `TRAIT_HEALERS` — 56 champions, present in 82.5% of teams — so it was the only advice the feature ever gave and the other four branches were unreachable. Measured over 600 simulated players from 60 matches, the suggestion went from antiheal 82.5% to MR 44% / armor 23% / antiheal 20% / tenacity 3%. Enablers are charged to the shield bucket and removed from both the damage and healing pools, so one Seraphine no longer inflates three branches at once; who counts as an enabler is read from their live items (AP < 80 and AD < 60) rather than assumed from champion identity. Normalising each branch's score by its own trigger bar was tried and reverted — measured, it inflated antiheal from 20% to 43% of all suggestions.

`suggestAntiShield` is separate rather than a sixth branch. Magic resist and armor are alternatives to each other, but Serpent's Fang counters a mechanic and may be wanted alongside them; ranked against the others it scored 0% in every variant tried, because two of five champions essentially never hold half the enemy threat. Note its role gate only rules someone out when the position is *known*: modes without lanes report none at all (73% of a 600-player sample), and gating on that suppressed the advice entirely.

Helpers: `computeBuildSequence`, `suggestThreatResponse`, `suggestPenetration`, `computeObjectiveSpawns`, `inferMainRole`, `getRoleAdjustedBenchmark`.

`DamageProfilePanel` is the post-game counterpart, two cards in one row: **Damage Dealt** (the split the game recorded, the enemy's resistances derived the same way, and how much they absorbed after your own penetration) and **Damage Taken** (what actually hit you by type, your finished resistances, mitigated total). A single note picks whichever story applies. Penetration advice is gated on `damage_share >= 0.15` — it used to fire on an Alistar who dealt 8% of team damage, which is bad advice nobody would follow. Its CSS is prefixed `dprof-`: champ select's damage-composition panel already owns `.dmg-row` / `.dmg-bar` / `.dmg-resist` / `.dmg-legend-item`, and reusing those names silently restyled it.

`suggestPenetration` reads the enemy team's *actual* resistances (champion base + per-level growth + magic resist/armor on the items they are holding, via `itemStats.ts`) and states the exact damage a penetration item would unlock. The multiplier `100/(100+R)` does not depend on ability ratios, so the figure is real rather than estimated — but comparing penetration against raw AP/AD *would* need a champion's base-vs-ratio damage split, which is not public, so the advisor never makes that claim. Validated against 60 Match-V5 timelines: the displayed gain lands within ±2 percentage points of the engine's own resistance values 91% of the time, biased slightly low because runes granting resistances are not modelled. Percent penetration is worth ~10% more damage even against a team with no resist items, so the trigger requires ≥15% gain (≈48 average resist) *and* two enemies actually holding resist items. Rendered in both in-game views: the main window's `BuildSequencePanel` and the overlay's build strip. The overlay is click-through, so nothing there can be hovered — the gain goes in the badge itself rather than a `title` (the neighbouring threat suggestion still uses a `title`, which is therefore dead).
- **itemStats.ts** — Parses structured stats out of Data Dragon's item description HTML. Needed because the `stats` object DDragon ships alongside each item is a legacy field that never tracked modern items: it reports Shadowflame's 110 AP but omits its 15 magic penetration, and says nothing about Void Staff's 40%. The `<stats>` block in `description` is what the shop actually renders. Note the percent sign sits *inside* the tag (`<attention>40%</attention> Magic Penetration`), so a regex expecting digits before `</attention>` silently drops every percent stat. Covers 404 of 476 purchasable items, 54 of them with penetration.
- **Data Dragon loading** — `DDRAGON_VERSION` starts as a hardcoded fallback and is replaced once `versions.json` resolves, while every loader (`loadChampionData`, `loadItemData`, `loadRuneData`, `loadChampionSpells`) memoises its result. Whichever loader runs first therefore pins the patch for the whole session, so they all `await ensureVersion()` before reading the version. Skipping that is not a cosmetic race: a panel mounting early once cached item stats from a months-old patch, which showed up only as a 5-point difference in a resistance total.
- **App.css** — Dark theme with CSS variables. League of Legends aesthetic with gold/blue/red accents. Custom scrollbar, overlay styles, position icons.

### State Flow

1. Rust backend detects game phase change via LCU polling
2. Backend updates centralized `SharedState` (`Arc<Mutex<AppState>>`)
3. Backend emits `app-state-changed` Tauri event with full `AppState` payload
4. React listener receives event → `setState(e.payload)` → re-render
5. Overlay window polls state via `invoke("get_state")` every 1s as fallback

All HTTP requests happen in Rust only. Frontend communicates with backend via `invoke("command_name", { args })` for user-initiated actions.

### Key Patterns

- **No Redux/state library** — pure React `useState` + Tauri event listener
- **Draft change detection** — hashing of draft state to avoid redundant API calls
- **Two windows** — main app + overlay (transparent, always-on-top, click-through)
- **Snapshot collection** — during live game, player stats recorded every 30s for post-game phase analysis
- **Win probability** — logistic model based on gold diff, game time, dragons, baron
- **Platform-conditional code** — `#[cfg(target_os)]` for macOS/Windows lockfile paths, process detection, notifications
- **TypeScript strict mode** enabled (`noUnusedLocals`, `noUnusedParameters`)

## Data Sources

| Source | Purpose |
|--------|---------|
| Riot LCU (local HTTPS) | Game state, summoner info, apply builds, match history, ARAM bench |
| Riot Live Client Data (port 2999) | Real-time in-game stats: KDA, CS, gold, items, events |
| OP.GG API | Builds, counters, recommendations, predictions, ARAM win rates |
| Data Dragon (Riot CDN) | Champion/item/rune/spell metadata, icons, descriptions. Per-champion ability text lives in a separate `champion/{Key}.json` (~15KB), keyed by the DDragon id ("MonkeyKing", not 62) — `loadChampionSpells()` caches it. |
| Riot champion-abilities CDN (`d28xe8vt774jo5.cloudfront.net`) | Per-ability preview clips + `.jpg` posters, keyed by the numeric champion id zero-padded to 4 digits (Ahri = `0103`). Use `.mp4`, not the smaller `.webm` — WebM support in WKWebView varies by macOS version. mp4 with `muted` + `playsInline` autoplays fine in WKWebView (confirmed in the app); no explicit `.play()` needed. Clips are 1-6MB each (Kai'Sa's five total 50MB), so they load only inside the hover tooltip, which renders lazily. |
| Riot Match-V5 (needs an API key) | Not used at runtime — the app ships no key. Used offline to validate `itemStats.ts`: per-minute `championStats` deltas around item purchases measure what an item actually grants. See `scripts/validate-item-stats.mjs`. Note V5 returns obfuscated PUUIDs that do not match the LCU's, and rejects requests carrying urllib's default User-Agent with a 403. |
| CommunityDragon | Rank emblems, stat shard icons, position icons |

## Known Issues

- **No per-item damage attribution exists**: not in the LCU, and not in Riot's public API either. Match-V5's `victimDamageDealt` names only champions and abilities (`ahriq`, `kaisapassive`, `kaisabasicattack2`); the string `Item` appears zero times in an 815KB timeline. Any "damage by item" feature would be unverifiable by construction, which is why there isn't one.
- **`championStats` reports live effective values**: armor, magic resist and health are polluted by shred, buffs and shields, so they cannot be used to measure item values (measured Trinity Force at -20 armor). Attack damage and ability power are almost never shredded and resolve exactly.

- **macOS Accessibility**: Overlay (TAB hold) requires Accessibility permission. In dev mode, the binary changes on each compile, invalidating the permission. In production (DMG), it persists.
- **LCU game timeline is V4-shaped**: `/lol-match-history/v1/game-timelines/{gameId}` works for every game in history, but `participantFrames` only carry gold/xp/level (no `damageStats`) and the only events are `CHAMPION_KILL` / `BUILDING_KILL` — no `victimDamageDealt`, no `ITEM_PURCHASED`. Per-item or per-ability damage attribution is therefore **not** obtainable locally; it exists only in Riot's public Match-V5 timeline. Frames are one per minute, so death gold-swings are split across the deaths sharing a frame.
- **Modes without lanes still report a position**: ARAM fills the field with a junk marker, and each endpoint picks a different one — the end-of-game block says `INVALID`, match details say `NONE`, and `timeline.lane` says `NONE` with `role: SUPPORT` for all ten players. `normalize_position()` in lcu.rs blanks these at the source; every render site already hides an empty position, so it must not be patched per-site.
- **LCU match details / history**: `timeline.lane` field is unreliable for position detection. We use Smite detection + lane/role heuristics as fallback (see `derive_position_from_history` in lcu.rs).
- **Trait sets carry ids that no longer exist**: `TRAIT_SHIELDERS` held `685` and `TRAIT_SCALING` held `803`; neither is in Data Dragon (173 champions) nor CommunityDragon, so they matched nobody and failed silently. Worth re-auditing all `TRAIT_*` sets against `champion.json` after champion reworks or removals.
- **`TRAIT_SHIELDERS` means *ally* shields, not self-shields**: it is what `suggestAntiShield` keys on, and Serpent's Fang is wasted against a Malphite rock passive. Classified from Data Dragon spell text — but note that Morgana's Black Shield never says "shield" in the spell *description* and only does in the `tooltip`, so a description-only scan gives a false negative there.
- **LCU ranked stats**: The endpoint returns 0 losses for other players — we hide W/L when data is incomplete.
- **LCU summoner_id post Riot-ID**: `/lol-summoner/v1/current-summoner` may return 0 or omit `summonerId` on newer clients. Live-game team detection falls back to summoner-name match — without it, allies/enemies were inverted on Red side.
- **OP.GG ARAM tier list**: Returns different JSON format than ranked — we fallback to the ranked tier list with ARAM position filter.
- **Riot draft API position field**: Enemy `position` is empty until lock-in. `pickLaneOpponent` infers from `CHAMP_ROLES` (primary then secondary) so the Skill Matchup / All-Lanes panels don't pair Shaco SUP vs Veigar etc.
