import type { BoxItem, Item, Stroke } from "../model/types";
import { uid } from "../model/util";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const strokeBoxCache = new WeakMap<Stroke, Rect>();

export function strokeBounds(s: Stroke): Rect {
  const c = strokeBoxCache.get(s);
  if (c) return c;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const p = s.pts;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i],
      y = p[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = s.width;
  const r = p.length ? { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 } : { x: 0, y: 0, w: 0, h: 0 };
  strokeBoxCache.set(s, r);
  return r;
}

export function boxCorners(b: { x: number; y: number; w: number; h: number; rot: number }): [number, number][] {
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  const c = Math.cos(b.rot || 0),
    s = Math.sin(b.rot || 0);
  return [
    [-b.w / 2, -b.h / 2],
    [b.w / 2, -b.h / 2],
    [b.w / 2, b.h / 2],
    [-b.w / 2, b.h / 2],
  ].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

export function itemBounds(it: Item): Rect {
  if (it.kind === "stroke") return strokeBounds(it);
  if (!it.rot) return { x: it.x, y: it.y, w: it.w, h: it.h };
  const pts = boxCorners(it);
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function unionRect(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function pointInRect(x: number, y: number, r: Rect, pad = 0) {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

/** Ray-casting point-in-polygon test. `poly` is a flat [x,y,x,y,...] list. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2],
      yi = poly[i * 2 + 1],
      xj = poly[j * 2],
      yj = poly[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px,
    y = ay + t * dy - py;
  return x * x + y * y;
}

/** Minimum squared distance between two segments. */
export function segSegDistSq(a: number[], b: number[]) {
  const [ax, ay, bx, by] = a;
  const [cx, cy, dx, dy] = b;
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distToSegmentSq(ax, ay, cx, cy, dx, dy),
    distToSegmentSq(bx, by, cx, cy, dx, dy),
    distToSegmentSq(cx, cy, ax, ay, bx, by),
    distToSegmentSq(dx, dy, ax, ay, bx, by),
  );
}

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Does the eraser path segment (x0,y0)->(x1,y1) with radius r touch the stroke? */
export function strokeHitBySegment(s: Stroke, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  const b = strokeBounds(s);
  const ex = { x: Math.min(x0, x1) - r, y: Math.min(y0, y1) - r, w: Math.abs(x1 - x0) + 2 * r, h: Math.abs(y1 - y0) + 2 * r };
  if (!rectsIntersect(b, ex)) return false;
  const rr = (r + s.width / 2) ** 2;
  const p = s.pts;
  const seg = [x0, y0, x1, y1];
  if (p.length === 3) return distToSegmentSq(p[0], p[1], x0, y0, x1, y1) <= rr;
  const n = s.closed ? p.length : p.length - 3;
  for (let i = 0; i < n; i += 3) {
    const j = (i + 3) % p.length;
    if (segSegDistSq([p[i], p[i + 1], p[j], p[j + 1]], seg) <= rr) return true;
  }
  return false;
}

export function itemHit(it: Item, x: number, y: number, r: number): boolean {
  if (it.kind === "stroke") return strokeHitBySegment(it, x, y, x, y, r);
  const poly = boxCorners(it).flat();
  return pointInPolygon(x, y, poly) || pointInRect(x, y, itemBounds(it), r);
}

/** Insert points so consecutive points are at most `spacing` apart. */
export function resample(pts: number[], spacing: number): number[] {
  if (pts.length <= 3) return pts.slice();
  const out = [pts[0], pts[1], pts[2]];
  for (let i = 3; i < pts.length; i += 3) {
    const x0 = out[out.length - 3],
      y0 = out[out.length - 2],
      p0 = out[out.length - 1];
    const x1 = pts[i],
      y1 = pts[i + 1],
      p1 = pts[i + 2];
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d > spacing) {
      const n = Math.ceil(d / spacing);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t);
      }
    }
    out.push(x1, y1, p1);
  }
  return out;
}

