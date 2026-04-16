# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **lcu.rs** — League Client Update (LCU) API integration. Connects via lockfile (platform-specific paths for macOS/Windows). Handles: game state, applying runes/spells/items, pick/ban, match history, post-game stats, live game data, ARAM bench swap. Also contains `poll_live_game_data()` for the Live Client Data API (port 2999) and `compute_phase_stats()`/`compute_gold_timeline()` from snapshot data.
- **opgg.rs** — OP.GG API integration. Fetches builds, counters, ban suggestions, pick recommendations, game predictions, ARAM win rates.
- **models.rs** — All serde-serializable data structures. Key types: `AppState`, `LiveGameState`, `LivePlayerStats`, `PostGameStats`, `PlayerSnapshot`, `AramBenchChampion`.
- **config.rs** — Persistent user config (region, toggles, LP history) saved to `{app_data_dir}/config.json`.

### Frontend (src/)

- **main.tsx** — Entry point. Detects overlay vs main window via `getCurrentWebviewWindow().label` and renders the appropriate component.
- **App.tsx** — Single-file containing all components (~2900 lines). Includes: champion select views, live game with spell tracking, post-game analysis, overlay, tooltips, ARAM bench, improvement panel, matchup analysis, damage composition, win probability model, and all static data (champion traits, power curves, elo benchmarks, spell cooldowns).
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
- **LCU match details**: `timeline.lane` field is unreliable for position detection. We use Smite detection + role heuristics as fallback.
- **LCU ranked stats**: The endpoint returns 0 losses for other players — we hide W/L when data is incomplete.
- **OP.GG ARAM tier list**: Returns different JSON format than ranked — we fallback to the ranked tier list with ARAM position filter.
