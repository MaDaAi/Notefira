// Palm rejection: decides what each finger/palm contact on the page may do.
//
// The browser cannot tell a palm from a finger. iPadOS Safari reports
// pointerType "pen" for Apple Pencil (with pressure, tilt and, on supported
// iPads, hover), but palm contacts arrive as ordinary "touch" pointers. The
// contact size (PointerEvent width/height) is used only when the browser
// reports a real value; it is often missing, so the main signals are:
//  - stylus priority: while the pen is down, every touch is a palm;
//  - timing: touches soon after the pen was writing or hovering are palms;
//  - place: touches where the writing hand rests, relative to the pen,
//    using the writing hand and posture preferences;
//  - clusters: extra contacts while a palm is down are part of that palm,
//    and a second finger that arrives late is not a pinch.
// The pen itself is never rejected, wherever and however it writes.
//
// Everything here is O(1) per event (a few comparisons on touch-down and
// on pen events); nothing runs per stroke point.

export type PalmMode = "auto" | "stylus" | "balanced" | "strict" | "off";
export type WritingHand = "auto" | "right" | "left";
export type WritingPosture = "upright" | "below" | "beside" | "angled";
export type PalmSensitivity = "low" | "medium" | "high";

/** What a touch contact may do: draw (finger ink), navigate (scroll/zoom), or nothing (palm). */
export type TouchRole = "draw" | "navigate" | "palm";

export interface PalmPrefs {
  mode: PalmMode;
  hand: WritingHand;
  posture: WritingPosture;
  sensitivity: PalmSensitivity;
  fingerDrawing: boolean;
  /** A stylus has been used on this device before (remembered across launches). */
  stylusSeen: boolean;
}

export const DEFAULT_PALM_PREFS: PalmPrefs = { mode: "auto", hand: "auto", posture: "below", sensitivity: "medium", fingerDrawing: true, stylusSeen: false };

export interface Tuning {
  /** Touches this soon after pen activity are palms (stylus modes). */
  recentMs: number;
  /** Touches in the hand's resting zone this soon after pen activity are palms. */
  zoneMs: number;
  /** Size of the resting zone around the pen, in screen pixels. */
  zoneR: number;
  /** Contacts at least this large (CSS px), when the browser reports size, are palms. */
  palmSize: number;
  /** A pinch's second finger must land within this time of the first. */
  pinchWindowMs: number;
  /** A finger must move this far before it starts scrolling (stylus modes), so a resting palm doesn't nudge the page. */
  panSlop: number;
}

// iPadOS Safari reports a fingertip as roughly 40-60 CSS px across, so the size
// limits sit well above that: only a flat palm or the side of the hand is that big.
const BASE: Record<PalmSensitivity, Tuning> = {
  low: { recentMs: 150, zoneMs: 800, zoneR: 150, palmSize: 110, pinchWindowMs: 600, panSlop: 4 },
  medium: { recentMs: 250, zoneMs: 1500, zoneR: 200, palmSize: 90, pinchWindowMs: 450, panSlop: 6 },
  high: { recentMs: 400, zoneMs: 2500, zoneR: 260, palmSize: 75, pinchWindowMs: 300, panSlop: 10 },
};

/** A contact the browser never reported lifting is forgotten after this long. */
const STALE_MS = 8000;

export function tuning(p: Pick<PalmPrefs, "mode" | "sensitivity">): Tuning {
  const t = { ...BASE[p.sensitivity] ?? BASE.medium };
  if (p.mode === "strict") {
    t.recentMs *= 1.5;
    t.zoneMs *= 2.5;
    t.zoneR *= 1.15;
    t.palmSize *= 0.85;
    t.pinchWindowMs *= 0.8;
    t.panSlop *= 1.5;
  }
  return t;
}

/**
 * Is a touch at (dx, dy) from the pen where the writing hand would rest?
 * Screen coordinates (y grows downward). For "auto" hand both sides count.
 * The zone only ever rejects touches near the pen: the pen can still write
 * anywhere, so left-handed writers are never limited to part of the page.
 */
export function inPalmZone(dx: number, dy: number, hand: WritingHand, posture: WritingPosture, R: number): boolean {
  const sides = hand === "right" ? [1] : hand === "left" ? [-1] : [1, -1];
  return sides.some((s) => {
    const u = dx * s, // toward the writing hand's side
      v = dy; // below the pen
    switch (posture) {
      case "upright": // hand above the paper: only a small zone close below and beside the tip
        return u > -0.3 * R && u < 1.6 * R && v > 0 && v < 1.6 * R;
      case "beside": // hand rests to the side of the writing
        return u > 0.15 * R && u < 2.6 * R && v > -1.1 * R && v < 1.5 * R;
      case "angled": // wrist angled: below and to the side, diagonal band
        return u > -0.4 * R && v > -0.5 * R && u + v < 3.4 * R && u < 2.6 * R && v < 2.6 * R;
      case "below":
      default: // hand rests below the writing line
        return u > -0.9 * R && u < 2.1 * R && v > -0.3 * R && v < 2.6 * R;
    }
  });
}

interface TouchState {
  x: number;
  y: number;
  t: number;
  role: TouchRole;
}

export type PenPhase = "down" | "move" | "hover" | "up" | "cancel";

export class PalmGuard {
  private touches = new Map<number, TouchState>();
  private penDown: number | null = null;
  private lastPen: { x: number; y: number; t: number } | null = null;
  /** When the pen last touched the screen (hovering doesn't count for the timing rule). */
  private lastInk = -Infinity;
  private listeners = new Set<(ids: number[]) => void>();
  onStylusSeen: (() => void) | null = null;

  constructor(private prefs: () => PalmPrefs) {}

