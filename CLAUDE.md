# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Start Tauri app in dev mode (Rust backend + Vite hot-reload frontend)
npm run tauri dev

# Build production binary
npm run tauri build

# Frontend-only dev server (no Tauri shell, runs on localhost:1420)
npm run dev

# Type-check + build frontend only
npm run build
```

There are no tests configured in this project.

## Architecture

**QueryLoL Desktop** is a League of Legends companion app built with Tauri 2 (Rust backend) and React 19 (TypeScript frontend).

### Backend (src-tauri/src/)

- **lib.rs** — Tauri app setup, command handlers, and the main `watcher_loop`/`poll_loop`. The watcher continuously detects the League client, and the poll loop (1s interval) tracks game phase transitions (lobby → champ select → in-game → post-game), triggering builds, recommendations, and auto-apply actions.
- **lcu.rs** — League Client Update (LCU) API integration. Connects via lockfile (`riot:password` + port over HTTPS with self-signed cert). Handles all client interactions: reading game state, applying runes/spells/items, pick/ban actions, match history, post-game stats.
- **opgg.rs** — OP.GG API integration (`https://lol-api-champion.op.gg/api`). Fetches builds, counters, ban suggestions, pick recommendations (scored 0-100), and game predictions with early/late phase analysis.
- **models.rs** — All serde-serializable data structures shared between backend and frontend.
- **config.rs** — Persistent user config (region, toggles, LP history) saved to `{app_data_dir}/config.json`.

### Frontend (src/)

- **App.tsx** — Single-file monolith containing all components (~1500 lines). No component splitting — everything from the LP chart to post-game scoreboard lives here.
- **App.css** — Dark theme styled with CSS variables (no preprocessor). League of Legends aesthetic with gold/blue/red accents.

### State Flow

1. Rust backend detects game phase change via LCU polling
2. Backend updates centralized `SharedState` (`Arc<Mutex<AppState>>`)
3. Backend emits `app-state-changed` Tauri event with full `AppState` payload
4. React listener receives event → `setState(e.payload)` → re-render

All HTTP requests happen in Rust only — the frontend never calls external APIs directly. Frontend communicates with backend via `invoke("command_name", { args })` for user-initiated actions (apply build, pick/ban, change settings).

### Key Patterns

- **No Redux/state library** — pure React `useState` + Tauri event listener
- **Draft change detection** — hashing of draft state to avoid redundant API calls in the poll loop
- **Error handling** — `Result<T, String>` in Rust, try/catch on `invoke` in React with toast notifications (5s timeout)
- **TypeScript strict mode** enabled (`noUnusedLocals`, `noUnusedParameters`)

## Data Sources

| Source | Purpose |
|--------|---------|
| Riot LCU (local HTTPS) | Game state, summoner info, apply builds, match history |
| OP.GG API | Builds, counters, recommendations, predictions |
| Data Dragon (Riot CDN) | Champion/item/rune/spell metadata and icons |
| CommunityDragon | Rank emblems, stat shard icons |
