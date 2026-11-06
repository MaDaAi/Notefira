import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Stroke } from "../src/model/types";
import { strokeCenterline, strokeOutline } from "../src/engine/strokes";
import { eraseStrokePart, lassoSelect, strokeHitBySegment } from "../src/engine/geometry";
import { resolveSavedTheme, DEFAULT_SETTINGS } from "../src/state/store";
import { closeDB, setDbName } from "../src/storage/db";
import { createDoc, getDoc, loadPages, saveDoc } from "../src/storage/repo";
import { DocSession, getSession, releaseSession } from "../src/editor/session";
import { PAPER_COLORS, isDark, templateBg } from "../src/model/templates";

const wave = (n = 40): number[] => {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) pts.push(10 + i * 5, 50 + Math.sin(i / 4) * 10, 0.1 + 0.8 * Math.sin((Math.PI * i) / n));
  return pts;
};
const pencil = (pts = wave()): Stroke => ({ id: "p1", kind: "stroke", pen: "pencil", color: "#111111", width: 2, pts, t0: 0, t1: 1 });

describe("graphite pencil geometry", () => {
  it("shades along the same smoothed centre line as the outline, with per-point pressure", () => {
    const s = pencil();
    const c = strokeCenterline("pencil", s.width, s.pts, true, 0.45, true);
    expect(c.length % 3).toBe(0);
    expect(c.length / 3).toBeGreaterThan(10);
    const ps = c.filter((_, i) => i % 3 === 2);
    // pressure varies along the stroke (local shading, not one average)
    expect(Math.max(...ps) - Math.min(...ps)).toBeGreaterThan(0.3);
    // every centre-line point lies inside the outline's bounding box
    const o = strokeOutline(s);
    const xs = o.map((p) => p[0]), ys = o.map((p) => p[1]);
    for (let i = 0; i < c.length; i += 3) {
      expect(c[i]).toBeGreaterThanOrEqual(Math.min(...xs) - 0.01);
      expect(c[i]).toBeLessThanOrEqual(Math.max(...xs) + 0.01);
      expect(c[i + 1]).toBeGreaterThanOrEqual(Math.min(...ys) - 0.01);
      expect(c[i + 1]).toBeLessThanOrEqual(Math.max(...ys) + 0.01);
    }
  });

  it("uses constant pressure when pressure is off", () => {
    const c = strokeCenterline("pencil", 2, wave(), false);
    expect(new Set(c.filter((_, i) => i % 3 === 2))).toEqual(new Set([0.5]));
  });

  it("precision erasing splits pencil stroke data instead of painting over it", () => {
    const s = pencil();
    const parts = eraseStrokePart(s, 110, 0, 110, 100, 4);
    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(2);
    for (const p of parts!) {
      expect(p.pen).toBe("pencil");
      expect(p.color).toBe(s.color);
      expect(p.id).not.toBe(s.id);
    }
    expect(strokeHitBySegment(s, 0, 0, 1, 1, 1)).toBe(false);
  });
});

describe("lasso select modes", () => {
  const line: Stroke = { ...pencil([0, 10, 0.5, 20, 10, 0.5, 40, 10, 0.5, 60, 10, 0.5, 80, 10, 0.5, 100, 10, 0.5]), id: "line" };
  const smallLoop = [5, 0, 25, 0, 25, 20, 5, 20]; // covers only the start of the line
  const crossing = [50, -10, 52, -10, 52, 30, 50, 30]; // thin lasso the line passes straight through
  const around = [-5, 0, 105, 0, 105, 20, -5, 20];
  it("touch selects anything the lasso touches", () => {
    expect(lassoSelect([line], smallLoop, "touch")).toHaveLength(1);
    expect(lassoSelect([line], crossing, "touch")).toHaveLength(1);
  });
  it("enclose selects only fully circled items", () => {
    expect(lassoSelect([line], smallLoop, "enclose")).toHaveLength(0);
    expect(lassoSelect([line], crossing, "enclose")).toHaveLength(0);
    expect(lassoSelect([line], around, "enclose")).toHaveLength(1);
  });
  it("selects boxes by overlap (touch) or full containment (enclose)", () => {
    const box = { id: "t", kind: "text", x: 10, y: 10, w: 40, h: 20, text: "hi", size: 16, font: "sans", color: "#000" } as any;
    const partial = [0, 0, 20, 0, 20, 15, 0, 15];
    expect(lassoSelect([box], partial, "touch")).toHaveLength(1);
    expect(lassoSelect([box], partial, "enclose")).toHaveLength(0);
    expect(lassoSelect([box], [0, 0, 60, 0, 60, 40, 0, 40], "enclose")).toHaveLength(1);
  });
});

