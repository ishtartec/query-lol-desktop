# QueryLoL Roadmap

Living document tracking proposed features and improvements. Items aren't ordered by priority within each section — see "Suggested implementation order" at the bottom for that.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[?]` needs investigation/spike

---

## Live Game

In-match features. Highest-impact area because the user is actively playing and decisions are time-sensitive.

- [x] **Enemy jungle tracker** — infers jungler activity from kill/assist/death events + game-time heuristics. Visual chip + TTS on rotation transitions and long absences.
- [x] **Wave state advisor** — recommendation per minute based on CS diff vs lane opponent: Push prio · roam / Push wave / Hold wave / Last-hit safe / Freeze cerca torre.
- [x] **Audio cues / TTS** — macOS `say` (Samantha en-US) and Windows SAPI (en-US). Toggle in toolbar. Champion-name based for clarity.
- [x] **Recall optimizer** — computes next reachable item from build + current gold. Pulses gold "B Lost Chapter" when affordable. TTS at threshold.
- [ ] **Enemy item powerspike countdown** — extend the existing "Xg to Y" alerts to be richer per enemy: "Jhin 320g to Collector", "Caitlyn 1500g to Wit's End (vs Mel)". Would require fetching OP.GG builds for all 5 enemies (deferred — basic version already works via item-completion alerts).
- [x] **Roam/missing tracker** — CS-delta inference (<1 cs in 25s + not dead = missing). Shows `⚠ TOP MIA 0:32` with live countdown + TTS by champion name.
- [x] **Death timer prediction** — official BRW table by level + post-15min time factor. Shows `💀 MID 28s` countdown.
- [x] **Vision score targets** — role-based Gold-elo benchmarks (SUP 1.5/min, JNG 0.9/min, others 0.6/min). Visual chip when <70% of target + TTS reminder when <50% (3min cooldown).
- [x] **Real-time recommended build panel** — full sequence (boots + 4 core items) with owned/next/future states, conic-gradient progress ring on the next item, gold-needed counter, and "READY" pulse when affordable. Compact 5-slot strip mirrored in the overlay.
- [x] **Threat-response suggestion** — after 8:00 game time, computes weighted enemy threat (KDA × level × gold-vs-baseline), detects dominant damage type / heavy CC / healing / shielding, and suggests one situational defensive item per role (Maw, Force of Nature, Randuin's, Mercury's, Mortal Reminder, Serpent's Fang…). Skips when user already owns coverage.
- [x] **Build alternatives with WR labels** — top-3 alternative core paths (≥50 games) sorted by WR, hides the currently-recommended path, shows item icons + WR% + game count.
- [x] **Objective spawn windows + TTS** — Drake / Voidgrubs / Herald / Baron spawn timers (Season 2026 timings: Drake 5:00, Voidgrubs 8:00 single, Herald 15:00 single, Baron 20:00). Overlay chips when ≤90s with urgent pulse at ≤30s and dashed border indicating last-taken team. TTS at -30s with enemy-jungler context ("Drake spawning in 30 seconds, enemy jungler unseen 50 seconds").

## Post-Game

Closes the learning loop. The data is there — we just need richer synthesis.

- [ ] **AI-powered match review** — Claude API call with aggregated stats + timeline + items/runes to generate one personalized paragraph: "Good early CS (+8 vs Gold avg), but lost tempo between 14-18m where your KDA dropped. The pivotal death was 16:32 mid without vision." Cost: ~$0.005 per review with Sonnet. **Differentiator vs other trackers.**
- [ ] **Mistake detection** — heuristics flagging notable inefficiencies: "died with 1500g unspent at 18:45", "first death 0:42 invade", "no vision contribution after 25:00".
- [ ] **Single-takeaway lesson** — distill the match into one actionable line: "your CS dropped at 14m, focus on wave management".
- [ ] **Replay marker export** — write timestamps to LoL replay files for key moments (deaths, pivotal fights).

## Champion Select

- [x] **Synergy/comp callouts** — strengths and gaps from trait analysis (engage, frontline, peel, scaling, burst). Color-coded list under the damage comp bar.
- [x] **Skill matchup for ALL lanes** — predicts each ally-vs-enemy lane outcome from power curves with FAVORED/EVEN/UNFAVORED verdicts and early/late deltas.
- [x] **Trinket recommendation** — yellow / sweeping / blue based on role + invisible threat detection + ranged poke matchup heuristics.
- [x] **Build alternatives by style** — runes/spells/items pickers now label each option with "Popular" or "Best WR" by comparing pick_rate and win_rate across alternatives.
- [x] **Ward placement preview** — text-based timeline tips per role and enemy jungler archetype (ganker/farmer/invader). Map-based visual deferred — diminishing returns vs effort.

## Lobby / Profile

- [x] **Daily summary** — games played, W/L, winrate, streak, LP net, best KDA of the day, total time played. Shown at the top of lobby.
- [x] **Champion-specific improvement** — for top 3 most-played champions (≥3 games), compares KDA/CS-min/Gold-min/WR against the user's overall baseline with color-coded deltas.
- [x] **Tilt gate** — after 3+ ranked losses in <2h, soft banner with personal historic post-streak winrate.
- [x] **Game time tracker** — total time played today shown in daily summary, colored yellow above 3h, red above 5h with "consider a break" hint.
- [?] **Ban frequency tracker** — "you should ban X based on your loss patterns". **Deferred:** requires backend changes (match_history doesn't currently store enemy champion IDs; we'd need to fetch participants per past match — 5-50 extra HTTP calls on initial load). Could revisit if local data proves insufficient.

## Cross-feature / Quality of life

- [ ] **System notifications** — native notifications for ready check, key in-game events.
- [ ] **Discord integration** — share match results, LP changes.
- [ ] **Stats over time** — charts of key metrics across weeks/months.
- [ ] **Multi-account support** — track multiple summoner accounts.
- [ ] **Customizable dashboard** — let users hide/show widgets.
- [ ] **Themes** — light theme, custom accent colors.
- [ ] **Auto-mute LoL on app focus** — mute game audio when checking the app.
- [ ] **Settings export/import** — share configs.
- [ ] **Cloud sync** — back up LP history and settings.

---

## Suggested implementation order

These are my opinion on the highest leverage next steps:

1. **Live game suite** — enemy jungle tracker, wave advisor, audio cues, recall optimizer, item spike countdown. They share a common foundation (Live Client Data + overlay/audio output) and compound: each one reinforces the others.
2. **AI-powered match review** — single highest differentiator. No competitor offers contextual per-match analysis. Once the prompt + caching pipeline is in place it unlocks more AI-driven features later (champ select advice, build review, etc.).
3. **Daily summary in lobby** — small effort, high engagement payoff.

---

## Done (recent)

- [x] **Adaptive live build engine** — full real-time recommended build panel with progress ring + threat-response situational suggestion + 3-path alternatives with WR labels, plus compact mirror in the overlay
- [x] **Objective spawn windows** — Season 2026 timings (Drake / Voidgrubs / Herald / Baron) with overlay chips, last-taken team indicator, and TTS alert at -30s with enemy-jungler context
- [x] **Roster sync — Yunara + Zaahen** — added missing 2025 champions to power curves and trait sets (Zaahen → healers/engage/burst/hard-CC; Yunara → scaling); Data Dragon fallback bumped to 16.9.1
- [x] **Lobby + Profile suite** — daily summary, tilt gate, champion-specific improvement (vs personal baseline), game time threshold warnings
- [x] **Champ select polish** — comp callouts (engage / frontline / peel / scaling / burst), all-lanes matchup predictions, trinket recommendation, build alternatives style labels (Popular / Best WR), ward placement tips per role + jungler archetype
- [x] **English localization** — translated all level plan strings (champ select + overlay) and TTS messages from Spanish to English for app-wide consistency
- [x] **Live coaching engine** — full live-game suite shipped (MIA tracker, death timer, recall optimizer, wave advisor, jungle tracker, vision targets) with TTS audio cues on macOS/Windows
- [x] **Level-by-level plan** in champ select (timeline + actions + spike highlights, 18 levels, 172 champ coverage)
- [x] **Compact 5-level plan** in overlay (current + next 4)
- [x] **Localized spell name fix** (Ignite/Prender via internal key matching)
- [x] **Ally summoner spell display** in live game
- [x] **Live game players sorted by position** (top → jng → mid → bot → sup)
- [x] **WR fallback estimation** for matchups OP.GG doesn't cover (uses power curves)
- [x] **Counter merge fix** — real OP.GG matchup WRs no longer overwritten by derived "beatability" data
- [x] **Mode gating** for level plan (hidden in ARAM)
- [x] **Missing AP champions** added to damage composition (Mel, Aurora, Hwei, etc.)
