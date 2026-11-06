// The drawing surface: layout of pages, zoom/pan, pointer input for every tool,
// low-latency live ink and cached page rendering.
//
// Rendering uses two canvases:
//  - base: committed page content, drawn from per-page bitmap caches (re-rendered
//    incrementally when strokes are appended; reused while zooming for smoothness)
//  - live: in-progress stroke, lasso, selection, eraser cursor, ruler, laser...
// The live canvas is created with `desynchronized: true` where supported for
// lower latency.

import type { DocSession } from "./session";
import type { ID, Item, LinkEl, Page, Stroke, TextEl } from "../model/types";
import { tools } from "./tools";
import { settingsStore } from "../state/store";
import { drawItem, renderPage, onImageLoaded, onPdfLoaded, paintPencil, pencilToneLayers, strokePencilLine, strokeDashedLine, dashedLinePath, dashedLineWidth, drawInkLine, inkLinePath } from "../engine/render";
import { liveOutline, outlineToSvgPath, strokeCenterline, inkLinePoints } from "../engine/strokes";
import {
  eraseStrokePart,
  eraseStrokeExact,
  isScribble,
  scribbleTargets,
  itemBounds,
  itemHit,
  lassoSelect,
  projectOnLine,
  rotateItem,
  scaleItem,
  strokeHitBySegment,
  translateItem,
  unionRect,
  pointInRect,
  type Rect,
} from "../engine/geometry";
import { recognizeShape, dragShape, shapeToPts } from "../engine/shapes";
import { round2, uid, clamp } from "../model/util";
import type { TextRun } from "../storage/repo";

export interface Selection {
  pageId: ID;
  ids: Set<ID>;
}

export interface ViewportCallbacks {
  onCurrentPage?(index: number): void;
  onSelection?(sel: Selection | null): void;
  onEditText?(t: { pageId: ID; id: ID } | null): void;
  onRequestImage?(pageId: ID, x: number, y: number): void;
  onFollowLink?(l: LinkEl | TextEl): void;
  onView?(): void;
  onStrokeTap?(s: Stroke): void;
}

interface PageRect {
  id: ID;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CacheEntry {
  page: Page;
  canvas: HTMLCanvasElement;
  scale: number;
  key: string;
}

type StrokeAction = {
  kind: "stroke";
  pid: number;
  pageId: ID;
  pen: Stroke["pen"];
  color: string;
  width: number;
  stabilization: number;
  opacity: number;
  pts: number[];
  t0: number;
  snap: null | { ax: number; ay: number; ang: number };
  straight: boolean;
  shape: Stroke | null;
  holdTimer: any;
  /** Pen line style (pens only; pencil and highlighter are always solid). */
  dash?: Stroke["dash"];
};

type Action =
  | StrokeAction
  | { kind: "erase"; pid: number; lx: number; ly: number }
  | { kind: "lasso"; pid: number; pageId: ID; poly: number[]; rect: boolean }
  | { kind: "move" | "scale" | "rotate"; pid: number; sx: number; sy: number; ox: number; oy: number; handle: string; bounds: Rect; cx: number; cy: number; a0: number }
  | { kind: "shape"; pid: number; pageId: ID; x0: number; y0: number; x1: number; y1: number; pts: number[]; t0: number }
  | { kind: "pan"; pid: number; lx: number; ly: number; vx: number; vy: number; lt: number; moved: number; tapX: number; tapY: number }
  | { kind: "pinch"; d0: number; z0: number; wx: number; wy: number; ang0: number }
  | { kind: "tap"; pid: number; x: number; y: number; tool: string }
  | { kind: "laser"; pid: number }
  | { kind: "ruler-move"; pid: number; lx: number; ly: number }
  | { kind: "ruler-rotate"; pid: number }
  | { kind: "zoombox-move"; pid: number; lx: number; ly: number };

const GAP = 22;
const PAD = 28;

export interface ZoomBoxState {
  pageId: ID;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Preview = { kind: "move" | "scale" | "rotate"; dx: number; dy: number; sx: number; sy: number; ox: number; oy: number; ang: number; cx: number; cy: number };

export class ViewportController {
  readonly el: HTMLDivElement;
  private base: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private dpr = 1;
  vw = 0;
  vh = 0;
  zoom = 1;
  sx = 0;
  sy = 0;
  session: DocSession | null = null;
  private unsub: (() => void) | null = null;
  rects: PageRect[] = [];
  contentW = 0;
  contentH = 0;
  private cache = new Map<ID, CacheEntry>();
  private frame = 0;
  private needBase = true;
  private needLive = true;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private action: Action | null = null;
  private penSeen = false;
  private spaceDown = false;
  private gestureUntil = 0;
  private overrides = new Map<ID, Item[]>();
  selection: Selection | null = null;
  private preview: Preview | null = null;
  editing: { pageId: ID; id: ID } | null = null;
  private hover: { x: number; y: number } | null = null;
  private laser: { x: number; y: number; t: number }[] = [];
  ruler = { x: 0, y: 0, ang: 0, len: 900, wid: 64, placed: false };
  zoombox: ZoomBoxState | null = null;
  fadeAfter: number | null = null;
  fadeUntil: number | null = null;
  highlights = new Map<ID, TextRun[]>();
  flash: { pageId: ID; until: number } | null = null;
  private currentIdx = -1;
  private inertia = 0;
  private canvasColor = "#ecebea";
  private ro: ResizeObserver;
  private disposers: (() => void)[] = [];
  private lastPointerWorld: { x: number; y: number } | null = null;
  private sharpenTimer: any;
  readonly minZoom = 0.15;
  readonly maxZoom = 8;

