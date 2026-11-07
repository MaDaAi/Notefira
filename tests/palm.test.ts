// Palm rejection. SIMULATED input only: these tests drive the classifier and the
// real editor viewport with synthetic Pointer Events shaped like the ones iPadOS
// Safari sends (Apple Pencil = "pen" with pressure, palm/fingers = "touch").
// They prove the logic; they are not a substitute for writing on a real iPad.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PalmGuard, inPalmZone, tuning, type PalmMode, type PalmPrefs, type PalmSensitivity, type TouchRole } from "../src/editor/palm";

// ------------------------------------------------------------------ classifier
const prefs = (o: Partial<PalmPrefs> = {}): PalmPrefs => ({ mode: "auto", hand: "right", posture: "below", sensitivity: "medium", fingerDrawing: true, stylusSeen: true, ...o });
const guard = (o: Partial<PalmPrefs> = {}) => {
  let p = prefs(o);
  const g = new PalmGuard(() => p);
  return { g, set: (n: Partial<PalmPrefs>) => (p = { ...p, ...n }) };
};
const MODES: PalmMode[] = ["auto", "stylus", "balanced", "strict", "off"];
const LEVELS: PalmSensitivity[] = ["low", "medium", "high"];

describe("palm classifier (simulated)", () => {
  it("never rejects the pen; while the pen is down every touch is a palm (all modes except Off)", () => {
    for (const mode of MODES) {
      const { g } = guard({ mode });
      g.pen("down", 1, 400, 400, 1000);
      const r = g.touchDown(10, 100, 100, 1010);
      expect(r).toBe(mode === "off" ? "draw" : "palm");
      g.pen("up", 1, 410, 400, 1100);
    }
  });

  it("a palm that lands before the pen is reclassified the moment the pen touches", () => {
    const { g } = guard({ mode: "auto" });
    const seen: number[][] = [];
    g.onReject((ids) => seen.push(ids));
    expect(g.touchDown(10, 520, 560, 1000)).toBe("navigate"); // first contact: can't know yet
    g.pen("down", 1, 400, 400, 1080);
    expect(seen).toEqual([[10]]);
    expect(g.role(10)).toBe("palm");
  });

  it("touches right after writing are palms in stylus modes; a finger far away later can scroll", () => {
    for (const mode of ["auto", "stylus", "strict"] as const) {
      const { g } = guard({ mode });
      g.pen("down", 1, 400, 400, 1000);
      g.pen("up", 1, 450, 400, 1300);
      expect(g.touchDown(10, 80, 80, 1400)).toBe("palm"); // 100 ms after the pen lifted
      g.touchUp(10);
      expect(g.touchDown(11, 80, 80, 1300 + 40_000)).toBe("navigate"); // long after, away from the hand
    }
  });

  it("extra contacts while a palm is down are part of the palm; a third contact is never a gesture", () => {
    const { g } = guard({ mode: "stylus" });
    g.pen("down", 1, 400, 400, 1000);
    g.touchDown(10, 500, 520, 1010);
    g.pen("up", 1, 410, 400, 1100);
    expect(g.touchDown(11, 100, 100, 9000)).toBe("palm"); // palm 10 still resting
    const h = guard({ mode: "balanced" }).g;
    h.touchDown(1, 100, 100, 1000);
    h.touchDown(2, 200, 100, 1010);
    expect(h.touchDown(3, 300, 100, 1020)).toBe("palm");
  });

  it("contact size is used only when the browser reports one; larger contacts are palms", () => {
    const { g } = guard({ mode: "balanced" });
    expect(g.touchDown(1, 100, 100, 1000, 1, 1)).toBe("draw"); // size unknown (default 1)
    g.touchUp(1);
    expect(g.touchDown(2, 100, 100, 2000, 60, 45)).toBe("palm");
    g.touchUp(2);
    expect(g.touchDown(3, 100, 100, 3000, 12, 12)).toBe("draw"); // fingertip
  });

  it("sensitivity changes the decision, not just a label", () => {
    // a 40 px contact: palm at medium/high, finger at low
    const size = LEVELS.map((sensitivity) => guard({ mode: "balanced", sensitivity }).g.touchDown(1, 100, 100, 1000, 40, 40));
    expect(size).toEqual(["draw", "palm", "palm"]);
    // a touch 800 ms after the pen lifted, far from the hand: palm only at high
    const timing = LEVELS.map((sensitivity) => {
      const g = guard({ mode: "stylus", sensitivity, hand: "right" }).g;
      g.pen("down", 1, 600, 600, 1000);
      g.pen("up", 1, 600, 600, 1200);
      return g.touchDown(1, 50, 50, 2000);
    });
    expect(timing).toEqual(["navigate", "navigate", "palm"]);
    expect(tuning({ mode: "auto", sensitivity: "low" }).panSlop).toBeLessThan(tuning({ mode: "auto", sensitivity: "high" }).panSlop);
  });

  it("writing hand: the resting zone follows the hand, but only rejects touches near the pen", () => {
    const below = (hand: "right" | "left" | "auto", dx: number) => inPalmZone(dx, 120, hand, "below", 210);
    expect(below("right", 180)).toBe(true); // below-right of the pen: right hand
    expect(below("left", 260)).toBe(false);
    expect(below("left", -180)).toBe(true); // below-left: left hand
    expect(below("right", -300)).toBe(false);
    expect(below("auto", 180) && below("auto", -180)).toBe(true);
    // the same right-hand palm position is a palm for a right-handed writer, a finger for a left-handed one (Balanced)
    const decide = (hand: "right" | "left") => {
      const g = guard({ mode: "balanced", hand }).g;
      g.pen("down", 1, 400, 400, 1000);
      g.pen("up", 1, 400, 400, 1200);
      return g.touchDown(1, 660, 520, 2200);
    };
    expect(decide("right")).toBe("palm");
    expect(decide("left")).toBe("draw");
  });

  it("left-handed writers can write anywhere: the pen is never filtered by side or location", () => {
    const { g } = guard({ mode: "strict", hand: "left" });
    for (const [x, y] of [[10, 10], [790, 10], [10, 990], [790, 990]]) {
      g.pen("down", 1, x, y, 1000 + x);
      expect(g.stylusActive(1000 + x)).toBe(true);
      g.pen("up", 1, x, y, 1001 + x);
    }
  });

  it("postures shape the zone", () => {
    const R = 210;
    expect(inPalmZone(300, 0, "right", "beside", R)).toBe(true);
    expect(inPalmZone(300, 0, "right", "upright", R)).toBe(false);
    expect(inPalmZone(100, 400, "right", "below", R)).toBe(true);
    expect(inPalmZone(100, 400, "right", "upright", R)).toBe(false);
    expect(inPalmZone(250, 250, "right", "angled", R)).toBe(true);
  });

  it("finger drawing on/off, per mode, with no stylus used yet", () => {
    const table: Record<PalmMode, [TouchRole, TouchRole]> = {
      auto: ["draw", "navigate"],
      stylus: ["navigate", "navigate"],
      balanced: ["draw", "navigate"],
      strict: ["navigate", "navigate"],
      off: ["draw", "navigate"],
    };
    for (const mode of MODES)
      for (const [i, fingerDrawing] of [true, false].entries()) expect([mode, guard({ mode, fingerDrawing, stylusSeen: false }).g.touchDown(1, 100, 100, 1000)]).toEqual([mode, table[mode][i]]);
    // Automatic keeps fingers for navigation once a stylus has been used on the device
    expect(guard({ mode: "auto", stylusSeen: true }).g.touchDown(1, 100, 100, 1000)).toBe("navigate");
  });

  it("a pinch is two fingers landing together; a late second contact is a palm (stylus modes)", () => {
    for (const mode of ["auto", "stylus", "strict"] as const) {
      const { g } = guard({ mode });
      g.touchDown(1, 300, 300, 1000);
      expect(g.touchDown(2, 400, 400, 1060)).toBe("navigate");
      const late = guard({ mode }).g;
      late.touchDown(1, 300, 300, 1000);
      expect(late.touchDown(2, 400, 400, 1900)).toBe("palm");
    }
    const b = guard({ mode: "balanced" }).g; // Balanced keeps two-finger gestures permissive
    b.touchDown(1, 300, 300, 1000);
    expect(b.touchDown(2, 400, 400, 1900)).toBe("draw");
  });

  it("Off performs no filtering at all", () => {
    const { g } = guard({ mode: "off" });
    g.pen("down", 1, 400, 400, 1000);
    expect(g.touchDown(1, 420, 430, 1001, 80, 80)).toBe("draw");
    expect(g.touchDown(2, 420, 430, 1002)).toBe("draw");
  });
});