/**
 * Precision eraser: removes the parts of a stroke under the eraser path and
 * returns the surviving pieces as new strokes (an empty list if fully erased,
 * or `null` if the stroke is untouched).
 */
export function eraseStrokePart(s: Stroke, x0: number, y0: number, x1: number, y1: number, r: number): Stroke[] | null {
  if (!strokeHitBySegment(s, x0, y0, x1, y1, r)) return null;
  const pts = resample(s.closed ? [...s.pts, s.pts[0], s.pts[1], s.pts[2]] : s.pts, Math.max(0.5, r / 3));
  const rr = (r + s.width / 3) ** 2;
  const pieces: { pts: number[]; cutStart: boolean; cutEnd: boolean }[] = [];
  let cur: number[] = [];
  let curCutStart = !!s.cutStart;
  for (let i = 0; i < pts.length; i += 3) {
    const hit = distToSegmentSq(pts[i], pts[i + 1], x0, y0, x1, y1) <= rr;
    if (hit) {
      if (cur.length >= 6) pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: true });
      cur = [];
      curCutStart = true;
    } else cur.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  if (cur.length >= 6) pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: !!s.cutEnd });
  return pieces.map((p) => cutPiece(s, p.pts, p.cutStart, p.cutEnd));
}

/** A piece of `s` left after erasing; cut ends are flagged so they don't get the pen's taper. */
function cutPiece(s: Stroke, pts: number[], cutStart: boolean, cutEnd: boolean): Stroke {
  const { cutStart: _a, cutEnd: _b, ...rest } = s;
  return { ...rest, id: uid(), pts, closed: false, fill: undefined, ...(cutStart ? { cutStart: true } : {}), ...(cutEnd ? { cutEnd: true } : {}) };
}

/** Half the visible ink width of a stroke (how far its ink reaches from the centre line). */
export function inkHalfWidth(s: Stroke): number {
  if (s.pen === "highlighter" || s.shape) return s.width / 2;
  return (s.width * 1.35) / 2;
}

/**
 * Precise eraser: removes exactly the part of the stroke whose ink lies under the eraser
 * (a circle of radius r swept from (x0,y0) to (x1,y1)). The centre line is cut where it is
 * `r + inkHalfWidth` from the eraser — so the round end caps of the remaining pieces just
 * touch the eraser's edge — with the cut position interpolated inside each segment.
 * Returns null when the eraser misses the stroke.
 */
export function eraseStrokeExact(s: Stroke, x0: number, y0: number, x1: number, y1: number, r: number): Stroke[] | null {
  const R = r + inkHalfWidth(s);
  if (!strokeHitBySegment(s, x0, y0, x1, y1, R - s.width / 2)) return null;
  const src = s.closed ? [...s.pts, s.pts[0], s.pts[1], s.pts[2]] : s.pts;
  const pts = resample(src, Math.max(0.25, Math.min(1, R / 4)));
  const R2 = R * R;
  const inside = (x: number, y: number) => distToSegmentSq(x, y, x0, y0, x1, y1) <= R2;
  const lerp = (i: number, j: number, t: number) => [pts[i] + (pts[j] - pts[i]) * t, pts[i + 1] + (pts[j + 1] - pts[i + 1]) * t, pts[i + 2] + (pts[j + 2] - pts[i + 2]) * t];
  // parameter on segment i→j where the centre line crosses the eraser boundary
  const crossing = (i: number, j: number, fromInside: boolean) => {
    let lo = 0, hi = 1;
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2;
      const [x, y] = lerp(i, j, m);
      if (inside(x, y) === fromInside) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  const pieces: { pts: number[]; cutStart: boolean; cutEnd: boolean }[] = [];
  let cur: number[] = [];
  let anyRemoved = false;
  let curCutStart = !!s.cutStart;
  const n = pts.length / 3;
  let prevIn = inside(pts[0], pts[1]);
  if (!prevIn) cur.push(pts[0], pts[1], pts[2]);
  else anyRemoved = true;
  for (let k = 1; k < n; k++) {
    const i = (k - 1) * 3, j = k * 3;
    const isIn = inside(pts[j], pts[j + 1]);
    if (!prevIn && isIn) {
      cur.push(...lerp(i, j, crossing(i, j, false)));
      if (cur.length >= 6) pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: true });
      cur = [];
      anyRemoved = true;
    } else if (prevIn && !isIn) {
      cur = [...lerp(i, j, crossing(i, j, true)), pts[j], pts[j + 1], pts[j + 2]];
      curCutStart = true;
    } else if (!isIn) {
      cur.push(pts[j], pts[j + 1], pts[j + 2]);
    }
    prevIn = isIn;
  }
  if (cur.length >= 6) pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: !!s.cutEnd });
  if (!anyRemoved) return null;
  return pieces.map((p) => cutPiece(s, p.pts, p.cutStart, p.cutEnd));
}

