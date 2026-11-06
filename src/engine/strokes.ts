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
    // Stylus pressure (Apple Pencil especially) is noisy; a wider weighted window keeps
    // the line weight steady while still following deliberate pressure changes.
    const raw = out.map((q) => q[2]);
    const W = [1, 2, 3, 2, 1];
    for (let i = 1; i < out.length - 1; i++) {
      let s = 0, w = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j < 0 || j >= raw.length) continue;
        s += raw[j] * W[k + 2];
        w += W[k + 2];
      }
      out[i][2] = s / w;
    }
  }
  return curveFill(out, Math.max(0.4, Math.min(1.5, width * 1.35 * 0.35)));
}

/**
 * perfect-freehand joins consecutive samples with straight lines. When samples are far
 * apart (fast writing, or browsers such as iPad Safari that report fewer Apple Pencil
 * positions), that shows as straight segments joined at corners. Fill any gap longer
 * than `step` with points on a centripetal Catmull-Rom curve through the neighbouring
 * samples (centripetal: no loops or overshoot on uneven spacing); pressure is
 * interpolated linearly.
 */
function curveFill(pts: number[][], step: number): number[][] {
  const n = pts.length;
  if (n < 3) return pts;
  const out: number[][] = [];
  const at = (i: number) => pts[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    out.push(p1);
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (d <= step) continue;
    // reflect the missing neighbour at the ends of the stroke
    const p0 = i > 0 ? at(i - 1) : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1], p1[2]];
    const p3 = i + 2 < n ? at(i + 2) : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1], p2[2]];
    const k = Math.min(32, Math.ceil(d / step));
    for (let j = 1; j < k; j++) {
      const t = j / k;
      const [x, y] = centripetal(p0, p1, p2, p3, t);
      out.push([x, y, p1[2] + (p2[2] - p1[2]) * t]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

function centripetal(p0: number[], p1: number[], p2: number[], p3: number[], u: number): [number, number] {
  const knot = (a: number[], b: number[]) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a: number[], b: number[], ta: number, tb: number) => {
    const f = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
  const c = lerp(b1, b2, t1, t2);
  return [c[0], c[1]];
}

/**
 * Ball pen ink: a line of constant width drawn exactly through the pen samples, like real
 * ink. No outline geometry (which bulges or spikes at sharp direction changes) and no
 * trailing "streamline" smoothing (which lags and rounds off corners). Gaps between
 * samples are filled with the same curve as other pens. Stabilization, if set, applies a
 * small centred average — it smooths jitter without pulling the line away from the pen.
 * Returns flat [x, y, pressure, ...] points.
 */
export function inkLinePoints(pts: number[], width: number, stabilization = 0.45): number[] {
  return exactPathPoints(pts, width, false, stabilization);
}

/** Pen samples cleaned and curve-filled, with a small centred (lag-free) smoothing. */
function exactPathPoints(pts: number[], width: number, usePressure: boolean, stabilization: number): number[] {
  const c = strokeInput(pts, width, usePressure);
  const r = Math.round(Math.max(0, Math.min(1, stabilization)) * 2);
  const n = c.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (r === 0 || i === 0 || i === n - 1) {
      out.push(c[i][0], c[i][1], c[i][2]);
      continue;
    }
    let sx = 0, sy = 0, k = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) (sx += c[j][0]), (sy += c[j][1]), k++;
    out.push(sx / k, sy / k, c[i][2]);
  }
  return out;
}

/** Strokes drawn as a plain ink line (ball pen, freehand, solid). */
export function isInkLineStroke(s: Pick<Stroke, "pen" | "shape" | "dash">) {
  return s.pen === "ballpoint" && !s.shape && !s.dash;
}

/** Line width of a ball pen ink line (same visual weight as before). */
export const inkLineWidth = (width: number) => width * 1.35;

/** Fountain pen and brush strokes: exact pen path with pressure-varying width. */
export function isVariableInkStroke(s: Pick<Stroke, "pen" | "shape" | "dash">) {
  return (s.pen === "fountain" || s.pen === "brush") && !s.shape && !s.dash;
}

/**
 * Fountain pen / brush ink built from the exact pen path (no trailing lag): a strip of
 * quads along the centre line whose half-width follows pressure (same formula as before:
 * size * (0.5 - thinning * (0.5 - pressure))), narrowed by each pen's start/end tapers,
 * plus round caps at the ends and at sharp turns. All pieces share one winding direction,
 * so filled together (non-zero rule) they form one even, seamless shape with none of the
 * bulges an outline produces at sharp reversals. Returns polygons as flat [x, y, ...] lists.
 */