describe("cream paper", () => {
  it("is offered alongside the existing paper colours and keeps light template lines", () => {
    const ids = PAPER_COLORS.map((p) => p.id);
    expect(ids).toEqual(["#ffffff", "#fbf7ec", "#f8f7eb", "#f3f2ef", "#1f1f22"]);
    const bg = templateBg("ruled", "#f8f7eb") as Extract<ReturnType<typeof templateBg>, { type: "template" }>;
    const white = templateBg("ruled", "#ffffff") as typeof bg;
    expect(bg.paper).toBe("#f8f7eb");
    expect(isDark("#f8f7eb")).toBe(false);
    expect(bg.line).toBe(white.line);
  });
});

describe("theme default", () => {
  it("defaults to dark and migrates the old stored light default", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("dark");
    expect(resolveSavedTheme({})).toBe("dark");
    expect(resolveSavedTheme({ theme: "light" })).toBe("dark");
  });
  it("respects explicit choices", () => {
    expect(resolveSavedTheme({ theme: "light", themeExplicit: true })).toBe("light");
    expect(resolveSavedTheme({ theme: "dark" })).toBe("dark");
    expect(resolveSavedTheme({ theme: "system" })).toBe("system");
  });
});

describe("history with pencil strokes", () => {
  beforeAll(() => setDbName(`notefira-pencil-test-${Date.now()}`));
  afterAll(() => closeDB());

  it("undoes and redoes drawing, shapes and erasing", async () => {
    const doc = await createDoc({ title: "History", pages: 1 });
    const s = new DocSession(doc, await loadPages(doc));
    const pageId = doc.pageIds[0];
    const items = () => s.pages.get(pageId)!.items;
    const stroke = pencil();
    s.addItems(pageId, [stroke], "Write");
    const shape: Stroke = { ...pencil([0, 0, 0.5, 40, 0, 0.5, 40, 40, 0.5]), id: "sh", shape: true, closed: true };
    s.addItems(pageId, [shape], "Shape");
    expect(items().map((i) => i.id)).toEqual(["p1", "sh"]);
    s.undo();
    expect(items().map((i) => i.id)).toEqual(["p1"]);
    s.redo();
    expect(items().map((i) => i.id)).toEqual(["p1", "sh"]);

    const parts = eraseStrokePart(stroke, 110, 0, 110, 100, 4)!;
    s.setItems(pageId, [...parts, shape], "Erase");
    expect(items().filter((i) => i.kind === "stroke" && i.pen === "pencil" && !i.shape)).toHaveLength(2);
    s.undo();
    expect(items().map((i) => i.id)).toEqual(["p1", "sh"]);
    expect((items()[0] as Stroke).pts).toEqual(stroke.pts);
    await s.flush();
  });

  it("keeps a favourite set from the library when drawing in an open notebook", async () => {
    const doc = await createDoc({ title: "Fav", pages: 1 });
    const s = await getSession(doc.id); // notebook open in the editor
    const stored = (await getDoc(doc.id))!;
    await saveDoc({ ...stored, favorite: true }, false); // star tapped in the library
    await new Promise((r) => setTimeout(r, 20));
    s.addItems(doc.pageIds[0], [pencil()], "Write"); // then draw
    await s.flush();
    expect((await getDoc(doc.id))!.favorite).toBe(true);
    await releaseSession(doc.id);
  });
});

