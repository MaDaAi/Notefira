// Canvas renderer for pages: paper/template/PDF background plus vector items.
import type { ImageEl, Item, Page, Stroke, TextEl, LinkEl, ID } from "../model/types";
import { templateShapes } from "../model/templates";
import { strokeOutline, strokeCenterline, strokeInput, outlineToSvgPath, isPolylineStroke, smoothPolyline, inkLinePoints, isInkLineStroke, inkLineWidth } from "./strokes";
import { cachedPdfBitmap, renderPdfBitmap } from "./pdf";
import { getAsset } from "../storage/repo";
import type { TextRun } from "../storage/repo";

// ---------------------------------------------------------------------------
// Image cache
// ---------------------------------------------------------------------------
const images = new Map<ID, ImageBitmap | HTMLImageElement | "loading" | "error">();
const imageListeners = new Set<() => void>();
export function onImageLoaded(fn: () => void) {
  imageListeners.add(fn);
  return () => void imageListeners.delete(fn);
}
export function getImage(id: ID): ImageBitmap | HTMLImageElement | null {
  const v = images.get(id);
  if (v && v !== "loading" && v !== "error") return v;
  if (!v) {
    images.set(id, "loading");
    (async () => {
      try {
        const a = await getAsset(id);
        if (!a) throw new Error("missing");
        let bmp: ImageBitmap | HTMLImageElement;
        try {
          bmp = await createImageBitmap(a.blob);
        } catch {
          bmp = await new Promise<HTMLImageElement>((res, rej) => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = rej;
            img.src = URL.createObjectURL(a.blob);
          });
        }
        images.set(id, bmp);
      } catch {
        images.set(id, "error");
      }
      imageListeners.forEach((f) => f());
    })();
  }
  return null;
}

/** Notify the renderer that PDF bitmaps finished loading. */
const pdfListeners = new Set<() => void>();
export function onPdfLoaded(fn: () => void) {
  pdfListeners.add(fn);
  return () => void pdfListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const pathCache = new WeakMap<Stroke, Path2D>();

export function strokePath(s: Stroke, usePressure = true): Path2D {
  let p = pathCache.get(s);
  if (p) return p;
  if (isInkLineStroke(s)) {
    p = inkLinePath(inkLinePoints(s.pts, s.width, s.stabilization ?? 0.45));
  } else if (isPolylineStroke(s)) {
    p = new Path2D();
    const pts = s.shape ? s.pts : smoothPolyline(s.pts);
    p.moveTo(pts[0], pts[1]);
    if (pts.length === 3) p.lineTo(pts[0] + 0.01, pts[1]);
    for (let i = 3; i < pts.length; i += 3) p.lineTo(pts[i], pts[i + 1]);
    if (s.closed) p.closePath();
  } else {
    p = new Path2D(outlineToSvgPath(strokeOutline(s, usePressure)));
  }
  pathCache.set(s, p);
  return p;
}

// ---------------------------------------------------------------------------
// Graphite pencil
// ---------------------------------------------------------------------------
// A pencil stroke keeps its perfect-freehand outline (hit-testing, erasing and lasso
// are unchanged), but it is NOT painted as a filled shape. Graphite is laid down as
// stacked layers of fine particles. Each layer is filled with a coverage pattern whose
// alpha is exactly zero between particles, so the real paper (whatever its colour)
// shows through the gaps. No white pixels are drawn and nothing is erased from the
// canvas, so there are no halos on cream, coloured or dark paper.
//
// Pressure controls how many independent particle layers are deposited along the
// stroke's centre line: a light touch leaves a sparse, broken mark; pressing harder
// closes the gaps and darkens it. The core is denser than the edges, which breaks up
// the outline the way a pencil tip does.
//
// Particles are sized in DEVICE pixels: the pattern scale snaps to a power of two of
// the current zoom, so the grain stays fine and crisp at 100%-600% instead of being
// magnified into blur, while remaining anchored to the page (no swimming while panning).
// Each layer uses a tile of a different size, so the combined texture does not visibly repeat.

const GRAIN_SIZES = [256, 251, 241, 239, 233, 229, 227]; // one tile per layer
const PRESSURE_LAYERS = GRAIN_SIZES.length - 1; // layers above the base deposit
const GRAIN_DEVICE_PX = 1.1; // target size of one grain cell on screen
const BASE_ALPHA = 0.9;
const LAYER_ALPHA = 0.6;
const CORE_WIDTH = 0.82; // pressure layers cover this fraction of the outline width

/** Deterministic, tileable particle coverage for one layer (alpha 0..255). */
function particleMask(n: number, seed: number, coverage: number): Uint8ClampedArray {
  let st = seed | 0;
  const rnd = () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const u = new Float32Array(n * n); // particle placement
  const w = new Float32Array(n * n); // particle darkness
  const c = new Float32Array(n * n); // paper-tooth density source
  for (let i = 0; i < u.length; i++) (u[i] = rnd()), (w[i] = rnd()), (c[i] = rnd());
  const out = new Uint8ClampedArray(n * n);
  const sd = Math.sqrt(1 / 12 / 25);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      // density varies over a few grain cells (5x5 wrapped box blur, so the tile is seamless)
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += c[((y + dy + n) % n) * n + ((x + dx + n) % n)];
      const z = (s / 25 - 0.5) / sd;
      const cov = Math.max(0.05, Math.min(0.95, coverage + 0.13 * z));
      const i = y * n + x;
      // soft-edged particle: denser well inside the threshold, fading over 0.14; graphite is grey, not black
      const edge = Math.max(0, Math.min(1, (cov - u[i]) / 0.14));
      out[i] = Math.round(edge * (0.42 + 0.5 * w[i]) * 255);
    }
  return out;
}