/**
 * Scribble detection for "scribble to erase": a quick back-and-forth scrub. Looks for at
 * least 4 reversals along the scribble's main direction (each reversal must travel ≥ 30%
 * of the scribble's length on that axis, so loops in cursive or the turns in "m"/"w",
 * which keep moving sideways, don't count) and a path much longer than its extent.
 */
export function isScribble(pts: number[]): boolean {
  const n = pts.length / 3;
  if (n < 16) return false;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) (mx += pts[i * 3]), (my += pts[i * 3 + 1]);
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 3] - mx, dy = pts[i * 3 + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // principal axis
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const proj: number[] = [];
  let lo = Infinity, hi = -Infinity, len = 0;
  for (let i = 0; i < n; i++) {
    const t = (pts[i * 3] - mx) * ux + (pts[i * 3 + 1] - my) * uy;
    proj.push(t);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
    if (i) len += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2]);
  }
  const extent = hi - lo;
  if (extent < 4) return false;
  const b = boundsOfPts(pts);
  if (len / Math.max(1, Math.hypot(b.w, b.h)) < 3) return false;
  const hyst = extent * 0.3;
  // dir: +1 moving up the axis, -1 moving down, 0 not yet known. `anchor` is the furthest
  // point reached in the current direction; a reversal is a pull-back of more than `hyst`.
  let dir = 0, reversals = 0, anchor = proj[0], runMin = proj[0], runMax = proj[0];
  for (const t of proj) {
    if (dir === 0) {
      runMin = Math.min(runMin, t);
      runMax = Math.max(runMax, t);
      if (t - runMin > hyst) (dir = 1), (anchor = t);
      else if (runMax - t > hyst) (dir = -1), (anchor = t);
      continue;
    }
    if (dir > 0) {
      if (t > anchor) anchor = t;
      else if (anchor - t > hyst) (dir = -1), (anchor = t), reversals++;
    } else {
      if (t < anchor) anchor = t;
      else if (t - anchor > hyst) (dir = 1), (anchor = t), reversals++;
    }
  }
  return reversals >= 4;
}

