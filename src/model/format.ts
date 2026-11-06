// The .notefira file format: gzip-compressed JSON holding one notebook — the
// document, every page (vector strokes with pressure, colour, width and pen;
// shapes; text; images; links; page backgrounds incl. PDF pages) and its audio
// recordings — plus a list of attachments (PDFs, images, audio).
//
// Version 2 (current):
//   - integrity: SHA-256 over a canonical serialisation of the content. Each
//     attachment is listed with its own SHA-256, so the one hash covers the
//     attachments too.
//   - attachments are content-addressed by that SHA-256. Exported files embed
//     their bytes (self-contained); in Google Drive they are stored once per
//     content as separate files, so editing a page never re-uploads a PDF.
//   - strict validation of every field, and size limits before anything is
//     decompressed or parsed.
// Version 1 (Notefira 0.1.0–0.1.4) is still read: its FNV checksum is checked
// and it is upgraded in memory; files are always written as version 2.

import type { Deck, Doc, Folder, Item, Page, Recording, Sticker, ID, Background } from "./types";
import { base64ToBytes, bytesToBase64, fnv1a, gzip, uid } from "./util";

export const FORMAT_VERSION = 2;

/** Limits checked before and while reading a file (protects against damaged and hostile files). */
export const LIMITS = {
  /** Largest file accepted, compressed or not (exports embed PDFs and audio). */
  fileBytes: 1024 * 1024 * 1024,
  /** Largest decompressed content. */
  decompressedBytes: 1536 * 1024 * 1024,
  /** Decompressed / compressed above this (for content over 64 MB) is treated as a decompression bomb. */
  maxRatio: 200,
  pages: 10_000,
  itemsPerPage: 200_000,
  pointsPerStroke: 300_000,
  textChars: 1_000_000,
  idChars: 128,
  titleChars: 1_000,
  attachments: 20_000,
  recordings: 2_000,
  attachmentBytes: 1024 * 1024 * 1024,
};