// ------------------------------------------------------------------ the editor viewport
// A minimal DOM: the viewport's drawing never runs (animation frames are not
// executed), so only input handling, scrolling, zoom and the document are exercised.
type Handler = (e: any) => void;
const winL = new Map<string, Handler[]>();
const on = (m: Map<string, Handler[]>, t: string, f: Handler) => m.set(t, [...(m.get(t) ?? []), f]);
const fakeCanvas = () => ({ style: {} as any, className: "", width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {} }), remove() {} });
class FakeHost {
  l = new Map<string, Handler[]>();
  style: any = {};
  addEventListener(t: string, f: Handler) {
    on(this.l, t, f);
  }
  removeEventListener() {}
  append() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000 };
  }
}

let vp: any, host: FakeHost, session: any, settingsStore: any, tools: any, DEFAULT_SETTINGS: any;
let t = 10_000;
const fire = (type: string, o: { id: number; kind: "pen" | "touch"; x: number; y: number; w?: number; buttons?: number; pressure?: number }) => {
  t += 16;
  const e = { type, pointerId: o.id, pointerType: o.kind, clientX: o.x, clientY: o.y, timeStamp: t, width: o.w ?? 1, height: o.w ?? 1, pressure: o.pressure ?? (o.kind === "pen" ? 0.6 : 0), buttons: o.buttons ?? (type === "pointerup" ? 0 : 1), button: 0, target: host };
  for (const f of winL.get(type) ?? []) f(e); // window capture listeners first, like a browser
  for (const f of host.l.get(type) ?? []) f(e);
};
const pen = (id: number, pts: [number, number][], pressure = 0.6) => {
  fire("pointerdown", { id, kind: "pen", x: pts[0][0], y: pts[0][1], pressure });
  for (const [x, y] of pts.slice(1)) fire("pointermove", { id, kind: "pen", x, y, pressure });
  const [x, y] = pts[pts.length - 1];
  fire("pointerup", { id, kind: "pen", x, y, pressure });
};
const line = (x0: number, y0: number, x1: number, y1: number, n = 12): [number, number][] => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const page0 = () => session.orderedPages()[0];
const items = () => page0().items as any[];
const setPrefs = (o: Record<string, unknown>) => settingsStore.set({ ...settingsStore.get(), ...o });

