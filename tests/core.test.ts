import { describe, expect, it } from "vitest";
import type { Card, Doc, Page, Stroke } from "../src/model/types";
import { dragShape, recognizeShape, shapeToPts } from "../src/engine/shapes";
import { eraseStrokePart, lassoSelect, rotateItems90, strokeBounds } from "../src/engine/geometry";
import { contentChecksum, decodeFile, encodeFile, validateFile, type NotefiraFile } from "../src/model/format";
import { isDark, pageSize, templateBg, templateShapes } from "../src/model/templates";
import { DAY, deckStats, schedule } from "../src/study/srs";

const stroke = (pts: number[]): Stroke => ({
  id: "s1",
  kind: "stroke",
  pen: "ballpoint",
  color: "#000000",
  width: 2,
  pts,
  t0: 0,
  t1: 1,
});

function notebook(): NotefiraFile {
  const page: Page = {
    id: "p1",
    docId: "d1",
    w: 595,
    h: 842,
    bg: templateBg("ruled"),
    items: [stroke([10, 10, 0.5, 20, 20, 0.7])],
    updated: 1,
  };
  const doc: Doc = {
    id: "d1",
    title: "Test notebook",
    folderId: null,
    cover: { type: "color", color: "#45bfdb", pattern: "plain" },
    created: 1,
    updated: 1,
    opened: 1,
    favorite: false,
    pageIds: [page.id],
    bookmarks: [],
    outline: [],
    defaultBg: page.bg,
    layout: "vertical",
    rev: 1,
  };
  return {
    format: "notefira",
    version: 1,
    exported: 1,
    doc,
    pages: [page],
    assets: [],
    recordings: [],
    checksum: contentChecksum(doc, [page]),
  };
}

describe("vector editing", () => {
  it("computes bounds and rotates page content without mutating it", () => {
    const s = stroke([10, 20, 0.5, 30, 40, 0.8]);
    expect(strokeBounds(s)).toEqual({ x: 8, y: 18, w: 24, h: 24 });
    const [rotated] = rotateItems90([s], 100) as Stroke[];
    expect(rotated.pts).toEqual([80, 10, 0.5, 60, 30, 0.8]);
    expect(s.pts[0]).toBe(10);
  });

  it("selects with a lasso and splits a stroke with the precision eraser", () => {
    const s = stroke([0, 10, 0.5, 10, 10, 0.5, 20, 10, 0.5, 30, 10, 0.5, 40, 10, 0.5]);
    expect(lassoSelect([s], [-5, 0, 45, 0, 45, 20, -5, 20])).toHaveLength(1);
    const pieces = eraseStrokePart(s, 20, 0, 20, 20, 3);
    expect(pieces).not.toBeNull();
    expect(pieces!.length).toBe(2);
  });

  it("recognizes straight lines and creates closed drag shapes", () => {
    expect(recognizeShape([0, 0, 0.5, 50, 1, 0.5, 100, 0, 0.5])?.kind).toBe("line");
    const rect = dragShape("rectangle", 10, 20, 50, 80);
    expect(rect.closed).toBe(true);
    expect(shapeToPts(rect.xy)).toHaveLength(12);
  });
});

describe("portable notebook format", () => {
  it("round-trips a compressed editable notebook and verifies its checksum", async () => {
    const original = notebook();
    const decoded = await decodeFile(await encodeFile(original));
    expect(decoded.checksumOk).toBe(true);
    expect(decoded.file.doc.title).toBe("Test notebook");
    expect(decoded.file.pages[0].items[0].kind).toBe("stroke");
  });

  it("repairs invalid items but reports that integrity changed", () => {
    const broken: any = notebook();
    broken.pages[0].items.push({ id: "bad", kind: "stroke", pts: [NaN] });
    const result = validateFile(broken);
    expect(result.droppedItems).toBe(1);
    expect(result.checksumOk).toBe(false);
    expect(result.file.pages[0].items).toHaveLength(1);
  });
});

describe("paper templates and study scheduling", () => {
  it("generates portrait/landscape paper and visible template marks", () => {
    expect(pageSize("a4", "landscape")).toEqual({ w: 842, h: 595 });
    expect(templateShapes(templateBg("grid"), 100, 100).lines.length).toBeGreaterThan(5);
    expect(isDark("#1f1f22")).toBe(true);
    expect(isDark("#ffffff")).toBe(false);
  });

  it("schedules reviews and tracks due cards", () => {
    const now = 1_000_000;
    const card: Card = { id: "c1", front: { text: "Q" }, back: { text: "A" }, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now, created: now, updated: now };
    const good = schedule(card, 2, now);
    expect(good.due).toBe(now + DAY);
    const again = schedule(good, 0, now);
    expect(again.lapses).toBe(1);
    expect(again.due).toBe(now + 10 * 60_000);
    expect(deckStats([card, good], now)).toEqual({ total: 2, due: 1, learning: 1, mature: 0 });
  });
});


