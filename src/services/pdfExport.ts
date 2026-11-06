// Export notebooks as PDF with vector handwriting, using pdf-lib. Imported PDF
// pages are embedded as vector form XObjects so the original text stays sharp
// and selectable; templates, strokes, shapes and text are drawn as vectors.
import type { Doc, ImageEl, Page, Stroke, TextEl, LinkEl, ID } from "../model/types";
import { templateShapes } from "../model/templates";
import { outlineToSvgPath, polylineSvgPath, smoothPolyline, strokeInput, strokeOutline } from "../engine/strokes";
import { getAsset } from "../storage/repo";
import { layoutText, renderItemsToCanvas, canvasToBlob, dashPattern, dashedLineWidth } from "../engine/render";
import { itemBounds, strokeBounds } from "../engine/geometry";
import { getImage } from "../engine/render";

type PdfLib = typeof import("pdf-lib");

function hexToRgb(lib: PdfLib, hex: string) {
  const m = /^#?([0-9a-f]{6})/i.exec(hex || "#000000");
  const n = m ? parseInt(m[1], 16) : 0;
  return lib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export interface PdfExportOptions {
  pageIds?: ID[];
  includeAnnotations?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export async function exportDocToPdf(doc: Doc, pages: Map<ID, Page>, opts: PdfExportOptions = {}): Promise<Uint8Array> {
  const lib = await import("pdf-lib");
  const { PDFDocument, StandardFonts, degrees, LineCapStyle, PDFName, PDFString } = lib;
  const out = await PDFDocument.create();
  out.setTitle(doc.title);
  out.setCreator("Notefira");
  out.setProducer("Notefira (pdf-lib)");
  const fonts = {
    sans: [await out.embedFont(StandardFonts.Helvetica), await out.embedFont(StandardFonts.HelveticaBold), await out.embedFont(StandardFonts.HelveticaOblique), await out.embedFont(StandardFonts.HelveticaBoldOblique)],
    serif: [await out.embedFont(StandardFonts.TimesRoman), await out.embedFont(StandardFonts.TimesRomanBold), await out.embedFont(StandardFonts.TimesRomanItalic), await out.embedFont(StandardFonts.TimesRomanBoldItalic)],
    mono: [await out.embedFont(StandardFonts.Courier), await out.embedFont(StandardFonts.CourierBold), await out.embedFont(StandardFonts.CourierOblique), await out.embedFont(StandardFonts.CourierBoldOblique)],
  };
  const srcDocs = new Map<ID, Awaited<ReturnType<typeof PDFDocument.load>>>();
  const ids = opts.pageIds ?? doc.pageIds;
  const pageRefs = new Map<ID, any>();
  const pendingLinks: { page: any; rect: number[]; el: LinkEl | TextEl }[] = [];
  const annotations = opts.includeAnnotations !== false;

  for (let i = 0; i < ids.length; i++) {
    opts.onProgress?.(i, ids.length);
    const p = pages.get(ids[i]);
    if (!p) continue;
    const { w, h } = p;
    const page = out.addPage([w, h]);
    pageRefs.set(p.id, page.ref);
    const Y = (y: number) => h - y;

    // ---- background
    if (p.bg.type === "pdf") {
      let src = srcDocs.get(p.bg.asset);
      if (!src) {
        const a = await getAsset(p.bg.asset);
        if (!a) throw new Error("A PDF background is missing from this notebook.");
        src = await PDFDocument.load(new Uint8Array(await a.blob.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
        srcDocs.set(p.bg.asset, src);
      }
      const sp = src.getPage(p.bg.page);
      const crop = sp.getCropBox();
      const emb = await out.embedPage(sp, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height });
      const W0 = emb.width,
        H0 = emb.height;
      const rot = ((p.bg.rot % 360) + 360) % 360;
      const pos = rot === 90 ? { x: 0, y: W0 } : rot === 180 ? { x: W0, y: H0 } : rot === 270 ? { x: H0, y: 0 } : { x: 0, y: 0 };
      page.drawPage(emb, { x: pos.x, y: pos.y, rotate: degrees(-rot) });
    } else {
      page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: hexToRgb(lib, p.bg.paper || "#ffffff") });
      if (p.bg.template === "custom" && p.bg.asset) {
        const a = await getAsset(p.bg.asset);
        if (a) {
          const img = await embedImageBlob(out, a.blob);
          if (img) page.drawImage(img, { x: 0, y: 0, width: w, height: h });
        }
      } else {
        const shapes = templateShapes(p.bg, w, h);
        for (const [x1, y1, x2, y2, color, lw] of shapes.lines) page.drawLine({ start: { x: x1, y: Y(y1) }, end: { x: x2, y: Y(y2) }, thickness: lw, color: hexToRgb(lib, color) });
        for (const [x, y, r, color] of shapes.dots) page.drawCircle({ x, y: Y(y), size: r, color: hexToRgb(lib, color) });
      }
    }
    if (!annotations) continue;
    // Round joins for every stroke on this page (PDF defaults to sharp miter joins, which
    // put spikes on tight turns in handwriting). drawSvgPath's own q/Q blocks inherit this.
    page.pushOperators(lib.setLineJoin(lib.LineJoinStyle.Round));

    // ---- items
    let pencilRun: Stroke[] = [];
    for (let idx = 0; idx <= p.items.length; idx++) {
      const it = p.items[idx];
      // Graphite pencil strokes are raster-textured; consecutive ones are embedded as one
      // transparent image so the grain survives and stacking order is preserved.
      if (it && it.kind === "stroke" && it.pen === "pencil") {
        pencilRun.push(it);
        continue;
      }
      if (pencilRun.length) {
        await drawPencilRun(out, page, pencilRun, h);
        pencilRun = [];
      }
      if (!it) break;
      if (it.kind === "stroke") drawStroke(lib, page, it, w, h, LineCapStyle);
      else if (it.kind === "text") await drawText(lib, out, page, it, h, fonts);
      else if (it.kind === "image") await drawImage(out, page, it, h, degrees);
      if (it.kind === "link" || (it.kind === "text" && it.link)) {
        const b = itemBounds(it);
        pendingLinks.push({ page, rect: [b.x, h - b.y - b.h, b.x + b.w, h - b.y], el: it as LinkEl | TextEl });
      }
    }
  }

  // ---- links (second pass so internal page links can reference any page)
  for (const l of pendingLinks) {
    const url = l.el.kind === "text" ? l.el.link : l.el.url;
    const pageId = l.el.kind === "link" ? l.el.pageId : undefined;
    let action: any = null;
    // Only web and e-mail links are written into exported PDFs (same rule as opening links in the app).
    if (url && /^(https?:|mailto:)/i.test(url)) action = out.context.obj({ Type: "Action", S: "URI", URI: PDFString.of(url) });
    else if (pageId && pageRefs.get(pageId)) action = out.context.obj({ Type: "Action", S: "GoTo", D: [pageRefs.get(pageId), PDFName.of("Fit")] });
    if (!action) continue;
    const annot = out.context.register(out.context.obj({ Type: "Annot", Subtype: "Link", Rect: l.rect, Border: [0, 0, 0], A: action }));
    l.page.node.addAnnot(annot);
  }

  // ---- outline (bookmarks panel in PDF readers) from the document outline
  if (doc.outline.length) addOutline(lib, out, doc, pageRefs);

  opts.onProgress?.(ids.length, ids.length);
  return out.save();
}

const PENCIL_PDF_SCALE = 3; // ≈216 dpi
async function drawPencilRun(out: any, page: any, run: Stroke[], h: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of run) {
    const b = strokeBounds(s);
    const r = s.width * 1.5;
    x0 = Math.min(x0, b.x - r);
    y0 = Math.min(y0, b.y - r);
    x1 = Math.max(x1, b.x + b.w + r);
    y1 = Math.max(y1, b.y + b.h + r);
  }
  if (!isFinite(x0)) return;
  const bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const scale = Math.min(PENCIL_PDF_SCALE, 4096 / Math.max(1, bounds.w + 12, bounds.h + 12));
  const c = renderItemsToCanvas(run, bounds, scale, "");
  const img = await embedImageBlob(out, await canvasToBlob(c, "image/png"));
  if (!img) return;
  const pad = 6; // renderItemsToCanvas pads each side
  page.drawImage(img, { x: x0 - pad, y: h - (y1 + pad), width: bounds.w + pad * 2, height: bounds.h + pad * 2 });
}

