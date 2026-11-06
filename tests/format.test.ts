// The .notefira format (version 2): integrity, strict validation, limits,
// backward compatibility with version 1, and self-contained exports.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDB, get, put, setDbName } from "../src/storage/db";
import * as repo from "../src/storage/repo";
import {
  FORMAT_VERSION,
  FormatError,
  buildFile,
  contentChecksum,
  contentHash,
  decodeFile,
  decodeJson,
  encodeFile,
  encodeJson,
  isSafeLinkUrl,
  sha256Hex,
  validateFile,
  type NotefiraFile,
} from "../src/model/format";
import { exportNotefira, importNotefiraBytes } from "../src/services/transfer";
import { bytesToBase64, gzip } from "../src/model/util";
import type { Doc, Page } from "../src/model/types";

beforeAll(() => setDbName(`format-${Math.random().toString(36).slice(2)}`));
afterAll(() => closeDB());

const page = (): Page => ({
  id: "p1",
  docId: "d1",
  w: 595,
  h: 842,
  bg: { type: "template", template: "ruled", paper: "#ffffff" },
  items: [
    { id: "s1", kind: "stroke", pen: "fountain", color: "#123456", width: 2.5, pts: [10, 10, 0.3, 20, 25, 0.9], t0: 1, t1: 2, stabilization: 0.4 } as any,
    { id: "sh", kind: "stroke", pen: "ballpoint", color: "#ff0000", width: 1, pts: [0, 0, 0.5, 50, 0, 0.5, 50, 50, 0.5], t0: 1, t1: 2, shape: true, closed: true, dash: "dashed" } as any,
    { id: "t1", kind: "text", x: 1, y: 2, w: 100, h: 20, rot: 0, text: "hello", font: "sans", size: 14, color: "#000", bold: false, italic: false, underline: false, align: "left", link: "https://example.com" } as any,
    { id: "i1", kind: "image", x: 0, y: 0, w: 10, h: 10, rot: 0, asset: "a1" } as any,
    { id: "l1", kind: "link", x: 0, y: 0, w: 10, h: 10, rot: 0, url: "mailto:someone@example.com" } as any,
  ],
  updated: 1,
});
const docOf = (p: Page): Doc => ({
  id: "d1",
  title: "Format test",
  folderId: null,
  cover: { type: "color", color: "#45bfdb", pattern: "plain" },
  created: 1,
  updated: 1,
  opened: 1,
  favorite: false,
  pageIds: [p.id],
  bookmarks: [],
  outline: [],
  defaultBg: p.bg,
  layout: "vertical",
  rev: 1,
});
const IMG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

async function v2(): Promise<NotefiraFile> {
  const p = page();
  return buildFile(docOf(p), [p], [{ id: "a1", mime: "image/png", size: IMG.length, sha256: await sha256Hex(IMG), data: bytesToBase64(IMG) }]);
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe(".notefira version 2", () => {
  it("writes version 2 with a SHA-256 over the content and each attachment", async () => {
    const f = await v2();
    expect(f.version).toBe(2);
    expect(FORMAT_VERSION).toBe(2);
    expect(f.integrity).toEqual({ alg: "SHA-256", hash: await contentHash(f) });
    expect(f.assets[0].sha256).toBe(await sha256Hex(IMG));
    const r = await decodeFile(await encodeFile(f), { strict: true });
    expect(r).toMatchObject({ checksumOk: true, integrity: "sha256", sourceVersion: 2 });
    // everything that makes ink editable survives exactly
    expect(r.file.pages[0].items).toEqual(page().items);
  });

  it("the hash does not depend on key order, and changes with any content", async () => {
    const f = await v2();
    const reordered = { ...f, doc: Object.fromEntries(Object.entries(f.doc).reverse()) as Doc };
    expect(await contentHash(reordered)).toBe(f.integrity!.hash);
    const moved = clone(f);
    (moved.pages[0].items[0] as any).pts[0] = 10.0001;
    expect(await contentHash(moved)).not.toBe(f.integrity!.hash);
  });

  it("detects tampering: strict reading rejects it, import repairs and reports it", async () => {
    const f = clone(await v2());
    (f.pages[0].items[0] as any).color = "#000000";
    await expect(validateFile(f, { strict: true })).rejects.toThrow(/integrity/);
    const r = await validateFile(f);
    expect(r.checksumOk).toBe(false);
  });

  it("an embedded attachment that does not match its SHA-256 is rejected or dropped", async () => {
    const f = clone(await v2());
    f.assets[0].data = bytesToBase64(new Uint8Array([1, 1, 1, 1, 1, 1, 1]));
    f.integrity!.hash = await contentHash(f); // even with a re-signed file
    await expect(validateFile(f, { strict: true })).rejects.toThrow(/SHA-256/);
    const r = await validateFile(f);
    expect(r.damagedAttachments).toBe(1);
    expect(r.file.assets[0].data).toBeUndefined();
  });

  it("strict validation rejects malformed or unsafe content", async () => {
    const cases: [string, (f: any) => void][] = [
      ["javascript: link", (f) => (f.pages[0].items[4].url = "javascript:alert(1)")],
      ["data: link in text", (f) => (f.pages[0].items[2].link = "data:text/html,hi")],
      ["unknown item kind", (f) => (f.pages[0].items[0].kind = "script")],
      ["stroke points not triples", (f) => f.pages[0].items[0].pts.push(1)],
      ["infinite number", (f) => (f.pages[0].items[0].width = 1e400)],
      ["unknown pen", (f) => (f.pages[0].items[0].pen = "laser")],
      ["opacity out of range", (f) => (f.pages[0].items[0].opacity = 7)],
      ["bad background", (f) => (f.pages[0].bg = { type: "html", src: "x" })],
      ["page listed twice", (f) => f.doc.pageIds.push("p1")],
      ["bad attachment hash", (f) => (f.assets[0].sha256 = "nothex")],
      ["bad mime", (f) => (f.assets[0].mime = "text/html; charset=x")],
      ["huge id", (f) => (f.pages[0].items[0].id = "x".repeat(500))],
    ];
    for (const [name, mutate] of cases) {
      const f: any = clone(await v2());
      mutate(f);
      f.integrity.hash = await contentHash(f);
      await expect(validateFile(f, { strict: true }), name).rejects.toThrow(FormatError);
    }
    expect(isSafeLinkUrl("https://notefira.app")).toBe(true);
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
  });

  it("drops keys that could tamper with object prototypes", async () => {
    const f: any = clone(await v2());
    const text = JSON.stringify(f).replace('"title":', '"__proto__":{"polluted":true},"constructor":{"x":1},"title":');
    const r = await decodeFile(new TextEncoder().encode(text));
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r.file.doc, "__proto__")).toBe(false);
  });

  it("refuses files that are too large or expand too much, before parsing them", async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const bomb = await gzip(zeros);
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(decodeJson(bomb, { maxBytes: 1024 * 1024 })).rejects.toThrow(/expands/);
    await expect(decodeJson(zeros, { maxBytes: 1024 * 1024 })).rejects.toThrow(/too large/);
    await expect(decodeJson(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).rejects.toThrow(FormatError);
    await expect(decodeJson(new Uint8Array([0xff, 0xfe, 0xfd]))).rejects.toThrow(FormatError);
  });

  it("refuses files from a newer version instead of misreading them", async () => {
    const f: any = clone(await v2());
    f.version = 3;
    await expect(validateFile(f)).rejects.toThrow(/newer version/);
  });
});

