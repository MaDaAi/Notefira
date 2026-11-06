import * as repo from "../storage/repo";
import * as db from "../storage/db";
import type { Doc, ID, Page, Recording, Asset, Folder, Deck, Sticker, Item } from "../model/types";
import { buildFile, decodeFile, encodeFile, embedBytes, extractBytes, remapIds, decodeJson, encodeJson, validateFile, sha256Hex, FormatError, type AssetRecord, type BackupFile, type NotefiraFile } from "../model/format";
import { openPdfBytes, pdfPageInfos, indexPdfText } from "../engine/pdf";
import { uid } from "../model/util";
import { templateBg } from "../model/templates";
import { settingsStore } from "../state/store";
import { pageSize } from "../model/templates";

const MAX_IMPORT_BYTES = 1024 * 1024 * 1024; // 1 GB safety limit

export async function importPdfFile(file: File | Blob, name: string, folderId: ID | null): Promise<Doc> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("This PDF is larger than 1 GB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new Error(`"${name}" is not a valid PDF file.`);
  let pdf;
  try {
    pdf = await openPdfBytes(bytes.slice());
  } catch (e: any) {
    throw new Error(e?.name === "PasswordException" ? `"${name}" is password protected. Remove the password and import again.` : `"${name}" could not be read as a PDF.`);
  }
  const infos = await pdfPageInfos(pdf);
  pdf.destroy();
  const docId = uid();
  const asset = await repo.putAsset(new Blob([bytes], { type: "application/pdf" }), docId, name);
  const now = Date.now();
  const pages: Page[] = infos.map((info, i) => repo.sealPage({ id: uid(), docId, w: info.w, h: info.h, bg: { type: "pdf", asset: asset.id, page: i, rot: info.rot }, items: [], updated: now }));
  const doc: Doc = {
    id: docId,
    title: name.replace(/\.pdf$/i, "") || "Imported PDF",
    folderId,
    cover: { type: "page" },
    created: now,
    updated: now,
    opened: now,
    favorite: false,
    pageIds: pages.map((p) => p.id),
    bookmarks: [],
    outline: [],
    defaultBg: templateBg("blank"),
    layout: "vertical",
    rev: 1,
  };
  await db.writeTx(["docs", "pages"], (w) => {
    w.put("docs", doc);
    pages.forEach((p) => w.put("pages", p));
  });
  repo.emit("library");
  indexPdfText(docId, pages).catch(() => {});
  return doc;
}

/** Build pages for a PDF to insert into an existing document. */
export async function pdfToPages(file: File, docId: ID): Promise<Page[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await openPdfBytes(bytes.slice());
  const infos = await pdfPageInfos(pdf);
  pdf.destroy();
  const asset = await repo.putAsset(new Blob([bytes], { type: "application/pdf" }), docId, file.name);
  const now = Date.now();
  const pages = infos.map((info, i) => ({ id: uid(), docId, w: info.w, h: info.h, bg: { type: "pdf" as const, asset: asset.id, page: i, rot: info.rot }, items: [], updated: now }));
  indexPdfText(docId, pages).catch(() => {});
  return pages;
}

export async function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const r = { w: bmp.width, h: bmp.height };
    bmp.close();
    return r;
  } catch {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => rej(new Error("Unsupported image"));
      img.src = URL.createObjectURL(blob);
    });
  }
}

export async function importImagesAsDoc(files: File[], folderId: ID | null): Promise<Doc> {
  const s = settingsStore.get();
  const size = pageSize(s.defaultPaper, s.defaultOrientation);
  const doc = await repo.createDoc({ title: files[0].name.replace(/\.[^.]+$/, ""), folderId, bg: templateBg("blank"), w: size.w, h: size.h, pages: files.length });
  const { pages } = await repo.loadPages(doc);
  const out: Page[] = [];
  for (let i = 0; i < files.length; i++) {
    const a = await repo.putAsset(files[i], doc.id, files[i].name);
    const dim = await imageSize(files[i]);
    const p = pages.get(doc.pageIds[i])!;
    const k = Math.min((p.w - 40) / dim.w, (p.h - 40) / dim.h, 1);
    const w = dim.w * k,
      h = dim.h * k;
    out.push({ ...p, items: [{ id: uid(), kind: "image", x: (p.w - w) / 2, y: (p.h - h) / 2, w, h, rot: 0, asset: a.id }] });
  }
  await repo.savePages(doc, out);
  return doc;
}