function drawStroke(lib: PdfLib, page: any, s: Stroke, w: number, h: number, LineCapStyle: any) {
  const color = hexToRgb(lib, s.color);
  // Canvas strokes can extend half their width beyond the page edge. PDF pages
  // hard-clip there, so nudge only genuinely overflowing strokes back inside.
  const b = strokeBounds(s);
  const dx = b.w <= w ? (b.x < 0 ? -b.x : b.x + b.w > w ? w - b.x - b.w : 0) : 0;
  const dy = b.h <= h ? (b.y < 0 ? -b.y : b.y + b.h > h ? h - b.y - b.h : 0) : 0;
  if (s.pen === "highlighter" || s.shape) {
    const pts = s.shape ? s.pts : smoothPolyline(s.pts);
    const d = polylineSvgPath(pts.length === 3 ? [...pts, pts[0] + 0.01, pts[1], pts[2]] : pts, s.closed);
    if (!d) return;
    const hl = s.pen === "highlighter";
    if (s.fill && s.closed) page.drawSvgPath(d, { x: dx, y: h - dy, color: hexToRgb(lib, s.fill) });
    const dashed = !hl && s.dash ? { borderDashArray: dashPattern(s.dash, s.width) } : {};
    page.drawSvgPath(d, {
      x: dx,
      y: h - dy,
      borderColor: color,
      borderWidth: s.width,
      borderOpacity: hl ? (s.opacity ?? 0.38) : 1,
      borderLineCap: hl && s.shape ? LineCapStyle.Butt : LineCapStyle.Round,
      ...dashed,
    });
    return;
  }
  if (s.dash) {
    // dashed / dotted pens: an even centre line, exactly like the canvas renderer
    const lw = dashedLineWidth(s);
    const d = smoothCenterSvgPath(strokeInput(s.pts, s.width, false).flat());
    if (d) page.drawSvgPath(d, { x: dx, y: h - dy, borderColor: color, borderWidth: lw, borderLineCap: LineCapStyle.Round, borderDashArray: dashPattern(s.dash, lw) });
    return;
  }
  // Solid pens: fill the exact pressure-sensitive outline the app draws on screen (same
  // smoothing, curve filling and tapers), so exported handwriting matches the notebook.
  // Filled with the non-zero winding rule, the same rule the canvas uses.
  const d = outlineToSvgPath(strokeOutline(s));
  if (d) page.drawSvgPath(d, { x: dx, y: h - dy, color });
}

