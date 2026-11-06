// The .notefira file format: gzip-compressed JSON containing the document,
// all pages (vector strokes, text, images, links), and optionally embedded
// binary assets (PDF backgrounds, images, audio). The same structure (without
// embedded assets) is what gets stored in Google Drive, so every platform reads
// and writes one compatible format.

import type { Deck, Doc, Folder, Item, Page, Recording, Sticker, ID } from "./types";
import { base64ToBytes, bytesToBase64, fnv1a, gunzipIfNeeded, gzip, uid } from "./util";

export const FORMAT_VERSION = 1;

export interface AssetRecord {
  id: ID;
  mime: string;
  size: number;
  name?: string;
  /** base64 bytes when embedded (file export / backups); absent in Drive notebooks where assets are separate files. */
  data?: string;
  remoteId?: string;
}

export interface NotefiraFile {
  format: "notefira";
  version: number;
  exported: number;
  doc: Doc;
  pages: Page[];
  assets: AssetRecord[];
  recordings: Recording[];
  checksum: string;
}

export interface BackupFile {
  format: "notefira-backup";
  version: number;
  exported: number;
  docs: NotefiraFile[];
  folders: Folder[];
  decks: Deck[];
  stickers: Sticker[];
}

export class FormatError extends Error {}

export function contentChecksum(doc: Doc, pages: Page[]): string {
  return fnv1a(JSON.stringify([doc.id, doc.pageIds, pages.map((p) => [p.id, p.w, p.h, p.bg, p.items])]));
}

export function buildFile(doc: Doc, pages: Page[], assets: AssetRecord[], recordings: Recording[] = []): NotefiraFile {
  const ordered = doc.pageIds.map((id) => pages.find((p) => p.id === id)).filter(Boolean) as Page[];
  return {
    format: "notefira",
    version: FORMAT_VERSION,
    exported: Date.now(),
    doc,
    pages: ordered,
    assets,
    recordings,
    checksum: contentChecksum(doc, ordered),
  };
}

export async function encodeJson(obj: unknown): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function decodeJson(bytes: Uint8Array): Promise<any> {
  let raw: Uint8Array;
  try {
    raw = await gunzipIfNeeded(bytes);
  } catch {
    throw new FormatError("The file is damaged (it could not be decompressed).");
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new FormatError("The file is damaged or is not a Notefira file.");
  }
}

function isNum(n: unknown): n is number {
  return typeof n === "number" && isFinite(n);
}

export function validateItem(it: any): it is Item {
  if (!it || typeof it !== "object" || typeof it.id !== "string") return false;
  if (it.kind === "stroke") return Array.isArray(it.pts) && it.pts.length % 3 === 0 && it.pts.every(isNum) && typeof it.color === "string" && isNum(it.width);
  if (it.kind === "text") return [it.x, it.y, it.w, it.h].every(isNum) && typeof it.text === "string";
  if (it.kind === "image") return [it.x, it.y, it.w, it.h].every(isNum) && typeof it.asset === "string";
  if (it.kind === "link") return [it.x, it.y, it.w, it.h].every(isNum);
  return false;
}

export function validatePage(p: any): string | null {
  if (!p || typeof p !== "object") return "page is not an object";
  if (typeof p.id !== "string") return "page has no id";
  if (!isNum(p.w) || !isNum(p.h) || p.w <= 0 || p.h <= 0 || p.w > 20000 || p.h > 20000) return "page has invalid size";
  if (!p.bg || (p.bg.type !== "template" && p.bg.type !== "pdf")) return "page has invalid background";
  if (!Array.isArray(p.items)) return "page has no items";
  return null;
}

export function validateDoc(d: any): string | null {
  if (!d || typeof d !== "object") return "document missing";
  if (typeof d.id !== "string" || typeof d.title !== "string") return "document has no id/title";
  if (!Array.isArray(d.pageIds)) return "document has no page list";
  return null;
}

export interface ValidationReport {
  file: NotefiraFile;
  droppedItems: number;
  repairedPages: number;
  checksumOk: boolean;
}