describe("backward compatibility with version 1 (Notefira 0.1.x)", () => {
  async function v1(): Promise<any> {
    const p = page();
    const doc = docOf(p);
    return { format: "notefira", version: 1, exported: 1, doc, pages: [p], assets: [{ id: "a1", mime: "image/png", size: IMG.length, data: bytesToBase64(IMG) }], recordings: [], checksum: contentChecksum(doc, [p]) };
  }

  it("reads version 1, checks its checksum, and upgrades it (attachment hashes computed)", async () => {
    const r = await decodeFile(await encodeJson(await v1()), { strict: true });
    expect(r).toMatchObject({ checksumOk: true, integrity: "legacy-checksum", sourceVersion: 1 });
    expect(r.file.version).toBe(2);
    expect(r.file.assets[0].sha256).toBe(await sha256Hex(IMG));
    expect(r.file.pages[0].items).toEqual(page().items);
  });

  it("a damaged version 1 file is still caught", async () => {
    const f = await v1();
    f.pages[0].items[0].pts[0] = 99;
    await expect(validateFile(f, { strict: true })).rejects.toThrow(/integrity/);
  });

  it("imports a version 1 export with its attachment", async () => {
    const { doc, warnings } = await importNotefiraBytes(await encodeJson(await v1()), null);
    expect(warnings).toEqual([]);
    const img = (await repo.loadPages(doc)).pages.get(doc.pageIds[0])!.items.find((i) => i.kind === "image") as any;
    const asset = await get<any>("assets", img.asset);
    expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(IMG);
    expect(asset.sha256).toBe(await sha256Hex(IMG));
  });
});

describe("exported .notefira files are self-contained", () => {
  it("embed every attachment (verified by SHA-256) and import on another device without Drive", async () => {
    const d = await repo.createDoc({ title: "Portable" });
    const pdf = new Uint8Array(Array.from({ length: 5000 }, (_, i) => i % 251));
    await put("assets", { id: "pdf1", docId: d.id, mime: "application/pdf", size: pdf.length, created: 1, blob: new Blob([pdf], { type: "application/pdf" }) });
    const cur = (await repo.getDoc(d.id))!;
    const { pages } = await repo.loadPages(cur);
    const p = pages.get(cur.pageIds[0])!;
    await repo.savePages(cur, [{ ...p, bg: { type: "pdf", asset: "pdf1", page: 0, rot: 0 } }]);
    const bytes = await exportNotefira(d.id);
    const parsed = await decodeJson(bytes);
    expect(parsed.version).toBe(2);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0].sha256).toBe(await sha256Hex(pdf));
    expect(typeof parsed.assets[0].data).toBe("string");
    // another device: a fresh database
    await closeDB();
    setDbName(`format-other-${Math.random().toString(36).slice(2)}`);
    const { doc, warnings } = await importNotefiraBytes(bytes, null);
    expect(warnings).toEqual([]);
    const bg = (await repo.loadPages(doc)).pages.get(doc.pageIds[0])!.bg as any;
    const asset = await get<any>("assets", bg.asset);
    expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(pdf);
  });
});