const masks: Uint8ClampedArray[] = [];
function layerMask(k: number) {
  return (masks[k] ??= particleMask(GRAIN_SIZES[k], 0x9e37 + k * 7919, k === 0 ? 0.66 : 0.52));
}

const grainTiles = new Map<string, HTMLCanvasElement>();
function grainTile(color: string, k: number): HTMLCanvasElement {
  const key = k + color;
  let c = grainTiles.get(key);
  if (c) return c;
  const n = GRAIN_SIZES[k];
  c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  const img = g.createImageData(n, n);
  const m = layerMask(k);
  for (let i = 0; i < m.length; i++) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gr;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = m[i];
  }
  g.putImageData(img, 0, 0);
  if (grainTiles.size > 16 * GRAIN_SIZES.length) grainTiles.clear();
  grainTiles.set(key, c);
  return c;
}

const grainPatterns = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern>>();
/** Particle pattern for layer k, scaled so one grain cell is about GRAIN_DEVICE_PX on this canvas. */
function graphite(ctx: CanvasRenderingContext2D, color: string, k: number): CanvasPattern | null {
  let m = grainPatterns.get(ctx);
  if (!m) grainPatterns.set(ctx, (m = new Map()));
  const key = k + color;
  let p = m.get(key);
  if (!p) {
    const made = ctx.createPattern(grainTile(color, k), "repeat");
    if (!made) return null;
    p = made;
    if (m.size > 16 * GRAIN_SIZES.length) m.clear();
    m.set(key, p);
  }
  const t = ctx.getTransform();
  const deviceScale = Math.hypot(t.a, t.b) || 1; // device pixels per page unit
  const q = Math.pow(2, Math.round(Math.log2(GRAIN_DEVICE_PX / deviceScale))); // page units per grain cell
  p.setTransform?.(new DOMMatrix([q, 0, 0, q, 0, 0]));
  return p;
}

/**
 * Pressure layers along a centre line (x, y, pressure triplets). Layer k (1-based)
 * covers every segment whose smoothed pressure maps to level >= k.
 */