export interface AssetRecord {
  id: ID;
  mime: string;
  size: number;
  name?: string;
  /** SHA-256 of the bytes (hex). Required in version 2; absent in version 1 files. */
  sha256?: string;
  /** base64 bytes when embedded (exports and backups); absent in Drive, where attachments are separate files. */
  data?: string;
  /** Version 1 Drive files only: the Drive file of this attachment. */
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
  /** Version 2: SHA-256 over the canonical content. */
  integrity?: { alg: "SHA-256"; hash: string };
  /** Version 1: FNV-1a checksum of the pages. */
  checksum?: string;
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

// ---------------------------------------------------------------------------
// Hashing

/** JSON with object keys sorted and undefined members left out: the same content always gives the same text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v) ?? "null";
}

export async function sha256Hex(data: Uint8Array | string | Blob): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const hashedAssets = (assets: AssetRecord[]) => assets.map(({ data: _d, remoteId: _r, ...a }) => a);

/** The version 2 integrity hash: covers the document, pages, recordings and each attachment's hash. */
export function contentHash(f: Pick<NotefiraFile, "doc" | "pages" | "assets" | "recordings">): Promise<string> {
  return sha256Hex(canonicalJson({ doc: f.doc, pages: f.pages, assets: hashedAssets(f.assets), recordings: f.recordings }));
}

/** Version 1 checksum (FNV-1a of the pages). Also used to compare a stored copy with what was downloaded. */
export function contentChecksum(doc: Doc, pages: Page[]): string {
  return fnv1a(JSON.stringify([doc.id, doc.pageIds, pages.map((p) => [p.id, p.w, p.h, p.bg, p.items])]));
}

// ---------------------------------------------------------------------------
// Writing

/** Fields of a notebook that belong in a file (device-only fields such as the linked account are left out). */
const DOC_FIELDS = ["id", "title", "folderId", "cover", "created", "updated", "opened", "favorite", "deletedAt", "pageIds", "bookmarks", "outline", "defaultBg", "layout", "rev", "syncedRev", "remoteRev", "remoteId", "conflictOf"] as const;

function pickDoc(d: any): Partial<Doc> {
  const o: any = {};
  for (const k of DOC_FIELDS) if (d[k] !== undefined) o[k] = d[k];
  return o;
}

const PAGE_FIELDS = ["id", "w", "h", "bg", "items", "recognized", "updated"] as const;
function pickPage(p: any): Page {
  const o: any = {};
  for (const k of PAGE_FIELDS) if (p[k] !== undefined) o[k] = p[k];
  return o;
}

/** Build a version 2 file. Every attachment must carry its SHA-256. */
export async function buildFile(doc: Doc, pages: Page[], assets: AssetRecord[], recordings: Recording[] = []): Promise<NotefiraFile> {
  if (assets.some((a) => !a.sha256)) throw new Error("Every attachment needs its SHA-256 before a notebook can be written.");
  const ordered = doc.pageIds.map((id) => pages.find((p) => p.id === id)).filter(Boolean).map(pickPage);
  const f: NotefiraFile = {
    format: "notefira",
    version: FORMAT_VERSION,
    exported: Date.now(),
    doc: pickDoc(doc) as Doc,
    pages: ordered,
    assets: assets.map((a) => ({ id: a.id, mime: a.mime, size: a.size, name: a.name, sha256: a.sha256, data: a.data })),
    recordings,
  };
  f.integrity = { alg: "SHA-256", hash: await contentHash(f) };
  return f;
}

export async function encodeJson(obj: unknown): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function encodeFile(file: NotefiraFile): Promise<Uint8Array> {
  return encodeJson(file);
}

// ---------------------------------------------------------------------------
// Reading: size limits, safe decompression, safe parsing

export interface ReadLimits {
  /** Largest accepted input and decompressed size (defaults: LIMITS). */
  maxBytes?: number;
}

/** Gunzip with a hard cap on the output size; plain (uncompressed) input is returned as is. */
export async function gunzipLimited(data: Uint8Array, maxOut: number): Promise<Uint8Array> {
  if (!(data.length > 2 && data[0] === 0x1f && data[1] === 0x8b)) {
    if (data.length > maxOut) throw new FormatError("The file is too large to open.");
    return data;
  }
  if (typeof DecompressionStream === "undefined") throw new FormatError("This browser cannot open compressed files.");
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOut || (total > 64 * 1024 * 1024 && total / data.length > LIMITS.maxRatio)) {
        await reader.cancel().catch(() => {});
        throw new FormatError("The file expands to more data than Notefira accepts, so it was not opened.");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof FormatError) throw e;
    throw new FormatError("The file is damaged (it could not be decompressed).");
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** JSON.parse that drops keys able to tamper with object prototypes. */
export function safeParse(text: string): any {
  return JSON.parse(text, (k, v) => (FORBIDDEN_KEYS.has(k) ? undefined : v));
}

export async function decodeJson(bytes: Uint8Array, limits: ReadLimits = {}): Promise<any> {
  const max = limits.maxBytes ?? LIMITS.fileBytes;
  if (bytes.length > max) throw new FormatError("The file is too large to open.");
  const raw = await gunzipLimited(bytes, Math.min(LIMITS.decompressedBytes, limits.maxBytes ?? LIMITS.decompressedBytes));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new FormatError("The file is damaged or is not a Notefira file.");
  }
  try {
    return safeParse(text);
  } catch {
    throw new FormatError("The file is damaged or is not a Notefira file.");
  }
}

// ---------------------------------------------------------------------------
// Validation

const isNum = (n: unknown): n is number => typeof n === "number" && isFinite(n);
const optNum = (n: unknown) => n === undefined || isNum(n);
const isStr = (s: unknown, max = 10_000): s is string => typeof s === "string" && s.length <= max;
const optStr = (s: unknown, max = 10_000) => s === undefined || isStr(s, max);
const isId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= LIMITS.idChars;
const optBool = (b: unknown) => b === undefined || typeof b === "boolean";
const isColor = (s: unknown) => isStr(s, 64);
const isBox = (it: any) => [it.x, it.y, it.w, it.h].every(isNum) && optNum(it.rot);
const oneOf = (v: unknown, opts: readonly string[]) => typeof v === "string" && opts.includes(v);

const PENS = ["ballpoint", "pencil", "fountain", "brush", "highlighter"] as const;
const TEMPLATES = ["blank", "ruled", "narrow", "grid", "dotted", "cornell", "music", "todo", "custom"] as const;