// ---------------------------------------------------------------------------
// .notefira files
// ---------------------------------------------------------------------------
export async function collectDocFile(docId: ID, embed = true): Promise<NotefiraFile> {
  const doc = await repo.getDoc(docId);
  if (!doc) throw new Error("Notebook not found");
  const { pages } = await repo.loadPages(doc);
  const assets = await repo.listDocAssets(docId);
  const recordings = await repo.listRecordings(docId);
  const records: AssetRecord[] = [];
  for (const a of assets) {
    const sha256 = await assetHash(a);
    const rec: AssetRecord = { id: a.id, mime: a.mime, size: a.blob.size, name: a.name, sha256 };
    if (embed) rec.data = embedBytes(new Uint8Array(await a.blob.arrayBuffer()));
    records.push(rec);
  }
  // which Google account a notebook is linked to, and its sync problems, stay on this device
  const { syncAccount: _a, syncIssue: _i, ...shareable } = doc;
  return buildFile(shareable, doc.pageIds.map((id) => pages.get(id)!).filter(Boolean), records, recordings);
}

/** SHA-256 of an attachment, computed once and remembered on its record. */
export async function assetHash(a: Asset): Promise<string> {
  if (a.sha256 && /^[0-9a-f]{64}$/.test(a.sha256)) return a.sha256;
  const sha256 = await sha256Hex(a.blob);
  await db.readWriteTx<Asset>(["assets"], { store: "assets", key: a.id }, (cur, w) => {
    if (!cur) return false;
    w.put("assets", { ...cur, sha256 });
  });
  a.sha256 = sha256;
  return sha256;
}

/** A self-contained file: every attachment's bytes are embedded and covered by the SHA-256. */
export async function exportNotefira(docId: ID): Promise<Uint8Array> {
  return encodeFile(await collectDocFile(docId, true));
}

/** Store a decoded notebook file locally. `keepIds` is used by sync/restore, otherwise fresh ids are generated. */
export async function storeNotefira(file: NotefiraFile, opts: StoreOptions & { expectRev?: undefined } = {}): Promise<Doc> {
  return (await storeNotefiraIf(file, opts))!;
}

export interface StoreOptions {
  keepIds?: boolean;
  folderId?: ID | null;
  /** Sync only: write nothing unless the stored notebook is still at this rev (`null`: unless no local copy exists). */
  expectRev?: number | null;
  /** Page keys to delete in the same transaction (pages the incoming version no longer has). */
  dropPages?: IDBValidKey[];
  /** Ask the browser to confirm the write reached disk before resolving. */
  strict?: boolean;
}

/** Like storeNotefira, but returns null (and writes nothing) when `expectRev` no longer matches. */
export async function storeNotefiraIf(file: NotefiraFile, opts: StoreOptions = {}): Promise<Doc | null> {
  const f = opts.keepIds ? file : remapIds(file);
  const doc: Doc = { ...f.doc, folderId: opts.folderId !== undefined ? opts.folderId : opts.keepIds ? f.doc.folderId : null };
  if (!opts.keepIds) {
    doc.created = Date.now();
    doc.updated = Date.now();
  }
  const assets: Asset[] = f.assets
    .filter((a) => a.data)
    .map((a) => ({ id: a.id, docId: doc.id, mime: a.mime, size: a.size, name: a.name, sha256: a.sha256, created: Date.now(), blob: new Blob([extractBytes(a.data!) as BlobPart], { type: a.mime }), remoteId: opts.keepIds ? a.remoteId : undefined }));
  const wrote = await db.readWriteTx<Doc>(["docs", "pages", "assets", "recordings"], { store: "docs", key: doc.id }, (cur, w) => {
    if (opts.expectRev !== undefined && (opts.expectRev === null ? !!cur : cur?.rev !== opts.expectRev)) return false;
    opts.dropPages?.forEach((k) => w.del("pages", k));
    w.put("docs", doc);
    f.pages.forEach((p) => w.put("pages", repo.sealPage({ ...p, docId: doc.id })));
    assets.forEach((a) => w.put("assets", a));
    f.recordings.forEach((r: Recording) => w.put("recordings", { ...r, docId: doc.id }));
  }, { strict: opts.strict });
  if (!wrote) return null;
  repo.emit("library");
  if (f.pages.some((p) => p.bg.type === "pdf")) indexPdfText(doc.id, f.pages).catch(() => {});
  return doc;
}