describe("draw and hold only snaps genuine shapes", () => {
  const jitter = (() => { let s = 17; return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 1.5; })();
  const path = (xy: number[][], steps = 12) => {
    const out: number[] = [];
    for (let i = 0; i < xy.length - 1; i++) for (let k = 0; k < steps; k++) { const t = k / steps; out.push(xy[i][0] + (xy[i + 1][0] - xy[i][0]) * t + jitter(), xy[i][1] + (xy[i + 1][1] - xy[i][1]) * t + jitter(), 0.5); }
    const last = xy[xy.length - 1];
    out.push(last[0], last[1], 0.5);
    return out;
  };
  it("still recognises lines, angles, triangles, rectangles and circles", () => {
    expect(recognizeShape(path([[0, 0], [120, 30]]))?.kind).toBe("line");
    expect(recognizeShape(path([[0, 0], [0, 80], [90, 80]]))?.kind).toBe("polyline");
    expect(recognizeShape(path([[50, 0], [100, 90], [0, 90], [50, 0]]))?.kind).toBe("triangle");
    expect(recognizeShape(path([[0, 0], [120, 0], [120, 80], [0, 80], [0, 0]]))?.kind).toBe("rectangle");
    const circle: number[] = [];
    for (let i = 0; i <= 60; i++) { const a = (i / 60) * Math.PI * 2; circle.push(60 + Math.cos(a) * 50 + jitter(), 60 + Math.sin(a) * 50 + jitter(), 0.5); }
    expect(recognizeShape(circle)?.kind).toBe("circle");
  });
  it("recognises sloppy real-life shapes: overshooting circles and wobbly rectangles", () => {
    const circ = (over: number) => { const p: number[] = []; for (let i = 0; i <= 80; i++) { const a = (i / 80) * Math.PI * 2 * (1 + over); const r = 50 * (1 + 0.09 * Math.sin(a * 3) + jitter() * 0.04); p.push(60 + Math.cos(a) * r * 1.05, 60 + Math.sin(a) * r, 0.5); } return p; };
    expect(recognizeShape(circ(0))?.kind).toBe("circle");
    expect(recognizeShape(circ(0.2))?.kind).toBe("circle");
    // a blobby, wobbly circle (the kind that simplifies to a few corners) still snaps to a circle
    let s2 = 3; const j2 = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647 - 0.5);
    const blob: number[] = [];
    for (let i = 0; i <= 70; i++) { const a = (i / 70) * Math.PI * 2 * 1.2; const rad = 60 * (1 + 0.08 * Math.sin(a * 3) + j2() * 0.05); blob.push(100 + Math.cos(a) * rad * 1.08, 100 + Math.sin(a) * rad, 0.5); }
    expect(["circle", "ellipse"]).toContain(recognizeShape(blob)?.kind);
    const rr: number[] = []; const c = [[0, 0], [140, 4], [138, 92], [-3, 88], [2, 2]];
    for (let i = 0; i < 4; i++) for (let k = 0; k < 20; k++) { const t = k / 20; const bow = Math.sin(t * Math.PI) * 4; const nx = -(c[i + 1][1] - c[i][1]), ny = c[i + 1][0] - c[i][0], l = Math.hypot(nx, ny); rr.push(c[i][0] + (c[i + 1][0] - c[i][0]) * t + (nx / l) * bow, c[i][1] + (c[i + 1][1] - c[i][1]) * t + (ny / l) * bow, 0.5); }
    rr.push(4, 6, 0.5);
    expect(recognizeShape(rr)?.kind).toBe("rectangle");
    const spiral: number[] = []; for (let i = 0; i <= 120; i++) { const a = i / 10; spiral.push(100 + Math.cos(a) * (10 + i * 0.6), 100 + Math.sin(a) * (10 + i * 0.6), 0.5); }
    expect(recognizeShape(spiral)).toBeNull();
  });
  it("never turns handwriting or scribbles into straight-line shapes", () => {
    const curvy: number[] = [];
    for (let i = 0; i <= 80; i++) { const t = i / 80; curvy.push(t * 300, 60 + Math.sin(t * Math.PI * 4) * 50 + Math.sin(t * 17) * 6, 0.5); }
    expect(recognizeShape(curvy)).toBeNull();
    const cursive: number[] = [];
    for (let i = 0; i <= 200; i++) { const a = i / 8; cursive.push(i * 1.2 + Math.sin(a) * 10, 40 + Math.cos(a) * 14, 0.5); }
    expect(recognizeShape(cursive)).toBeNull();
    expect(recognizeShape(path([[20, 60], [150, 15], [40, 120], [230, 40], [120, 140], [300, 90]]))).toBeNull();
    const wave: number[] = [];
    for (let i = 0; i <= 60; i++) { const t = i / 60; wave.push(t * 200, 50 + Math.sin(t * Math.PI * 2.2) * 35, 0.5); }
    expect(recognizeShape(wave)).toBeNull();
    const arch: number[] = [];
    for (let i = 0; i <= 50; i++) { const a = (i / 50) * Math.PI; arch.push(80 - Math.cos(a) * 70, 80 - Math.sin(a) * 50, 0.5); }
    expect(recognizeShape(arch)).toBeNull();
  });
});
