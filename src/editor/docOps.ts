import type { DocSession } from "./session";
import type { ViewportController } from "./viewport";
import type { Background, ID, Item, Page, TextEl } from "../model/types";
import { itemBounds, unionRect } from "../engine/geometry";
import { renderItemsToCanvas, renderPageToCanvasAsync, textHeight, canvasToBlob } from "../engine/render";
import { toast } from "../state/store";
import { uid } from "../model/util";
import { getPageText, savePageText, putAsset, saveSticker } from "../storage/repo";
import { pdfToPages } from "../services/transfer";
import { saveFile } from "../platform/native";

export async function recognizeSelection(vp: ViewportController, mode: "text" | "math"): Promise<string> {
  const items = vp.selectionItems().filter((i) => i.kind === "stroke");
  if (!items.length) throw new Error("Select some handwriting first.");
  const b = unionRect(items.map(itemBounds))!;
  const canvas = renderItemsToCanvas(items, b, Math.min(4, Math.max(2, 900 / Math.max(b.w, b.h))));
  if (mode === "math") throw new Error("Maths recognition is not available in the offline build.");
  toast("Using on-device OCR. No note content leaves this device.", "info", undefined, 4000);
  const { ocrCanvas } = await import("../ai/ocr");
  return (await ocrCanvas(canvas)).text;
}

export function textBoxFor(text: string, x: number, y: number, w: number, size = 16, color = "#130d0c"): TextEl {
  const t: TextEl = { id: uid(), kind: "text", x, y, w: Math.max(80, w), h: 30, rot: 0, text, font: "sans", size, color, bold: false, italic: false, underline: false, align: "left", t0: Date.now() };
  t.h = textHeight(t);
  return t;
}

export function replaceSelectionWithText(vp: ViewportController, session: DocSession, text: string) {
  const sel = vp.selection;
  if (!sel) return;
  const strokes = vp.selectionItems().filter((i) => i.kind === "stroke");
  const b = unionRect(strokes.map(itemBounds))!;
  const color = (strokes[0] as any)?.color ?? "#130d0c";
  const size = Math.max(10, Math.min(36, Math.round(b.h / Math.max(1, text.split("\n").length) / 1.5)));
  const t = textBoxFor(text, b.x, b.y, b.w + 20, size, color);
  const map = new Map<ID, Item[]>();
  strokes.forEach((s, i) => map.set(s.id, i === 0 ? [t] : []));
  session.replaceItems(sel.pageId, map, "Convert to text");
  vp.setSelection({ pageId: sel.pageId, ids: new Set([t.id]) });
}

export function insertTextBelowSelection(vp: ViewportController, session: DocSession, text: string, mono = false) {
  const sel = vp.selection;
  const b = vp.selectionBounds();
  if (!sel || !b) return;
  const t = textBoxFor(text, b.x, b.y + b.h + 8, Math.max(160, b.w), 14);
  if (mono) t.font = "mono";
  session.addItems(sel.pageId, [t], "Insert text");
}

/** Recognise all handwriting locally so it becomes searchable. */
export async function indexHandwriting(session: DocSession, onProgress?: (d: number, t: number) => void): Promise<number> {
  const pages = session.orderedPages().filter((p) => p.items.some((i) => i.kind === "stroke" && i.pen !== "highlighter"));
  let done = 0;
  for (const p of pages) {
    onProgress?.(done, pages.length);
    const ink = p.items.filter((i) => i.kind === "stroke" && i.pen !== "highlighter");
    const b = unionRect(ink.map(itemBounds))!;
    const c = renderItemsToCanvas(ink, b, Math.min(3, 1400 / Math.max(b.w, b.h)));
    const { ocrCanvas } = await import("../ai/ocr");
    const text = (await ocrCanvas(c)).text;
    c.width = c.height = 0;
    session.updatePage(p.id, { recognized: text }, "Recognise", false);
    done++;
  }
  onProgress?.(done, pages.length);
  await session.flush();
  return done;
}

/** OCR scanned PDF pages and image-only pages so their text becomes searchable. */
export async function ocrDocument(session: DocSession, onProgress?: (d: number, t: number) => void): Promise<number> {
  const { ocrCanvas } = await import("../ai/ocr");
  const candidates: Page[] = [];
  for (const p of session.orderedPages()) {
    const existing = await getPageText(p.id);
    const hasImages = p.items.some((i) => i.kind === "image");
    if ((p.bg.type === "pdf" && (!existing || existing.text.trim().length < 20)) || (hasImages && !existing)) candidates.push(p);
  }
  let n = 0;
  for (const p of candidates) {
    onProgress?.(n, candidates.length);
    const scale = 2.2;
    const c = await renderPageToCanvasAsync({ ...p, items: p.items.filter((i) => i.kind === "image") }, Math.round(p.w * scale), { showLinks: false });
    const r = await ocrCanvas(c, scale);
    c.width = c.height = 0;
    await savePageText({ pageId: p.id, docId: session.doc.id, source: "ocr", text: r.text, runs: r.runs });
    n++;
  }
  onProgress?.(n, candidates.length);
  return n;
}

export async function insertPdfPages(session: DocSession, file: File, index: number) {
  const pages = await pdfToPages(file, session.doc.id);
  const ids = session.doc.pageIds.slice();
  ids.splice(index, 0, ...pages.map((p) => p.id));
  session.setPageList(ids, pages, "Insert PDF");
  return pages.length;
}

export function addPageWithBg(session: DocSession, index: number, bg: Background, dim: { w: number; h: number }) {
  const p: Page = { id: uid(), docId: session.doc.id, w: dim.w, h: dim.h, bg, items: [], updated: Date.now() };
  session.insertPage(index, p);
  return p;
}

export async function saveSelectionAsSticker(vp: ViewportController, name: string) {
  const items = vp.selectionItems();
  const b = unionRect(items.map(itemBounds));
  if (!b) return;
  await saveSticker({ id: uid(), name, items, w: b.w, h: b.h, created: Date.now() });
}

export async function selectionImageAsset(vp: ViewportController, docId: ID): Promise<ID | null> {
  const items = vp.selectionItems();
  const b = unionRect(items.map(itemBounds));
  if (!b) return null;
  const blob = await canvasToBlob(renderItemsToCanvas(items, b, 2));
  return (await putAsset(blob, docId, "flashcard.png")).id;
}

export async function copySelectionAsImage(vp: ViewportController) {
  const items = vp.selectionItems();
  const b = unionRect(items.map(itemBounds));
  if (!b) return;
  const blob = await canvasToBlob(renderItemsToCanvas(items, b, 3, ""));
  const CI = (window as any).ClipboardItem;
  try {
    if (!CI || !navigator.clipboard?.write) throw new Error("no clipboard");
    await navigator.clipboard.write([new CI({ "image/png": blob })]);
    toast("Copied as image", "success");
  } catch {
    await saveFile("selection.png", blob, "image/png");
  }
}

export async function exportPageImage(page: Page, title: string) {
  const c = await renderPageToCanvasAsync(page, Math.round(page.w * 3), { showLinks: false });
  await saveFile(`${title.replace(/[\\/:*?"<>|]/g, "_")}.png`, await canvasToBlob(c), "image/png");
  c.width = c.height = 0;
}