export async function importNotefiraBytes(bytes: Uint8Array, folderId: ID | null): Promise<{ doc: Doc; warnings: string[] }> {
  const report = await decodeFile(bytes);
  const warnings: string[] = [];
  if (report.droppedItems) warnings.push(`${report.droppedItems} damaged item(s) were skipped`);
  if (report.repairedPages) warnings.push(`${report.repairedPages} damaged page(s) were skipped`);
  if (report.damagedAttachments) warnings.push(`${report.damagedAttachments} damaged attachment(s) were skipped`);
  if (!report.checksumOk && !warnings.length) warnings.push("the file's integrity check did not match; its content was validated and imported");
  const missing = report.file.pages.some((p) => p.bg.type === "pdf" && !report.file.assets.some((a) => a.id === (p.bg as any).asset && a.data));
  if (missing) warnings.push("some PDF backgrounds were not included in the file");
  const doc = await storeNotefira(report.file, { folderId });
  return { doc, warnings };
}

// ---------------------------------------------------------------------------
// Full backups
// ---------------------------------------------------------------------------
export async function exportBackup(onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const docs = (await repo.listDocs()).filter((d) => !d.deletedAt);
  const out: NotefiraFile[] = [];
  for (let i = 0; i < docs.length; i++) {
    onProgress?.(i, docs.length);
    out.push(await collectDocFile(docs[i].id, true));
  }
  const backup: BackupFile = {
    format: "notefira-backup",
    version: 2,
    exported: Date.now(),
    docs: out,
    folders: (await repo.listFolders()).filter((f) => !f.deletedAt),
    decks: await repo.listDecks(),
    stickers: await repo.listStickers(),
  };
  onProgress?.(docs.length, docs.length);
  return encodeJson(backup);
}

export async function importBackup(bytes: Uint8Array): Promise<{ docs: number; replaced: number }> {
  const obj = await decodeJson(bytes);
  if (obj?.format !== "notefira-backup" || !Array.isArray(obj.docs)) throw new FormatError("This is not a Notefira backup file.");
  let docs = 0,
    replaced = 0;
  for (const f of obj.folders as Folder[]) if (f?.id && f.name) await db.put("folders", f);
  for (const raw of obj.docs) {
    try {
      const report = await validateFile(raw);
      const existing = await repo.getDoc(report.file.doc.id);
      if (existing) {
        await repo.snapshotDoc(existing.id, "Before restoring a backup");
        replaced++;
      }
      await storeNotefira(report.file, { keepIds: true });
      docs++;
    } catch (e) {
      console.warn("Skipped a damaged notebook in the backup", e);
    }
  }
  for (const d of (obj.decks ?? []) as Deck[]) if (d?.id) await db.put("decks", d);
  for (const s of (obj.stickers ?? []) as Sticker[]) if (s?.id) await db.put("stickers", s);
  repo.emit("library");
  repo.emit("decks");
  return { docs, replaced };
}

// ---------------------------------------------------------------------------
// Unified import entry point
// ---------------------------------------------------------------------------
export interface ImportResult {
  docs: Doc[];
  messages: string[];
}

