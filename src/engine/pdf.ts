// PDF rendering and text extraction via Mozilla's pdf.js (lazy loaded).
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getAsset, savePageText, type TextRun } from "../storage/repo";
import type { ID } from "../model/types";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import("pdfjs-dist");
      const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      lib.GlobalWorkerOptions.workerSrc = worker;
      return lib;
    })();
  }
  return pdfjsPromise;
}

// --------------------------------------------------------------------------
// Document cache (LRU of open PDFs)
// --------------------------------------------------------------------------
const docs = new Map<ID, Promise<PDFDocumentProxy>>();
const MAX_DOCS = 4;

export async function openPdfBytes(data: Uint8Array): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  return lib.getDocument({ data, isEvalSupported: false, disableAutoFetch: true }).promise;
}

export function loadPdf(assetId: ID): Promise<PDFDocumentProxy> {
  const hit = docs.get(assetId);
  if (hit) {
    docs.delete(assetId);
    docs.set(assetId, hit);
    return hit;
  }
  const p = (async () => {
    const a = await getAsset(assetId);
    if (!a) throw new Error("The PDF for this page is missing.");
    const bytes = new Uint8Array(await a.blob.arrayBuffer());
    return openPdfBytes(bytes);
  })();
  docs.set(assetId, p);
  p.catch(() => docs.delete(assetId));
  while (docs.size > MAX_DOCS) {
    const first = docs.keys().next().value as ID;
    const old = docs.get(first);
    docs.delete(first);
    old?.then((d) => d.destroy()).catch(() => {});
  }
  return p;
}

// --------------------------------------------------------------------------
// Bitmap cache with a memory budget
// --------------------------------------------------------------------------
type Bmp = HTMLCanvasElement | ImageBitmap;
interface Entry {
  bmp: Bmp;
  bytes: number;
}
const bitmaps = new Map<string, Entry>();
const pending = new Map<string, Promise<Bmp | null>>();
let used = 0;
const BUDGET = 180 * 1024 * 1024;

const BUCKETS = [0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5];
export function scaleBucket(scale: number, w: number, h: number) {
  const maxPixels = 16_000_000;
  let b = BUCKETS.find((x) => x >= scale) ?? BUCKETS[BUCKETS.length - 1];
  while (w * h * b * b > maxPixels && b > BUCKETS[0]) b = BUCKETS[Math.max(0, BUCKETS.indexOf(b) - 1)];
  return b;
}

function touch(key: string) {
  const e = bitmaps.get(key);
  if (e) {
    bitmaps.delete(key);
    bitmaps.set(key, e);
  }
  return e?.bmp;
}

function store(key: string, bmp: Bmp, bytes: number) {
  bitmaps.set(key, { bmp, bytes });
  used += bytes;
  while (used > BUDGET && bitmaps.size > 1) {
    const k = bitmaps.keys().next().value as string;
    const e = bitmaps.get(k)!;
    bitmaps.delete(k);
    used -= e.bytes;
    if ("close" in e.bmp) (e.bmp as ImageBitmap).close();
  }
}

/** Best cached bitmap for a page (any resolution) — used while a sharper one renders. */
export function cachedPdfBitmap(assetId: ID, page: number, rot: number, scale: number): Bmp | null {
  let best: Bmp | null = null;
  let bestDiff = Infinity;
  for (const b of BUCKETS) {
    const e = bitmaps.get(`${assetId}:${page}:${rot}:${b}`);
    if (e) {
      const diff = b >= scale ? b - scale : (scale - b) * 4;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = e.bmp;
      }
    }
  }
  return best;
}

export function renderPdfBitmap(assetId: ID, page: number, rot: number, w: number, h: number, scale: number): Promise<Bmp | null> {
  const b = scaleBucket(scale, w, h);
  const key = `${assetId}:${page}:${rot}:${b}`;
  const hit = touch(key);
  if (hit) return Promise.resolve(hit);
  const p0 = pending.get(key);
  if (p0) return p0;
  const p = (async () => {
    try {
      const pdf = await loadPdf(assetId);
      const pg = await pdf.getPage(page + 1);
      const vp = pg.getViewport({ scale: b, rotation: rot });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx = canvas.getContext("2d", { alpha: false })!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      let bmp: Bmp = canvas;
      if (typeof createImageBitmap === "function") {
        try {
          bmp = await createImageBitmap(canvas);
          canvas.width = canvas.height = 0;
        } catch {
          bmp = canvas;
        }
      }
      store(key, bmp, (bmp.width * bmp.height * 4) | 0);
      return bmp;
    } catch (e) {
      console.warn("PDF render failed", e);
      return null;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

// --------------------------------------------------------------------------
// Import helpers
// --------------------------------------------------------------------------
export interface PdfPageInfo {
  w: number;
  h: number;
  rot: number;
}

export async function pdfPageInfos(pdf: PDFDocumentProxy): Promise<PdfPageInfo[]> {
  const out: PdfPageInfo[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    out.push({ w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100, rot: pg.rotate || 0 });
  }
  return out;
}

/** Extract positioned text for search & highlighting (page coordinates, top-left origin). */
export async function extractPdfText(pdf: PDFDocumentProxy, pageIndex: number, rot: number): Promise<{ text: string; runs: TextRun[] }> {
  const lib = await pdfjs();
  const pg = await pdf.getPage(pageIndex + 1);
  const vp = pg.getViewport({ scale: 1, rotation: rot });
  const tc = await pg.getTextContent();
  const runs: TextRun[] = [];
  const parts: string[] = [];
  for (const it of tc.items as any[]) {
    if (typeof it.str !== "string" || !it.str.trim()) {
      if (it.hasEOL) parts.push("\n");
      continue;
    }
    const tx = lib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]) || 10;
    const w = it.width * (vp.scale || 1);
    runs.push({ s: it.str, x: tx[4], y: tx[5] - fh, w: Math.max(w, 2), h: fh * 1.15 });
    parts.push(it.str + (it.hasEOL ? "\n" : " "));
  }
  return { text: parts.join("").replace(/[ \t]+/g, " "), runs };
}

/** Background job: index the text layer of every PDF page of a document. */
export async function indexPdfText(docId: ID, pages: { id: ID; bg: { type: string; asset?: ID; page?: number; rot?: number } }[]) {
  for (const p of pages) {
    if (p.bg.type !== "pdf" || !p.bg.asset) continue;
    try {
      const pdf = await loadPdf(p.bg.asset);
      const { text, runs } = await extractPdfText(pdf, p.bg.page ?? 0, p.bg.rot ?? 0);
      await savePageText({ pageId: p.id, docId, source: "pdf", text, runs });
    } catch (e) {
      console.warn("Text extraction failed", e);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}