describe("stroke input clean-up", () => {
  it("thins dense jittery samples and keeps the exact end point", async () => {
    const { strokeInput } = await import("../src/engine/strokes");
    const pts: number[] = [];
    for (let i = 0; i <= 2000; i++) pts.push(i * 0.05, 10 + Math.sin(i * 7) * 0.02, 0.5 + Math.sin(i * 13) * 0.2); // 100 units, 0.05 apart, noisy pressure
    const out = strokeInput(pts, 1.8);
    expect(out.length).toBeLessThan(250);
    expect(out.length).toBeGreaterThan(50);
    expect(out[out.length - 1][0]).toBeCloseTo(100, 5);
    const ps = out.slice(1, -1).map((q) => q[2]);
    expect(Math.max(...ps) - Math.min(...ps)).toBeLessThan(0.25); // pressure noise smoothed
  });
});

describe("eraser modes", () => {
  it("precise erasing cuts exactly at the eraser edge (plus the ink's half width)", async () => {
    const { eraseStrokeExact, eraseStrokePart, inkHalfWidth } = await import("../src/engine/geometry");
    const line: Stroke = { ...pencil([0, 10, 0.5, 100, 10, 0.5]), id: "l", pen: "ballpoint", width: 2 };
    const r = 6;
    const exact = eraseStrokeExact(line, 50, 10, 50, 10, r)!;
    expect(exact).toHaveLength(2);
    const R = r + inkHalfWidth(line);
    const leftEnd = exact[0].pts[exact[0].pts.length - 3];
    const rightStart = exact[1].pts[0];
    expect(leftEnd).toBeCloseTo(50 - R, 1);
    expect(rightStart).toBeCloseTo(50 + R, 1);
    // the standard mode removes at least as much
    const std = eraseStrokePart(line, 50, 10, 50, 10, r)!;
    const stdGap = std[1].pts[0] - std[0].pts[std[0].pts.length - 3];
    expect(stdGap).toBeGreaterThanOrEqual(rightStart - leftEnd - 0.01);
    expect(eraseStrokeExact(line, 50, 40, 50, 40, r)).toBeNull();
  });
});

describe("scribble to erase", () => {
  it("recognises a back-and-forth scrub but not handwriting", async () => {
    const { isScribble, scribbleTargets } = await import("../src/engine/geometry");
    const scrub: number[] = [];
    for (let k = 0; k < 8; k++) for (let i = 0; i <= 10; i++) scrub.push(k % 2 ? 60 - i * 6 : i * 6, 10 + k * 1.2 + i * 0.1, 0.5);
    expect(isScribble(scrub)).toBe(true);
    const mmm: number[] = [];
    for (let i = 0; i <= 120; i++) mmm.push(i * 1.5, 20 - Math.abs(Math.sin(i / 6)) * 12, 0.5);
    expect(isScribble(mmm)).toBe(false);
    const loops: number[] = [];
    for (let i = 0; i <= 200; i++) loops.push(i * 0.8 + Math.cos(i / 4) * 6, 20 + Math.sin(i / 4) * 6, 0.5);
    expect(isScribble(loops)).toBe(false);
    const word: Stroke = { ...pencil([5, 14, 0.5, 30, 15, 0.5, 55, 14, 0.5]), id: "w", pen: "ballpoint" };
    const far: Stroke = { ...pencil([5, 80, 0.5, 55, 80, 0.5]), id: "far", pen: "ballpoint" };
    expect(scribbleTargets([word, far], scrub, 2.4).map((s) => s.id)).toEqual(["w"]);
  });
});

describe("arrow heads", () => {
  it("scale with line width and never exceed ~30% of a short arrow", async () => {
    const { dragShape } = await import("../src/engine/shapes");
    const head = (xy: number[]) => Math.hypot(xy[4] - xy[2], xy[5] - xy[3]);
    expect(head(dragShape("arrow", 0, 0, 200, 0, 1).xy)).toBeLessThan(head(dragShape("arrow", 0, 0, 200, 0, 5).xy));
    expect(head(dragShape("arrow", 0, 0, 20, 0, 5).xy)).toBeLessThanOrEqual(6.01);
  });
});

