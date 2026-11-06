import type { Background, TemplateId, Settings } from "./types";

export const PAPER_SIZES: Record<Settings["defaultPaper"], { label: string; w: number; h: number }> = {
  a4: { label: "A4", w: 595, h: 842 },
  letter: { label: "US Letter", w: 612, h: 792 },
  a5: { label: "A5", w: 420, h: 595 },
  widescreen: { label: "Widescreen 16:9", w: 576, h: 1024 },
  square: { label: "Square", w: 700, h: 700 },
};

export const TEMPLATES: { id: TemplateId; label: string }[] = [
  { id: "blank", label: "Blank" },
  { id: "ruled", label: "Ruled" },
  { id: "narrow", label: "Narrow ruled" },
  { id: "grid", label: "Grid" },
  { id: "dotted", label: "Dotted" },
  { id: "cornell", label: "Cornell" },
  { id: "todo", label: "To-do" },
  { id: "music", label: "Music staff" },
];

export const PAPER_COLORS = [
  { id: "#ffffff", label: "White" },
  { id: "#fbf7ec", label: "Ivory" },
  { id: "#f8f7eb", label: "Cream" },
  { id: "#f3f2ef", label: "Grey" },
  { id: "#1f1f22", label: "Dark" },
];

export function pageSize(paper: Settings["defaultPaper"], orientation: "portrait" | "landscape") {
  const s = PAPER_SIZES[paper] ?? PAPER_SIZES.a4;
  return orientation === "landscape" ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

export function templateBg(template: TemplateId, paper = "#ffffff", asset?: string): Background {
  const dark = isDark(paper);
  return {
    type: "template",
    template,
    paper,
    line: dark ? "#4a4a50" : "#c9d3dd",
    spacing: template === "narrow" ? 18 : template === "grid" || template === "dotted" ? 20 : 26,
    ...(asset ? { asset } : {}),
  };
}

export function isDark(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

/** Vector description of a template so that the canvas renderer and PDF exporter draw identical paper. */
export interface TemplateShape {
  lines: [number, number, number, number, string, number][]; // x1,y1,x2,y2,color,width
  dots: [number, number, number, string][]; // x,y,r,color
}

export function templateShapes(bg: Background, w: number, h: number): TemplateShape {
  const out: TemplateShape = { lines: [], dots: [] };
  if (bg.type !== "template") return out;
  const line = bg.line ?? "#c9d3dd";
  const sp = bg.spacing ?? 26;
  const accent = "#e8a2a2";
  switch (bg.template) {
    case "ruled":
    case "narrow": {
      const top = sp * 3;
      for (let y = top; y < h - sp / 2; y += sp) out.lines.push([0, y, w, y, line, 0.7]);
      out.lines.push([sp * 2.6, 0, sp * 2.6, h, accent, 0.8]);
      break;
    }
    case "grid": {
      for (let x = sp; x < w; x += sp) out.lines.push([x, 0, x, h, line, 0.5]);
      for (let y = sp; y < h; y += sp) out.lines.push([0, y, w, y, line, 0.5]);
      break;
    }
    case "dotted": {
      for (let x = sp; x < w; x += sp) for (let y = sp; y < h; y += sp) out.dots.push([x, y, 0.9, line]);
      break;
    }
    case "cornell": {
      const header = h * 0.1;
      const summary = h * 0.8;
      const cue = w * 0.3;
      for (let y = header + sp; y < summary; y += sp) out.lines.push([cue, y, w, y, line, 0.6]);
      out.lines.push([0, header, w, header, "#8aa0b4", 1.2]);
      out.lines.push([cue, header, cue, summary, "#8aa0b4", 1.2]);
      out.lines.push([0, summary, w, summary, "#8aa0b4", 1.2]);
      break;
    }
    case "todo": {
      const top = sp * 3;
      for (let y = top; y < h - sp; y += sp * 1.3) {
        out.lines.push([sp * 2.4, y, w - sp, y, line, 0.6]);
        const b = sp * 0.55;
        const bx = sp * 1.2,
          by = y - b - 3;
        out.lines.push([bx, by, bx + b, by, line, 0.8], [bx + b, by, bx + b, by + b, line, 0.8], [bx + b, by + b, bx, by + b, line, 0.8], [bx, by + b, bx, by, line, 0.8]);
      }
      break;
    }
    case "music": {
      const gap = 7;
      for (let y = sp * 3; y + gap * 4 < h - sp; y += gap * 4 + sp * 1.6) {
        for (let k = 0; k < 5; k++) out.lines.push([sp, y + k * gap, w - sp, y + k * gap, "#9aa4ad", 0.6]);
      }
      break;
    }
  }
  return out;
}
