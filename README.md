# QueryLoL Desktop

A desktop companion app for League of Legends that auto-configures optimal builds, provides counter-based pick/ban suggestions, real-time in-game tracking, and post-game analysis — all in real time.

Built with **Tauri** (Rust) + **React** (TypeScript). Lightweight (~15MB), no Overwolf, no Electron.

---

## Features

### Auto-Detection & Connection
- Automatically detects the League of Legends client via LCU (League Client Update)
- **Windows and macOS** support with automatic lockfile and process detection
- Displays summoner name, ranked tier, rank, and LP on connection
- Supports 11 regions: EUW, NA, KR, EUNE, BR, LAS, LAN, OCE, TR, RU, JP
- Persistent configuration saved to disk (region, toggles, LP history)

### Champion Select — Builds
- Fetches optimal builds from OP.GG the moment you pick a champion
- **Auto-apply runes** — writes a full rune page (primary tree, secondary tree, stat shards)
- **Auto-apply summoner spells** — sets the recommended spell pair
- **Auto-apply item sets** — creates a custom item set with starter items, boots, and core build
- **Alternative builds** — up to 3 options per category (runes, spells, items) with win rate and pick rate, switchable via tabs
- **Skill priority** — color-coded skill order sequence (Q/W/E/R)
- **Item & rune tooltips** — hover any icon to see name, description, and gold cost
- Manual "Apply" button when auto-apply is disabled

### Champion Select — Drafting Intelligence
- **Pick recommendations** — scrollable carousel of suggested champions scored 0-100, factoring in enemy counters, ally synergies, and meta strength
- **Ban suggestions** — top ban candidates for your position with win rate and pick rate, one-click ban
- **Matchup win rates** — per-enemy win rate badges (green = favorable, red = unfavorable)
- **Matchup analysis by level** — phase-by-phase power comparison (early/mid/late) with actionable tips like "avoid trades level 1-3" or "power spike at level 6"
- **Level-by-level plan** — 18-level timeline vs your lane opponent with a contextual action per level (e.g. "Lvl 3 trade", "All-in con R", "Farm lado opuesto", "R2 + obj"). Calculates per-level advantage from power curves + spike bonuses + ult-strength comparison, with hexagonal nodes pulsing on spike levels and color-coded categories (dominant / strong / even / careful / weak). Full coverage for all 172 champions. Hover any level to see a coach-style tip in the detail card
- **Damage composition** — AD/AP split bar for both teams, with warnings for heavy one-type compositions
- **Adaptive item recommendations** — situational items based on enemy comp (antiheal, MR stacking, armor, anti-shield) with champion-specific reasoning
- **Game prediction** — team-vs-team analysis with early/late game phase scores and a strategy tip
- **One-click pick/ban** — click any recommendation or ban suggestion to lock it in
- **Auto-lock** — optionally auto-lock your champion selection
- **Full draft visualization** — ally/enemy picks, bans, and positions with role icons displayed in a 3-column layout
- **ARAM bench** — shows available bench champions sorted by ARAM win rate, click to swap

### Lobby
- **Improvement priorities** — top 3 areas to improve based on your ranked history vs elo benchmarks, with visual bars and actionable advice
- **Match history** — recent games with champion icon, result, KDA, duration, and relative timestamps
- **Mode filters** — filter by All, Ranked, Normal, or ARAM
- **Champion filter** — filter match history by your top 5 most-played champions
- **Win/loss stats** — win rate percentage and current win/loss streak detection
- **LP progress chart** — SVG line chart tracking LP changes over time (up to 50 data points) with bezier curves and color-coded gains/losses
- **Champion stats bar** — top 5 champions by games played with win rate badges
- **Hero splash background** — dynamic background using your most-played champion's splash art

### Live Game
- **Team compositions** — blue vs red side with champion icons and summoner names
- **Player ranks** — rank emblems and tier text for every player in the match
- **Player labels** — automatic badges: OTP, Autofill/1st Time, Win Streak, Loss Streak, Tilted, High WR
- **Ranked stats** — W/L record, win rate, and current win/loss streak
- **Champion proficiency** — games played, win rate, and KDA on the picked champion
- **Smurf detection** — automatic analysis of enemy accounts using account level, win rate, games played, KDA, and champion diversity to flag likely smurfs with a 0-100 confidence score
- **Real-time scoreboard** — live KDA, CS, level, and current items for all players (via Live Client Data API)
- **Gold tracker** — team gold bar with total gold comparison (unspent + item value)
- **Lane matchup gold diff** — per-position gold comparison between matched lane opponents
- **Summoner spell display** — all 10 players show their summoner spells (Flash, Ignite, TP, etc.). Localized LoL clients supported via internal spell-key matching
- **Spell cooldown tracker** — click enemy summoner spells to start countdown timers (Flash 5:00, TP 6:00, etc.), click again to cancel
- **Power spike alerts** — "400g to [item]" for your next core item, and "Enemy completed [item]" when enemies buy key items
- **Objective timers** — Baron buff (3:00), Elder Dragon buff (2:30), and Dragon Soul tracking with countdown and team indicator
- **Objective feed** — dragons, baron, herald, turrets, inhibitors, and multikills with timestamps
- **Win probability** — real-time win % estimate based on gold diff, game time, dragons, and baron (displayed in gold bar and overlay)
- **In-game overlay** — hold TAB to show a compact overlay with win probability, lane gold diffs, objective timers, and a **5-level plan preview** (current level + next 4 with actions, advantage, and spike warnings for both you and the lane opponent). Borderless windowed mode, configurable position
- **Player profiles** — click any player to view their match history in an overlay