export function pencilToneLayers(center: number[]): Path2D[] {
  const xs: number[] = [], ys: number[] = [], ps: number[] = [];
  for (let i = 0; i < center.length; i += 3) {
    const x = center[i], y = center[i + 1];
    const k = xs.length - 1;
    if (k >= 0 && Math.abs(x - xs[k]) + Math.abs(y - ys[k]) < 0.2) continue;
    xs.push(x);
    ys.push(y);
    ps.push(center[i + 2] ?? 0.5);
  }
  const n = xs.length;
  const layers: Path2D[] = [];
  if (n < 2) return layers;
  const sm = ps.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) (s += ps[j]), c++;
    return s / c;
  });
  const level = (p: number) => Math.round(Math.max(0, Math.min(1, (p - 0.1) / 0.75)) * PRESSURE_LAYERS);
  const seg = new Int8Array(n - 1);
  for (let i = 0; i < n - 1; i++) seg[i] = level((sm[i] + sm[i + 1]) / 2);
  for (let k = 1; k <= PRESSURE_LAYERS; k++) {
    const p = new Path2D();
    let open = false, any = false;
    for (let i = 0; i < n - 1; i++) {
      if (seg[i] >= k) {
        if (!open) p.moveTo(xs[i], ys[i]);
        p.lineTo(xs[i + 1], ys[i + 1]);
        open = any = true;
      } else open = false;
    }
    if (!any) break;
    layers.push(p);
  }
  return layers;
}

/** Paint a freehand pencil stroke: a broken base deposit over the outline, then pressure layers in the core. */
export function paintPencil(ctx: CanvasRenderingContext2D, outline: Path2D, layers: Path2D[], color: string, width: number, alpha = 1) {
  ctx.save();
  ctx.imageSmoothingEnabled = false; // crisp particles, no muddy blur
  ctx.fillStyle = graphite(ctx, color, 0) ?? color;
  ctx.globalAlpha = BASE_ALPHA * alpha;
  ctx.fill(outline);
  if (layers.length) {
    ctx.clip(outline);
    ctx.lineWidth = width * 1.35 * CORE_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = LAYER_ALPHA * alpha;
    layers.forEach((l, i) => {
      ctx.strokeStyle = graphite(ctx, color, i + 1) ?? color;
      ctx.stroke(l);
    });
  }
  ctx.restore();
}

/** Pencil straight lines and Draw-and-Hold shapes: the same particle deposit along a stroked centre line (medium pressure). */
export function strokePencilLine(ctx: CanvasRenderingContext2D, path: Path2D, color: string, width: number, alpha = 1) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = graphite(ctx, color, 0) ?? color;
  ctx.globalAlpha = BASE_ALPHA * alpha;
  ctx.stroke(path);
  ctx.lineWidth = width * CORE_WIDTH;
  ctx.globalAlpha = LAYER_ALPHA * alpha;
  for (let k = 1; k <= Math.ceil(PRESSURE_LAYERS / 2); k++) {
    ctx.strokeStyle = graphite(ctx, color, k) ?? color;
    ctx.stroke(path);
  }
  ctx.restore();
}

const pencilLayerCache = new WeakMap<Stroke, { usePressure: boolean; layers: Path2D[] }>();
function cachedPencilLayers(s: Stroke, usePressure: boolean) {
  const c = pencilLayerCache.get(s);
  if (c && c.usePressure === usePressure) return c.layers;
  const layers = pencilToneLayers(strokeCenterline(s.pen, s.width, s.pts, usePressure, s.stabilization ?? 0.45, true));
  pencilLayerCache.set(s, { usePressure, layers });
  return layers;
}

/** Path through ball pen ink points (flat x, y, pressure triplets). */
export function inkLinePath(flat: number[]): Path2D {
  const p = new Path2D();
  if (!flat.length) return p;
  p.moveTo(flat[0], flat[1]);
  if (flat.length === 3) p.lineTo(flat[0] + 0.01, flat[1]);
  for (let i = 3; i < flat.length; i += 3) p.lineTo(flat[i], flat[i + 1]);
  return p;
}

