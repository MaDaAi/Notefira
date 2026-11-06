import { createStore } from "../state/store";
import type { PenKind, StrokeDash, TextEl, ToolId } from "../model/types";
import { kvGet, kvSet } from "../storage/db";

export type ShapeTool = "auto" | "line" | "arrow" | "rectangle" | "ellipse" | "triangle";

export interface ToolState {
  tool: ToolId;
  pen: { pen: Exclude<PenKind, "highlighter">; color: string; width: number; stabilization: number; dash?: "solid" | StrokeDash };
  highlighter: { color: string; width: number; straight: boolean; opacity: number; stabilization: number };
  /** "stroke" removes whole strokes; "precision" (shown as Standard) erases generously; "exact" (Precise) cuts exactly under the eraser. */
  eraser: { mode: "stroke" | "precision" | "exact"; size: number; highlighterOnly: boolean };
  shapes: { kind: ShapeTool; color: string; width: number; fill: string | null };
  /** select: "touch" = anything the lasso touches (default); "enclose" = only items fully circled. */
  lasso: { mode: "freeform" | "rect"; select?: "touch" | "enclose" };
  text: Pick<TextEl, "font" | "size" | "color" | "bold" | "italic" | "underline" | "align">;
  ruler: boolean;
  zoombox: boolean;
  recentColors: string[];
}

export const tools = createStore<ToolState>({
  tool: "pen",
  pen: { pen: "ballpoint", color: "#130d0c", width: 1.8, stabilization: 0.45, dash: "solid" },
  highlighter: { color: "#ffe14d", width: 14, straight: false, opacity: 0.38, stabilization: 0.35 },
  eraser: { mode: "stroke", size: 10, highlighterOnly: false },
  shapes: { kind: "auto", color: "#130d0c", width: 1.8, fill: null },
  lasso: { mode: "freeform", select: "touch" },
  text: { font: "sans", size: 16, color: "#130d0c", bold: false, italic: false, underline: false, align: "left" },
  ruler: false,
  zoombox: false,
  recentColors: [],
});

export async function loadTools() {
  const saved = await kvGet<Partial<ToolState> | null>("tools", null);
  if (saved) {
    const current = tools.get();
    tools.set({
      ...saved,
      pen: { ...current.pen, ...(saved.pen ?? {}) },
      highlighter: { ...current.highlighter, ...(saved.highlighter ?? {}) },
      ruler: false,
      zoombox: false,
    });
  }
  let t: any;
  tools.subscribe(() => {
    clearTimeout(t);
    t = setTimeout(() => kvSet("tools", tools.get()).catch(() => {}), 500);
  });
}

export function setTool(tool: ToolId) {
  if (tool === "ruler") return tools.set((s) => ({ ruler: !s.ruler }));
  if (tool === "zoombox") return tools.set((s) => ({ zoombox: !s.zoombox }));
  tools.set({ tool });
}

/** Commands from the shared toolbar to whichever editor pane is active. */
export const editorBus = createStore<{ cmd: "image" | "elements" | "clear-page" | null; n: number }>({ cmd: null, n: 0 });
export function sendEditorCommand(cmd: "image" | "elements" | "clear-page") {
  editorBus.set((s) => ({ cmd, n: s.n + 1 }));
}

export function rememberColor(c: string) {
  tools.set((s) => ({ recentColors: [c, ...s.recentColors.filter((x) => x !== c)].slice(0, 8) }));
}

export const TOOL_LABELS: Record<ToolId, string> = {
  pen: "Pen",
  eraser: "Eraser",
  highlighter: "Highlighter",
  shapes: "Shapes",
  lasso: "Lasso",
  elements: "Elements",
  image: "Image",
  text: "Text",
  laser: "Laser pointer",
  zoombox: "Zoom window",
  ruler: "Ruler",
  hand: "Read only",
};

export const TOOL_KEYS: Partial<Record<string, ToolId>> = {
  p: "pen",
  e: "eraser",
  h: "highlighter",
  s: "shapes",
  l: "lasso",
  t: "text",
  k: "laser",
  r: "ruler",
  z: "zoombox",
  i: "image",
  v: "hand",
};
