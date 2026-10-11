// Shared UI primitives for the visual system defined in App.css :root
// (surfaces, text, accent, semantic and team tokens). Styles live in ui.css
// under the `q-` prefix so they never collide with view classes.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./ui.css";

/** Closes a popover on outside click or Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close]);
  return ref;
}

export function Toggle({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: () => void;
}) {
  return (
    <label className="q-toggle">
      <span className="q-toggle-text">
        <span className="q-toggle-label">{label}</span>
        {hint && <span className="q-toggle-hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="q-toggle-track" aria-hidden="true"><span className="q-toggle-knob" /></span>
    </label>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange, label, size = "md" }: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T; onChange: (v: T) => void; label: string; size?: "sm" | "md";
}) {
  return (
    <div className={`q-seg q-seg-${size}`} role="group" aria-label={label}>
      {options.map(o => (
        <button key={String(o.value)} type="button" title={o.title}
          className={o.value === value ? "is-on" : ""} aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A select drawn by the app instead of the browser's native control. */
export function Select<T extends string>({ options, value, onChange, label, prefix }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
  label: string; prefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const id = useId();
  const current = options.find(o => o.value === value);
  const move = (dir: number) => {
    const i = options.findIndex(o => o.value === value);
    const next = options[(i + dir + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div className="q-select" ref={ref}>
      <button type="button" className="q-select-btn" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={id} aria-label={label}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}>
        {prefix && <span className="q-select-prefix">{prefix}</span>}
        <span>{current?.label ?? value}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul className="q-select-list" role="listbox" id={id} aria-label={label}>
          {options.map(o => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button type="button" className={o.value === value ? "is-on" : ""}
                onClick={() => { onChange(o.value); setOpen(false); }}>
                {o.label}
                {o.value === value && <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type BadgeTone = "neutral" | "gold" | "positive" | "negative" | "outline";

export function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return <span className={`q-badge q-badge-${tone}`} title={title}>{children}</span>;
}

/** The single section-header style: 11px capitals, secondary colour, an
 *  optional meta line on the right. */
export function SectionLabel({ children, meta, tone }: { children: ReactNode; meta?: ReactNode; tone?: "ally" | "enemy" }) {
  return (
    <div className="q-section-head">
      <h3 className={`q-label ${tone ? `q-label-${tone}` : ""}`}>{children}</h3>
      {meta && <span className="q-section-meta">{meta}</span>}
    </div>
  );
}

export function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.3 3.6a1.7 1.7 0 0 1 3.4 0 1.7 1.7 0 0 0 2.6 1.1 1.7 1.7 0 0 1 2.4 2.4 1.7 1.7 0 0 0 1.1 2.6 1.7 1.7 0 0 1 0 3.4 1.7 1.7 0 0 0-1.1 2.6 1.7 1.7 0 0 1-2.4 2.4 1.7 1.7 0 0 0-2.6 1.1 1.7 1.7 0 0 1-3.4 0 1.7 1.7 0 0 0-2.6-1.1 1.7 1.7 0 0 1-2.4-2.4 1.7 1.7 0 0 0-1.1-2.6 1.7 1.7 0 0 1 0-3.4 1.7 1.7 0 0 0 1.1-2.6 1.7 1.7 0 0 1 2.4-2.4 1.7 1.7 0 0 0 2.6-1.1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function WarnIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l10 18H2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 10v4M12 17.5v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