  constructor(host: HTMLDivElement, private cb: ViewportCallbacks) {
    this.el = host;
    this.base = document.createElement("canvas");
    this.live = document.createElement("canvas");
    this.base.className = "vp-base";
    this.live.className = "vp-live";
    host.append(this.base, this.live);
    this.bctx = this.base.getContext("2d", { alpha: false })!;
    this.lctx = (this.live.getContext("2d", { desynchronized: true } as any) as CanvasRenderingContext2D) || this.live.getContext("2d")!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    const on = (t: string, f: (e: any) => void, opts?: AddEventListenerOptions) => {
      host.addEventListener(t, f, opts);
      this.disposers.push(() => host.removeEventListener(t, f, opts));
    };
    on("pointerdown", (e) => this.onDown(e));
    on("pointermove", (e) => this.onMove(e));
    on("pointerup", (e) => this.onUp(e));
    on("pointercancel", (e) => this.onCancel(e));
    on("pointerleave", () => {
      this.hover = null;
      this.requestLive();
    });
    on("wheel", (e) => this.onWheel(e), { passive: false });
    on("contextmenu", (e) => e.preventDefault());
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target as HTMLElement)?.closest?.("input,textarea,[contenteditable]")) this.spaceDown = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") this.spaceDown = false;
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    this.disposers.push(() => window.removeEventListener("keydown", kd), () => window.removeEventListener("keyup", ku));
    this.disposers.push(onImageLoaded(() => this.invalidateAll()));
    this.disposers.push(onPdfLoaded(() => this.requestBase()));
    this.disposers.push(tools.subscribe(() => this.requestLive()));
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.inertia);
    this.ro.disconnect();
    this.disposers.forEach((d) => d());
    this.unsub?.();
    this.cache.clear();
    this.base.remove();
    this.live.remove();
  }

  setSession(s: DocSession) {
    this.unsub?.();
    this.session = s;
    this.selection = null;
    this.cache.clear();
    this.unsub = s.subscribe(() => {
      this.relayout();
      this.validateSelection();
      this.requestBase();
    });
    this.relayout();
    this.fitWidth(true);
  }

  refreshTheme() {
    this.canvasColor = getComputedStyle(this.el).getPropertyValue("--c-canvas").trim() || "#ecebea";
    this.requestBase();
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    const first = this.vw <= 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.vw = Math.max(1, r.width);
    this.vh = Math.max(1, r.height);
    for (const c of [this.base, this.live]) {
      c.width = Math.round(this.vw * this.dpr);
      c.height = Math.round(this.vh * this.dpr);
      c.style.width = this.vw + "px";
      c.style.height = this.vh + "px";
    }
    this.refreshTheme();
    if (first && this.session) this.fitWidth(true);
    if (!this.ruler.placed) {
      this.ruler.x = this.vw / 2;
      this.ruler.y = this.vh * 0.55;
      this.ruler.len = Math.min(1100, this.vw * 0.9);
    }
    this.clampScroll();
    this.requestBase();
  }

  relayout() {
    const s = this.session;
    if (!s) return;
    const pages = s.orderedPages();
    const rects: PageRect[] = [];
    if (s.doc.layout === "horizontal") {
      const maxH = Math.max(...pages.map((p) => p.h), 1);
      let x = PAD;
      for (const p of pages) {
        rects.push({ id: p.id, x, y: PAD + (maxH - p.h) / 2, w: p.w, h: p.h });
        x += p.w + GAP;
      }
      this.contentW = x - GAP + PAD;
      this.contentH = maxH + PAD * 2;
    } else {
      const maxW = Math.max(...pages.map((p) => p.w), 1);
      let y = PAD;
      for (const p of pages) {
        rects.push({ id: p.id, x: PAD + (maxW - p.w) / 2, y, w: p.w, h: p.h });
        y += p.h + GAP;
      }
      this.contentW = maxW + PAD * 2;
      this.contentH = y - GAP + PAD;
    }
    this.rects = rects;
    this.clampScroll();
  }

  fitWidth(top = false) {
    if (!this.rects.length || this.vw <= 1) return;
    if (this.session!.doc.layout === "horizontal") {
      const maxH = Math.max(...this.rects.map((r) => r.h));
      this.zoom = clamp((this.vh - 40) / (maxH + PAD * 2), this.minZoom, 2.5);
    } else {
      const maxW = Math.max(...this.rects.map((r) => r.w));
      this.zoom = clamp((this.vw - 24) / (maxW + PAD * 2), this.minZoom, this.vw > 900 ? 1.6 : 2.5);
    }
    if (top) {
      this.sx = 0;
      this.sy = 0;
    }
    this.clampScroll();
    this.requestBase();
    this.cb.onView?.();
  }

  fitPage() {
    const r = this.rects[this.currentPageIndex];
    if (!r) return;
    this.zoom = clamp(Math.min((this.vw - 40) / r.w, (this.vh - 40) / r.h), this.minZoom, this.maxZoom);
    this.scrollToPage(r.id);
  }

  zoomAt(z: number, px: number, py: number) {
    const nz = clamp(z, this.minZoom, this.maxZoom);
    const wx = px / this.zoom + this.sx,
      wy = py / this.zoom + this.sy;
    this.zoom = nz;
    this.sx = wx - px / nz;
    this.sy = wy - py / nz;
    this.clampScroll();
    this.requestBase();
    this.cb.onView?.();
  }

  zoomBy(f: number) {
    this.zoomAt(this.zoom * f, this.vw / 2, this.vh / 2);
    this.scheduleSharpen();
  }

  private scheduleSharpen() {
    this.gestureUntil = performance.now() + 140;
    clearTimeout(this.sharpenTimer);
    this.sharpenTimer = setTimeout(() => this.requestBase(), 160);
  }

  clampScroll() {
    const cw = this.contentW * this.zoom,
      ch = this.contentH * this.zoom;
    if (cw <= this.vw) this.sx = -(this.vw - cw) / 2 / this.zoom;
    else this.sx = clamp(this.sx, 0, this.contentW - this.vw / this.zoom);
    if (ch <= this.vh) this.sy = -(this.vh - ch) / 2 / this.zoom;
    else this.sy = clamp(this.sy, 0, this.contentH - this.vh / this.zoom);
  }

  scrollBy(dx: number, dy: number) {
    this.sx += dx / this.zoom;
    this.sy += dy / this.zoom;
    this.clampScroll();
    this.requestBase();
    this.cb.onView?.();
  }

  scrollToPage(id: ID, yInPage?: number) {
    const r = this.rects.find((x) => x.id === id);
    if (!r) return;
    if (this.session?.doc.layout === "horizontal") this.sx = r.x - 16 / this.zoom;
    else this.sy = yInPage != null ? r.y + yInPage - this.vh / 3 / this.zoom : r.y - 12 / this.zoom;
    this.clampScroll();
    this.requestBase();
    this.cb.onView?.();
  }

  flashPage(id: ID) {
    this.flash = { pageId: id, until: performance.now() + 900 };
    this.requestLive();
    setTimeout(() => this.requestLive(), 950);
  }

  get currentPageIndex() {
    return Math.max(0, this.currentIdx);
  }

  visiblePageRect(): { pageId: ID; x: number; y: number; w: number; h: number } | null {
    const r = this.rects[this.currentPageIndex];
    if (!r) return null;
    const x0 = Math.max(r.x, this.sx),
      y0 = Math.max(r.y, this.sy);
    const x1 = Math.min(r.x + r.w, this.sx + this.vw / this.zoom),
      y1 = Math.min(r.y + r.h, this.sy + this.vh / this.zoom);
    return { pageId: r.id, x: x0 - r.x, y: y0 - r.y, w: Math.max(40, x1 - x0), h: Math.max(40, y1 - y0) };
  }

  pageToScreen(pageId: ID, x: number, y: number) {
    const r = this.rects.find((p) => p.id === pageId);
    if (!r) return { x: 0, y: 0 };
    return { x: (r.x + x - this.sx) * this.zoom, y: (r.y + y - this.sy) * this.zoom };
  }

  private toWorld(px: number, py: number) {
    return { x: px / this.zoom + this.sx, y: py / this.zoom + this.sy };
  }

  private pageIndexAt(wx: number, wy: number, slack = 0): number {
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (wx >= r.x - slack && wx <= r.x + r.w + slack && wy >= r.y - slack && wy <= r.y + r.h + slack) return i;
    }
    return -1;
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pageItems(pageId: ID): Item[] {
    return this.overrides.get(pageId) ?? this.session?.page(pageId)?.items ?? [];
  }

  private rectOf(pageId: ID) {
    return this.rects.find((q) => q.id === pageId);
  }

  // ------------------------------------------------------------------ rendering
  requestBase() {
    this.needBase = true;
    this.needLive = true;
    this.schedule();
  }
  requestLive() {
    this.needLive = true;
    this.schedule();
  }
  invalidateAll() {
    this.cache.clear();
    this.requestBase();
  }
  invalidatePage(id: ID) {
    this.cache.delete(id);
    this.requestBase();
  }
  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.needBase) this.renderBase();
      if (this.needLive) this.renderLive();
    });
  }

  private hiddenFor(pageId: ID): Set<ID> | undefined {
    const h = new Set<ID>();
    if (this.selection && this.selection.pageId === pageId) this.selection.ids.forEach((i) => h.add(i));
    if (this.editing && this.editing.pageId === pageId) h.add(this.editing.id);
    return h.size ? h : undefined;
  }

  private pageBitmap(page: Page, scale: number, hide: Set<ID> | undefined, allowStale: boolean): HTMLCanvasElement | null {
    const usePressure = settingsStore.get().pressure;
    const key = `${hide ? [...hide].sort().join(",") : ""}|${this.fadeAfter == null ? "" : Math.floor(this.fadeAfter / 250) + ":" + this.fadeUntil}|${usePressure ? 1 : 0}`;
    const c = this.cache.get(page.id);
    if (c && c.key === key) {
      const sameScale = Math.abs(c.scale / scale - 1) < 0.02;
      if (c.page === page && (sameScale || allowStale)) return c.canvas;
      if (sameScale && c.page.bg === page.bg && c.page.w === page.w && c.page.h === page.h && page.items.length >= c.page.items.length) {
        // incremental update when strokes were only appended
        const old = c.page.items;
        let prefix = true;
        for (let i = old.length - 1; i >= 0; i--)
          if (old[i] !== page.items[i]) {
            prefix = false;
            break;
          }
        if (prefix) {
          const ctx = c.canvas.getContext("2d")!;
          ctx.setTransform(scale, 0, 0, scale, 0, 0);
          for (let i = old.length; i < page.items.length; i++) if (!hide?.has(page.items[i].id)) drawItem(ctx, page.items[i], { usePressure, fadeAfter: this.fadeAfter, fadeUntil: this.fadeUntil });
          c.page = page;
          return c.canvas;
        }
      }
    }
    if (page.w * page.h * scale * scale > 14_000_000) return null; // too large at this zoom: draw directly
    const canvas = c?.canvas ?? document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(page.w * scale));
    canvas.height = Math.max(1, Math.round(page.h * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderPage(ctx, page, { scale, hide, fadeAfter: this.fadeAfter, fadeUntil: this.fadeUntil, usePressure, onAsync: () => this.invalidatePage(page.id) });
    this.cache.delete(page.id);
    this.cache.set(page.id, { page, canvas, scale, key });
    let total = 0;
    const entries = [...this.cache.entries()];
    for (const [, e] of entries) total += e.canvas.width * e.canvas.height;
    for (const [id, e] of entries) {
      if (total < 60_000_000 && this.cache.size <= 14) break;
      if (id === page.id) continue;
      total -= e.canvas.width * e.canvas.height;
      e.canvas.width = e.canvas.height = 0;
      this.cache.delete(id);
    }
    return canvas;
  }

  private renderBase() {
    this.needBase = false;
    const ctx = this.bctx;
    const s = this.session;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.canvasColor;
    ctx.fillRect(0, 0, this.vw, this.vh);
    if (!s) return;
    const z = this.zoom;
    const scale = z * this.dpr;
    const stale = performance.now() < this.gestureUntil;
    const usePressure = settingsStore.get().pressure;
    const wx0 = this.sx,
      wy0 = this.sy,
      wx1 = this.sx + this.vw / z,
      wy1 = this.sy + this.vh / z;
    let best = -1,
      bestArea = 0;
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (r.x > wx1 || r.x + r.w < wx0 || r.y > wy1 || r.y + r.h < wy0) continue;
      const page = s.page(r.id);
      if (!page) continue;
      const vis = (Math.min(r.x + r.w, wx1) - Math.max(r.x, wx0)) * (Math.min(r.y + r.h, wy1) - Math.max(r.y, wy0));
      if (vis > bestArea) {
        bestArea = vis;
        best = i;
      }
      const X = (r.x - this.sx) * z,
        Y = (r.y - this.sy) * z,
        W = r.w * z,
        H = r.h * z;
      ctx.fillStyle = "rgba(0,0,0,0.07)";
      ctx.fillRect(X + 1, Y + 2, W, H);
      const ov = this.overrides.get(r.id);
      const pg = ov ? { ...page, items: ov } : page;
      const hide = this.hiddenFor(r.id);
      const bmp = ov ? null : this.pageBitmap(pg, scale, hide, stale);
      if (bmp) ctx.drawImage(bmp, X, Y, W, H);
      else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(X, Y, W, H);
        ctx.clip();
        ctx.translate(X, Y);
        ctx.scale(z, z);
        renderPage(ctx, pg, { scale, hide, fadeAfter: this.fadeAfter, fadeUntil: this.fadeUntil, usePressure, onAsync: () => this.requestBase() });
        ctx.restore();
      }
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(X - 0.5, Y - 0.5, W + 1, H + 1);
    }
    if (best !== -1 && best !== this.currentIdx) {
      this.currentIdx = best;
      this.cb.onCurrentPage?.(best);
    }
  }

  private toScreenCtx(ctx: CanvasRenderingContext2D, pageId: ID) {
    const r = this.rectOf(pageId);
    if (!r) return false;
    ctx.setTransform(this.dpr * this.zoom, 0, 0, this.dpr * this.zoom, (r.x - this.sx) * this.zoom * this.dpr, (r.y - this.sy) * this.zoom * this.dpr);
    return true;
  }

  selectionItems(): Item[] {
    if (!this.selection) return [];
    const ids = this.selection.ids;
    return this.pageItems(this.selection.pageId).filter((i) => ids.has(i.id));
  }

  private transformed(items: Item[]): Item[] {
    const p = this.preview;
    if (!p) return items;
    if (p.kind === "move") return items.map((i) => translateItem(i, p.dx, p.dy));
    if (p.kind === "scale") return items.map((i) => scaleItem(i, p.ox, p.oy, p.sx, p.sy));
    return items.map((i) => rotateItem(i, p.cx, p.cy, p.ang));
  }

  selectionBounds(): Rect | null {
    return unionRect(this.transformed(this.selectionItems()).map(itemBounds));
  }

  selectionScreenRect(): Rect | null {
    const b = this.selectionBounds();
    if (!b || !this.selection) return null;
    const a = this.pageToScreen(this.selection.pageId, b.x, b.y);
    return { x: a.x, y: a.y, w: b.w * this.zoom, h: b.h * this.zoom };
  }

  private handles(): { id: string; x: number; y: number }[] {
    const r = this.selectionScreenRect();
    if (!r) return [];
    const { x, y, w, h } = r;
    return [
      { id: "nw", x, y },
      { id: "ne", x: x + w, y },
      { id: "se", x: x + w, y: y + h },
      { id: "sw", x, y: y + h },
      { id: "n", x: x + w / 2, y },
      { id: "s", x: x + w / 2, y: y + h },
      { id: "e", x: x + w, y: y + h / 2 },
      { id: "w", x, y: y + h / 2 },
      { id: "rot", x: x + w / 2, y: y - 28 },
    ];
  }

  private renderLive() {
    this.needLive = false;
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const st = tools.get();
    const a = this.action;
    const usePressure = settingsStore.get().pressure;

    for (const [pid, runs] of this.highlights) {
      if (!this.toScreenCtx(ctx, pid)) continue;
      ctx.fillStyle = "rgba(255, 190, 0, 0.35)";
      for (const r of runs) ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (this.flash && performance.now() < this.flash.until && this.toScreenCtx(ctx, this.flash.pageId)) {
      const pg = this.session?.page(this.flash.pageId);
      if (pg) {
        ctx.strokeStyle = "rgba(69,191,219,0.9)";
        ctx.lineWidth = 4 / this.zoom;
        ctx.strokeRect(0, 0, pg.w, pg.h);
      }
    }

    if (this.selection) {
      const items = this.transformed(this.selectionItems());
      if (this.toScreenCtx(ctx, this.selection.pageId)) for (const it of items) drawItem(ctx, it, { usePressure });
      const r = this.selectionScreenRect();
      if (r) {
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.strokeStyle = "#2a9fc0";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(r.x + r.w / 2, r.y);
        ctx.lineTo(r.x + r.w / 2, r.y - 22);
        ctx.stroke();
        for (const h of this.handles()) {
          ctx.beginPath();
          ctx.fillStyle = "#fff";
          ctx.arc(h.x, h.y, h.id === "rot" ? 7 : 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          if (h.id === "rot") {
            ctx.beginPath();
            ctx.arc(h.x, h.y, 3, 0.4, Math.PI * 1.6);
            ctx.stroke();
          }
        }
      }
    }

    if (a?.kind === "stroke" && this.toScreenCtx(ctx, a.pageId)) {
      if (a.shape) drawItem(ctx, a.shape, { usePressure });
      else if (a.dash && a.pts.length) {
        const shapeLike = !!(a.snap || a.straight);
        strokeDashedLine(ctx, dashedLinePath(a.pts, shapeLike, false, a.width), a.color, dashedLineWidth({ width: a.width, shape: shapeLike }), a.dash);
      } else if (a.pen === "highlighter" || a.snap || a.straight) {
        ctx.save();
        if (a.pen === "highlighter") {
          ctx.globalAlpha = 0.38;
          ctx.globalCompositeOperation = "multiply";
        }
        const line = new Path2D();
        line.moveTo(a.pts[0], a.pts[1]);
        for (let i = 3; i < a.pts.length; i += 3) line.lineTo(a.pts[i], a.pts[i + 1]);
        if (a.pts.length === 3) line.lineTo(a.pts[0] + 0.01, a.pts[1]);
        if (a.pen === "pencil") strokePencilLine(ctx, line, a.color, a.width);
        else {
          ctx.strokeStyle = a.color;
          ctx.lineWidth = a.width;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.stroke(line);
        }
        ctx.restore();
      } else if (a.pen === "ballpoint" && a.pts.length) {
        drawInkLine(ctx, inkLinePath(inkLinePoints(a.pts, a.width, a.stabilization)), a.color, a.width);
      } else if (a.pts.length) {
        const outline = new Path2D(outlineToSvgPath(liveOutline(a.pen, a.width, a.pts, usePressure, a.stabilization)));
        if (a.pen === "pencil") paintPencil(ctx, outline, pencilToneLayers(strokeCenterline(a.pen, a.width, a.pts, usePressure, a.stabilization, false)), a.color, a.width);
        else {
          ctx.fillStyle = a.color;
          ctx.fill(outline);
        }
      }
    }
    if (a?.kind === "shape" && this.toScreenCtx(ctx, a.pageId)) {
      const sh = st.shapes;
      const shp = sh.kind === "auto" ? null : dragShape(sh.kind, a.x0, a.y0, a.x1, a.y1, sh.width);
      ctx.strokeStyle = sh.color;
      ctx.lineWidth = sh.width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      if (shp) {
        ctx.moveTo(shp.xy[0], shp.xy[1]);
        for (let i = 2; i < shp.xy.length; i += 2) ctx.lineTo(shp.xy[i], shp.xy[i + 1]);
        if (shp.closed) ctx.closePath();
        if (sh.fill && shp.closed) {
          ctx.fillStyle = sh.fill;
          ctx.fill();
        }
      } else if (a.pts.length) {
        ctx.moveTo(a.pts[0], a.pts[1]);
        for (let i = 3; i < a.pts.length; i += 3) ctx.lineTo(a.pts[i], a.pts[i + 1]);
      }
      ctx.stroke();
    }
    if (a?.kind === "lasso" && this.toScreenCtx(ctx, a.pageId)) {
      ctx.strokeStyle = "#2a9fc0";
      ctx.fillStyle = "rgba(69,191,219,0.08)";
      ctx.lineWidth = 1.3 / this.zoom;
      ctx.setLineDash([6 / this.zoom, 5 / this.zoom]);
      ctx.beginPath();
      const p = a.poly;
      if (p.length >= 2) {
        ctx.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    if ((st.tool === "eraser" || a?.kind === "erase") && this.hover) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.strokeStyle = "rgba(60,60,60,0.7)";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, Math.max(3, st.eraser.size * this.zoom), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (this.laser.length) {
      const now = performance.now();
      this.laser = this.laser.filter((p) => now - p.t < 700);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < this.laser.length; i++) {
        const p0 = this.laser[i - 1],
          p1 = this.laser[i];
        const age = (now - p1.t) / 700;
        ctx.strokeStyle = `rgba(255, 40, 60, ${Math.max(0, 1 - age)})`;
        ctx.lineWidth = 6 * (1 - age * 0.6);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      const last = this.laser[this.laser.length - 1];
      if (last) {
        ctx.fillStyle = "rgba(255,40,60,0.95)";
        ctx.shadowColor = "rgba(255,40,60,0.8)";
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      if (this.laser.length) this.requestLive();
    }

    if (st.zoombox && this.zoombox && this.toScreenCtx(ctx, this.zoombox.pageId)) {
      const zb = this.zoombox;
      ctx.fillStyle = "rgba(69,191,219,0.10)";
      ctx.strokeStyle = "#2a9fc0";
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.fillRect(zb.x, zb.y, zb.w, zb.h);
      ctx.strokeRect(zb.x, zb.y, zb.w, zb.h);
    }

    if (st.ruler) this.drawRuler(ctx);
  }

  private drawRuler(ctx: CanvasRenderingContext2D) {
    const R = this.ruler;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.translate(R.x, R.y);
    ctx.rotate(R.ang);
    ctx.fillStyle = "rgba(235, 238, 242, 0.82)";
    ctx.strokeStyle = "rgba(90,100,110,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(-R.len / 2, -R.wid / 2, R.len, R.wid);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(60,70,80,0.75)";
    const unit = (72 / 25.4) * this.zoom; // 1 mm on paper at the current zoom
    const step = unit < 3 ? unit * 5 : unit;
    let k = 0;
    for (let x = -R.len / 2 + 6; x < R.len / 2 - 6; x += step, k++) {
      const big = unit < 3 ? k % 2 === 0 : k % 10 === 0;
      const mid = unit >= 3 && k % 5 === 0;
      const h = big ? 14 : mid ? 10 : 6;
      ctx.beginPath();
      ctx.moveTo(x, -R.wid / 2);
      ctx.lineTo(x, -R.wid / 2 + h);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(30,30,30,0.85)";
    ctx.font = "600 12px Figtree, sans-serif";
    ctx.textAlign = "center";
    const deg = Math.round(((((-R.ang * 180) / Math.PI) % 360) + 360) % 360);
    ctx.fillText(`${deg}°`, 0, 8);
    ctx.beginPath();
    ctx.fillStyle = "#2a9fc0";
    ctx.arc(R.len / 2 - 18, 8, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private rulerLocal(px: number, py: number) {
    const R = this.ruler;
    const c = Math.cos(-R.ang),
      s = Math.sin(-R.ang);
    const dx = px - R.x,
      dy = py - R.y;
    return { u: dx * c - dy * s, v: dx * s + dy * c };
  }

  // ------------------------------------------------------------------ selection API
  setSelection(sel: Selection | null) {
    this.selection = sel && sel.ids.size ? sel : null;
    this.preview = null;
    this.requestBase();
    this.cb.onSelection?.(this.selection);
  }
  clearSelection() {
    if (this.selection) this.setSelection(null);
  }
  private validateSelection() {
    if (!this.selection) return;
    const items = this.pageItems(this.selection.pageId);
    const ids = new Set([...this.selection.ids].filter((id) => items.some((i) => i.id === id)));
    if (ids.size !== this.selection.ids.size) this.setSelection(ids.size ? { pageId: this.selection.pageId, ids } : null);
  }
  setEditing(e: { pageId: ID; id: ID } | null) {
    this.editing = e;
    this.requestBase();
  }

  // ------------------------------------------------------------------ input
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      this.zoomAt(this.zoom * f, p.x, p.y);
      this.scheduleSharpen();
      return;
    }
    if (tools.get().ruler) {
      const { u, v } = this.rulerLocal(p.x, p.y);
      if (Math.abs(u) < this.ruler.len / 2 && Math.abs(v) < this.ruler.wid / 2) {
        this.ruler.ang += e.deltaY * 0.002;
        this.ruler.placed = true;
        this.requestLive();
        return;
      }
    }
    const k = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? this.vh : 1;
    let dx = e.deltaX * k,
      dy = e.deltaY * k;
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    if (this.session?.doc.layout === "horizontal" && !e.shiftKey && Math.abs(dy) > Math.abs(dx) && this.contentH * this.zoom <= this.vh + 1) {
      dx = dy;
      dy = 0;
    }
    this.scrollBy(dx, dy);
  }

  private isDrawingPointer(e: PointerEvent): boolean {
    const st = tools.get();
    const set = settingsStore.get();
    if (st.tool === "hand") return false;
    if (e.pointerType === "touch") {
      if (!set.fingerDrawing) return false;
      if (set.palmRejection && this.penSeen) return false;
      return true;
    }
    if (e.pointerType === "mouse") return e.button === 0 && !this.spaceDown;
    return true;
  }

  private onDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (t !== this.live && t !== this.base && t !== this.el) return;
    cancelAnimationFrame(this.inertia);
    const p = this.local(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, type: e.pointerType });
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (e.pointerType === "pen") this.penSeen = true;

    const touches = [...this.pointers.values()].filter((q) => q.type === "touch");
    if (e.pointerType === "touch" && touches.length >= 2) {
      // a second finger turns a just-started finger stroke into a pinch/pan gesture
      if (this.action && "pid" in this.action && this.pointers.get(this.action.pid)?.type === "touch") {
        if (this.action.kind === "stroke") clearTimeout(this.action.holdTimer);
        this.overrides.clear();
      }
      this.startPinch();
      return;
    }
    if (this.action) return;
    if (e.pointerType === "mouse" && e.button === 2) return;
    if (!this.isDrawingPointer(e)) {
      this.action = { kind: "pan", pid: e.pointerId, lx: p.x, ly: p.y, vx: 0, vy: 0, lt: performance.now(), moved: 0, tapX: p.x, tapY: p.y };
      this.el.style.cursor = "grabbing";
      return;
    }
    this.startTool(e, p);
  }

  private startPinch() {
    const pts = [...this.pointers.values()].filter((q) => q.type === "touch").slice(0, 2);
    if (pts.length < 2) return;
    const d0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    const mx = (pts[0].x + pts[1].x) / 2,
      my = (pts[0].y + pts[1].y) / 2;
    const w = this.toWorld(mx, my);
    this.action = { kind: "pinch", d0, z0: this.zoom, wx: w.x, wy: w.y, ang0: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) };
    this.requestBase();
  }

  private startTool(e: PointerEvent, p: { x: number; y: number }) {
    const st = tools.get();
    const w = this.toWorld(p.x, p.y);
    this.lastPointerWorld = w;

    if (st.ruler) {
      const { u, v } = this.rulerLocal(p.x, p.y);
      const R = this.ruler;
      if (Math.hypot(u - (R.len / 2 - 18), v - 8) < 14) {
        this.action = { kind: "ruler-rotate", pid: e.pointerId };
        return;
      }
      const onBody = Math.abs(u) < R.len / 2 && Math.abs(v) < R.wid / 2;
      const drawTool = st.tool === "pen" || st.tool === "highlighter";
      if (onBody && !(drawTool && e.pointerType === "pen")) {
        this.action = { kind: "ruler-move", pid: e.pointerId, lx: p.x, ly: p.y };
        return;
      }
    }

    if (this.selection) {
      const hit = this.handles().find((h) => Math.hypot(h.x - p.x, h.y - p.y) < (e.pointerType === "touch" ? 18 : 11));
      const b = this.selectionBounds();
      if (b && (hit || this.insideSelection(p))) {
        const cx = b.x + b.w / 2,
          cy = b.y + b.h / 2;
        const r = this.rectOf(this.selection.pageId)!;
        const lpx = w.x - r.x,
          lpy = w.y - r.y;
        if (hit?.id === "rot") this.action = { kind: "rotate", pid: e.pointerId, sx: lpx, sy: lpy, ox: 0, oy: 0, handle: "rot", bounds: b, cx, cy, a0: Math.atan2(lpy - cy, lpx - cx) };
        else if (hit) {
          const ox = hit.id.includes("w") ? b.x + b.w : hit.id.includes("e") ? b.x : cx;
          const oy = hit.id.includes("n") ? b.y + b.h : hit.id.includes("s") ? b.y : cy;
          this.action = { kind: "scale", pid: e.pointerId, sx: lpx, sy: lpy, ox, oy, handle: hit.id, bounds: b, cx, cy, a0: 0 };
        } else this.action = { kind: "move", pid: e.pointerId, sx: lpx, sy: lpy, ox: 0, oy: 0, handle: "", bounds: b, cx, cy, a0: 0 };
        return;
      }
      this.clearSelection();
    }

    if (st.tool === "laser") {
      this.action = { kind: "laser", pid: e.pointerId };
      this.laser.push({ x: p.x, y: p.y, t: performance.now() });
      this.requestLive();
      return;
    }
    const idx = this.pageIndexAt(w.x, w.y, st.tool === "lasso" ? 40 : 0);
    const rect = this.rects[idx];
    if (!rect) return;
    const px = w.x - rect.x,
      py = w.y - rect.y;

    if (st.zoombox && this.zoombox && this.zoombox.pageId === rect.id && e.pointerType !== "pen") {
      const zb = this.zoombox;
      if (px >= zb.x && px <= zb.x + zb.w && py >= zb.y && py <= zb.y + zb.h) {
        this.action = { kind: "zoombox-move", pid: e.pointerId, lx: p.x, ly: p.y };
        return;
      }
    }

    if (e.ctrlKey || e.metaKey) {
      const link = this.linkAt(rect.id, px, py);
      if (link) {
        this.cb.onFollowLink?.(link);
        return;
      }
    }

    const pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 0.5;
    switch (st.tool) {
      case "pen":
      case "highlighter": {
        const hl = st.tool === "highlighter";
        const snap = st.ruler ? this.rulerSnap(p.x, p.y, rect, hl ? st.highlighter.width : st.pen.width) : null;
        this.action = {
          kind: "stroke",
          pid: e.pointerId,
          pageId: rect.id,
          pen: hl ? "highlighter" : st.pen.pen,
          color: hl ? st.highlighter.color : st.pen.color,
          width: hl ? st.highlighter.width : st.pen.width,
          stabilization: hl ? st.highlighter.stabilization : st.pen.stabilization,
          opacity: hl ? st.highlighter.opacity : 1,
          pts: [],
          t0: Date.now(),
          snap,
          straight: hl && st.highlighter.straight,
          shape: null,
          holdTimer: null,
          dash: !hl && st.pen.pen !== "pencil" && st.pen.dash && st.pen.dash !== "solid" ? st.pen.dash : undefined,
        };
        this.addStrokePoint(px, py, pressure);
        this.armHold();
        break;
      }
      case "eraser":
        this.action = { kind: "erase", pid: e.pointerId, lx: w.x, ly: w.y };
        this.hover = p;
        this.eraseAlong(w.x, w.y, w.x, w.y);
        break;
      case "lasso":
        this.action = { kind: "lasso", pid: e.pointerId, pageId: rect.id, poly: [px, py], rect: st.lasso.mode === "rect" };
        break;
      case "shapes":
        this.action = { kind: "shape", pid: e.pointerId, pageId: rect.id, x0: px, y0: py, x1: px, y1: py, pts: [round2(px), round2(py), 0.5], t0: Date.now() };
        break;
      case "text":
      case "image":
      case "elements":
        this.action = { kind: "tap", pid: e.pointerId, x: p.x, y: p.y, tool: st.tool };
        break;
    }
    this.requestLive();
  }

  private insideSelection(p: { x: number; y: number }) {
    const r = this.selectionScreenRect();
    return !!r && pointInRect(p.x, p.y, r, 6);
  }

  linkAt(pageId: ID, x: number, y: number): LinkEl | TextEl | null {
    const items = this.pageItems(pageId);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if ((it.kind === "link" || (it.kind === "text" && it.link)) && itemHit(it, x, y, 2)) return it as LinkEl | TextEl;
    }
    return null;
  }

  private rulerSnap(sxp: number, syp: number, rect: PageRect, width: number) {
    const R = this.ruler;
    const { u, v } = this.rulerLocal(sxp, syp);
    if (Math.abs(u) > R.len / 2 + 10) return null;
    const edge = v < 0 ? -R.wid / 2 : R.wid / 2;
    if (Math.abs(v - edge) > 30 && Math.abs(v) > R.wid / 2) return null;
    const off = edge + ((v < 0 ? -1 : 1) * (width * this.zoom)) / 2;
    const c = Math.cos(R.ang),
      s = Math.sin(R.ang);
    const ax = R.x + u * c - off * s,
      ay = R.y + u * s + off * c;
    const wa = this.toWorld(ax, ay);
    return { ax: wa.x - rect.x, ay: wa.y - rect.y, ang: R.ang };
  }

  private armHold() {
    const a = this.action;
    if (!a || a.kind !== "stroke" || !settingsStore.get().shapeHold || a.snap || a.straight) return;
    clearTimeout(a.holdTimer);
    a.holdTimer = setTimeout(() => {
      if (this.action !== a || a.pts.length < 9) return;
      const shp = recognizeShape(a.pts);
      if (!shp) return;
      a.shape = {
        id: uid(),
        kind: "stroke",
        pen: a.pen === "highlighter" ? "highlighter" : a.pen === "pencil" ? "pencil" : "ballpoint",
        color: a.color,
        width: a.width,
        pts: shapeToPts(shp.xy),
        t0: a.t0,
        t1: Date.now(),
        shape: true,
        closed: shp.closed,
        ...(a.dash ? { dash: a.dash } : {}),
      };
      this.requestLive();
    }, 550);
  }

  private addStrokePoint(x: number, y: number, pr: number) {
    const a = this.action;
    if (!a || a.kind !== "stroke") return;
    if (a.snap) {
      const q = projectOnLine(x, y, a.snap.ax, a.snap.ay, a.snap.ang);
      x = q.x;
      y = q.y;
    }
    if (a.straight && a.pts.length >= 6) a.pts.length = 3;
    const n = a.pts.length;
    if (n >= 3 && !a.straight) {
      const dx = x - a.pts[n - 3],
        dy = y - a.pts[n - 2];
      if (dx * dx + dy * dy < 0.04 / (this.zoom * this.zoom)) return;
    }
    a.pts.push(round2(x), round2(y), round2(settingsStore.get().pressure ? pr : 0.5));
  }

  private onMove(e: PointerEvent) {
    const p = this.local(e);
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) {
      ptr.x = p.x;
      ptr.y = p.y;
    }
    const a = this.action;
    if (!a) {
      if (tools.get().tool === "eraser" && e.pointerType !== "touch") {
        this.hover = p;
        this.requestLive();
      }
      return;
    }
    if (a.kind === "pinch") {
      const pts = [...this.pointers.values()].filter((q) => q.type === "touch").slice(0, 2);
      if (pts.length < 2) return;
      const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2,
        my = (pts[0].y + pts[1].y) / 2;
      if (tools.get().ruler) {
        const R = this.ruler;
        const onR = (l: { u: number; v: number }) => Math.abs(l.u) < R.len / 2 && Math.abs(l.v) < R.wid / 2 + 20;
        if (onR(this.rulerLocal(pts[0].x, pts[0].y)) && onR(this.rulerLocal(pts[1].x, pts[1].y))) {
          const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
          R.ang += ang - a.ang0;
          a.ang0 = ang;
          R.x = mx;
          R.y = my;
          R.placed = true;
          this.requestLive();
          return;
        }
      }
      this.zoom = clamp(a.z0 * (d / a.d0), this.minZoom, this.maxZoom);
      this.sx = a.wx - mx / this.zoom;
      this.sy = a.wy - my / this.zoom;
      this.clampScroll();
      this.gestureUntil = performance.now() + 200;
      this.requestBase();
      this.cb.onView?.();
      return;
    }
    if (!("pid" in a) || a.pid !== e.pointerId) return;
    const coalesced: PointerEvent[] = (e as any).getCoalescedEvents?.() ?? [];
    const list = coalesced.length ? coalesced : [e];

    switch (a.kind) {
      case "stroke": {
        const r = this.rectOf(a.pageId)!;
        for (const ce of list) {
          const lp = this.local(ce);
          const w = this.toWorld(lp.x, lp.y);
          this.addStrokePoint(w.x - r.x, w.y - r.y, ce.pointerType === "pen" ? ce.pressure || 0.5 : 0.5);
        }
        const n = a.pts.length;
        if (n >= 6) {
          const moved = Math.hypot(a.pts[n - 3] - a.pts[n - 6], a.pts[n - 2] - a.pts[n - 5]) * this.zoom;
          if (moved > 1.5) {
            a.shape = null;
            this.armHold();
          }
        }
        this.requestLive();
        break;
      }
      case "erase": {
        this.hover = p;
        for (const ce of list) {
          const lp = this.local(ce);
          const w = this.toWorld(lp.x, lp.y);
          this.eraseAlong(a.lx, a.ly, w.x, w.y);
          a.lx = w.x;
          a.ly = w.y;
        }
        this.requestLive();
        break;
      }
      case "lasso": {
        const r = this.rectOf(a.pageId)!;
        const w = this.toWorld(p.x, p.y);
        const x = w.x - r.x,
          y = w.y - r.y;
        if (a.rect) {
          const x0 = a.poly[0],
            y0 = a.poly[1];
          a.poly = [x0, y0, x, y0, x, y, x0, y];
        } else a.poly.push(x, y);
        this.requestLive();
        break;
      }
      case "move":
      case "scale":
      case "rotate": {
        const sel = this.selection;
        if (!sel) break;
        const r = this.rectOf(sel.pageId)!;
        const w = this.toWorld(p.x, p.y);
        const x = w.x - r.x,
          y = w.y - r.y;
        if (a.kind === "move") this.preview = { kind: "move", dx: x - a.sx, dy: y - a.sy, sx: 1, sy: 1, ox: 0, oy: 0, ang: 0, cx: 0, cy: 0 };
        else if (a.kind === "rotate") {
          let ang = Math.atan2(y - a.cy, x - a.cx) - a.a0;
          const snapAng = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
          if (Math.abs(ang - snapAng) < 0.04) ang = snapAng;
          this.preview = { kind: "rotate", dx: 0, dy: 0, sx: 1, sy: 1, ox: 0, oy: 0, ang, cx: a.cx, cy: a.cy };
        } else {
          const b = a.bounds;
          let sx = 1,
            sy = 1;
          if (a.handle.includes("e")) sx = (x - a.ox) / Math.max(1, b.x + b.w - a.ox);
          if (a.handle.includes("w")) sx = (a.ox - x) / Math.max(1, a.ox - b.x);
          if (a.handle.includes("s")) sy = (y - a.oy) / Math.max(1, b.y + b.h - a.oy);
          if (a.handle.includes("n")) sy = (a.oy - y) / Math.max(1, a.oy - b.y);
          if (a.handle.length === 2) sx = sy = Math.max(0.05, Math.max(sx, sy));
          this.preview = { kind: "scale", dx: 0, dy: 0, sx: Math.max(0.05, sx), sy: Math.max(0.05, sy), ox: a.ox, oy: a.oy, ang: 0, cx: 0, cy: 0 };
        }
        this.cb.onView?.();
        this.requestLive();
        break;
      }
      case "shape": {
        const r = this.rectOf(a.pageId)!;
        for (const ce of list) {
          const lp = this.local(ce);
          const w = this.toWorld(lp.x, lp.y);
          a.x1 = w.x - r.x;
          a.y1 = w.y - r.y;
          a.pts.push(round2(a.x1), round2(a.y1), 0.5);
        }
        this.requestLive();
        break;
      }
      case "pan": {
        const dx = p.x - a.lx,
          dy = p.y - a.ly;
        const now = performance.now();
        const dt = Math.max(1, now - a.lt);
        a.vx = a.vx * 0.6 + (dx / dt) * 0.4;
        a.vy = a.vy * 0.6 + (dy / dt) * 0.4;
        a.lx = p.x;
        a.ly = p.y;
        a.lt = now;
        a.moved += Math.abs(dx) + Math.abs(dy);
        this.scrollBy(-dx, -dy);
        break;
      }
      case "laser":
        for (const ce of list) {
          const lp = this.local(ce);
          this.laser.push({ x: lp.x, y: lp.y, t: performance.now() });
        }
        this.requestLive();
        break;
      case "ruler-move":
        this.ruler.x += p.x - a.lx;
        this.ruler.y += p.y - a.ly;
        this.ruler.placed = true;
        a.lx = p.x;
        a.ly = p.y;
        this.requestLive();
        break;
      case "ruler-rotate": {
        let A = Math.atan2(p.y - this.ruler.y, p.x - this.ruler.x) - Math.atan2(8, this.ruler.len / 2 - 18);
        const snap = Math.round(A / (Math.PI / 12)) * (Math.PI / 12);
        if (Math.abs(A - snap) < 0.03) A = snap;
        this.ruler.ang = A;
        this.ruler.placed = true;
        this.requestLive();
        break;
      }
      case "zoombox-move": {
        const zb = this.zoombox!;
        const pg = this.session?.page(zb.pageId);
        zb.x = clamp(zb.x + (p.x - a.lx) / this.zoom, 0, (pg?.w ?? 600) - zb.w);
        zb.y = clamp(zb.y + (p.y - a.ly) / this.zoom, 0, (pg?.h ?? 800) - zb.h);
        a.lx = p.x;
        a.ly = p.y;
        this.cb.onView?.();
        this.requestLive();
        break;
      }
    }
  }

  private eraseAlong(x0: number, y0: number, x1: number, y1: number) {
    const st = tools.get().eraser;
    const r = st.size;
    for (const rect of this.rects) {
      if (Math.max(x0, x1) + r < rect.x || Math.min(x0, x1) - r > rect.x + rect.w || Math.max(y0, y1) + r < rect.y || Math.min(y0, y1) - r > rect.y + rect.h) continue;
      const items = this.pageItems(rect.id);
      const ax = x0 - rect.x,
        ay = y0 - rect.y,
        bx = x1 - rect.x,
        by = y1 - rect.y;
      let changed = false;
      const next: Item[] = [];
      for (const it of items) {
        if (it.kind !== "stroke" || (st.highlighterOnly && it.pen !== "highlighter")) {
          next.push(it);
          continue;
        }
        if (st.mode === "stroke") {
          if (strokeHitBySegment(it, ax, ay, bx, by, r)) changed = true;
          else next.push(it);
        } else {
          const parts = st.mode === "exact" ? eraseStrokeExact(it, ax, ay, bx, by, r) : eraseStrokePart(it, ax, ay, bx, by, r);
          if (parts === null) next.push(it);
          else {
            changed = true;
            next.push(...parts);
          }
        }
      }
      if (changed) {
        this.overrides.set(rect.id, next);
        this.requestBase();
      }
    }
  }

  private onUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    const a = this.action;
    this.el.style.cursor = "";
    if (!a) return;
    if (a.kind === "pinch") {
      if ([...this.pointers.values()].filter((q) => q.type === "touch").length < 2) {
        this.action = null;
        this.gestureUntil = 0;
        this.requestBase();
      }
      return;
    }
    if (!("pid" in a) || a.pid !== e.pointerId) return;
    this.action = null;
    const s = this.session!;
    switch (a.kind) {
      case "stroke": {
        clearTimeout(a.holdTimer);
        if (!a.pts.length) break;
        // Scribble to erase: a back-and-forth scrub over ink removes the ink it covers instead of adding a stroke.
        if (!a.shape && !a.snap && !a.straight && a.pen !== "highlighter" && settingsStore.get().scribbleErase !== false && isScribble(a.pts)) {
          const items = this.pageItems(a.pageId);
          const victims = scribbleTargets(items, a.pts, a.width * 1.35);
          if (victims.length) {
            const ids = new Set(victims.map((v) => v.id));
            s.setItems(a.pageId, items.filter((it) => !ids.has(it.id)), "Scribble erase");
            this.requestBase();
            break;
          }
        }
        let stroke: Stroke;
        if (a.shape) stroke = { ...a.shape, t1: Date.now() };
        else stroke = { id: uid(), kind: "stroke", pen: a.pen, color: a.color, width: a.width, stabilization: a.stabilization, opacity: a.opacity, pts: a.pts, t0: a.t0, t1: Date.now(), ...(a.snap || a.straight ? { shape: true } : {}), ...(a.dash ? { dash: a.dash } : {}) };
        if ((a.straight || a.snap) && !a.shape && stroke.pts.length >= 6) {
          const n = stroke.pts.length;
          stroke.pts = [stroke.pts[0], stroke.pts[1], 0.5, stroke.pts[n - 3], stroke.pts[n - 2], 0.5];
        }
        s.addItems(a.pageId, [stroke], a.shape ? "Shape" : a.pen === "highlighter" ? "Highlight" : "Write");
        break;
      }
      case "erase": {
        const ov = [...this.overrides.entries()];
        this.overrides.clear();
        for (const [pid, items] of ov) s.setItems(pid, items, "Erase");
        this.requestBase();
        break;
      }
      case "lasso": {
        const items = this.pageItems(a.pageId);
        let picked = lassoSelect(items, a.poly, tools.get().lasso.select ?? "touch");
        if (!picked.length && a.poly.length <= 10) {
          const hit = [...items].reverse().find((it) => itemHit(it, a.poly[0], a.poly[1], 6 / this.zoom));
          if (hit) picked = [hit];
        }
        this.setSelection(picked.length ? { pageId: a.pageId, ids: new Set(picked.map((i) => i.id)) } : null);
        break;
      }
      case "move":
      case "scale":
      case "rotate":
        this.commitTransform(a.kind);
        break;
      case "shape": {
        const st = tools.get().shapes;
        let xy: number[] | null = null;
        let closed = false;
        if (st.kind === "auto") {
          const shp = recognizeShape(a.pts);
          if (shp) {
            xy = shp.xy;
            closed = shp.closed;
          } else if (a.pts.length >= 6) {
            s.addItems(a.pageId, [{ id: uid(), kind: "stroke", pen: "ballpoint", color: st.color, width: st.width, pts: a.pts, t0: a.t0, t1: Date.now() }], "Draw");
          }
        } else if (Math.hypot(a.x1 - a.x0, a.y1 - a.y0) > 3) {
          const shp = dragShape(st.kind, a.x0, a.y0, a.x1, a.y1, st.width);
          xy = shp.xy;
          closed = shp.closed;
        }
        if (xy) {
          const stroke: Stroke = {
            id: uid(),
            kind: "stroke",
            pen: "ballpoint",
            color: st.color,
            width: st.width,
            pts: shapeToPts(xy),
            t0: a.t0,
            t1: Date.now(),
            shape: true,
            closed,
            ...(closed && st.fill ? { fill: st.fill } : {}),
          };
          s.addItems(a.pageId, [stroke], "Shape");
        }
        break;
      }
      case "pan":
        if (a.moved < 6) this.handleTap(a.tapX, a.tapY);
        else this.startInertia(a.vx, a.vy);
        break;
      case "tap": {
        const w = this.toWorld(a.x, a.y);
        const idx = this.pageIndexAt(w.x, w.y);
        if (idx === -1) break;
        const r = this.rects[idx];
        const px = w.x - r.x,
          py = w.y - r.y;
        if (a.tool === "text") {
          const items = this.pageItems(r.id);
          const hit = [...items].reverse().find((it) => it.kind === "text" && itemHit(it, px, py, 2));
          if (hit) this.cb.onEditText?.({ pageId: r.id, id: hit.id });
          else {
            const ts = tools.get().text;
            const width = Math.max(80, Math.min(260, r.w - px - 8));
            const t: TextEl = { id: uid(), kind: "text", x: px, y: py - ts.size * 0.8, w: width, h: ts.size * 1.6, rot: 0, text: "", ...ts, t0: Date.now() };
            s.addItems(r.id, [t], "Text");
            this.cb.onEditText?.({ pageId: r.id, id: t.id });
          }
        } else if (a.tool === "image") this.cb.onRequestImage?.(r.id, px, py);
        break;
      }
    }
    this.requestLive();
  }

  private commitTransform(kind: "move" | "scale" | "rotate") {
    const s = this.session!;
    const sel = this.selection;
    const pv = this.preview;
    if (sel && pv && (pv.dx || pv.dy || pv.sx !== 1 || pv.sy !== 1 || pv.ang)) {
      const moved = this.transformed(this.selectionItems());
      this.preview = null;
      const r = this.rectOf(sel.pageId)!;
      const b = unionRect(moved.map(itemBounds))!;
      const target = this.pageIndexAt(r.x + b.x + b.w / 2, r.y + b.y + b.h / 2);
      if (kind === "move" && target !== -1 && this.rects[target].id !== sel.pageId) {
        // dragged onto another page: move the items there
        const t = this.rects[target];
        const shifted = moved.map((it) => translateItem(it, r.x - t.x, r.y - t.y));
        s.removeItems(sel.pageId, sel.ids, "Move");
        s.addItems(t.id, shifted, "Move");
        this.setSelection({ pageId: t.id, ids: new Set(shifted.map((i) => i.id)) });
      } else {
        s.replaceItems(sel.pageId, new Map<ID, Item[]>(moved.map((it) => [it.id, [it]])), kind === "move" ? "Move" : kind === "scale" ? "Resize" : "Rotate");
        this.cb.onSelection?.(this.selection);
      }
    } else if (sel && kind === "move") {
      const items = this.selectionItems();
      if (items.length === 1 && items[0].kind === "text") this.cb.onEditText?.({ pageId: sel.pageId, id: items[0].id });
    }
    this.preview = null;
    this.requestBase();
  }

  private handleTap(x: number, y: number) {
    const w = this.toWorld(x, y);
    const idx = this.pageIndexAt(w.x, w.y);
    if (idx === -1) return;
    const r = this.rects[idx];
    const px = w.x - r.x,
      py = w.y - r.y;
    const link = this.linkAt(r.id, px, py);
    if (link) {
      this.cb.onFollowLink?.(link);
      return;
    }
    if (this.cb.onStrokeTap) {
      const items = this.pageItems(r.id);
      const hit = [...items].reverse().find((it) => it.kind === "stroke" && itemHit(it, px, py, 6 / this.zoom)) as Stroke | undefined;
      if (hit) this.cb.onStrokeTap(hit);
    }
  }

  private startInertia(vx: number, vy: number) {
    let lt = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - lt;
      lt = now;
      vx *= Math.pow(0.94, dt / 16);
      vy *= Math.pow(0.94, dt / 16);
      if (Math.abs(vx) + Math.abs(vy) < 0.02) return;
      this.scrollBy(-vx * dt, -vy * dt);
      this.inertia = requestAnimationFrame(step);
    };
    if (Math.abs(vx) + Math.abs(vy) > 0.15) this.inertia = requestAnimationFrame(step);
  }

  private onCancel(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    const a = this.action;
    if (a && "pid" in a && a.pid === e.pointerId) {
      if (a.kind === "stroke") clearTimeout(a.holdTimer);
      this.action = null;
      this.overrides.clear();
      this.preview = null;
      this.requestBase();
    } else if (a?.kind === "pinch") this.action = null;
  }

  // ------------------------------------------------------------------ misc API
  visibleCenter(): { pageId: ID; x: number; y: number } | null {
    const v = this.visiblePageRect();
    if (!v) return null;
    return { pageId: v.pageId, x: v.x + v.w / 2, y: v.y + v.h / 2 };
  }

  lastPointer(): { pageId: ID; x: number; y: number } | null {
    const w = this.lastPointerWorld;
    if (!w) return null;
    const idx = this.pageIndexAt(w.x, w.y);
    if (idx === -1) return null;
    const r = this.rects[idx];
    return { pageId: r.id, x: w.x - r.x, y: w.y - r.y };
  }

  ensureZoomBox() {
    if (this.zoombox && this.session?.page(this.zoombox.pageId)) return this.zoombox;
    const v = this.visiblePageRect();
    const pg = v && this.session?.page(v.pageId);
    if (!v || !pg) return null;
    const w = Math.min(pg.w * 0.42, 260),
      h = w * 0.32;
    this.zoombox = { pageId: v.pageId, x: pg.w * 0.08, y: Math.max(pg.h * 0.08, v.y + 20), w, h };
    this.requestLive();
    return this.zoombox;
  }
}