export function variableInkPolygons(
  s: Pick<Stroke, "pen" | "width" | "pts" | "stabilization" | "cutStart" | "cutEnd">,
  usePressure = true,
): number[][] {
  const feel = PEN_FEEL[s.pen as Exclude<PenKind, "highlighter">] ?? PEN_FEEL.fountain;
  const c = exactPathPoints(s.pts, s.width, usePressure, s.stabilization ?? 0.45);
  const n = c.length / 3;
  const size = s.width * 1.35;
  const polys: number[][] = [];
  if (!n) return polys;
  // distance along the stroke, for tapers
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(c[i * 3] - c[i * 3 - 3], c[i * 3 + 1] - c[i * 3 - 2]);
  const L = dist[n - 1];
  const ts = s.cutStart ? 0 : feel.taperStart, te = s.cutEnd ? 0 : feel.taperEnd;
  const ease = (t: number) => t * (2 - t);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = usePressure ? c[i * 3 + 2] : 0.5;
    let rad = size * (0.5 - feel.thinning * (0.5 - p));
    if (ts > 0 && dist[i] < ts) rad *= ease(Math.max(0, dist[i] / ts));
    if (te > 0 && L - dist[i] < te) rad *= ease(Math.max(0, (L - dist[i]) / te));
    r[i] = Math.max(size * 0.04, rad);
  }
  const circle = (x: number, y: number, rad: number) => {
    const k = Math.max(10, Math.min(28, Math.ceil(rad * 6)));
    const out: number[] = [];
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2;
      out.push(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    return out;
  };
  if (n === 1 || L < 0.01) {
    polys.push(circle(c[0], c[1], r[0]));
    return orient(polys);
  }
  // unit direction of each segment
  const dx: number[] = [], dy: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const ax = c[i * 3 + 3] - c[i * 3], ay = c[i * 3 + 4] - c[i * 3 + 1];
    const l = Math.hypot(ax, ay) || 1;
    dx.push(ax / l);
    dy.push(ay / l);
  }
  // vertex normals: averaged across gentle turns (shared edges, no gaps); at sharp turns
  // each segment keeps its own normal and a round cap fills the corner
  const sharp = new Uint8Array(n);
  sharp[0] = sharp[n - 1] = 1;
  for (let i = 1; i < n - 1; i++) {
    const dot = dx[i - 1] * dx[i] + dy[i - 1] * dy[i];
    if (dot < Math.cos(0.6)) sharp[i] = 1;
  }
  const normalAt = (i: number, seg: number) => {
    if (sharp[i] || i === 0 || i === n - 1) return [-dy[seg], dx[seg]];
    const nx = -(dy[i - 1] + dy[i]), ny = dx[i - 1] + dx[i];
    const l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l];
  };
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = normalAt(i, i);
    const [bx, by] = normalAt(i + 1, i);
    const x0 = c[i * 3], y0 = c[i * 3 + 1], x1 = c[i * 3 + 3], y1 = c[i * 3 + 4];
    polys.push([x0 + ax * r[i], y0 + ay * r[i], x1 + bx * r[i + 1], y1 + by * r[i + 1], x1 - bx * r[i + 1], y1 - by * r[i + 1], x0 - ax * r[i], y0 - ay * r[i]]);
  }
  for (let i = 0; i < n; i++) if (sharp[i]) polys.push(circle(c[i * 3], c[i * 3 + 1], r[i]));
  return orient(polys);
}

/** Give every polygon the same winding so overlaps add up (never cancel) under non-zero fill. */
function orient(polys: number[][]): number[][] {
  for (const p of polys) {
    let a = 0;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      a += p[i] * p[j + 1] - p[j] * p[i + 1];
    }
    if (a < 0) {
      for (let i = 0, k = p.length - 2; i < k; i += 2, k -= 2) {
        [p[i], p[k]] = [p[k], p[i]];
        [p[i + 1], p[k + 1]] = [p[k + 1], p[i + 1]];
      }
    }
  }
  return polys;
}

/** SVG path (one closed subpath per polygon) for variable ink — used by the canvas and the PDF exporter. */
export function polygonsToSvgPath(polys: number[][]): string {
  let d = "";
  for (const p of polys) {
    if (p.length < 6) continue;
    d += `M${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    for (let i = 2; i < p.length; i += 2) d += ` L${p[i].toFixed(2)},${p[i + 1].toFixed(2)}`;
    d += " Z ";
  }
  return d.trim();
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

/**
 * Smooth closed path around an outline: a quadratic curve through the midpoint of each
 * edge, using each outline point as the control point. Every segment is written as an
 * explicit "Q" (no "T" shorthand or implicit repeats), so the canvas and the PDF exporter
 * (pdf-lib's path parser) draw exactly the same, smooth shape.
 */
export function outlineToSvgPath(points: number[][]): string {
  const len = points.length;
  if (len < 4) {
    if (!len) return "";
    const [x, y] = points[0];
    return `M${x.toFixed(2)},${y.toFixed(2)}Z`;
  }
  const f = (v: number) => v.toFixed(2);
  const mid = (a: number[], b: number[]) => `${f((a[0] + b[0]) / 2)},${f((a[1] + b[1]) / 2)}`;
  let d = `M${mid(points[0], points[1])}`;
  for (let i = 1; i <= len; i++) {
    const p = points[i % len];
    const q = points[(i + 1) % len];
    d += ` Q${f(p[0])},${f(p[1])} ${mid(p, q)}`;
  }
  return d + " Z";
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