describe("smooth ink", () => {
  it("fills sparse samples with a curve so fast handwriting has no straight joins", async () => {
    const { strokeInput } = await import("../src/engine/strokes");
    // a circle sampled only 12 times (~16 units apart), like fast Apple Pencil input in Safari
    const pts: number[] = [];
    for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push(30 + Math.cos(a) * 30, 30 + Math.sin(a) * 30, 0.5); }
    const out = strokeInput(pts, 1.8);
    expect(out.length).toBeGreaterThan(60);
    // every filled-in point stays close to the true circle (no corner-cutting chords)
    for (const [x, y] of out) expect(Math.abs(Math.hypot(x - 30, y - 30) - 30)).toBeLessThan(1);
  });

  it("writes outlines as explicit quadratic curves (no SVG T shorthand) so PDF export matches", async () => {
    const { outlineToSvgPath, strokeOutline } = await import("../src/engine/strokes");
    const s: Stroke = { id: "o", kind: "stroke", pen: "fountain", color: "#000", width: 2, pts: wave(), t0: 0, t1: 0 };
    const d = outlineToSvgPath(strokeOutline(s));
    expect(d.startsWith("M")).toBe(true);
    expect(d).not.toMatch(/T/);
    expect((d.match(/Q/g) ?? []).length).toBe(strokeOutline(s).length);
    expect(d.trim().endsWith("Z")).toBe(true);
  });
});

describe("ball pen ink line", () => {
  it("passes through every pen sample with no lag, even on sharp reversals", async () => {
    const { inkLinePoints } = await import("../src/engine/strokes");
    // a big zig-zag scribble with sharp turns, sampled sparsely
    const samples: number[] = [];
    for (let i = 0; i <= 10; i++) samples.push(i * 20, i % 2 ? 0 : 60, 0.5);
    const line = inkLinePoints(samples, 1.8, 0); // no stabilization: exact
    const near = (x: number, y: number) => {
      let best = Infinity;
      for (let i = 0; i < line.length; i += 3) best = Math.min(best, Math.hypot(line[i] - x, line[i + 1] - y));
      return best;
    };
    for (let i = 0; i < samples.length; i += 3) expect(near(samples[i], samples[i + 1])).toBeLessThan(0.01);
    // the line ends exactly where the pen lifted (no trailing lag)
    expect(line[line.length - 3]).toBeCloseTo(200, 6);
    expect(line[line.length - 2]).toBeCloseTo(60, 6);
  });

  it("ball pen strokes are drawn as an ink line; other pens keep their pressure outline", async () => {
    const { isInkLineStroke } = await import("../src/engine/strokes");
    expect(isInkLineStroke({ pen: "ballpoint" })).toBe(true);
    expect(isInkLineStroke({ pen: "ballpoint", dash: "dashed" })).toBe(false);
    expect(isInkLineStroke({ pen: "ballpoint", shape: true })).toBe(false);
    expect(isInkLineStroke({ pen: "fountain" })).toBe(false);
    expect(isInkLineStroke({ pen: "pencil" })).toBe(false);
  });
});

describe("scribble to erase stays out of the way", () => {
  it("does not treat big looping scribbles as an erase gesture", async () => {
    const { isScribble } = await import("../src/engine/geometry");
    const loops: number[] = [];
    for (let i = 0; i <= 300; i++) { const a = i / 18; loops.push(200 + Math.cos(a) * (120 + i * 0.2), 200 + Math.sin(a * 1.3) * 110, 0.5); }
    expect(isScribble(loops)).toBe(false);
  });
});

describe("version", () => {
  it("is the same for web and desktop builds", async () => {
    const pkg: string = JSON.parse((await import("../package.json?raw")).default).version;
    const tauri: string = JSON.parse((await import("../src-tauri/tauri.conf.json?raw")).default).version;
    const cargo: string = (await import("../src-tauri/Cargo.toml?raw")).default;
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(tauri).toBe(pkg);
    expect(cargo).toMatch(new RegExp(`^version = "${pkg.replace(/\./g, "\\.")}"`, "m"));
    const { APP_VERSION } = await import("../src/version");
    expect(APP_VERSION).toBe(pkg);
  });
});