/** Only web and e-mail links are opened from a notebook (never javascript:, data:, file: …). */
export function isSafeLinkUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function validateItem(it: any): it is Item {
  if (!it || typeof it !== "object" || !isId(it.id)) return false;
  switch (it.kind) {
    case "stroke":
      return (
        Array.isArray(it.pts) &&
        it.pts.length % 3 === 0 &&
        it.pts.length <= LIMITS.pointsPerStroke * 3 &&
        it.pts.every(isNum) &&
        isColor(it.color) &&
        isNum(it.width) &&
        it.width >= 0 &&
        it.width <= 2000 &&
        (it.pen === undefined || oneOf(it.pen, PENS)) &&
        optNum(it.t0) &&
        optNum(it.t1) &&
        (it.opacity === undefined || (isNum(it.opacity) && it.opacity >= 0 && it.opacity <= 1)) &&
        (it.stabilization === undefined || (isNum(it.stabilization) && it.stabilization >= 0 && it.stabilization <= 1)) &&
        optBool(it.shape) &&
        optBool(it.closed) &&
        optBool(it.cutStart) &&
        optBool(it.cutEnd) &&
        (it.fill === undefined || isColor(it.fill)) &&
        (it.dash === undefined || oneOf(it.dash, ["dashed", "dotted"]))
      );
    case "text":
      return (
        isBox(it) &&
        isStr(it.text, LIMITS.textChars) &&
        (it.font === undefined || oneOf(it.font, ["sans", "serif", "mono", "hand"])) &&
        optNum(it.size) &&
        (it.color === undefined || isColor(it.color)) &&
        optBool(it.bold) &&
        optBool(it.italic) &&
        optBool(it.underline) &&
        (it.align === undefined || oneOf(it.align, ["left", "center", "right"])) &&
        (it.bg === undefined || isColor(it.bg)) &&
        (it.link === undefined || (isStr(it.link, 4096) && isSafeLinkUrl(it.link))) &&
        optNum(it.t0)
      );
    case "image":
      return isBox(it) && isId(it.asset) && (it.crop === undefined || (it.crop && [it.crop.x, it.crop.y, it.crop.w, it.crop.h].every(isNum))) && optNum(it.t0);
    case "link":
      return isBox(it) && (it.url === undefined || (isStr(it.url, 4096) && isSafeLinkUrl(it.url))) && (it.pageId === undefined || isId(it.pageId)) && optStr(it.label, 1000);
    default:
      return false;
  }
}

export function validateBackground(bg: any): bg is Background {
  if (!bg || typeof bg !== "object") return false;
  if (bg.type === "template") return oneOf(bg.template, TEMPLATES) && isColor(bg.paper) && (bg.line === undefined || isColor(bg.line)) && optNum(bg.spacing) && (bg.asset === undefined || isId(bg.asset));
  if (bg.type === "pdf") return isId(bg.asset) && Number.isInteger(bg.page) && bg.page >= 0 && optNum(bg.rot);
  return false;
}

export function validatePage(p: any): string | null {
  if (!p || typeof p !== "object") return "page is not an object";
  if (!isId(p.id)) return "page has no id";
  if (!isNum(p.w) || !isNum(p.h) || p.w <= 0 || p.h <= 0 || p.w > 20000 || p.h > 20000) return "page has invalid size";
  if (!validateBackground(p.bg)) return "page has invalid background";
  if (!Array.isArray(p.items)) return "page has no items";
  if (p.items.length > LIMITS.itemsPerPage) return "page has too many items";
  if (!optStr(p.recognized, LIMITS.textChars) || !optNum(p.updated)) return "page has invalid fields";
  return null;
}

export function validateDoc(d: any): string | null {
  if (!d || typeof d !== "object") return "document missing";
  if (!isId(d.id) || !isStr(d.title, LIMITS.titleChars)) return "document has no id/title";
  if (!Array.isArray(d.pageIds) || !d.pageIds.every(isId) || d.pageIds.length > LIMITS.pages) return "document has no valid page list";
  if (new Set(d.pageIds).size !== d.pageIds.length) return "document lists a page twice";
  if (d.bookmarks !== undefined && !(Array.isArray(d.bookmarks) && d.bookmarks.every(isId))) return "document has invalid bookmarks";
  if (d.outline !== undefined && !(Array.isArray(d.outline) && d.outline.every((o: any) => o && isId(o.id) && isStr(o.title, LIMITS.titleChars) && isId(o.pageId) && isNum(o.level)))) return "document has an invalid outline";
  if (d.defaultBg !== undefined && !validateBackground(d.defaultBg)) return "document has an invalid default background";
  if (d.layout !== undefined && !oneOf(d.layout, ["vertical", "horizontal"])) return "document has an invalid layout";
  if (d.folderId !== undefined && d.folderId !== null && !isId(d.folderId)) return "document has an invalid folder";
  if (d.cover !== undefined && !validCover(d.cover)) return "document has an invalid cover";
  for (const k of ["created", "updated", "opened", "deletedAt", "rev", "syncedRev"]) if (!optNum(d[k])) return `document has an invalid ${k}`;
  if (!optBool(d.favorite) || !optStr(d.remoteRev, 200) || !optStr(d.remoteId, 200) || (d.conflictOf !== undefined && !isId(d.conflictOf))) return "document has invalid fields";
  return null;
}

