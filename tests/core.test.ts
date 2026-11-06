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

