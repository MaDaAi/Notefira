import { useEffect, useRef, useState } from "react";
import type { DocSession } from "./session";
import type { ViewportController } from "./viewport";
import type { ID, Item, Sticker, Stroke } from "../model/types";
import { searchDoc, pageMatches, type DocHit } from "../services/search";
import { Icon } from "../ui/icons";
import { listStickers, deleteSticker, onChange } from "../storage/repo";
import { translateItem, itemBounds, unionRect } from "../engine/geometry";
import { freshIds } from "./clipboard";
import { uid, clamp } from "../model/util";
import { palmGuard } from "./palm";
import { renderPage, renderPageToCanvasAsync, drawItem, paintPencil, pencilToneLayers, drawInkLine, inkLinePath } from "../engine/render";
import { liveOutline, outlineToSvgPath, strokeCenterline, inkLinePoints, variableInkPolygons, polygonsToSvgPath } from "../engine/strokes";
import { tools } from "./tools";
import { useStore, settingsStore } from "../state/store";
import { ellipsePoints, shapeToPts } from "../engine/shapes";

// ---------------------------------------------------------------------------
// Search in document
// ---------------------------------------------------------------------------
export function SearchPanel({ session, vp, initial, onClose }: { session: DocSession; vp: ViewportController; initial?: string; onClose: () => void }) {
  const [q, setQ] = useState(initial ?? "");
  const [hits, setHits] = useState<DocHit[]>([]);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(async () => {
      const h = await searchDoc(session.doc, session.pages, q);
      setHits(h);
      setIdx(0);
      vp.highlights.clear();
      for (const pid of new Set(h.map((x) => x.pageId))) {
        const p = session.page(pid);
        if (p) vp.highlights.set(pid, await pageMatches(p, q));
      }
      vp.requestLive();
      if (h[0]) vp.scrollToPage(h[0].pageId);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(
    () => () => {
      vp.highlights.clear();
      vp.requestLive();
    },
    [],
  );
  const go = (i: number) => {
    if (!hits.length) return;
    const n = (i + hits.length) % hits.length;
    setIdx(n);
    const h = hits[n];
    const run = vp.highlights.get(h.pageId)?.[0];
    vp.scrollToPage(h.pageId, run?.y);
    vp.flashPage(h.pageId);
  };
  return (
    <aside className="side-panel">
      <div className="panel-head">
        <Icon name="search" size={18} />
        <input
          ref={input}
          className="input grow"
          placeholder="Search this notebook"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") go(e.shiftKey ? idx - 1 : idx + 1);
            if (e.key === "Escape") onClose();
          }}
        />
        <button className="icon-btn small" onClick={onClose} aria-label="Close search">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="row" style={{ padding: "0 12px 8px" }}>
        <span className="muted small grow">{q ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : "Searches PDF text, typed text, recognised handwriting and the outline"}</span>
        <button className="icon-btn small" onClick={() => go(idx - 1)} disabled={!hits.length} aria-label="Previous result">
          <Icon name="chevronLeft" size={16} />
        </button>
        <button className="icon-btn small" onClick={() => go(idx + 1)} disabled={!hits.length} aria-label="Next result">
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <div className="panel-body">
        {hits.map((h, i) => (
          <button key={i} className={"search-hit" + (i === idx ? " on" : "")} onClick={() => go(i)}>
            <span className="search-kind">
              Page {h.index + 1} · {h.kind === "pdf" ? "PDF text" : h.kind === "typed" ? "Typed" : h.kind === "handwriting" ? "Handwriting" : h.kind === "ocr" ? "OCR" : "Outline"}
            </span>
            <span className="search-snip">{h.snippet}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Elements (reusable stickers) panel
// ---------------------------------------------------------------------------
function builtins(): { name: string; items: Item[] }[] {
  const now = Date.now();
  const st = (pts: number[], color: string, width = 2, extra: Partial<Stroke> = {}): Stroke => ({ id: uid(), kind: "stroke", pen: "ballpoint", color, width, pts, t0: now, t1: now, shape: true, ...extra });
  const star: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 14 : 34;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    star.push(40 + Math.cos(a) * r, 40 + Math.sin(a) * r);
  }
  return [
    { name: "Star", items: [st(shapeToPts(star), "#f2a541", 2, { closed: true, fill: "#f2a54155" })] },
    { name: "Check", items: [st(shapeToPts([10, 40, 30, 60, 70, 16]), "#16a34a", 5)] },
    { name: "Arrow", items: [st(shapeToPts([6, 30, 80, 30, 66, 18, 80, 30, 66, 42]), "#130d0c", 3)] },
    { name: "Circle", items: [st(shapeToPts(ellipsePoints(40, 40, 34, 34)), "#c62828", 2.5, { closed: true })] },
    { name: "Box", items: [st(shapeToPts([4, 4, 120, 4, 120, 70, 4, 70]), "#1d4fd8", 2, { closed: true })] },
    {
      name: "Sticky note",
      items: [{ id: uid(), kind: "text", x: 0, y: 0, w: 150, h: 110, rot: 0, text: "Note", font: "hand", size: 18, color: "#3a2d00", bold: false, italic: false, underline: false, align: "left", bg: "#fff3a6" }],
    },
    { name: "Divider", items: [st(shapeToPts([0, 10, 300, 10]), "#9a8f85", 1.5)] },
    {
      name: "Important",
      items: [{ id: uid(), kind: "text", x: 0, y: 0, w: 120, h: 30, rot: 0, text: "IMPORTANT", font: "sans", size: 14, color: "#ffffff", bold: true, italic: false, underline: false, align: "center", bg: "#e4572e" }],
    },
  ];
}

function StickerPreview({ items }: { items: Item[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const b = unionRect(items.map(itemBounds));
    if (!b) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 84,
      H = 64;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    const k = Math.min((W - 8) / b.w, (H - 8) / b.h, 2);
    ctx.setTransform(k * dpr, 0, 0, k * dpr, (W / 2 - (b.x + b.w / 2) * k) * dpr, (H / 2 - (b.y + b.h / 2) * k) * dpr);
    for (const it of items) drawItem(ctx, it, { showLinks: false });
  }, [items]);
  return <canvas ref={ref} style={{ width: 84, height: 64 }} />;
}

export function ElementsPanel({ session, vp, onClose }: { session: DocSession; vp: ViewportController; onClose: () => void }) {
  const [list, setList] = useState<Sticker[]>([]);
  useEffect(() => {
    const load = () => listStickers().then(setList);
    load();
    return onChange((t) => t === "stickers" && load());
  }, []);
  const insert = (items: Item[]) => {
    const c = vp.visibleCenter();
    if (!c) return;
    const b = unionRect(items.map(itemBounds))!;
    const placed = freshIds(items).map((it) => translateItem(it, c.x - (b.x + b.w / 2), c.y - (b.y + b.h / 2)));
    session.addItems(c.pageId, placed, "Insert element");
    vp.setSelection({ pageId: c.pageId, ids: new Set(placed.map((i) => i.id)) });
  };
  return (
    <aside className="side-panel">
      <div className="panel-head">
        <Icon name="elements" size={18} />
        <strong className="grow">Elements</strong>
        <button className="icon-btn small" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-body">
        <p className="small muted" style={{ margin: 0 }}>
          Tap to insert. Save your own: select with the lasso → “Save as element”.
        </p>
        {list.length > 0 && <strong className="small">My elements</strong>}
        <div className="el-grid">
          {list.map((s) => (
            <div key={s.id} className="el-cell">
              <button onClick={() => insert(s.items)} title={s.name}>
                <StickerPreview items={s.items} />
              </button>
              <button className="el-del" onClick={() => deleteSticker(s.id)} aria-label={`Delete ${s.name}`}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
        <strong className="small">Built-in</strong>
        <div className="el-grid">
          {builtins().map((b) => (
            <div key={b.name} className="el-cell">
              <button onClick={() => insert(b.items)} title={b.name}>
                <StickerPreview items={b.items} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Zoom window: write large in a magnified strip, ink lands small on the page
// ---------------------------------------------------------------------------
export function ZoomWindow({ session, vp, onClose, tick }: { session: DocSession; vp: ViewportController; onClose: () => void; tick: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const st = useStore(tools, (s) => s);
  const pressureOn = useStore(settingsStore, (s) => s.pressure);
  const [, force] = useState(0);
  const live = useRef<{ pts: number[]; t0: number; id: number } | null>(null);
  const box = vp.ensureZoomBox();
  const page = box ? session.page(box.pageId) : undefined;

  const draw = () => {
    const c = canvas.current;
    const z = vp.zoombox;
    const pg = z && session.page(z.pageId);
    if (!c || !z || !pg) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth,
      H = c.clientHeight;
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const k = W / z.w;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(k * dpr, 0, 0, k * dpr, -z.x * k * dpr, -z.y * k * dpr);
    renderPage(ctx, pg, { scale: k * dpr, usePressure: pressureOn, onAsync: () => requestAnimationFrame(draw) });
    const l = live.current;
    if (l && l.pts.length) {
      const hl = tools.get().tool === "highlighter";
      if (hl) {
        ctx.globalAlpha = 0.38;
        ctx.strokeStyle = tools.get().highlighter.color;
        ctx.lineWidth = tools.get().highlighter.width;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(l.pts[0], l.pts[1]);
        for (let i = 3; i < l.pts.length; i += 3) ctx.lineTo(l.pts[i], l.pts[i + 1]);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        const pen = tools.get().pen;
        if (pen.pen === "ballpoint" && (!pen.dash || pen.dash === "solid")) {
          drawInkLine(ctx, inkLinePath(inkLinePoints(l.pts, pen.width, pen.stabilization)), pen.color, pen.width);
          return;
        }
        if ((pen.pen === "fountain" || pen.pen === "brush") && (!pen.dash || pen.dash === "solid")) {
          ctx.fillStyle = pen.color;
          ctx.fill(new Path2D(polygonsToSvgPath(variableInkPolygons({ pen: pen.pen, width: pen.width, pts: l.pts, stabilization: pen.stabilization }, pressureOn))));
          return;
        }
        const outline = new Path2D(outlineToSvgPath(liveOutline(pen.pen, pen.width, l.pts, pressureOn)));
        if (pen.pen === "pencil") paintPencil(ctx, outline, pencilToneLayers(strokeCenterline(pen.pen, pen.width, l.pts, pressureOn, 0.45, false)), pen.color, pen.width);
        else {
          ctx.fillStyle = pen.color;
          ctx.fill(outline);
        }
      }
    }
  };
  useEffect(() => {
    draw();
    const un = session.subscribe(draw);
    const ro = new ResizeObserver(draw);
    if (canvas.current) ro.observe(canvas.current);
    return () => {
      un();
      ro.disconnect();
    };
  });
  useEffect(draw, [tick]);

  const toPage = (e: React.PointerEvent) => {
    const z = vp.zoombox!;
    const r = canvas.current!.getBoundingClientRect();
    const k = r.width / z.w;
    return { x: z.x + (e.clientX - r.left) / k, y: z.y + (e.clientY - r.top) / k };
  };
  const down = (e: React.PointerEvent) => {
    if (!vp.zoombox) return;
    if (e.pointerType === "touch" && palmGuard.touchDown(e.pointerId, e.clientX, e.clientY, e.timeStamp, e.width, e.height) !== "draw") return;
    // the pen wins over a finger stroke that a resting palm started here
    if (e.pointerType === "pen" && live.current) live.current = null;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPage(e);
    live.current = { pts: [p.x, p.y, e.pointerType === "pen" ? e.pressure || 0.5 : 0.5], t0: Date.now(), id: e.pointerId };
    draw();
  };
  const move = (e: React.PointerEvent) => {
    const l = live.current;
    if (!l || l.id !== e.pointerId) return;
    const evs: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ce of evs.length ? evs : [e.nativeEvent]) {
      const p = toPage(ce as any);
      l.pts.push(Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, ce.pointerType === "pen" ? ce.pressure || 0.5 : 0.5);
    }
    draw();
  };
  const up = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") palmGuard.touchUp(e.pointerId);
    const l = live.current;
    live.current = null;
    if (!l || l.id !== e.pointerId || !vp.zoombox) return;
    const t = tools.get();
    const hl = t.tool === "highlighter";
    const s: Stroke = { id: uid(), kind: "stroke", pen: hl ? "highlighter" : t.pen.pen, color: hl ? t.highlighter.color : t.pen.color, width: hl ? t.highlighter.width : t.pen.width, pts: l.pts, t0: l.t0, t1: Date.now() };
    session.addItems(vp.zoombox.pageId, [s], "Write");
  };
  const shift = (dir: "left" | "right" | "newline") => {
    const z = vp.zoombox;
    const pg = z && session.page(z.pageId);
    if (!z || !pg) return;
    const margin = pg.w * 0.06;
    if (dir === "left") z.x = Math.max(0, z.x - z.w * 0.85);
    else if (dir === "right") {
      if (z.x + z.w >= pg.w - 2) {
        z.x = margin;
        z.y = Math.min(pg.h - z.h, z.y + z.h);
      } else z.x = Math.min(pg.w - z.w, z.x + z.w * 0.85);
    } else {
      z.x = margin;
      z.y = Math.min(pg.h - z.h, z.y + z.h);
    }
    vp.requestLive();
    if (!vp.visiblePageRect() || z.y * vp.zoom > 0) vp.scrollToPage(z.pageId, z.y);
    force((x) => x + 1);
    draw();
  };
  if (!box || !page) return null;
  return (
    <div className="zoomwin">
      <div className="zoomwin-bar">
        <span className="small muted">Zoom window — write here; drag the blue box on the page to move it</span>
        <span className="spacer" />
        <label className="small row">
          Size
          <input
            type="range"
            min={80}
            max={Math.max(120, page.w * 0.9)}
            value={box.w}
            onChange={(e) => {
              box.w = Number(e.target.value);
              box.h = box.w * 0.32;
              box.x = clamp(box.x, 0, page.w - box.w);
              vp.requestLive();
              force((x) => x + 1);
            }}
            aria-label="Zoom window size"
          />
        </label>
        <button className="icon-btn small" onClick={() => shift("left")} aria-label="Move left">
          <Icon name="chevronLeft" size={16} />
        </button>
        <button className="icon-btn small" onClick={() => shift("right")} aria-label="Move right">
          <Icon name="chevronRight" size={16} />
        </button>
        <button className="icon-btn small" onClick={() => shift("newline")} aria-label="Next line">
          <Icon name="enter" size={16} />
        </button>
        <button className="icon-btn small" onClick={onClose} aria-label="Close zoom window">
          <Icon name="close" size={16} />
        </button>
      </div>
      <canvas ref={canvas} className="zoomwin-canvas" style={{ aspectRatio: `${box.w} / ${box.h}` }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={(e) => {
          if (e.pointerType === "touch") palmGuard.touchUp(e.pointerId);
          live.current = null;
        }} />
      {st.tool !== "pen" && st.tool !== "highlighter" && <div className="zoomwin-hint small">Choose the pen or highlighter to write in the zoom window.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentation mode
// ---------------------------------------------------------------------------
export function Presentation({ session, start, onClose }: { session: DocSession; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const [url, setUrl] = useState<string | null>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const trail = useRef<{ x: number; y: number; t: number }[]>([]);
  const ids = session.doc.pageIds;
  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    const exit = () => !document.fullscreenElement && onClose();
    document.addEventListener("fullscreenchange", exit);
    return () => {
      document.removeEventListener("fullscreenchange", exit);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const p = session.page(ids[i]);
    if (!p) return;
    const k = Math.min(window.innerWidth / p.w, window.innerHeight / p.h) * (window.devicePixelRatio || 1);
    renderPageToCanvasAsync(p, Math.round(p.w * k), { showLinks: false }).then((c) => {
      if (!alive) return;
      setUrl(c.toDataURL("image/png"));
      c.width = c.height = 0;
    });
    return () => {
      alive = false;
    };
  }, [i]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) setI((x) => Math.min(ids.length - 1, x + 1));
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) setI((x) => Math.max(0, x - 1));
      else if (e.key === "Home") setI(0);
      else if (e.key === "End") setI(ids.length - 1);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [ids.length]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = overlay.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        if (c.width !== window.innerWidth * dpr) {
          c.width = window.innerWidth * dpr;
          c.height = window.innerHeight * dpr;
        }
        const ctx = c.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        const now = performance.now();
        trail.current = trail.current.filter((p) => now - p.t < 650);
        const t = trail.current;
        ctx.lineCap = "round";
        for (let j = 1; j < t.length; j++) {
          const a = 1 - (now - t[j].t) / 650;
          ctx.strokeStyle = `rgba(255,40,60,${a})`;
          ctx.lineWidth = 7 * a + 1;
          ctx.beginPath();
          ctx.moveTo(t[j - 1].x, t[j - 1].y);
          ctx.lineTo(t[j].x, t[j].y);
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div
      className="present"
      onPointerMove={(e) => e.buttons && trail.current.push({ x: e.clientX, y: e.clientY, t: performance.now() })}
      onPointerDown={(e) => trail.current.push({ x: e.clientX, y: e.clientY, t: performance.now() })}
      onDoubleClick={(e) => (e.clientX > window.innerWidth / 2 ? setI((x) => Math.min(ids.length - 1, x + 1)) : setI((x) => Math.max(0, x - 1)))}
    >
      {url && <img src={url} alt={`Page ${i + 1}`} draggable={false} />}
      <canvas ref={overlay} className="present-laser" />
      <div className="present-bar">
        <button onClick={() => setI((x) => Math.max(0, x - 1))} aria-label="Previous">
          <Icon name="chevronLeft" />
        </button>
        <span>
          {i + 1} / {ids.length}
        </span>
        <button onClick={() => setI((x) => Math.min(ids.length - 1, x + 1))} aria-label="Next">
          <Icon name="chevronRight" />
        </button>
        <button onClick={onClose} aria-label="Exit presentation">
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}

export type { ID };