function boundsOfPts(pts: number[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Strokes a scribble covers: touched by the scribble and with at least half of their
 * ink inside the scribbled area (its bounding box, padded by the scribble width).
 */
export function scribbleTargets(items: Item[], scribble: number[], width: number): Stroke[] {
  const b = boundsOfPts(scribble);
  const pad = width * 1.5;
  const area = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  const n = scribble.length / 3;
  const out: Stroke[] = [];
  for (const it of items) {
    if (it.kind !== "stroke") continue;
    if (!rectsIntersect(strokeBounds(it), area)) continue;
    let touched = false;
    for (let i = 0; i < n - 1 && !touched; i++) {
      touched = strokeHitBySegment(it, scribble[i * 3], scribble[i * 3 + 1], scribble[i * 3 + 3], scribble[i * 3 + 4], width / 2);
    }
    if (!touched) continue;
    const p = it.pts, m = p.length / 3;
    let inside = 0;
    for (let i = 0; i < m; i++) if (pointInRect(p[i * 3], p[i * 3 + 1], area, 0)) inside++;
    if (inside / m >= 0.5) out.push(it);
  }
  return out;
}

export type LassoSelectMode = "touch" | "enclose";

/**
 * Items chosen by a lasso polygon.
 *  - "touch": anything the lasso touches — a stroke with any point inside or any segment
 *    crossing the lasso line; a box that overlaps the lasso area or is crossed by it.
 *  - "enclose": only items entirely inside — every stroke point / all four box corners.
 *  - legacy (no mode): strokes with at least half their points inside, boxes whose centre is inside.
 */
export function lassoSelect(items: Item[], poly: number[], mode?: LassoSelectMode): Item[] {
  if (mode === "touch" || mode === "enclose") return lassoSelectBy(items, poly, mode);
  return lassoSelectHalf(items, poly);
}

function lassoSelectBy(items: Item[], poly: number[], mode: LassoSelectMode): Item[] {
  if (poly.length < 4) return [];
  const lb = polyBounds(poly);
  const np = poly.length / 2;
  const crossesLasso = (ax: number, ay: number, bx: number, by: number) => {
    for (let j = 0; j < np; j++) {
      const k = (j + 1) % np;
      if (segmentsIntersect(ax, ay, bx, by, poly[j * 2], poly[j * 2 + 1], poly[k * 2], poly[k * 2 + 1])) return true;
    }
    return false;
  };
  return items.filter((it) => {
    const b = itemBounds(it);
    if (!rectsIntersect(b, lb)) return false;
    if (it.kind === "stroke") {
      const p = it.pts;
      const n = p.length / 3;
      if (mode === "enclose") {
        for (let i = 0; i < n; i++) if (!pointInPolygon(p[i * 3], p[i * 3 + 1], poly)) return false;
        return n > 0;
      }
      const step = Math.max(1, Math.floor(n / 80));
      for (let i = 0; i < n; i += step) if (pointInPolygon(p[i * 3], p[i * 3 + 1], poly)) return true;
      // the lasso line passes through the stroke without enclosing any of its points
      for (let i = 0; i < n - 1; i += step) {
        const e = Math.min(n - 1, i + step);
        if (crossesLasso(p[i * 3], p[i * 3 + 1], p[e * 3], p[e * 3 + 1])) return true;
      }
      return false;
    }
    const corners = [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h];
    const inside = [0, 2, 4, 6].map((i) => pointInPolygon(corners[i], corners[i + 1], poly));
    if (mode === "enclose") return inside.every(Boolean);
    if (inside.some(Boolean)) return true;
    // lasso drawn inside the box, or crossing one of its edges
    if (poly[0] >= b.x && poly[0] <= b.x + b.w && poly[1] >= b.y && poly[1] <= b.y + b.h) return true;
    for (let i = 0; i < 8; i += 2) {
      const j = (i + 2) % 8;
      if (crossesLasso(corners[i], corners[i + 1], corners[j], corners[j + 1])) return true;
    }
    return false;
  });
}

function polyBounds(poly: number[]): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]);
    maxY = Math.max(maxY, poly[i + 1]);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function lassoSelectHalf(items: Item[], poly: number[]): Item[] {
  if (poly.length < 6) return [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]);
    maxY = Math.max(maxY, poly[i + 1]);
  }
  const lb = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  return items.filter((it) => {
    const b = itemBounds(it);
    if (!rectsIntersect(b, lb)) return false;
    if (it.kind === "stroke") {
      const p = it.pts;
      const n = p.length / 3;
      const step = Math.max(1, Math.floor(n / 40));
      let inside = 0,
        total = 0;
      for (let i = 0; i < n; i += step) {
        total++;
        if (pointInPolygon(p[i * 3], p[i * 3 + 1], poly)) inside++;
      }
      return inside / total >= 0.5;
    }
    return pointInPolygon(it.x + it.w / 2, it.y + it.h / 2, poly);
  });
}

