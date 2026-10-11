// Game recordings: the post-game card, the review player and the library.
// The backend (recorder.rs) writes `{id}.mp4` plus `{id}.json` with the key
// moments, the gold timeline and the offset that maps game time to video
// time (`video_t = game_t + offset_secs`).
import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./recordings.css";

export interface KeyMoment {
  time: number;
  kind: string; // kill | death | assist | multikill | objective | end
  title: string;
  detail: string;
  ally: boolean;
}

export interface Recording {
  id: string;
  path: string;
  created_at: number;
  duration_secs: number;
  bytes: number;
  offset_secs: number | null;
  kept: boolean;
  interrupted: boolean;
  game_id: number;
  champion_id: number;
  queue: string;
  win: boolean | null;
  kills: number;
  deaths: number;
  assists: number;
  moments: KeyMoment[];
  gold_timeline: { game_time: number; gold_diff: number }[];
}

export type ChampionMap = Record<string, { key: string; name: string }>;

export interface RecordingStatus {
  active: boolean;
  error: string | null;
}

/** Seconds of lead-in before a moment, so a jump shows how it started. */
const LEAD = 8;
/** Mirrors KEEP_RECENT in recorder.rs. */
const KEEP_RECENT = 10;
/** How long a deleted recording can still be restored. */
const UNDO_MS = 6000;

export function useRecordings(): Recording[] {
  const [list, setList] = useState<Recording[]>([]);
  useEffect(() => {
    const load = () => invoke<Recording[]>("list_recordings").then(setList).catch(() => {});
    load();
    const unlisten = listen("recordings-changed", load);
    return () => { unlisten.then(fn => fn()); };
  }, []);
  return list;
}

// ---------- helpers ----------

const offsetOf = (r: Recording) => r.offset_secs ?? 0;
const toVideo = (r: Recording, gameT: number) => Math.max(0, gameT + offsetOf(r));
const gameLength = (r: Recording) => Math.max(0, r.duration_secs - offsetOf(r));
const videoUrl = (r: Recording) => convertFileSrc(r.path);

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function fmtWhen(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

const MULTI_RANK: Record<string, number> = { "Penta kill": 5, "Quadra kill": 4, "Triple kill": 3, "Double kill": 2 };

/** The moment a recording is best opened at: the biggest multikill, else a
 *  kill, else an objective your team took. */
export function bestMoment(r: Recording): KeyMoment | null {
  const multis = r.moments.filter(m => m.kind === "multikill")
    .sort((a, b) => (MULTI_RANK[b.title] ?? 0) - (MULTI_RANK[a.title] ?? 0));
  return multis[0]
    ?? r.moments.find(m => m.kind === "kill")
    ?? r.moments.find(m => m.kind === "objective" && m.ally && m.title === "Baron")
    ?? r.moments.find(m => m.kind === "objective" && m.ally)
    ?? null;
}

type Bucket = "kill" | "death" | "obj";
const bucketOf = (m: KeyMoment): Bucket | null =>
  m.kind === "kill" || m.kind === "multikill" || m.kind === "assist" ? "kill"
    : m.kind === "death" ? "death"
    : m.kind === "objective" ? "obj" : null;

/** CSS class giving a moment its marker shape and colour. */
const markClass = (m: KeyMoment) =>
  m.kind === "death" ? "rec-mk-death"
    : m.kind === "assist" ? "rec-mk-assist"
    : m.kind === "objective" ? (m.ally ? "rec-mk-obj" : "rec-mk-obj-enemy")
    : "rec-mk-kill";

const resultLabel = (r: Recording) =>
  r.win === true ? "Victory" : r.win === false ? "Defeat" : r.interrupted ? "Interrupted" : "Practice";
const resultClass = (r: Recording) => r.win === true ? "rec-win" : r.win === false ? "rec-loss" : "rec-neutral";

function Icon({ name, size = 16 }: { name: "play" | "pause" | "keep" | "kept" | "trash" | "prev" | "next" | "folder" | "close"; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true } as const;
  switch (name) {
    case "play": return <svg {...p}><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>;
    case "pause": return <svg {...p}><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /></svg>;
    case "keep": return <svg {...p}><path d="M6 3h12v18l-6-4-6 4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
    case "kept": return <svg {...p}><path d="M6 3h12v18l-6-4-6 4z" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
    case "trash": return <svg {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "prev": return <svg {...p}><path d="M6 5v14M19 5l-9 7 9 7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
    case "next": return <svg {...p}><path d="M18 5v14M5 5l9 7-9 7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
    case "folder": return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
    case "close": return <svg {...p}><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  }
}

/** A still from the recording, taken at `at` seconds of video time. */
function Thumb({ rec, at }: { rec: Recording; at: number }) {
  return <video className="rec-thumb-media" src={`${videoUrl(rec)}#t=${at.toFixed(1)}`} preload="metadata" muted playsInline />;
}

/** Deletes after a grace period unless undone. Deletes immediately if the
 *  component unmounts while the period is running. */
function useDeferredDelete(id: string) {
  const [pending, setPending] = useState(false);
  const timer = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pendingRef.current = false;
    invoke("delete_recording", { id }).catch(() => {});
  };
  useEffect(() => () => { if (pendingRef.current) commit(); }, [id]); // eslint-disable-line
  return {
    pending,
    start: () => {
      setPending(true);
      pendingRef.current = true;
      timer.current = window.setTimeout(commit, UNDO_MS);
    },
    undo: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pendingRef.current = false;
      setPending(false);
    },
  };
}

