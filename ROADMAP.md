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

## Post-Game

Closes the learning loop. The data is there — we just need richer synthesis.

- [ ] **AI-powered match review** — Claude API call with aggregated stats + timeline + items/runes to generate one personalized paragraph: "Good early CS (+8 vs Gold avg), but lost tempo between 14-18m where your KDA dropped. The pivotal death was 16:32 mid without vision." Cost: ~$0.005 per review with Sonnet. **Differentiator vs other trackers.**
- [ ] **Mistake detection** — heuristics flagging notable inefficiencies: "died with 1500g unspent at 18:45", "first death 0:42 invade", "no vision contribution after 25:00".
- [ ] **Single-takeaway lesson** — distill the match into one actionable line: "your CS dropped at 14m, focus on wave management".
- [ ] **Replay marker export** — write timestamps to LoL replay files for key moments (deaths, pivotal fights).

## Champion Select

- [ ] **Synergy/comp callouts** — explicit summary of team strengths and gaps: "Strong engage (Maokai + Yone), missing sustain, consider Karma or Lulu".
- [ ] **Skill matchup for ALL lanes** — predict each lane's matchup outcome, not just yours, with simple verdicts (favored / even / unfavored).
- [ ] **Trinket recommendation** — yellow vs sweeping vs blue ward based on role + matchup + typical swap minute.
- [ ] **Build alternatives by style** — show "most popular", "highest WR", and "off-meta strong" side-by-side instead of a single recommended build.
- [ ] **Ward placement preview** — first-3-min ward placements per role and against the specific jungler (Mobalytics-style).

## Lobby / Profile

- [ ] **Daily / weekly summary** — winrate of the day, net LP, MVP count, KDA peaks. Shown when the app opens. Engagement + motivation.
- [ ] **Champion-specific improvement** — for top 3 champions, compare your CS/min, vision/min, KP against the Gold average for *that specific champion* (not aggregate role).
- [ ] **Tilt / streak gate** — after 3 ranked losses in <2h, soft prompt with personal data: "your historical winrate drops from 48% to 31% on games after a 3-loss streak — consider a break".
- [ ] **Game time tracker** — "you've played 4h today". Optional ceiling notification.
- [ ] **Ban frequency tracker** — "you should ban X based on your loss patterns".

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