describe("editor input with palm rejection (simulated Pointer Events)", () => {
  beforeAll(async () => {
    Object.assign(globalThis, {
      window: Object.assign(globalThis, { devicePixelRatio: 2, addEventListener: (ty: string, f: Handler) => on(winL, ty, f), removeEventListener: () => {} }),
      document: { createElement: fakeCanvas, addEventListener: () => {} },
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
    });
    const db = await import("../src/storage/db");
    db.setDbName("palm-test");
    const store = await import("../src/state/store");
    settingsStore = store.settingsStore;
    DEFAULT_SETTINGS = store.DEFAULT_SETTINGS;
    tools = (await import("../src/editor/tools")).tools;
    const repo = await import("../src/storage/repo");
    const doc = await repo.createDoc({ title: "Palm", pages: 2 });
    session = await (await import("../src/editor/session")).getSession(doc.id);
    const { ViewportController } = await import("../src/editor/viewport");
    host = new FakeHost();
    vp = new ViewportController(host as any, {} as any);
    vp.setSession(session);
  });
  afterAll(async () => (await import("../src/storage/db")).closeDB());

  beforeEach(() => {
    settingsStore.set({ ...DEFAULT_SETTINGS, stylusSeen: true });
    tools.set({ tool: "pen" });
    session.setItems(page0().id, [], "reset");
    vp.zoom = 1;
    vp.sx = 0;
    vp.sy = 0;
    t += 60_000; // each test starts long after earlier pen activity
  });

  it("an Apple Pencil stroke draws, with its pressure", () => {
    pen(1, line(200, 200, 400, 260), 0.8);
    expect(items()).toHaveLength(1);
    const s = items()[0];
    expect(s.kind).toBe("stroke");
    expect(s.pts.filter((_: number, i: number) => i % 3 === 2).every((p: number) => p === 0.8)).toBe(true);
  });

  it("palm resting BEFORE the pencil: the pencil still writes, the palm draws nothing and the page doesn't move", () => {
    for (const mode of ["auto", "stylus", "balanced", "strict"] as const) {
      setPrefs({ mode, palmMode: mode, fingerDrawing: true });
      session.setItems(page0().id, [], "reset");
      const sx = vp.sx,
        sy = vp.sy;
      fire("pointerdown", { id: 50, kind: "touch", x: 520, y: 600 });
      fire("pointermove", { id: 50, kind: "touch", x: 540, y: 640 }); // the palm rolls
      pen(1, line(300, 400, 460, 420));
      fire("pointermove", { id: 50, kind: "touch", x: 560, y: 700 });
      fire("pointerup", { id: 50, kind: "touch", x: 560, y: 700 });
      expect([mode, items().length]).toEqual([mode, 1]);
      expect(items()[0].pts[0]).not.toBeCloseTo(540, 0); // the stroke is the pen's, not the palm's
      expect([mode, vp.sx, vp.sy]).toEqual([mode, sx, sy]);
    }
  });

  it("palm landing DURING a stroke never interrupts it or scrolls", () => {
    const sy = vp.sy;
    fire("pointerdown", { id: 1, kind: "pen", x: 200, y: 300 });
    for (const [x, y] of line(200, 300, 300, 320, 5)) fire("pointermove", { id: 1, kind: "pen", x, y });
    fire("pointerdown", { id: 60, kind: "touch", x: 420, y: 500 });
    fire("pointerdown", { id: 61, kind: "touch", x: 470, y: 520 }); // two palm contacts: no pinch
    fire("pointermove", { id: 60, kind: "touch", x: 430, y: 560 });
    for (const [x, y] of line(300, 320, 400, 330, 5)) fire("pointermove", { id: 1, kind: "pen", x, y });
    fire("pointerup", { id: 1, kind: "pen", x: 400, y: 330 });
    fire("pointerup", { id: 60, kind: "touch", x: 430, y: 560 });
    fire("pointerup", { id: 61, kind: "touch", x: 470, y: 520 });
    expect(items()).toHaveLength(1);
    expect(vp.sy).toBe(sy);
    expect(vp.zoom).toBe(1);
  });

  it("palm AFTER a stroke (hand still resting) draws nothing and doesn't scroll", () => {
    setPrefs({ palmMode: "balanced", fingerDrawing: true });
    pen(1, line(200, 300, 400, 300));
    fire("pointerdown", { id: 70, kind: "touch", x: 470, y: 420 });
    fire("pointermove", { id: 70, kind: "touch", x: 500, y: 470 });
    fire("pointerup", { id: 70, kind: "touch", x: 500, y: 470 });
    expect(items()).toHaveLength(1);
  });

  it("finger drawing follows the mode", () => {
    for (const [mode, draws] of [["balanced", 1], ["off", 1], ["stylus", 0], ["strict", 0]] as const) {
      setPrefs({ palmMode: mode, fingerDrawing: true });
      session.setItems(page0().id, [], "reset");
      t += 60_000;
      fire("pointerdown", { id: 80, kind: "touch", x: 200, y: 300 });
      for (const [x, y] of line(200, 300, 380, 360, 6)) fire("pointermove", { id: 80, kind: "touch", x, y });
      fire("pointerup", { id: 80, kind: "touch", x: 380, y: 360 });
      expect([mode, items().length]).toEqual([mode, draws]);
    }
    setPrefs({ palmMode: "balanced", fingerDrawing: false });
    session.setItems(page0().id, [], "reset");
    fire("pointerdown", { id: 81, kind: "touch", x: 200, y: 300 });
    fire("pointermove", { id: 81, kind: "touch", x: 260, y: 300 });
    fire("pointerup", { id: 81, kind: "touch", x: 260, y: 300 });
    expect(items()).toHaveLength(0);
  });

  it("a finger scrolls (after a small slop) and two fingers pinch-zoom when the pen is idle", () => {
    const sy = vp.sy;
    fire("pointerdown", { id: 90, kind: "touch", x: 400, y: 600 });
    fire("pointermove", { id: 90, kind: "touch", x: 400, y: 596 }); // within the slop: no scroll
    expect(vp.sy).toBe(sy);
    for (let y = 590; y >= 400; y -= 30) fire("pointermove", { id: 90, kind: "touch", x: 400, y });
    fire("pointerup", { id: 90, kind: "touch", x: 400, y: 400 });
    expect(vp.sy).toBeGreaterThan(sy);
    t += 60_000;
    fire("pointerdown", { id: 91, kind: "touch", x: 300, y: 500 });
    fire("pointerdown", { id: 92, kind: "touch", x: 500, y: 500 });
    fire("pointermove", { id: 91, kind: "touch", x: 200, y: 500 });
    fire("pointermove", { id: 92, kind: "touch", x: 600, y: 500 });
    fire("pointerup", { id: 91, kind: "touch", x: 200, y: 500 });
    fire("pointerup", { id: 92, kind: "touch", x: 600, y: 500 });
    expect(vp.zoom).toBeGreaterThan(1.5);
  });

  it("a resting palm's pinch is undone when the pen lands, and the pen writes", () => {
    fire("pointerdown", { id: 93, kind: "touch", x: 480, y: 600 });
    fire("pointerdown", { id: 94, kind: "touch", x: 560, y: 640 });
    fire("pointermove", { id: 94, kind: "touch", x: 620, y: 700 });
    expect(vp.zoom).not.toBe(1);
    pen(1, line(200, 300, 300, 300));
    expect(vp.zoom).toBe(1);
    expect(items()).toHaveLength(1);
    fire("pointerup", { id: 93, kind: "touch", x: 480, y: 600 });
    fire("pointerup", { id: 94, kind: "touch", x: 620, y: 700 });
  });

  it("pointer cancellation: a cancelled stroke is dropped, a cancelled palm nudge is undone", () => {
    fire("pointerdown", { id: 1, kind: "pen", x: 200, y: 300 });
    fire("pointermove", { id: 1, kind: "pen", x: 260, y: 310 });
    fire("pointercancel", { id: 1, kind: "pen", x: 260, y: 310 });
    expect(items()).toHaveLength(0);
    const sy = vp.sy;
    fire("pointerdown", { id: 95, kind: "touch", x: 400, y: 600 });
    fire("pointermove", { id: 95, kind: "touch", x: 400, y: 588 });
    fire("pointercancel", { id: 95, kind: "touch", x: 400, y: 588 });
    expect(vp.sy).toBe(sy);
    pen(2, line(200, 300, 300, 300)); // input still works afterwards
    expect(items()).toHaveLength(1);
  });

  it("highlighter, eraser and lasso selection keep working with a palm resting", () => {
    tools.set({ tool: "highlighter" });
    fire("pointerdown", { id: 100, kind: "touch", x: 520, y: 640 });
    pen(1, line(200, 300, 420, 300));
    expect(items().map((i) => i.pen)).toEqual(["highlighter"]);
    tools.set({ tool: "eraser" });
    fire("pointermove", { id: 100, kind: "touch", x: 300, y: 300 }); // palm drifts across the ink: erases nothing
    expect(items()).toHaveLength(1);
    pen(2, line(300, 260, 300, 340));
    expect(items()).toHaveLength(0);
    tools.set({ tool: "pen" });
    pen(3, line(200, 300, 300, 300));
    tools.set({ tool: "lasso" });
    pen(4, [[150, 250], [350, 250], [350, 350], [150, 350], [150, 250]]);
    expect(vp.selection?.ids.size).toBe(1);
    fire("pointerup", { id: 100, kind: "touch", x: 300, y: 300 });
  });

  it("a held palm can't bring up the iPadOS text magnifier on the page (touch default cancelled)", () => {
    let prevented = 0;
    const ev = { target: host, cancelable: true, preventDefault: () => prevented++ };
    for (const f of host.l.get("touchstart") ?? []) f(ev);
    for (const f of host.l.get("touchmove") ?? []) f(ev);
    expect(prevented).toBe(2);
    // ...but not for elements on top of the page, such as a text box being edited
    for (const f of host.l.get("touchstart") ?? []) f({ ...ev, target: { tagName: "DIV" } });
    expect(prevented).toBe(2);
  });

  it("PDF pages are annotated the same way", () => {
    const pg = page0();
    session.pages.set(pg.id, { ...pg, bg: { type: "pdf", asset: "missing-asset", page: 1, rot: 0 } });
    expect(page0().bg.type).toBe("pdf");
    fire("pointerdown", { id: 110, kind: "touch", x: 520, y: 640 });
    pen(1, line(200, 300, 400, 320));
    fire("pointerup", { id: 110, kind: "touch", x: 520, y: 640 });
    expect(items()).toHaveLength(1);
    session.pages.set(pg.id, { ...page0(), bg: pg.bg });
  });
});