/**
 * Centre line as quadratic curves through segment midpoints (instead of straight
 * segments), so handwriting stays smooth when the PDF is zoomed in.
 */
function smoothCenterSvgPath(raw: number[]): string {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < raw.length; i += 3) {
    const k = xs.length - 1;
    if (k >= 0 && Math.abs(raw[i] - xs[k]) + Math.abs(raw[i + 1] - ys[k]) < 0.15) continue;
    xs.push(raw[i]);
    ys.push(raw[i + 1]);
  }
  const n = xs.length;
  const f = (v: number) => v.toFixed(2);
  if (!n) return "";
  if (n === 1) return `M${f(xs[0])},${f(ys[0])} L${f(xs[0] + 0.01)},${f(ys[0])}`;
  let d = `M${f(xs[0])},${f(ys[0])}`;
  if (n === 2) return d + ` L${f(xs[1])},${f(ys[1])}`;
  d += ` L${f((xs[0] + xs[1]) / 2)},${f((ys[0] + ys[1]) / 2)}`;
  for (let i = 1; i < n - 1; i++) d += ` Q${f(xs[i])},${f(ys[i])} ${f((xs[i] + xs[i + 1]) / 2)},${f((ys[i] + ys[i + 1]) / 2)}`;
  return d + ` L${f(xs[n - 1])},${f(ys[n - 1])}`;
}