function KeepButton({ rec, compact }: { rec: Recording; compact?: boolean }) {
  const toggle = () => invoke("set_recording_kept", { id: rec.id, kept: !rec.kept }).catch(() => {});
  return (
    <button className={`rec-btn rec-keep ${rec.kept ? "is-kept" : ""} ${compact ? "rec-keep-compact" : ""}`}
      onClick={toggle} aria-pressed={rec.kept}
      aria-label={compact ? (rec.kept ? "Unkeep recording" : "Keep recording") : undefined}
      title={rec.kept ? "Kept: never deleted automatically" : `Keep: exempt from the last-${KEEP_RECENT} rotation`}>
      <Icon name={rec.kept ? "kept" : "keep"} size={compact ? 14 : 15} />
      {!compact && (rec.kept ? "Kept" : "Keep")}
    </button>
  );
}

// ---------- post-game card ----------

export function RecordingCard({ rec, onWatch }: { rec: Recording; onWatch: (rec: Recording, at?: number) => void }) {
  const [confirming, setConfirming] = useState(false);
  const del = useDeferredDelete(rec.id);
  const best = bestMoment(rec);
  const openAt = best ? toVideo(rec, best.time - LEAD) : 0;
  const deaths = rec.moments.filter(m => m.kind === "death");

  const chips = useMemo(() => {
    const out: { label: string; time: string; cls: string; at: number }[] = [];
    if (best) out.push({ label: best.title, time: fmtClock(best.time), cls: markClass(best), at: best.time });
    const firstKill = rec.moments.find(m => m.kind === "kill");
    if (firstKill && firstKill !== best) out.push({ label: "First kill", time: fmtClock(firstKill.time), cls: "rec-mk-kill", at: firstKill.time });
    const baron = rec.moments.find(m => m.kind === "objective" && m.title === "Baron" && m.ally);
    if (baron && baron !== best) out.push({ label: "Baron", time: fmtClock(baron.time), cls: "rec-mk-obj", at: baron.time });
    if (deaths.length) out.push({
      label: deaths.length === 1 ? "1 death" : `${deaths.length} deaths`,
      time: deaths.slice(0, 2).map(d => fmtClock(d.time)).join(" · "), cls: "rec-mk-death", at: deaths[0].time,
    });
    return out;
  }, [rec]); // eslint-disable-line

  if (del.pending) {
    return (
      <div className="rec-deleted">
        <span><Icon name="trash" size={15} /> Recording deleted · {fmtSize(rec.bytes)} freed</span>
        <button className="rec-btn rec-btn-quiet" onClick={del.undo}>Undo</button>
      </div>
    );
  }

  const len = rec.duration_secs || 1;
  return (
    <section className="rec-card" aria-label="Game recording">
      <button className="rec-card-thumb" onClick={() => onWatch(rec, openAt)} aria-label="Watch recording">
        <Thumb rec={rec} at={openAt + LEAD} />
        <span className="rec-thumb-shade" />
        <span className="rec-thumb-play"><Icon name="play" size={22} /></span>
        <span className="rec-thumb-foot">
          <span className="rec-badge">{fmtClock(gameLength(rec))}</span>
          {best && <span className="rec-thumb-caption">Opens at your {best.title.toLowerCase()} · {fmtClock(best.time - LEAD)}</span>}
        </span>
      </button>

      <div className="rec-card-body">
        <div className="rec-eyebrow"><span className="rec-dot" />Recording</div>
        <h2 className="rec-card-title">Your game is ready to watch</h2>
        <div className="rec-meta">{fmtClock(gameLength(rec))} · {fmtSize(rec.bytes)}{rec.moments.length ? ` · ${rec.moments.filter(m => bucketOf(m)).length} key moments` : ""}</div>
        {chips.length > 0 && (
          <div className="rec-chips">
            {chips.map((c, i) => (
              <button key={i} className="rec-chip" onClick={() => onWatch(rec, toVideo(rec, c.at - LEAD))}>
                <span className={`rec-mk rec-mk-sm ${c.cls}`} />{c.label}<span className="rec-chip-time">{c.time}</span>
              </button>
            ))}
          </div>
        )}
        <div className="rec-strip">
          <div className="rec-strip-track">
            <span className="rec-strip-line" />
            {rec.moments.filter(m => bucketOf(m)).map((m, i) => (
              <button key={i} className={`rec-mk rec-strip-mk ${markClass(m)}`}
                style={{ left: `${(toVideo(rec, m.time) / len) * 100}%` }}
                onClick={() => onWatch(rec, toVideo(rec, m.time - LEAD))}
                aria-label={`${m.title} at ${fmtClock(m.time)}`} />
            ))}
          </div>
          <div className="rec-strip-axis"><span>0:00</span><span>{fmtClock(gameLength(rec))}</span></div>
        </div>
      </div>

      <div className="rec-card-actions">
        <button className="rec-btn rec-watch" onClick={() => onWatch(rec, openAt)}><Icon name="play" />Watch</button>
        <KeepButton rec={rec} />
        {confirming ? (
          <div className="rec-confirm">
            <div>Delete this recording? Frees {fmtSize(rec.bytes)}.</div>
            <div className="rec-confirm-row">
              <button className="rec-btn rec-danger" onClick={() => { setConfirming(false); del.start(); }}>Delete</button>
              <button className="rec-btn rec-btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="rec-btn rec-ghost" onClick={() => setConfirming(true)}><Icon name="trash" size={15} />Delete</button>
        )}
        <div className="rec-retention">
          {rec.kept ? "Kept. It will never be deleted automatically." : `Stays among your last ${KEEP_RECENT} games, then makes room for newer ones.`}
        </div>
      </div>
    </section>
  );
}