export async function importFiles(files: File[], folderId: ID | null): Promise<ImportResult> {
  const res: ImportResult = { docs: [], messages: [] };
  const images = files.filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name));
  for (const f of files) {
    try {
      const lower = f.name.toLowerCase();
      if (f.type === "application/pdf" || lower.endsWith(".pdf")) res.docs.push(await importPdfFile(f, f.name, folderId));
      else if (lower.endsWith(".notefira")) {
        const { doc, warnings } = await importNotefiraBytes(new Uint8Array(await f.arrayBuffer()), folderId);
        res.docs.push(doc);
        if (warnings.length) res.messages.push(`${f.name}: ${warnings.join("; ")}`);
      } else if (lower.endsWith(".nfbackup")) {
        const r = await importBackup(new Uint8Array(await f.arrayBuffer()));
        res.messages.push(`Restored ${r.docs} notebook(s) from the backup${r.replaced ? ` (${r.replaced} replaced; previous versions kept in version history)` : ""}.`);
      } else if (!images.includes(f)) res.messages.push(`${f.name}: this file type is not supported.`);
    } catch (e: any) {
      res.messages.push(`${f.name}: ${e?.message ?? e}`);
    }
  }
  if (images.length) {
    try {
      res.docs.push(await importImagesAsDoc(images, folderId));
    } catch (e: any) {
      res.messages.push(`Images: ${e?.message ?? e}`);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Sample notebook (first-run content created locally, all editable)
// ---------------------------------------------------------------------------
export async function createSampleNotebook(): Promise<Doc> {
  const doc = await repo.createDoc({ title: "Welcome to Notefira", bg: templateBg("ruled"), pages: 3, cover: { type: "color", color: "#45bfdb", pattern: "wave" } });
  const { pages } = await repo.loadPages(doc);
  const [p1, p2, p3] = doc.pageIds.map((id) => pages.get(id)!);
  const t = (x: number, y: number, w: number, text: string, size = 16, extra: Partial<Extract<Item, { kind: "text" }>> = {}): Item => ({
    id: uid(),
    kind: "text",
    x,
    y,
    w,
    h: size * 1.6,
    rot: 0,
    text,
    font: "sans",
    size,
    color: "#130d0c",
    bold: false,
    italic: false,
    underline: false,
    align: "left",
    ...extra,
  });
  const wave: number[] = [];
  for (let i = 0; i <= 60; i++) wave.push(80 + i * 7, 250 + Math.sin(i / 5) * 14, 0.5 + 0.3 * Math.sin(i / 7));
  const out: Page[] = [
    {
      ...p1,
      items: [
        t(80, 90, 440, "Welcome to Notefira", 26, { bold: true, h: 40 }),
        t(80, 140, 440, "Write with a stylus, finger or mouse. Pick a pen, highlighter or eraser from the toolbar. Everything is saved automatically on this device.", 14, { h: 70, color: "#403b3b" }),
        { id: uid(), kind: "stroke", pen: "fountain", color: "#1d4fd8", width: 2.2, pts: wave, t0: Date.now(), t1: Date.now() },
        t(80, 300, 440, "Tip: draw a shape and keep the pen still for a moment — it snaps into a clean shape.", 14, { h: 50, bg: "#fff6c9" }),
      ],
    },
    {
      ...p2,
      bg: templateBg("cornell"),
      items: [t(30, 30, 520, "Cornell notes", 22, { bold: true, h: 36 }), t(30, 110, 150, "Cues and questions go here", 12, { color: "#757070", h: 40 }), t(200, 110, 360, "Notes go here", 12, { color: "#757070", h: 30 })],
    },
    { ...p3, bg: templateBg("grid"), items: [t(40, 40, 500, "Grid paper — great for diagrams and maths", 16, { h: 30 })] },
  ];
  await repo.savePages(doc, out);
  return doc;
}

export function guessName(title: string, ext: string) {
  return `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "Notebook"}.${ext}`;
}

export type { NotefiraFile };
