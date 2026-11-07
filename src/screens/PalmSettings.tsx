// Stylus & palm rejection preferences, shown in Settings → Stylus & touch and
// from a notebook's "…" menu. Changes apply immediately (editor/palm.ts reads them).
import { useState } from "react";
import { Dialog, Switch } from "../ui/common";
import { settingsStore, updateSettings, useStore } from "../state/store";
import type { Settings } from "../model/types";

type Hand = "right" | "left";
type Posture = Settings["writingPosture"];

const POSTURES: { id: Posture; label: string }[] = [
  { id: "below", label: "Hand below the line" },
  { id: "beside", label: "Hand beside the line" },
  { id: "angled", label: "Angled wrist" },
  { id: "upright", label: "Upright, hand lifted" },
];

const MODES: { id: Settings["palmMode"]; label: string; hint: string }[] = [
  { id: "auto", label: "Automatic (recommended)", hint: "Fingers draw until you use a stylus on this device; then the stylus writes and fingers scroll and zoom." },
  { id: "stylus", label: "Stylus only", hint: "Only a stylus draws. Fingers scroll, zoom and use buttons." },
  { id: "balanced", label: "Balanced", hint: "Fingers and stylus both draw; touches where your hand rests are ignored." },
  { id: "strict", label: "Strict", hint: "Like Stylus only, and ignores touches near your writing for longer." },
  { id: "off", label: "Off", hint: "No palm filtering: every touch acts normally." },
];

/** A small drawing of where the hand rests for a posture (original artwork: page, pencil, palm). */
function PostureArt({ hand, posture }: { hand: Hand; posture: Posture }) {
  const s = hand === "right" ? 1 : -1;
  const palm: Record<Posture, { cx: number; cy: number; rx: number; ry: number; rot: number; o: number }> = {
    below: { cx: 30 + 6 * s, cy: 50, rx: 14, ry: 9, rot: 0, o: 0.9 },
    beside: { cx: 30 + 19 * s, cy: 32, rx: 9, ry: 13, rot: 0, o: 0.9 },
    angled: { cx: 30 + 15 * s, cy: 46, rx: 13, ry: 9, rot: 35 * s, o: 0.9 },
    upright: { cx: 30 + 9 * s, cy: 55, rx: 8, ry: 5, rot: 0, o: 0.35 },
  };
  const p = palm[posture];
  return (
    <svg viewBox="0 0 60 66" width="60" height="66" aria-hidden="true">
      <rect x="6" y="4" width="48" height="58" rx="4" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeDasharray="3 3" />
      <path d="M14 22h18M14 30h14" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" strokeLinecap="round" />
      <ellipse cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} transform={`rotate(${p.rot} ${p.cx} ${p.cy})`} fill="var(--c-accent)" fillOpacity={p.o * 0.55} />
      <line x1="30" y1="30" x2={30 + 20 * s} y2="8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="30" cy="30" r="2.6" fill="var(--c-accent)" />
    </svg>
  );
}

export function PalmRejectionSettings() {
  const s = useStore(settingsStore, (x) => x);
  const [advanced, setAdvanced] = useState(false);
  const mode = MODES.find((m) => m.id === (s.palmMode ?? "auto")) ?? MODES[0];
  const hand = s.writingHand ?? "auto";
  const posture = s.writingPosture ?? "below";
  const fingersCanDraw = mode.id !== "stylus" && mode.id !== "strict";
  return (
    <div className="palm-settings">
      <div className="set-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 8 }}>
        <div>
          <div>Writing posture</div>
          <div className="muted small">Pick how you hold your stylus. The stylus still writes anywhere on the page.</div>
        </div>
        <div role="radiogroup" aria-label="Writing posture and hand">
          {(["right", "left"] as const).map((h) => (
            <div key={h} className="posture-row">
              <span className="small muted">{h === "left" ? "Left hand" : "Right hand"}</span>
              <div className="posture-grid">
                {POSTURES.map((p) => {
                  const on = hand === h && posture === p.id;
                  return (
                    <button key={p.id} role="radio" aria-checked={on} className={"posture-tile" + (on ? " on" : "")} title={p.label} aria-label={`${h === "left" ? "Left" : "Right"} hand, ${p.label}`} onClick={() => updateSettings({ writingHand: h, writingPosture: p.id })}>
                      <PostureArt hand={h} posture={p.id} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <button className="link-btn small" aria-pressed={hand === "auto"} onClick={() => updateSettings({ writingHand: "auto" })}>
          {hand === "auto" ? "✓ No preference (either hand)" : "No preference (either hand)"}
        </button>
      </div>
      <div className="set-row">
        <div className="grow">
          <div>Sensitivity</div>
          <div className="muted small">Higher ignores more touches near your writing.</div>
        </div>
        <div className="seg" role="group" aria-label="Palm rejection sensitivity">
          {(["low", "medium", "high"] as const).map((v) => (
            <button key={v} className={(s.palmSensitivity ?? "medium") === v ? "on" : ""} aria-pressed={(s.palmSensitivity ?? "medium") === v} onClick={() => updateSettings({ palmSensitivity: v })}>
              {v === "low" ? "Low" : v === "medium" ? "Medium" : "High"}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <div className="grow">
          <div>Draw with finger</div>
          <div className="muted small">{fingersCanDraw ? "When off, one finger scrolls the page." : `${mode.label} never draws with fingers.`}</div>
        </div>
        <Switch on={s.fingerDrawing && fingersCanDraw} onChange={(v) => fingersCanDraw && updateSettings({ fingerDrawing: v })} label="Draw with finger" />
      </div>
      <button className="link-btn small" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} style={{ marginTop: 8 }}>
        {advanced ? "▾" : "▸"} Palm rejection mode: {mode.label}
      </button>
      {advanced && (
        <div className="set-row">
          <div className="grow muted small">{mode.hint}</div>
          <select className="input" style={{ width: 210 }} aria-label="Palm rejection mode" value={mode.id} onChange={(e) => updateSettings({ palmMode: e.target.value as Settings["palmMode"] })}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

export function PalmRejectionDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Stylus & palm rejection"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <PalmRejectionSettings />
    </Dialog>
  );
}
