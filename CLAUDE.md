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
- **lcu.rs** — League Client Update (LCU) API integration. Connects via lockfile (platform-specific paths for macOS/Windows). Handles: game state, applying runes/spells/items, pick/ban, match history, post-game stats, live game data, ARAM bench swap. Also contains `poll_live_game_data()` for the Live Client Data API (port 2999), `compute_phase_stats()`/`compute_gold_timeline()` from snapshot data, and `derive_position_from_history()` (timeline lane + Smite heuristic, used for both match details and match history entries). `get_live_game()` resolves the local player's team via `summoner_id` first, falling back to summoner-name match — important on Riot-ID clients where the LCU returns `summonerId: 0`.
- **opgg.rs** — OP.GG API integration. Fetches builds, counters, ban suggestions, pick recommendations, game predictions, ARAM win rates. `fetch_champion_data()` retries up to 3× with backoff (600ms / 1.5s / 3s) to absorb transient OP.GG outages during champ select.
- **models.rs** — All serde-serializable data structures. Key types: `AppState`, `LiveGameState` (carries `recommended_build` and `recommended_alternatives` for the in-game build panel), `LivePlayerStats`, `PostGameStats`, `MatchHistoryEntry` (now includes `position`), `PlayerSnapshot`, `AramBenchChampion`.
- **config.rs** — Persistent user config (region, toggles, LP history) saved to `{app_data_dir}/config.json`.

### Frontend (src/)

- **main.tsx** — Entry point. Detects overlay vs main window via `getCurrentWebviewWindow().label` and renders the appropriate component.
- **App.tsx** — Single-file containing all components (~4800 lines). Includes: champion select views, live game with spell tracking, post-game analysis, overlay, tooltips, ARAM bench, improvement panel, matchup analysis, damage composition, win probability model, and all static data. Key static maps: `CHAMP_DAMAGE_TYPE`, `POWER_CURVES`, `CHAMP_ROLES` (primary + flex roles per champion, used by `pickLaneOpponent` and `pairLanes` to match enemies during draft when their `position` field is empty), trait sets (`TRAIT_HEALERS`, `TRAIT_HARD_CC`, `TRAIT_ENGAGE`, etc.), `ELO_BENCHMARKS` + `ROLE_MULTIPLIERS` (role-adjusted post-game / lobby benchmarks), `ROLE_TIPS` (per-role improvement tips), `THREAT_ITEMS` (situational defensive items by archetype). Helpers: `computeBuildSequence`, `suggestThreatResponse`, `computeObjectiveSpawns`, `inferMainRole`, `getRoleAdjustedBenchmark`.
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
| Data Dragon (Riot CDN) | Champion/item/rune/spell metadata, icons, descriptions |
| CommunityDragon | Rank emblems, stat shard icons, position icons |

## Known Issues

- **macOS Accessibility**: Overlay (TAB hold) requires Accessibility permission. In dev mode, the binary changes on each compile, invalidating the permission. In production (DMG), it persists.
- **LCU match details / history**: `timeline.lane` field is unreliable for position detection. We use Smite detection + lane/role heuristics as fallback (see `derive_position_from_history` in lcu.rs).
- **LCU ranked stats**: The endpoint returns 0 losses for other players — we hide W/L when data is incomplete.
- **LCU summoner_id post Riot-ID**: `/lol-summoner/v1/current-summoner` may return 0 or omit `summonerId` on newer clients. Live-game team detection falls back to summoner-name match — without it, allies/enemies were inverted on Red side.
- **OP.GG ARAM tier list**: Returns different JSON format than ranked — we fallback to the ranked tier list with ARAM position filter.
- **Riot draft API position field**: Enemy `position` is empty until lock-in. `pickLaneOpponent` infers from `CHAMP_ROLES` (primary then secondary) so the Skill Matchup / All-Lanes panels don't pair Shaco SUP vs Veigar etc.