// ---------------------------------------------------------------------------
// Transforms for selections
// ---------------------------------------------------------------------------
export function translateItem(it: Item, dx: number, dy: number): Item {
  if (it.kind === "stroke") {
    const p = it.pts.slice();
    for (let i = 0; i < p.length; i += 3) {
      p[i] += dx;
      p[i + 1] += dy;
    }
    return { ...it, pts: p };
  }
  return { ...it, x: it.x + dx, y: it.y + dy };
}

/** Scale around an origin. Stroke widths scale with the geometric mean of the factors. */
export function scaleItem(it: Item, ox: number, oy: number, sx: number, sy: number): Item {
  if (it.kind === "stroke") {
    const p = it.pts.slice();
    for (let i = 0; i < p.length; i += 3) {
      p[i] = ox + (p[i] - ox) * sx;
      p[i + 1] = oy + (p[i + 1] - oy) * sy;
    }
    const k = Math.sqrt(Math.abs(sx * sy));
    return { ...it, pts: p, width: Math.max(0.2, it.width * k) };
  }
  const cx = it.x + it.w / 2,
    cy = it.y + it.h / 2;
  const ncx = ox + (cx - ox) * sx,
    ncy = oy + (cy - oy) * sy;
  const w = Math.max(4, it.w * Math.abs(sx)),
    h = Math.max(4, it.h * Math.abs(sy));
  const next: BoxItem = { ...it, x: ncx - w / 2, y: ncy - h / 2, w, h };
  if (next.kind === "text") next.size = Math.max(4, Math.round(it.kind === "text" ? it.size * Math.sqrt(Math.abs(sx * sy)) * 10 : 0) / 10);
  return next;
}

export function rotateItem(it: Item, cx: number, cy: number, angle: number): Item {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  if (it.kind === "stroke") {
    const p = it.pts.slice();
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] - cx,
        y = p[i + 1] - cy;
      p[i] = cx + x * c - y * s;
      p[i + 1] = cy + x * s + y * c;
    }
    return { ...it, pts: p };
  }
  const bx = it.x + it.w / 2 - cx,
    by = it.y + it.h / 2 - cy;
  const ncx = cx + bx * c - by * s,
    ncy = cy + bx * s + by * c;
  return { ...it, x: ncx - it.w / 2, y: ncy - it.h / 2, rot: (it.rot || 0) + angle };
}

/** Rotate a whole page's content by 90° clockwise (page width/height swap). */
export function rotateItems90(items: Item[], pageH: number): Item[] {
  // (x, y) -> (pageH - y, x)
  return items.map((it) => {
    if (it.kind === "stroke") {
      const p = it.pts.slice();
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i],
          y = p[i + 1];
        p[i] = pageH - y;
        p[i + 1] = x;
      }
      return { ...it, pts: p };
    }
    const cx = it.x + it.w / 2,
      cy = it.y + it.h / 2;
    const ncx = pageH - cy,
      ncy = cx;
    return { ...it, x: ncx - it.w / 2, y: ncy - it.h / 2, rot: (it.rot || 0) + Math.PI / 2 };
  });
}

/** Douglas–Peucker simplification on a flat [x,y,...] list (no pressure). */
export function simplifyDP(xy: number[], eps: number): number[] {
  const n = xy.length / 2;
  if (n < 3) return xy.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1,
      idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegmentSq(xy[i * 2], xy[i * 2 + 1], xy[a * 2], xy[a * 2 + 1], xy[b * 2], xy[b * 2 + 1]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > e2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(xy[i * 2], xy[i * 2 + 1]);
  return out;
}

export function pathLength(xy: number[]) {
  let L = 0;
  for (let i = 2; i < xy.length; i += 2) L += Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]);
  return L;
}

export function toXY(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 3) out.push(pts[i], pts[i + 1]);
  return out;
}

/** Project a point onto an infinite line through (ax,ay) with direction angle `ang`. */
export function projectOnLine(x: number, y: number, ax: number, ay: number, ang: number) {
  const dx = Math.cos(ang),
    dy = Math.sin(ang);
  const t = (x - ax) * dx + (y - ay) * dy;
  return { x: ax + dx * t, y: ay + dy * t, t };
}