/** Validate and repair a parsed .notefira object. Invalid items are dropped rather than failing the whole import. */
export function validateFile(obj: any): ValidationReport {
  if (!obj || obj.format !== "notefira") throw new FormatError("This is not a Notefira notebook file.");
  if (!isNum(obj.version) || obj.version > FORMAT_VERSION) throw new FormatError("This notebook was made by a newer version of Notefira. Please update the app.");
  const docErr = validateDoc(obj.doc);
  if (docErr) throw new FormatError(`The notebook is damaged: ${docErr}.`);
  if (!Array.isArray(obj.pages)) throw new FormatError("The notebook is damaged: no pages.");
  let dropped = 0,
    repaired = 0;
  const pages: Page[] = [];
  for (const p of obj.pages) {
    const err = validatePage(p);
    if (err) {
      repaired++;
      continue;
    }
    const items = p.items.filter((it: any) => {
      const ok = validateItem(it);
      if (!ok) dropped++;
      return ok;
    });
    pages.push({ ...p, docId: obj.doc.id, items, sum: undefined });
  }
  if (!pages.length) throw new FormatError("The notebook has no readable pages.");
  const pageIds = (obj.doc.pageIds as string[]).filter((id) => pages.some((p) => p.id === id));
  for (const p of pages) if (!pageIds.includes(p.id)) pageIds.push(p.id);
  const doc: Doc = {
    bookmarks: [],
    outline: [],
    favorite: false,
    layout: "vertical",
    cover: { type: "color", color: "#45bfdb", pattern: "plain" },
    folderId: null,
    created: Date.now(),
    updated: Date.now(),
    opened: Date.now(),
    defaultBg: pages[0].bg.type === "template" ? pages[0].bg : { type: "template", template: "blank", paper: "#ffffff" },
    rev: 1,
    ...obj.doc,
    pageIds,
  };
  doc.bookmarks = (doc.bookmarks || []).filter((b) => pageIds.includes(b));
  doc.outline = (doc.outline || []).filter((o) => o && pageIds.includes(o.pageId));
  const file: NotefiraFile = {
    format: "notefira",
    version: obj.version,
    exported: obj.exported ?? Date.now(),
    doc,
    pages,
    assets: Array.isArray(obj.assets) ? obj.assets.filter((a: any) => a && typeof a.id === "string") : [],
    recordings: Array.isArray(obj.recordings) ? obj.recordings : [],
    checksum: obj.checksum,
  };
  const checksumOk = !obj.checksum || (obj.checksum === contentChecksum(obj.doc, obj.pages) && dropped === 0 && repaired === 0);
  return { file, droppedItems: dropped, repairedPages: repaired, checksumOk };
}

export async function encodeFile(file: NotefiraFile): Promise<Uint8Array> {
  return encodeJson(file);
}

export async function decodeFile(bytes: Uint8Array): Promise<ValidationReport> {
  return validateFile(await decodeJson(bytes));
}

/** Give an imported document fresh ids so it never collides with existing notebooks. */
export function remapIds(file: NotefiraFile): NotefiraFile {
  const docId = uid();
  const pageMap = new Map<string, string>();
  const assetMap = new Map<string, string>();
  file.pages.forEach((p) => pageMap.set(p.id, uid()));
  file.assets.forEach((a) => assetMap.set(a.id, uid()));
  const ma = (id: string) => assetMap.get(id) ?? id;
  const mp = (id: string) => pageMap.get(id) ?? id;
  const pages = file.pages.map((p) => ({
    ...p,
    id: mp(p.id),
    docId,
    bg: p.bg.type === "pdf" ? { ...p.bg, asset: ma(p.bg.asset) } : p.bg.asset ? { ...p.bg, asset: ma(p.bg.asset) } : p.bg,
    items: p.items.map((it) => (it.kind === "image" ? { ...it, asset: ma(it.asset) } : it.kind === "link" && it.pageId ? { ...it, pageId: mp(it.pageId) } : it)),
  }));
  const doc: Doc = {
    ...file.doc,
    id: docId,
    pageIds: file.doc.pageIds.map(mp),
    bookmarks: file.doc.bookmarks.map(mp),
    outline: file.doc.outline.map((o) => ({ ...o, pageId: mp(o.pageId) })),
    cover: file.doc.cover?.type === "image" ? { type: "image", asset: ma(file.doc.cover.asset) } : file.doc.cover,
    remoteId: undefined,
    remoteRev: undefined,
    syncedRev: undefined,
    deletedAt: undefined,
    rev: 1,
  };
  return {
    ...file,
    doc,
    pages,
    assets: file.assets.map((a) => ({ ...a, id: ma(a.id), remoteId: undefined })),
    recordings: file.recordings.map((r) => ({ ...r, id: uid(), docId, asset: ma(r.asset) })),
  };
}

export function embedBytes(bytes: Uint8Array) {
  return bytesToBase64(bytes);
}
export function extractBytes(b64: string) {
  return base64ToBytes(b64);
}