function validCover(c: any): boolean {
  if (!c || typeof c !== "object") return false;
  if (c.type === "color") return isColor(c.color) && oneOf(c.pattern, ["plain", "lines", "dots", "wave", "grid"]);
  if (c.type === "image") return isId(c.asset);
  return c.type === "page";
}

function validAsset(a: any, version: number): string | null {
  if (!a || typeof a !== "object" || !isId(a.id)) return "attachment has no id";
  if (!isStr(a.mime, 200) || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime)) return "attachment has an invalid type";
  if (!Number.isInteger(a.size) || a.size < 0 || a.size > LIMITS.attachmentBytes) return "attachment has an invalid size";
  if (!optStr(a.name, 1000)) return "attachment has an invalid name";
  if (version >= 2 ? !(typeof a.sha256 === "string" && /^[0-9a-f]{64}$/.test(a.sha256)) : a.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(a.sha256)) return "attachment has no valid SHA-256";
  if (a.data !== undefined && !(typeof a.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(a.data))) return "attachment data is not valid";
  if (!optStr(a.remoteId, 200)) return "attachment has invalid fields";
  return null;
}

function validRecording(r: any): boolean {
  return (
    !!r &&
    typeof r === "object" &&
    isId(r.id) &&
    isStr(r.title ?? "", LIMITS.titleChars) &&
    isNum(r.start) &&
    isNum(r.duration) &&
    isId(r.asset) &&
    Array.isArray(r.transcript ?? []) &&
    (r.transcript ?? []).every((l: any) => l && isNum(l.t) && isStr(l.text, LIMITS.textChars)) &&
    Array.isArray(r.segments ?? []) &&
    (r.segments ?? []).every((s: any) => Array.isArray(s) && s.length === 2 && s.every(isNum))
  );
}

export interface ValidationReport {
  file: NotefiraFile;
  droppedItems: number;
  repairedPages: number;
  /** Attachments whose embedded bytes failed their SHA-256 (their bytes were dropped). */
  damagedAttachments: number;
  /** True when the file's integrity check (SHA-256, or the version 1 checksum) matched and nothing was repaired. */
  checksumOk: boolean;
  /** How the content was verified. */
  integrity: "sha256" | "legacy-checksum" | "none";
  /** The version the file was written in (it is upgraded to the current version in memory). */
  sourceVersion: number;
}

export interface ValidateOptions {
  /** Sync: any damage at all rejects the file. Import: damaged parts are dropped and reported. */
  strict?: boolean;
}

/**
 * Validate a parsed .notefira object, verify its integrity and upgrade it to
 * the current version. In strict mode nothing is repaired: any problem throws.
 */