/** Draw a ball pen ink line (shared by live drawing and saved strokes so they match). */
export function drawInkLine(ctx: CanvasRenderingContext2D, path: Path2D, color: string, width: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = inkLineWidth(width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();
}

export const FONT_FAMILIES: Record<TextEl["font"], string> = {
  sans: "Figtree, 'Segoe UI', system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, Menlo, Consolas, monospace",
  hand: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive",
};

export function textFont(t: TextEl) {
  return `${t.italic ? "italic " : ""}${t.bold ? "700 " : "400 "}${t.size}px ${FONT_FAMILIES[t.font] ?? FONT_FAMILIES.sans}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx() {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d")!;
  return measureCtx;
}

export function layoutText(t: Pick<TextEl, "text" | "w" | "size" | "font" | "bold" | "italic">): string[] {
  const ctx = mctx();
  ctx.font = textFont(t as TextEl);
  const lines: string[] = [];
  for (const para of t.text.split("\n")) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const test = line + w;
      if (ctx.measureText(test).width > t.w - 8 && line.trim()) {
        lines.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

export function textHeight(t: Pick<TextEl, "text" | "w" | "size" | "font" | "bold" | "italic">) {
  return Math.max(t.size * 1.6, layoutText(t).length * t.size * 1.3 + 8);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
export interface RenderOptions {
  /** device pixels per page point — used to pick PDF raster resolution */
  scale: number;
  usePressure?: boolean;
  /** Audio replay: strokes that started after this time are drawn faded. */
  fadeAfter?: number | null;
  fadeUntil?: number | null;
  hide?: Set<ID>;
  highlights?: TextRun[];
  /** Darken paper for dark mode (only for white template paper). */
  dimPaper?: boolean;
  /** Called when an async background (PDF) becomes available. */
  onAsync?: () => void;
  /** Draw link items' affordance */
  showLinks?: boolean;
}

export function drawBackground(ctx: CanvasRenderingContext2D, page: Page, o: RenderOptions) {
  const { w, h, bg } = page;
  if (bg.type === "pdf") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    const bmp = cachedPdfBitmap(bg.asset, bg.page, bg.rot, o.scale);
    if (bmp) ctx.drawImage(bmp as CanvasImageSource, 0, 0, w, h);
    const want = renderPdfBitmap(bg.asset, bg.page, bg.rot, w, h, o.scale);
    want.then((b) => {
      if (b && b !== bmp) {
        o.onAsync?.();
        pdfListeners.forEach((f) => f());
      }
    });
    return;
  }
  ctx.fillStyle = bg.paper || "#ffffff";
  ctx.fillRect(0, 0, w, h);
  if (bg.template === "custom" && bg.asset) {
    const img = getImage(bg.asset);
    if (img) ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    return;
  }
  const shapes = templateShapes(bg, w, h);
  for (const [x1, y1, x2, y2, color, lw] of shapes.lines) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  for (const [x, y, r, color] of shapes.dots) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Dash pattern (in units of the line width) for a pen line style. */
export function dashPattern(dash: Stroke["dash"], lineWidth: number): number[] {
  if (dash === "dashed") return [lineWidth * 3, lineWidth * 2.2];
  if (dash === "dotted") return [0.001, lineWidth * 2]; // zero-length dashes + round caps = dots
  return [];
}

/** Line width a dashed/dotted pen line uses: the solid stroke's size for freehand, the shape width for shapes. */
export function dashedLineWidth(s: Pick<Stroke, "width" | "shape">) {
  return s.shape ? s.width : s.width * 1.35;
}

/**
 * Even centre-line path for a dashed/dotted pen stroke. Freehand lines go through the same
 * clean-up and curve filling as solid ink, so sparse stylus samples don't show as corners.
 */
export function dashedLinePath(pts: number[], shape?: boolean, closed?: boolean, width = 1.8): Path2D {
  const p = new Path2D();
  const q = shape ? pts : strokeInput(pts, width, false).flat();
  if (!q.length) return p;
  p.moveTo(q[0], q[1]);
  if (q.length === 3) p.lineTo(q[0] + 0.01, q[1]);
  for (let i = 3; i < q.length; i += 3) p.lineTo(q[i], q[i + 1]);
  if (closed) p.closePath();
  return p;
}

/** Stroke a dashed/dotted pen line (shared by live drawing and saved strokes so they match). */
export function strokeDashedLine(ctx: CanvasRenderingContext2D, path: Path2D, color: string, lineWidth: number, dash: Stroke["dash"], alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dashPattern(dash, lineWidth));
  ctx.stroke(path);
  ctx.restore();
}

const dashedPathCache = new WeakMap<Stroke, Path2D>();

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, usePressure = true, alpha = 1) {
  if (s.dash && s.pen !== "highlighter" && s.pen !== "pencil") {
    let dp = dashedPathCache.get(s);
    if (!dp) dashedPathCache.set(s, (dp = dashedLinePath(s.pts, s.shape, s.closed, s.width)));
    if (s.shape && s.fill && s.closed) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.fill;
      ctx.fill(dp);
      ctx.restore();
    }
    strokeDashedLine(ctx, dp, s.color, dashedLineWidth(s), s.dash, alpha);
    return;
  }
  const path = strokePath(s, usePressure);
  ctx.save();
  if (s.pen === "highlighter") {
    ctx.globalAlpha = (s.opacity ?? 0.38) * alpha;
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = s.shape ? "butt" : "round";
    ctx.lineJoin = "round";
    ctx.stroke(path);
  } else if (s.shape) {
    ctx.globalAlpha = alpha;
    if (s.fill) {
      ctx.fillStyle = s.fill;
      ctx.fill(path);
    }
    if (s.pen === "pencil") strokePencilLine(ctx, path, s.color, s.width, alpha);
    else {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(path);
    }
  } else if (isInkLineStroke(s)) {
    ctx.restore();
    drawInkLine(ctx, path, s.color, s.width, alpha);
    return;
  } else if (s.pen === "pencil") {
    paintPencil(ctx, path, cachedPencilLayers(s, usePressure), s.color, s.width, alpha);
  } else {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = s.color;
    ctx.fill(path);
  }
  ctx.restore();
}

export function drawText(ctx: CanvasRenderingContext2D, t: TextEl, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const cx = t.x + t.w / 2,
    cy = t.y + t.h / 2;
  if (t.rot) {
    ctx.translate(cx, cy);
    ctx.rotate(t.rot);
    ctx.translate(-cx, -cy);
  }
  if (t.bg) {
    ctx.fillStyle = t.bg;
    ctx.beginPath();
    (ctx as any).roundRect ? (ctx as any).roundRect(t.x, t.y, t.w, t.h, 4) : ctx.rect(t.x, t.y, t.w, t.h);
    ctx.fill();
  }
  ctx.font = textFont(t);
  ctx.fillStyle = t.link ? "#1a73c8" : t.color;
  ctx.textBaseline = "alphabetic";
  const lines = layoutText(t);
  const lh = t.size * 1.3;
  lines.forEach((line, i) => {
    const y = t.y + 4 + t.size + i * lh;
    let x = t.x + 4;
    const mw = ctx.measureText(line).width;
    if (t.align === "center") x = t.x + (t.w - mw) / 2;
    else if (t.align === "right") x = t.x + t.w - 4 - mw;
    ctx.fillText(line, x, y);
    if (t.underline || t.link) {
      ctx.fillRect(x, y + Math.max(1, t.size * 0.08), mw, Math.max(0.6, t.size * 0.06));
    }
  });
  ctx.restore();
}

export function drawImageEl(ctx: CanvasRenderingContext2D, im: ImageEl, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const cx = im.x + im.w / 2,
    cy = im.y + im.h / 2;
  if (im.rot) {
    ctx.translate(cx, cy);
    ctx.rotate(im.rot);
    ctx.translate(-cx, -cy);
  }
  const img = getImage(im.asset);
  if (img) {
    const iw = (img as any).width,
      ih = (img as any).height;
    const c = im.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    ctx.drawImage(img as CanvasImageSource, c.x * iw, c.y * ih, c.w * iw, c.h * ih, im.x, im.y, im.w, im.h);
  } else {
    ctx.fillStyle = "#eceae8";
    ctx.fillRect(im.x, im.y, im.w, im.h);
  }
  ctx.restore();
}

export function drawLink(ctx: CanvasRenderingContext2D, l: LinkEl) {
  ctx.save();
  ctx.fillStyle = "rgba(26,115,200,0.08)";
  ctx.strokeStyle = "rgba(26,115,200,0.7)";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.fillRect(l.x, l.y, l.w, l.h);
  ctx.strokeRect(l.x, l.y, l.w, l.h);
  ctx.setLineDash([]);
  // small chain glyph
  ctx.strokeStyle = "#1a73c8";
  ctx.lineWidth = 1.4;
  const gx = l.x + l.w - 10,
    gy = l.y + 4;
  ctx.beginPath();
  ctx.ellipse(gx, gy + 3, 3, 2, -0.6, 0, Math.PI * 2);
  ctx.ellipse(gx + 4, gy + 1, 3, 2, -0.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawItem(ctx: CanvasRenderingContext2D, it: Item, o: Pick<RenderOptions, "usePressure" | "fadeAfter" | "fadeUntil" | "showLinks">) {
  const t = it.kind === "stroke" ? it.t0 : it.kind === "link" ? 0 : it.t0 ?? 0;
  const faded = o.fadeAfter != null && t > o.fadeAfter && (o.fadeUntil == null || t <= o.fadeUntil);
  const alpha = faded ? 0.18 : 1;
  switch (it.kind) {
    case "stroke":
      return drawStroke(ctx, it, o.usePressure !== false, alpha);
    case "text":
      return drawText(ctx, it, alpha);
    case "image":
      return drawImageEl(ctx, it, alpha);
    case "link":
      if (o.showLinks !== false) drawLink(ctx, it);
      return;
  }
}

/** Render a complete page. The context must already be scaled so 1 unit = 1 page point. */
export function renderPage(ctx: CanvasRenderingContext2D, page: Page, o: RenderOptions) {
  drawBackground(ctx, page, o);
  for (const it of page.items) {
    if (o.hide?.has(it.id)) continue;
    drawItem(ctx, it, o);
  }
  if (o.highlights?.length) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 196, 0, 0.38)";
    for (const r of o.highlights) ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
}

/** Render a page to a new canvas (thumbnails, exports, flashcards). */
export function renderPageToCanvas(page: Page, pxWidth: number, opts: Partial<RenderOptions> = {}): HTMLCanvasElement {
  const scale = pxWidth / page.w;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(page.w * scale));
  c.height = Math.max(1, Math.round(page.h * scale));
  const ctx = c.getContext("2d")!;
  ctx.scale(scale, scale);
  renderPage(ctx, page, { scale, showLinks: false, ...opts });
  return c;
}

/** Wait until the PDF background of a page is rendered at (at least) the given scale, then draw. */
export async function renderPageToCanvasAsync(page: Page, pxWidth: number, opts: Partial<RenderOptions> = {}) {
  const scale = pxWidth / page.w;
  if (page.bg.type === "pdf") await renderPdfBitmap(page.bg.asset, page.bg.page, page.bg.rot, page.w, page.h, scale);
  const imgs = page.items.filter((i) => i.kind === "image") as ImageEl[];
  if (imgs.length || (page.bg.type === "template" && page.bg.asset)) {
    const ids = imgs.map((i) => i.asset).concat(page.bg.type === "template" && page.bg.asset ? [page.bg.asset] : []);
    ids.forEach((id) => getImage(id));
    for (let k = 0; k < 50 && ids.some((id) => images.get(id) === "loading"); k++) await new Promise((r) => setTimeout(r, 40));
  }
  return renderPageToCanvas(page, pxWidth, opts);
}

/** Render a set of items (selection) cropped to their bounds — for stickers, flashcards and recognition. */
export function renderItemsToCanvas(items: Item[], bounds: { x: number; y: number; w: number; h: number }, scale = 2, bg = "#ffffff") {
  const pad = 6;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil((bounds.w + pad * 2) * scale));
  c.height = Math.max(1, Math.ceil((bounds.h + pad * 2) * scale));
  const ctx = c.getContext("2d")!;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.scale(scale, scale);
  ctx.translate(-bounds.x + pad, -bounds.y + pad);
  for (const it of items) drawItem(ctx, it, { showLinks: false });
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, type = "image/png", q?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode image"))), type, q));
}
