// Shape recognition: turns a freehand stroke into a clean geometric shape
// (line, polyline, triangle, rectangle, polygon, circle, ellipse).

import { pathLength, simplifyDP, toXY } from "./geometry";

export type ShapeKind = "line" | "polyline" | "triangle" | "rectangle" | "polygon" | "ellipse" | "circle";

export interface RecognizedShape {
  kind: ShapeKind;
  /** Flat [x,y,...] vertices; for ellipses a sampled outline. */
  xy: number[];
  closed: boolean;
}

function angleAt(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const v1x = ax - bx,
    v1y = ay - by,
    v2x = cx - bx,
    v2y = cy - by;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d)));
}

export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, rot = 0, n = 72): number[] {
  const out: number[] = [];
  const c = Math.cos(rot),
    s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.cos(t) * rx,
      y = Math.sin(t) * ry;
    out.push(cx + x * c - y * s, cy + x * s + y * c);
  }
  return out;
}

export function recognizeShape(pts: number[]): RecognizedShape | null {
  const xy = toXY(pts);
  const n = xy.length / 2;
  if (n < 3) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    minX = Math.min(minX, xy[i]);
    maxX = Math.max(maxX, xy[i]);
    minY = Math.min(minY, xy[i + 1]);
    maxY = Math.max(maxY, xy[i + 1]);
  }
  const w = maxX - minX,
    h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (diag < 8) return null;
  const L = pathLength(xy);
  const sx = xy[0],
    sy = xy[1],
    ex = xy[xy.length - 2],
    ey = xy[xy.length - 1];
  const chord = Math.hypot(ex - sx, ey - sy);

  // Straight line
  if (chord / L > 0.94) return { kind: "line", xy: [sx, sy, ex, ey], closed: false };

  const closed = chord < Math.max(0.22 * diag, 12) && L > diag * 1.6;
  if (closed) {
    // Ellipse fit test against the bounding ellipse.
    const cx = minX + w / 2,
      cy = minY + h / 2,
      rx = w / 2 || 1,
      ry = h / 2 || 1;
    let dev = 0;
    for (let i = 0; i < xy.length; i += 2) {
      const d = Math.sqrt(((xy[i] - cx) / rx) ** 2 + ((xy[i + 1] - cy) / ry) ** 2);
      dev += Math.abs(1 - d);
    }
    dev /= n;

    const ring = [...xy, sx, sy];
    let poly = simplifyDP(ring, diag * 0.075);
    // drop the duplicated closing vertex
    if (poly.length >= 4 && Math.hypot(poly[0] - poly[poly.length - 2], poly[1] - poly[poly.length - 1]) < diag * 0.15) poly = poly.slice(0, -2);
    // merge near-collinear vertices
    poly = mergeCollinear(poly, 0.35);
    const verts = poly.length / 2;

    if (verts === 3) return { kind: "triangle", xy: poly, closed: true };
    if (verts === 4 && dev > 0.07) {
      let rightish = 0;
      for (let i = 0; i < 4; i++) {
        const a = (i + 3) % 4,
          c = (i + 1) % 4;
        const ang = angleAt(poly[a * 2], poly[a * 2 + 1], poly[i * 2], poly[i * 2 + 1], poly[c * 2], poly[c * 2 + 1]);
        if (Math.abs(ang - Math.PI / 2) < 0.4) rightish++;
      }
      if (rightish >= 3) {
        // Axis-aligned rectangle when edges are nearly horizontal/vertical; otherwise keep the rotated quad.
        const e0 = Math.atan2(poly[3] - poly[1], poly[2] - poly[0]);
        const tilt = Math.abs(((e0 % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
        if (tilt < 0.15 || tilt > Math.PI / 2 - 0.15) return { kind: "rectangle", xy: [minX, minY, maxX, minY, maxX, maxY, minX, maxY], closed: true };
        return { kind: "rectangle", xy: poly, closed: true };
      }
      return { kind: "polygon", xy: poly, closed: true };
    }
    if (dev < 0.16) {
      const circle = Math.abs(w - h) / Math.max(w, h) < 0.18;
      if (circle) {
        const r = (w + h) / 4;
        return { kind: "circle", xy: ellipsePoints(cx, cy, r, r), closed: true };
      }
      return { kind: "ellipse", xy: ellipsePoints(cx, cy, rx, ry), closed: true };
    }
    if (verts >= 5 && verts <= 10) return { kind: "polygon", xy: poly, closed: true };
    return null;
  }

  // Open polyline (e.g. an angle, zig-zag or arrow body)
  const poly = mergeCollinear(simplifyDP(xy, diag * 0.06), 0.3);
  if (poly.length / 2 <= 5) return { kind: "polyline", xy: poly, closed: false };
  return null;
}

function mergeCollinear(poly: number[], tol: number): number[] {
  if (poly.length < 8) return poly;
  let changed = true;
  let p = poly.slice();
  while (changed && p.length >= 8) {
    changed = false;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n,
        c = (i + 1) % n;
      const ang = angleAt(p[a * 2], p[a * 2 + 1], p[i * 2], p[i * 2 + 1], p[c * 2], p[c * 2 + 1]);
      if (Math.PI - ang < tol) {
        p.splice(i * 2, 2);
        changed = true;
        break;
      }
    }
  }
  return p;
}

/** Shape-tool primitives drawn by dragging. */
/** `width`: the stroke width the shape will be drawn with (arrowheads scale with it). */
export function dragShape(kind: "line" | "arrow" | "rectangle" | "ellipse" | "triangle", x0: number, y0: number, x1: number, y1: number, width = 1.8): RecognizedShape {
  switch (kind) {
    case "line":
      return { kind: "line", xy: [x0, y0, x1, y1], closed: false };
    case "arrow": {
      const ang = Math.atan2(y1 - y0, x1 - x0);
      // Head proportional to the line weight (so thick arrows get bigger heads), but never
      // more than ~30% of the shaft, so short arrows keep a sensible head.
      const L = Math.hypot(x1 - x0, y1 - y0);
      const len = Math.min(L * 0.3, Math.max(5, 3.2 + width * 3.2));
      const a1 = ang + Math.PI - 0.45,
        a2 = ang + Math.PI + 0.45;
      return {
        kind: "polyline",
        xy: [x0, y0, x1, y1, x1 + Math.cos(a1) * len, y1 + Math.sin(a1) * len, x1, y1, x1 + Math.cos(a2) * len, y1 + Math.sin(a2) * len],
        closed: false,
      };
    }
    case "rectangle":
      return { kind: "rectangle", xy: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true };
    case "triangle":
      return { kind: "triangle", xy: [(x0 + x1) / 2, y0, x1, y1, x0, y1], closed: true };
    case "ellipse":
      return { kind: "ellipse", xy: ellipsePoints((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2), closed: true };
  }
}

export function shapeToPts(xy: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < xy.length; i += 2) out.push(Math.round(xy[i] * 100) / 100, Math.round(xy[i + 1] * 100) / 100, 0.5);
  return out;
}