async function drawText(lib: PdfLib, out: any, page: any, t: TextEl, h: number, fonts: Record<string, any[]>) {
  const set = fonts[t.font === "serif" ? "serif" : t.font === "mono" ? "mono" : "sans"];
  const font = set[(t.bold ? 1 : 0) + (t.italic ? 2 : 0)];
  const lines = layoutText(t);
  try {
    if (t.rot) throw new Error("rotated");
    if (t.bg) page.drawRectangle({ x: t.x, y: h - t.y - t.h, width: t.w, height: t.h, color: hexToRgb(lib, t.bg) });
    const lh = t.size * 1.3;
    lines.forEach((line, i) => {
      const lw = font.widthOfTextAtSize(line, t.size);
      let x = t.x + 4;
      if (t.align === "center") x = t.x + (t.w - lw) / 2;
      else if (t.align === "right") x = t.x + t.w - 4 - lw;
      const y = h - (t.y + 4 + t.size + i * lh);
      const color = hexToRgb(lib, t.link ? "#1a73c8" : t.color);
      page.drawText(line, { x, y, size: t.size, font, color });
      if (t.underline || t.link) page.drawLine({ start: { x, y: y - t.size * 0.12 }, end: { x: x + lw, y: y - t.size * 0.12 }, thickness: Math.max(0.5, t.size * 0.06), color });
    });
  } catch {
    // Characters outside the standard PDF fonts (or rotated text): embed a high-resolution image of the text box instead.
    const b = itemBounds(t);
    const c = renderItemsToCanvas([t], b, 4, "");
    const png = await out.embedPng(new Uint8Array(await (await canvasToBlob(c)).arrayBuffer()));
    page.drawImage(png, { x: b.x - 6, y: h - (b.y - 6) - (b.h + 12), width: b.w + 12, height: b.h + 12 });
  }
}

async function embedImageBlob(out: any, blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    if (blob.type === "image/png") return await out.embedPng(bytes);
    if (blob.type === "image/jpeg") return await out.embedJpg(bytes);
  } catch {
    /* fall back to re-encoding */
  }
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return out.embedPng(new Uint8Array(await (await canvasToBlob(c)).arrayBuffer()));
}

async function drawImage(out: any, page: any, im: ImageEl, h: number, degrees: any) {
  const a = await getAsset(im.asset);
  if (!a) return;
  if (!im.crop && !im.rot) {
    const img = await embedImageBlob(out, a.blob);
    page.drawImage(img, { x: im.x, y: h - im.y - im.h, width: im.w, height: im.h });
    return;
  }
  // cropped / rotated: rasterise the element at its native resolution
  getImage(im.asset);
  await new Promise((r) => setTimeout(r, 60));
  const b = itemBounds(im);
  const src = await createImageBitmap(a.blob);
  const scale = Math.min(4, Math.max(1, src.width / Math.max(1, im.w)));
  src.close();
  const c = renderItemsToCanvas([im], b, scale, "");
  const png = await out.embedPng(new Uint8Array(await (await canvasToBlob(c)).arrayBuffer()));
  void degrees;
  page.drawImage(png, { x: b.x - 6, y: h - (b.y - 6) - (b.h + 12), width: b.w + 12, height: b.h + 12 });
}

function addOutline(lib: PdfLib, out: any, doc: Doc, pageRefs: Map<ID, any>) {
  const { PDFName, PDFString } = lib;
  const entries = doc.outline.filter((o) => pageRefs.has(o.pageId));
  if (!entries.length) return;
  const ctx = out.context;
  const outlineRef = ctx.nextRef();
  const refs = entries.map(() => ctx.nextRef());
  entries.forEach((o, i) => {
    const dict: Record<string, any> = {
      Title: PDFString.of(o.title),
      Parent: outlineRef,
      Dest: [pageRefs.get(o.pageId), PDFName.of("Fit")],
    };
    if (i > 0) dict.Prev = refs[i - 1];
    if (i < refs.length - 1) dict.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(dict));
  });
  ctx.assign(outlineRef, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
  out.catalog.set(PDFName.of("Outlines"), outlineRef);
}
