import { getStroke, getStrokePoints } from "perfect-freehand";
import type { PenKind, Stroke } from "../model/types";

export interface PenFeel {
  thinning: number;
  smoothing: number;
  streamline: number;
  taperStart: number;
  taperEnd: number;
}

export const PEN_FEEL: Record<Exclude<PenKind, "highlighter">, PenFeel> = {
  ballpoint: { thinning: 0.18, smoothing: 0.6, streamline: 0.42, taperStart: 0, taperEnd: 0 },
  pencil: { thinning: 0.3, smoothing: 0.72, streamline: 0.58, taperStart: 2, taperEnd: 4 },
  fountain: { thinning: 0.62, smoothing: 0.62, streamline: 0.5, taperStart: 0, taperEnd: 6 },
  brush: { thinning: 0.86, smoothing: 0.72, streamline: 0.52, taperStart: 14, taperEnd: 22 },
};

const outlineCache = new WeakMap<Stroke, number[][]>();

/**
 * Clean up raw pointer samples before perfect-freehand builds the outline.
 * Pointer events (especially coalesced ones) arrive far denser than the ink is wide,
 * with tiny jitter in position and pressure; perfect-freehand derives the edge from
 * each step's direction and pressure, so dense jittery input makes long strokes ripple
 * and can leave a hook at the start. Here samples are thinned to a spacing tied to the
 * stroke width, each kept point takes the average pressure of the samples it replaces,
 * and pressure is lightly smoothed. Stored stroke data is never modified.
 */
export function strokeInput(pts: number[], width: number, usePressure = true): number[][] {
  const n = pts.length / 3;
  if (n === 0) return [];
  const minGap = Math.max(0.25, Math.min(1.2, width * 1.35 * 0.22));
  const gap2 = minGap * minGap;
  const out: number[][] = [];
  let lx = pts[0], ly = pts[1], pSum = usePressure ? pts[2] : 0.5, pCount = 1;
  out.push([lx, ly, pSum]);
  for (let i = 1; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], p = usePressure ? pts[i * 3 + 2] : 0.5;
    pSum += p;
    pCount++;
    const dx = x - lx, dy = y - ly;
    if (dx * dx + dy * dy >= gap2) {
      out.push([x, y, pSum / pCount]);
      lx = x;
      ly = y;
      pSum = 0;
      pCount = 0;
    }
  }
  // always end exactly where the pen lifted (or currently is, for a live stroke)
  const ex = pts[(n - 1) * 3], ey = pts[(n - 1) * 3 + 1];
  const last = out[out.length - 1];
  if (n > 1 && (last[0] !== ex || last[1] !== ey)) {
    if (out.length > 1 && (ex - last[0]) ** 2 + (ey - last[1]) ** 2 < gap2 * 0.25) out[out.length - 1] = [ex, ey, pCount ? pSum / pCount : last[2]];
    else out.push([ex, ey, pCount ? pSum / pCount : last[2]]);
  }
  if (usePressure && out.length > 2) {
    const raw = out.map((q) => q[2]);
    for (let i = 1; i < out.length - 1; i++) out[i][2] = raw[i - 1] * 0.25 + raw[i] * 0.5 + raw[i + 1] * 0.25;
  }
  return out;
}

/** Polygon outline of a variable-width stroke (page coordinates). */
export function strokeOutline(s: Stroke, usePressure = true): number[][] {
  const c = outlineCache.get(s);
  if (c) return c;
  const feel = PEN_FEEL[s.pen as Exclude<PenKind, "highlighter">] ?? PEN_FEEL.ballpoint;
  const input = strokeInput(s.pts, s.width, usePressure);
  const out = getStroke(input, {
    size: s.width * 1.35,
    thinning: feel.thinning,
    smoothing: Math.min(0.95, feel.smoothing + (s.stabilization ?? 0.45) * 0.2),
    streamline: Math.min(0.9, feel.streamline + (s.stabilization ?? 0.45) * 0.25),
    simulatePressure: false,
    last: true,
    start: { taper: s.cutStart ? 0 : feel.taperStart, cap: true },
    end: { taper: s.cutEnd ? 0 : feel.taperEnd, cap: true },
  });
  outlineCache.set(s, out);
  return out;
}

/** Live (in-progress) outline — not cached, `last: false`. */
export function liveOutline(pen: PenKind, width: number, pts: number[], usePressure = true, stabilization = 0.45): number[][] {
  const feel = PEN_FEEL[pen as Exclude<PenKind, "highlighter">] ?? PEN_FEEL.ballpoint;
  const input = strokeInput(pts, width, usePressure);
  return getStroke(input, {
    size: width * 1.35,
    thinning: feel.thinning,
    smoothing: Math.min(0.95, feel.smoothing + stabilization * 0.2),
    streamline: Math.min(0.9, feel.streamline + stabilization * 0.25),
    simulatePressure: false,
    last: false,
    start: { taper: feel.taperStart, cap: true },
    end: { taper: 0, cap: true },
  });
}

/**
 * Smoothed centre line (x, y, pressure triplets) that perfect-freehand builds the
 * outline around, using the same options as strokeOutline / liveOutline. The pencil
 * renderer shades along it so tone follows the outline exactly.
 */
export function strokeCenterline(pen: PenKind, width: number, pts: number[], usePressure = true, stabilization = 0.45, last = true): number[] {
  const feel = PEN_FEEL[pen as Exclude<PenKind, "highlighter">] ?? PEN_FEEL.ballpoint;
  const input = strokeInput(pts, width, usePressure);
  const sp = getStrokePoints(input, {
    size: width * 1.35,
    streamline: Math.min(0.9, feel.streamline + stabilization * 0.25),
    last,
  });
  const out: number[] = [];
  for (const p of sp) out.push(p.point[0], p.point[1], usePressure ? p.pressure : 0.5);
  return out;
}

/** Smooth closed SVG path through outline points using quadratic midpoints. */
export function outlineToSvgPath(points: number[][]): string {
  const len = points.length;
  if (len < 4) {
    if (!len) return "";
    const [x, y] = points[0];
    return `M${x.toFixed(2)},${y.toFixed(2)}Z`;
  }
  let a = points[0],
    b = points[1];
  const c = points[2];
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${((b[0] + c[0]) / 2).toFixed(2)},${((b[1] + c[1]) / 2).toFixed(2)} T`;
  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${((a[0] + b[0]) / 2).toFixed(2)},${((a[1] + b[1]) / 2).toFixed(2)} `;
  }
  return d + "Z";
}

export function polylineSvgPath(pts: number[], closed?: boolean): string {
  if (pts.length < 3) return "";
  let d = `M${pts[0].toFixed(2)},${pts[1].toFixed(2)}`;
  for (let i = 3; i < pts.length; i += 3) d += ` L${pts[i].toFixed(2)},${pts[i + 1].toFixed(2)}`;
  return closed ? d + " Z" : d;
}

export function isPolylineStroke(s: Stroke) {
  return s.pen === "highlighter" || !!s.shape;
}

/** Highlighter / shapes are drawn as a stroked centre line. Returns a smoothed polyline for freehand highlighter. */
export function smoothPolyline(pts: number[]): number[] {
  if (pts.length <= 6) return pts;
  // light moving-average smoothing (keeps endpoints)
  const out = pts.slice();
  for (let i = 3; i < pts.length - 3; i += 3) {
    out[i] = (pts[i - 3] + pts[i] * 2 + pts[i + 3]) / 4;
    out[i + 1] = (pts[i - 2] + pts[i + 1] * 2 + pts[i + 4]) / 4;
  }
  return out;
}