export async function validateFile(obj: any, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const strict = !!opts.strict;
  const fail = (msg: string): never => {
    throw new FormatError(`The notebook is damaged: ${msg}.`);
  };
  if (!obj || typeof obj !== "object" || obj.format !== "notefira") throw new FormatError("This is not a Notefira notebook file.");
  if (!Number.isInteger(obj.version) || obj.version < 1) throw new FormatError("This is not a Notefira notebook file.");
  if (obj.version > FORMAT_VERSION) throw new FormatError("This notebook was made by a newer version of Notefira. Please update the app.");
  const version: number = obj.version;
  const docErr = validateDoc(obj.doc);
  if (docErr) fail(docErr);
  if (!Array.isArray(obj.pages) || obj.pages.length > LIMITS.pages) fail("no valid page list");
  const rawAssets = obj.assets === undefined ? [] : obj.assets;
  const rawRecs = obj.recordings === undefined ? [] : obj.recordings;
  if (!Array.isArray(rawAssets) || rawAssets.length > LIMITS.attachments) fail("invalid attachment list");
  if (!Array.isArray(rawRecs) || rawRecs.length > LIMITS.recordings) fail("invalid recordings");

  // ---- integrity of the content exactly as written
  let integrity: ValidationReport["integrity"] = "none";
  let integrityOk = true;
  if (version >= 2) {
    if (!obj.integrity || obj.integrity.alg !== "SHA-256" || typeof obj.integrity.hash !== "string") fail("missing integrity hash");
    integrity = "sha256";
    integrityOk = (await contentHash({ doc: obj.doc, pages: obj.pages, assets: rawAssets, recordings: rawRecs })) === obj.integrity.hash;
  } else if (obj.checksum !== undefined) {
    integrity = "legacy-checksum";
    integrityOk = typeof obj.checksum === "string" && obj.checksum === contentChecksum(obj.doc, obj.pages);
  }
  if (strict && !integrityOk) fail("its integrity check failed");
  if (strict && version < 2 && integrity === "none") fail("it has no integrity check");

  // ---- pages and items
  let dropped = 0;
  let repaired = 0;
  const pages: Page[] = [];
  const seen = new Set<string>();
  for (const p of obj.pages) {
    const err = validatePage(p) ?? (seen.has(p.id) ? "page listed twice" : null);
    if (err) {
      if (strict) fail(err);
      repaired++;
      continue;
    }
    seen.add(p.id);
    const items = p.items.filter((it: any) => {
      const ok = validateItem(it);
      if (!ok) {
        if (strict) fail("a page has an invalid item");
        dropped++;
      }
      return ok;
    });
    pages.push({ ...pickPage(p), docId: obj.doc.id, items, sum: undefined } as Page);
  }
  if (!pages.length) throw new FormatError("The notebook has no readable pages.");
  if (strict && obj.doc.pageIds.some((id: string) => !seen.has(id))) fail("a listed page is missing");

  // ---- attachments: valid records; embedded bytes must match their size and SHA-256
  const assets: AssetRecord[] = [];
  let damagedAttachments = 0;
  const assetIds = new Set<string>();
  for (const a of rawAssets) {
    const err = validAsset(a, version) ?? (assetIds.has(a.id) ? "attachment listed twice" : null);
    if (err) {
      if (strict) fail(err);
      continue;
    }
    assetIds.add(a.id);
    const rec: AssetRecord = { id: a.id, mime: a.mime, size: a.size, name: a.name, sha256: a.sha256, remoteId: a.remoteId };
    if (a.data !== undefined) {
      let bytes: Uint8Array | null = null;
      try {
        bytes = base64ToBytes(a.data);
      } catch {
        bytes = null;
      }
      const hash = bytes ? await sha256Hex(bytes) : "";
      if (!bytes || bytes.length !== a.size || (a.sha256 && hash !== a.sha256)) {
        if (strict) fail("an attachment failed its SHA-256 check");
        damagedAttachments++;
      } else {
        rec.data = a.data;
        rec.sha256 = hash; // version 1 files: computed now
      }
    }
    assets.push(rec);
  }
  const recordings: Recording[] = [];
  for (const r of rawRecs) {
    if (!validRecording(r)) {
      if (strict) fail("a recording is invalid");
      continue;
    }
    recordings.push({ id: r.id, docId: obj.doc.id, title: r.title ?? "", start: r.start, duration: r.duration, asset: r.asset, transcript: r.transcript ?? [], segments: r.segments ?? [] });
  }

  // ---- the document (upgraded: defaults for fields older files may lack)
  const pageIds = (obj.doc.pageIds as string[]).filter((id) => pages.some((p) => p.id === id));
  for (const p of pages) if (!pageIds.includes(p.id)) pageIds.push(p.id);
  const doc = {
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
    ...pickDoc(obj.doc),
    pageIds,
  } as Doc;
  doc.bookmarks = (doc.bookmarks || []).filter((b) => pageIds.includes(b));
  doc.outline = (doc.outline || []).filter((o) => o && pageIds.includes(o.pageId));
  const file: NotefiraFile = {
    format: "notefira",
    version: FORMAT_VERSION,
    exported: isNum(obj.exported) ? obj.exported : Date.now(),
    doc,
    pages,
    assets,
    recordings,
    integrity: version >= 2 ? obj.integrity : undefined,
    checksum: version < 2 ? obj.checksum : undefined,
  };
  const checksumOk = integrityOk && dropped === 0 && repaired === 0 && damagedAttachments === 0;
  return { file, droppedItems: dropped, repairedPages: repaired, damagedAttachments, checksumOk, integrity, sourceVersion: version };
}

export async function decodeFile(bytes: Uint8Array, opts: ValidateOptions & ReadLimits = {}): Promise<ValidationReport> {
  return validateFile(await decodeJson(bytes, opts), opts);
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
    syncAccount: undefined,
    syncIssue: undefined,
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