  setPrefs(get: () => PalmPrefs) {
    this.prefs = get;
  }

  /** Called with touch ids that were just reclassified as palm (the pen came down while they rested on the screen). */
  onReject(fn: (ids: number[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Feed every pen pointer event, including hover moves (no buttons pressed). Cheap. */
  pen(phase: PenPhase, id: number, x: number, y: number, t: number) {
    const lp = this.lastPen ?? (this.lastPen = { x, y, t });
    lp.x = x; // updated in place: this runs for every pen move and hover event
    lp.y = y;
    lp.t = t;
    if (phase !== "hover") this.lastInk = t;
    if (phase === "down") {
      if (!this.prefs().stylusSeen) this.onStylusSeen?.();
      this.penDown = id;
      if (this.prefs().mode === "off") return;
      // stylus priority: anything resting on the screen when the pen lands is a palm
      const rejected: number[] = [];
      for (const [tid, s] of this.touches)
        if (s.role !== "palm") {
          s.role = "palm";
          rejected.push(tid);
        }
      if (rejected.length) this.listeners.forEach((fn) => fn(rejected));
    } else if ((phase === "up" || phase === "cancel") && this.penDown === id) this.penDown = null;
  }

  /** Classify a new touch contact. Width/height are the browser's contact size (1 or 0 when unknown). */
  touchDown(id: number, x: number, y: number, t: number, w = 0, h = 0): TouchRole {
    const role = this.classify(x, y, t, w, h);
    this.touches.set(id, { x, y, t, role });
    return role;
  }

  touchUp(id: number) {
    this.touches.delete(id);
  }

  /** Keep a contact alive while it moves (so it isn't treated as stale). */
  touchMove(id: number, t: number) {
    const s = this.touches.get(id);
    if (s) s.t = Math.max(s.t, t - 1);
  }

  role(id: number): TouchRole | undefined {
    return this.touches.get(id)?.role;
  }

  stylusActive(t: number): boolean {
    if (this.penDown !== null) return true;
    return t - this.lastInk < tuning(this.prefs()).recentMs;
  }

  /** Forget all contacts (e.g. the page was hidden and pointer events were lost). */
  reset() {
    this.touches.clear();
    this.penDown = null;
  }

  private classify(x: number, y: number, t: number, w: number, h: number): TouchRole {
    const p = this.prefs();
    const base: TouchRole = p.mode === "stylus" || p.mode === "strict" || (p.mode === "auto" && p.stylusSeen) || !p.fingerDrawing ? "navigate" : "draw";
    if (p.mode === "off") return p.fingerDrawing ? "draw" : "navigate";
    const T = tuning(p);
    // 1. the pen is writing: every touch is a resting hand
    if (this.penDown !== null) return "palm";
    // 2. part of a palm that is already down, or a third contact
    let others = 0;
    let firstOther: TouchState | null = null;
    for (const [id, s] of this.touches) {
      if (t - s.t > STALE_MS) {
        this.touches.delete(id); // its lift was never reported: don't let it block every later touch
        continue;
      }
      if (s.role === "palm") return "palm";
      others++;
      if (!firstOther || s.t < firstOther.t) firstOther = s;
    }
    if (others >= 2) return "palm";
    // 3. contact size, only when the browser reports a real size (a fingertip is never this large)
    const size = Math.max(w, h);
    if (size > 2 && size >= T.palmSize) return "palm";
    // 4. a second finger landing together with the first is a pinch, whatever else is true
    if (firstOther && t - firstOther.t <= T.pinchWindowMs) return base === "draw" && p.mode === "balanced" ? "draw" : "navigate";
    // a late second contact is a palm only in Strict
    if (firstOther && p.mode === "strict") return "palm";
    const stylusMode = p.mode !== "balanced" && (p.mode !== "auto" || p.stylusSeen);
    // 5. timing and place relative to the pen
    if (stylusMode && t - this.lastInk < T.recentMs) return "palm"; // just lifted the pen: the hand is landing
    if (this.lastPen) {
      const age = t - this.lastPen.t;
      if (age < T.zoneMs && inPalmZone(x - this.lastPen.x, y - this.lastPen.y, p.hand, p.posture, T.zoneR)) return "palm";
    }
    return base;
  }
}

/** The app-wide guard (one hand, one screen). Settings are attached by the editor. */
export const palmGuard = new PalmGuard(() => DEFAULT_PALM_PREFS);

let tracking = false;
/** Follow the pen everywhere on the page (hover over the canvas, taps on the toolbar), once. */
export function trackPenActivity(target: Window = window) {
  if (tracking) return;
  tracking = true;
  const opts = { capture: true, passive: true } as const;
  target.addEventListener("pointerdown", (e) => e.pointerType === "pen" && palmGuard.pen("down", e.pointerId, e.clientX, e.clientY, e.timeStamp), opts);
  target.addEventListener("pointermove", (e) => e.pointerType === "pen" && palmGuard.pen(e.buttons ? "move" : "hover", e.pointerId, e.clientX, e.clientY, e.timeStamp), opts);
  // touches are forgotten wherever they lift, even off the page
  target.addEventListener("pointerup", (e) => (e.pointerType === "pen" ? palmGuard.pen("up", e.pointerId, e.clientX, e.clientY, e.timeStamp) : e.pointerType === "touch" && palmGuard.touchUp(e.pointerId)), opts);
  target.addEventListener("pointercancel", (e) => (e.pointerType === "pen" ? palmGuard.pen("cancel", e.pointerId, e.clientX, e.clientY, e.timeStamp) : e.pointerType === "touch" && palmGuard.touchUp(e.pointerId)), opts);
  target.document?.addEventListener("visibilitychange", () => palmGuard.reset());
}