// ---------- player ----------

export function RecordingPlayer({ rec, startAt, champions, onClose }: {
  rec: Recording; startAt?: number; champions: ChampionMap; onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(startAt ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [show, setShow] = useState<Record<Bucket, boolean>>({ kill: true, death: true, obj: true });
  const [selected, setSelected] = useState<KeyMoment | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [mediaLen, setMediaLen] = useState(0);
  // Interrupted recordings may not know their length until the video loads.
  const len = rec.duration_secs || mediaLen || 1;
  const listRef = useRef<HTMLDivElement>(null);

  const moments = rec.moments.filter(m => { const b = bucketOf(m); return b && show[b]; });
  const gameNow = Math.max(0, now - offsetOf(rec));

  // Smooth playhead: timeupdate fires only ~4 times a second.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { if (video.current) setNow(video.current.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => { if (video.current) video.current.playbackRate = rate; }, [rate]);

  const seek = (t: number) => {
    const v = Math.min(Math.max(0, t), len);
    if (video.current) video.current.currentTime = v;
    setNow(v);
  };
  const jump = (m: KeyMoment) => { setSelected(m); seek(toVideo(rec, m.time - LEAD)); video.current?.play(); };
  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) v.play(); else v.pause(); };
  const nextM = moments.find(m => toVideo(rec, m.time - LEAD) > now + 0.5);
  const prevM = [...moments].reverse().find(m => toVideo(rec, m.time - LEAD) < now - 1.5);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") { e.preventDefault(); toggle(); }
      else if (k === "j") seek(now - 5);
      else if (k === "l") seek(now + 5);
      else if (k === "arrowright" && nextM) { e.preventDefault(); jump(nextM); }
      else if (k === "arrowleft" && prevM) { e.preventDefault(); jump(prevM); }
      else if (k === "escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The moment on screen: the one just jumped to while its lead-in and
  // aftermath play, else the latest one passed in the last 6 s.
  const active = (selected && gameNow >= selected.time - LEAD - 0.5 && gameNow <= selected.time + 6) ? selected
    : [...moments].reverse().find(m => m.time <= gameNow + 0.25 && gameNow - m.time <= 6) ?? null;
  const listActive = active ?? [...moments].reverse().find(m => m.time <= gameNow) ?? null;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".rec-row.is-active");
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [listActive]);

  // Gold lead curve, drawn in video time so it lines up with the markers.
  const gold = useMemo(() => {
    const pts = rec.gold_timeline;
    if (pts.length < 2) return null;
    const max = Math.max(1000, ...pts.map(p => Math.abs(p.gold_diff)));
    const x = (t: number) => ((toVideo(rec, t) / len) * 1000).toFixed(1);
    const y = (v: number) => (30 - (v / max) * 27).toFixed(1);
    const area = (f: (v: number) => number) =>
      `M${x(pts[0].game_time)},30 ` + pts.map(p => `L${x(p.game_time)},${y(f(p.gold_diff))}`).join(" ") + ` L${x(pts[pts.length - 1].game_time)},30 Z`;
    return {
      pos: area(v => Math.max(0, v)),
      neg: area(v => Math.min(0, v)),
      line: pts.map((p, i) => `${i ? "L" : "M"}${x(p.game_time)},${y(p.gold_diff)}`).join(" "),
    };
  }, [rec]); // eslint-disable-line

  const champ = champions[String(rec.champion_id)];
  const pct = (t: number) => `${(t / len) * 100}%`;
  const kda = `${rec.kills} / ${rec.deaths} / ${rec.assists}`;

  const onTrack = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  return (
    <div className="rec-player" role="dialog" aria-label="Recording player">
      <header className="rec-player-head">
        <div className="rec-player-title">
          <button className="rec-btn rec-btn-quiet" onClick={onClose}>&larr; Back</button>
          <span className="rec-sep" />
          <span className={`rec-result ${resultClass(rec)}`}>{resultLabel(rec)}</span>
          <span className="rec-player-sub">
            {[champ?.name, rec.queue, (rec.kills || rec.deaths || rec.assists) ? kda : "", fmtWhen(rec.created_at)].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="rec-player-actions">
          <KeepButton rec={rec} />
          {confirmDel ? (
            <span className="rec-inline-confirm">
              Delete {fmtSize(rec.bytes)}?
              <button className="rec-btn rec-danger rec-btn-sm" onClick={() => { invoke("delete_recording", { id: rec.id }).finally(onClose); }}>Delete</button>
              <button className="rec-btn rec-btn-quiet rec-btn-sm" onClick={() => setConfirmDel(false)}>Cancel</button>
            </span>
          ) : (
            <button className="rec-btn rec-icon" aria-label="Delete recording" onClick={() => setConfirmDel(true)}><Icon name="trash" size={15} /></button>
          )}
          <button className="rec-btn rec-icon" aria-label="Close player" onClick={onClose}><Icon name="close" size={15} /></button>
        </div>
      </header>

      <div className="rec-player-body">
        <div className="rec-player-main">
          <div className="rec-stage">
            <video ref={video} className="rec-video" src={videoUrl(rec)} preload="auto" playsInline
              onLoadedMetadata={(e) => { setMediaLen(e.currentTarget.duration || 0); e.currentTarget.currentTime = startAt ?? 0; e.currentTarget.playbackRate = rate; e.currentTarget.play().catch(() => {}); }}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
              onTimeUpdate={(e) => { if (!playing) setNow(e.currentTarget.currentTime); }}
              onClick={toggle} />
            <span className="rec-stage-shade" />
            {active && (
              <div className="rec-toast" key={`${active.kind}-${active.time}`}>
                <span className={`rec-mk ${markClass(active)}`} />
                <span className="rec-toast-title">{active.title}</span>
                {active.detail && <span className="rec-toast-detail">{active.detail}</span>}
                <span className="rec-toast-time">{fmtClock(active.time)}</span>
              </div>
            )}
            {!playing && (
              <button className="rec-stage-play" onClick={toggle} aria-label="Play"><Icon name="play" size={26} /></button>
            )}
            <span className="rec-badge rec-stage-rate">{rate}×</span>
          </div>

          <div className="rec-timeline">
            <div className="rec-track"
              onClick={(e) => seek(onTrack(e) * len)}
              onMouseMove={(e) => setHoverX(onTrack(e))}
              onMouseLeave={() => setHoverX(null)}>
              <div className="rec-track-lane" />
              <svg className="rec-gold" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">
                <line x1="0" y1="30" x2="1000" y2="30" className="rec-gold-zero" />
                {gold && <>
                  <path d={gold.pos} className="rec-gold-pos" />
                  <path d={gold.neg} className="rec-gold-neg" />
                  <path d={gold.line} className="rec-gold-line" />
                </>}
              </svg>
              <div className="rec-played" style={{ width: pct(now) }} />
              {moments.map((m, i) => (
                <button key={i}
                  className={`rec-mk rec-track-mk ${markClass(m)} ${selected === m ? "is-selected" : ""}`}
                  style={{ left: pct(toVideo(rec, m.time)) }}
                  onClick={(e) => { e.stopPropagation(); jump(m); }}
                  aria-label={`${m.title} at ${fmtClock(m.time)}`} />
              ))}
              {hoverX !== null && (
                <div className="rec-hover" style={{ left: `${hoverX * 100}%` }}>
                  <span className="rec-hover-time">{fmtClock(hoverX * len - offsetOf(rec))}</span>
                </div>
              )}
              <div className="rec-head" style={{ left: pct(now) }}><span /></div>
              {gold && <span className="rec-gold-label">Gold lead</span>}
            </div>
            <div className="rec-axis">
              {[0, 0.2, 0.4, 0.6, 0.8, 1].map(f => <span key={f}>{fmtClock(f * gameLength(rec))}</span>)}
            </div>
          </div>

          <div className="rec-controls">
            <div className="rec-controls-group">
              <button className="rec-btn rec-icon" onClick={() => prevM && jump(prevM)} disabled={!prevM} aria-label="Previous moment"><Icon name="prev" /></button>
              <button className="rec-btn rec-step" onClick={() => seek(now - 5)} aria-label="Back 5 seconds">−5s</button>
              <button className="rec-btn rec-playbtn" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={18} /></button>
              <button className="rec-btn rec-step" onClick={() => seek(now + 5)} aria-label="Forward 5 seconds">+5s</button>
              <button className="rec-btn rec-icon" onClick={() => nextM && jump(nextM)} disabled={!nextM} aria-label="Next moment"><Icon name="next" /></button>
              <span className="rec-clock">{fmtClock(gameNow)} <span>/ {fmtClock(gameLength(rec))}</span></span>
            </div>
            <div className="rec-controls-group">
              {([["kill", "Kills", "rec-mk-kill"], ["death", "Deaths", "rec-mk-death"], ["obj", "Objectives", "rec-mk-obj"]] as const).map(([b, label, cls]) => (
                <button key={b} className={`rec-btn rec-filter ${show[b] ? "is-on" : ""}`} aria-pressed={show[b]}
                  onClick={() => setShow({ ...show, [b]: !show[b] })}>
                  <span className={`rec-mk rec-mk-sm ${cls}`} />{label}
                </button>
              ))}
              <div className="rec-seg" role="group" aria-label="Playback speed">
                {[0.5, 1, 1.5, 2].map(v => (
                  <button key={v} className={`rec-btn ${rate === v ? "is-on" : ""}`} aria-pressed={rate === v} onClick={() => setRate(v)}>{v}×</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <aside className="rec-side">
          <div className="rec-side-head">
            <h3>Key moments</h3>
            <span>{moments.length} of {rec.moments.filter(m => bucketOf(m)).length}</span>
          </div>
          <div className="rec-side-list" ref={listRef}>
            {moments.length === 0 && (
              <div className="rec-empty">
                {rec.moments.length === 0
                  ? "No key moments were captured for this game. The timeline still works for scrubbing."
                  : "Every kind of moment is filtered out."}
              </div>
            )}
            {moments.map((m, i) => (
              <button key={i} className={`rec-row ${listActive === m ? "is-active" : ""}`} onClick={() => jump(m)}>
                <span className="rec-row-time">{fmtClock(m.time)}</span>
                <span className={`rec-mk ${markClass(m)}`} />
                <span className="rec-row-text">
                  <span className="rec-row-title">{m.title}</span>
                  {m.detail && <span className="rec-row-detail">{m.detail}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="rec-keys">
            <span><kbd>&larr;</kbd> <kbd>&rarr;</kbd> moments</span>
            <span><kbd>J</kbd> <kbd>L</kbd> ±5s</span>
            <span><kbd>Space</kbd> play</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------- library ----------

export function RecordingsLibrary({ recordings, recordingOn, permission, status, champions, iconUrl, onWatch }: {
  recordings: Recording[]; recordingOn: boolean; permission: boolean; status: RecordingStatus;
  champions: ChampionMap; iconUrl: (key: string) => string;
  onWatch: (rec: Recording, at?: number) => void;
}) {
  const [tab, setTab] = useState<"all" | "kept">("all");
  const [expanded, setExpanded] = useState(false);
  const kept = recordings.filter(r => r.kept);
  const recent = recordings.filter(r => !r.kept);
  const sum = (rs: Recording[]) => rs.reduce((a, r) => a + r.bytes, 0);
  const keptBytes = sum(kept), recentBytes = sum(recent);
  // Scale the bar to what the rotation can grow to, so it reads as headroom.
  const perGame = recent.length ? recentBytes / recent.length : 1.6e9;
  const scale = Math.max(keptBytes + perGame * KEEP_RECENT, keptBytes + recentBytes, 1);
  const list = tab === "kept" ? kept : recordings;
  const shown = expanded ? list : list.slice(0, 8);

  return (
    <section className="rec-lib" aria-label="Recordings">
      <div className="rec-lib-head">
        <div>
          <h3 className="rec-lib-title">Recordings</h3>
          <div className="rec-lib-sub">
          {recordingOn
            ? "Every game is recorded automatically. Keep the ones worth reviewing."
            : "Recording is off. Turn on Record games to capture your next game."}
        </div>
        </div>
        <button className="rec-btn rec-btn-quiet" onClick={() => invoke("open_recordings_folder").catch(() => {})}><Icon name="folder" size={14} />Open folder</button>
      </div>

      {recordingOn && !permission ? (
        <div className="rec-alert" role="status">
          <div>
            <div className="rec-alert-title">Screen Recording permission needed</div>
            <div className="rec-alert-text">Allow QueryLoL in System Settings → Privacy &amp; Security → Screen Recording, then restart QueryLoL.</div>
          </div>
          <button className="rec-btn rec-btn-quiet" onClick={() => invoke("open_screen_recording_settings").catch(() => {})}>Open System Settings</button>
        </div>
      ) : recordingOn && status.error ? (
        <RecordingNotice error={status.error} />
      ) : null}

      <div className="rec-storage">
        <div className="rec-storage-top">
          <span className="rec-storage-used">{fmtSize(keptBytes + recentBytes)} used</span>
          <span className="rec-storage-cap">Up to ~{fmtSize(scale)} with {KEEP_RECENT} recent games</span>
        </div>
        <div className="rec-storage-bar">
          <span className="rec-storage-kept" style={{ width: `${(keptBytes / scale) * 100}%` }} />
          <span className="rec-storage-recent" style={{ width: `${(recentBytes / scale) * 100}%` }} />
        </div>
        <div className="rec-storage-legend">
          <span><i className="rec-swatch rec-swatch-kept" />Kept · {kept.length} · {fmtSize(keptBytes)} · never deleted</span>
          <span><i className="rec-swatch rec-swatch-recent" />Recent · {recent.length} of {KEEP_RECENT} · {fmtSize(recentBytes)} · oldest replaced first</span>
        </div>
      </div>

      <div className="rec-tabs" role="tablist">
        {([["all", "All", recordings.length], ["kept", "Kept", kept.length]] as const).map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`rec-tab ${tab === id ? "is-on" : ""}`} onClick={() => setTab(id)}>
            {label} <span className="rec-tab-count">{n}</span>
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="rec-empty rec-lib-empty">
          {tab === "kept" ? "Recordings you keep show up here and are never deleted automatically."
            : recordingOn ? "Your next game will show up here." : "Turn on Record games to start."}
        </div>
      ) : (
        <div className="rec-grid">
          {shown.map(r => {
            const best = bestMoment(r);
            const at = best ? toVideo(r, best.time - LEAD) : 0;
            const champ = champions[String(r.champion_id)];
            return (
              <div key={r.id} className="rec-tile">
                <button className="rec-tile-thumb" onClick={() => onWatch(r, at)} aria-label={`Watch ${resultLabel(r)} from ${fmtWhen(r.created_at)}`}>
                  <Thumb rec={r} at={at + LEAD} />
                  <span className="rec-thumb-shade" />
                  <span className="rec-tile-play"><Icon name="play" size={16} /></span>
                  <span className="rec-badge rec-tile-len">{fmtClock(gameLength(r))}</span>
                  {best && <span className="rec-tile-moment">{best.title} · {fmtClock(best.time)}</span>}
                </button>
                <div className="rec-tile-body">
                  {champ && <img className="rec-tile-champ" src={iconUrl(champ.key)} alt={champ.name} />}
                  <div className="rec-tile-text">
                    <div className="rec-tile-line">
                      <span className={`rec-result ${resultClass(r)}`}>{resultLabel(r)}</span>
                      {(r.kills || r.deaths || r.assists) ? <span className="rec-tile-kda">{r.kills} / {r.deaths} / {r.assists}</span> : null}
                    </div>
                    <div className="rec-tile-meta">{[r.queue, fmtWhen(r.created_at), fmtSize(r.bytes)].filter(Boolean).join(" · ")}</div>
                  </div>
                  <KeepButton rec={r} compact />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {list.length > 8 && (
        <button className="rec-btn rec-btn-quiet rec-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}

/** Why the last game has no (complete) recording. */
export function RecordingNotice({ error }: { error: string }) {
  return (
    <div className="rec-alert rec-alert-soft" role="status">
      <div>
        <div className="rec-alert-title">The last game wasn't fully recorded</div>
        <div className="rec-alert-text">{error}.</div>
      </div>
    </div>
  );
}

/** Shown in the live game header while the game is being recorded. */
export function RecIndicator() {
  return <span className="rec-live" title="This game is being recorded"><span className="rec-live-dot" />REC</span>;
}

/** The small "Watch" pill for a match history row. */
export function WatchPill({ rec, onWatch }: { rec: Recording; onWatch: (rec: Recording, at?: number) => void }) {
  const best = bestMoment(rec);
  return (
    <button className="rec-pill" onClick={(e) => { e.stopPropagation(); onWatch(rec, best ? toVideo(rec, best.time - LEAD) : 0); }}
      title="Watch the recording of this game">
      <Icon name="play" size={10} />Watch
    </button>
  );
}