### Post-Game Analysis
- **Full scoreboard** — all 10 players with comprehensive stats and position icons
- **KDA** — kills, deaths, assists with computed KDA ratio (or "Perfect" for 0 deaths)
- **Damage & damage share** — total damage with proportional bar, damage percentage of team total
- **Kill participation** — percentage of team kills involved in
- **CS & vision score** — with ward placement and ward kill breakdown on hover
- **Gold earned** — formatted with "k" suffix
- **Performance highlighting** — stats color-coded green (>115% of team avg) or red (<85% of team avg)
- **MVP badge** — awarded to the top performer based on a composite score
- **Multikill badges** — triple, quadra, and penta kill indicators
- **Final items** — complete end-game item build for each player with tooltips
- **Gold advantage timeline** — SVG chart showing gold diff over time with death markers and win probability curve overlay
- **Elo comparison** — your CS/min, vision/min, KDA, damage share, KP, and gold/min compared against your rank's average with percentage deltas
- **Performance by phase** — CS/min, gold/min, and KDA broken down by early (0-14m), mid (14-25m), and late (25m+) game phases
- **Player profiles** — click any player name to view their ranked info and match history

### Ready Check
- **Auto-accept** — automatically accepts the ready check when a match is found

### Settings (Toolbar)
- Region selector
- Auto-apply toggle
- Auto-lock toggle
- Auto-accept toggle
- All settings persisted across sessions

### Auto-Update
- Checks for new versions on startup via GitHub Releases
- One-click update & restart from an in-app banner

---

## Download & Install

Pre-built binaries for **Windows** (.exe) and **macOS** (.dmg) are available from the [Releases](../../releases/latest) page.

### Windows

1. Download the `.exe` installer from the latest release
2. Run the installer — Windows SmartScreen will show a warning because the app is not code-signed yet
3. Click **"More info"** → **"Run anyway"** to proceed with the installation
4. Launch QueryLoL from the Start Menu or desktop shortcut
5. Set League of Legends to **Borderless** display mode (Settings → Video) for the in-game overlay to work

### macOS

1. Download the `.dmg` from the latest release
2. Open the DMG and drag QueryLoL to Applications
3. On first launch, macOS may block the app. If you see "app is damaged", open Terminal and run:
   ```bash
   xattr -cr /Applications/QueryLoL.app
   ```
4. Open QueryLoL from Applications

### In-Game Overlay

During a match, hold **TAB** to show a compact overlay with gold diff, enemy KDA/items/spells, and objective timers. The overlay position can be configured from the toolbar dropdown (Top-Left, Top-Right, Bottom-Left, Bottom-Right, Center, or Off). Requires **Borderless** display mode in League of Legends.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop runtime | [Tauri 2](https://tauri.app/) (Rust) |
| Frontend | React 19 + TypeScript |
| Build tool | Vite 7 |
| HTTP client | Reqwest (Rust) |
| Async runtime | Tokio (Rust) |
| Serialization | Serde (Rust) |

### Data Sources
- **Riot LCU** — local League client API for game state, summoner info, applying builds, match history
- **Riot Live Client Data** — real-time in-game stats (port 2999): KDA, CS, gold, items, game events
- **OP.GG API** — champion builds, counters, win rates, ban suggestions, pick recommendations, game predictions
- **Data Dragon** (Riot CDN) — champion/item/rune/spell metadata, icons, and descriptions
- **CommunityDragon** — rank emblems, stat shard icons, position icons

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri prerequisites](https://tauri.app/start/prerequisites/)

### Development

```bash
# Install dependencies
pnpm install

# Run in development mode (launches Tauri + Vite dev server)
pnpm tauri dev
```

### Build

```bash
# Build for production
pnpm tauri build
```

### Release

```bash
# Bump version, commit, tag, and push (triggers CI build + GitHub Release)
./scripts/release.sh 0.5.0
```

---

## How It Works

1. **Watcher loop** — the Rust backend continuously polls for the League client process. Once detected, it reads the LCU lockfile to establish a connection.
2. **Phase detection** — polls the game phase every second (lobby, champ select, in-game, post-game) and reacts to transitions.
3. **Build fetching** — when you pick a champion in champ select, it fetches the optimal build from OP.GG for your champion + position + region.
4. **Auto-apply** — writes runes, summoner spells, and item sets directly to the League client via LCU endpoints.
5. **Draft analysis** — as enemies are revealed, it calculates matchup win rates, power curves, damage composition, generates pick/ban recommendations, adaptive item suggestions, a game prediction, and an 18-level action plan against your lane opponent (combining interpolated power curves, per-champion spike levels, and ult-strength comparison).
6. **Live game data** — during a match, polls the Live Client Data API (port 2999) every second for real-time KDA, CS, gold, items, and game events. Records snapshots every 30s for post-game phase analysis.
7. **Overlay** — a second transparent window (hold TAB) shows compact live game info on top of the game (Windows borderless windowed).
8. **Post-game analysis** — computes gold timeline, death impacts, per-phase stats, and elo comparison from collected snapshots.
9. **State sync** — the backend emits `app-state-changed` events to the React frontend, which re-renders reactively.

---

## Disclaimer

QueryLoL Desktop is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

## License

[MIT](LICENSE)
