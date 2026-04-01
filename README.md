# QueryLoL Desktop

A desktop companion app for League of Legends that auto-configures optimal builds, provides counter-based pick/ban suggestions, and delivers post-game analysis — all in real time.

Built with **Tauri** (Rust) + **React** (TypeScript).

---

## Features

### Auto-Detection & Connection
- Automatically detects the League of Legends client via LCU (League Client Update)
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
- Manual "Apply" button when auto-apply is disabled

### Champion Select — Drafting Intelligence
- **Pick recommendations** — scrollable carousel of suggested champions scored 0-100, factoring in enemy counters, ally synergies, and meta strength
- **Ban suggestions** — top ban candidates for your position with win rate and pick rate, one-click ban
- **Matchup win rates** — per-enemy win rate badges (green = favorable, red = unfavorable)
- **Game prediction** — team-vs-team analysis with early/late game phase scores and a strategy tip
- **One-click pick/ban** — click any recommendation or ban suggestion to lock it in
- **Auto-lock** — optionally auto-lock your champion selection
- **Full draft visualization** — ally/enemy picks, bans, and positions displayed in a 3-column layout

### Lobby
- **Match history** — recent games with champion icon, result, KDA, duration, and relative timestamps
- **Mode filters** — filter by All, Ranked, Normal, or ARAM
- **Champion filter** — filter match history by your top 5 most-played champions
- **Win/loss stats** — win rate percentage and current win/loss streak detection
- **LP progress chart** — SVG line chart tracking LP changes over time (up to 50 data points) with bezier curves and color-coded gains/losses
- **Champion stats bar** — top 5 champions by games played with win rate badges
- **Hero splash background** — dynamic background using your most-played champion's splash art
- **Show more** — expandable match history (up to 50 matches)

### Live Game
- **Team compositions** — blue vs red side with champion icons and summoner names
- **Player ranks** — rank emblems and tier text for every player in the match
- **Smurf detection** — automatic analysis of enemy accounts using account level, win rate, games played, KDA, and champion diversity to flag likely smurfs with a 0-100 confidence score
- **Player profiles** — click any player to view their match history in an overlay

### Post-Game Analysis
- **Full scoreboard** — all 10 players with comprehensive stats
- **KDA** — kills, deaths, assists with computed KDA ratio (or "Perfect" for 0 deaths)
- **Damage & damage share** — total damage with proportional bar, damage percentage of team total
- **Kill participation** — percentage of team kills involved in
- **CS & vision score** — with ward placement and ward kill breakdown on hover
- **Gold earned** — formatted with "k" suffix
- **Performance highlighting** — stats color-coded green (>115% of team avg) or red (<85% of team avg)
- **MVP badge** — awarded to the top performer based on a composite score
- **Multikill badges** — triple, quadra, and penta kill indicators
- **Final items** — complete end-game item build for each player
- **Player profiles** — click any player name to view their ranked info and match history

### Ready Check
- **Auto-accept** — automatically accepts the ready check when a match is found

### Settings (Toolbar)
- Region selector
- Auto-apply toggle
- Auto-lock toggle
- Auto-accept toggle
- All settings persisted across sessions

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
- **OP.GG API** — champion builds, counters, win rates, ban suggestions, pick recommendations, game predictions
- **Data Dragon** (Riot CDN) — champion data, item/rune/spell icons and metadata
- **CommunityDragon** — rank emblems, stat shard icons, rune icons

---

## Project Structure

```
query-lol-desktop/
├── src/                        # Frontend (React + TypeScript)
│   ├── App.tsx                 # Main app component & all child components
│   ├── App.css                 # Full styling (dark theme, CSS variables)
│   ├── main.tsx                # React entry point
│   └── vite-env.d.ts
├── src-tauri/                  # Backend (Rust + Tauri)
│   ├── src/
│   │   ├── main.rs             # Entry point
│   │   ├── lib.rs              # Tauri commands, watcher loop, state management
│   │   ├── lcu.rs              # League Client (LCU) integration
│   │   ├── opgg.rs             # OP.GG API integration
│   │   ├── models.rs           # Data structures
│   │   └── config.rs           # Config persistence
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri prerequisites](https://tauri.app/start/prerequisites/)

### Download

Pre-built binaries for **Windows** and **macOS** are available from [GitHub Actions](../../actions) artifacts on every push to `main`.

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

---

## How It Works

1. **Watcher loop** — the Rust backend continuously polls for the League client process. Once detected, it reads the LCU lockfile to establish a connection.
2. **Phase detection** — polls the game phase every second (lobby, champ select, in-game, post-game) and reacts to transitions.
3. **Build fetching** — when you pick a champion in champ select, it fetches the optimal build from OP.GG for your champion + position + region.
4. **Auto-apply** — writes runes, summoner spells, and item sets directly to the League client via LCU endpoints.
5. **Draft analysis** — as enemies are revealed, it calculates matchup win rates, generates pick/ban recommendations, and produces a game prediction with early/late phase analysis.
6. **State sync** — the backend emits `app-state-changed` events to the React frontend, which re-renders reactively.

---

## Disclaimer

QueryLoL Desktop is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

## License

[MIT](LICENSE)
