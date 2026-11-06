import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tools, setTool, rememberColor, type ShapeTool } from "./tools";
import { useStore, settingsStore, updateSettings, DEFAULT_SETTINGS } from "../state/store";
import type { PenKind, Stroke, ToolId } from "../model/types";
import { drawItem } from "../engine/render";
import { Icon } from "../ui/icons";
import { ColorGrid, Popover } from "../ui/common";

type Pop = { anchor: DOMRect; kind: "settings" | "color" | "width"; slot: number };
const GENERAL_TOOLS: { id: ToolId; icon: string; label: string }[] = [
  { id: "lasso", icon: "lasso", label: "Selection" },
  { id: "pen", icon: "pen", label: "Writing" },
  { id: "eraser", icon: "eraser", label: "Eraser" },
  { id: "text", icon: "text", label: "Text box" },
  { id: "image", icon: "image", label: "Images" },
  { id: "shapes", icon: "shapes", label: "Shapes" },
  { id: "elements", icon: "elements", label: "Post-it notes" },
  { id: "laser", icon: "laser", label: "Pointer" },
  { id: "ruler", icon: "ruler", label: "Ruler" },
];

const SHAPE_KINDS: { kind: ShapeTool; icon: string; label: string }[] = [
  { kind: "auto", icon: "wand", label: "Auto shape (draw, then it snaps)" },
  { kind: "line", icon: "shapeLine", label: "Line" },
  { kind: "arrow", icon: "shapeArrow", label: "Arrow" },
  { kind: "rectangle", icon: "shapeRect", label: "Rectangle" },
  { kind: "ellipse", icon: "shapeEllipse", label: "Ellipse" },
  { kind: "triangle", icon: "shapeTriangle", label: "Triangle" },
];
const ERASER_SIZES = [4, 10, 24];
const ERASER_MODES: { mode: "stroke" | "precision" | "exact"; label: string; title: string }[] = [
  { mode: "stroke", label: "Stroke", title: "Erase whole strokes" },
  { mode: "precision", label: "Standard", title: "Erase where you rub (generous)" },
  { mode: "exact", label: "Precise", title: "Erase exactly under the eraser circle" },
];
const PT_TO_MM = 25.4 / 72;

export function Toolbar({ centerTarget, onImage, onElements, onClearPage }: { centerTarget: HTMLElement | null; onImage: () => void; onElements: () => void; onClearPage: () => void }) {
  const st = useStore(tools, (s) => s);
  const settings = useStore(settingsStore, (s) => s);
  const [pop, setPop] = useState<Pop | null>(null);
  const tapeOn = st.tool === "highlighter" && st.highlighter.straight && st.highlighter.opacity >= 0.55;
  const pencilOn = st.tool === "pen" && st.pen.pen === "pencil";
  const inkTool = st.tool === "pen" || st.tool === "highlighter";
  // Each top-bar tool has its own options bar below it (or none).
  const dock: "ink" | "eraser" | "shapes" | null = inkTool ? "ink" : st.tool === "eraser" ? "eraser" : st.tool === "shapes" ? "shapes" : null;
  const styleControls = dock === "ink" || dock === "shapes";
  const colors = st.tool === "highlighter" ? settings.highlighterColors : settings.penColors;
  const widths = st.tool === "highlighter" ? settings.highlighterWidths : settings.penWidths;
  const curColor = st.tool === "highlighter" ? st.highlighter.color : st.tool === "shapes" ? st.shapes.color : st.tool === "text" ? st.text.color : st.pen.color;
  const curWidth = st.tool === "highlighter" ? st.highlighter.width : st.tool === "shapes" ? st.shapes.width : st.pen.width;

  const setColor = (color: string) => {
    rememberColor(color);
    if (st.tool === "highlighter") tools.set({ highlighter: { ...st.highlighter, color } });
    else if (st.tool === "shapes") tools.set({ shapes: { ...st.shapes, color } });
    else if (st.tool === "text") tools.set({ text: { ...st.text, color } });
    else tools.set({ pen: { ...st.pen, color } });
  };
  const setWidth = (width: number) => {
    if (st.tool === "highlighter") tools.set({ highlighter: { ...st.highlighter, width } });
    else if (st.tool === "shapes") tools.set({ shapes: { ...st.shapes, width } });
    else tools.set({ pen: { ...st.pen, width } });
  };
  const openSettings = (e: React.MouseEvent<HTMLElement>) => setPop({ anchor: e.currentTarget.getBoundingClientRect(), kind: "settings", slot: -1 });
  const pickPen = (pen: Exclude<PenKind, "highlighter">, e: React.MouseEvent<HTMLElement>) => {
    if (st.tool === "pen" && st.pen.pen === pen) return openSettings(e);
    tools.set({ tool: "pen", pen: { ...st.pen, pen } });
  };
  const pickHighlighter = (tape: boolean, e: React.MouseEvent<HTMLElement>) => {
    if (st.tool === "highlighter" && tapeOn === tape) return openSettings(e);
    tools.set({ tool: "highlighter", highlighter: { ...st.highlighter, straight: tape, opacity: tape ? 0.68 : Math.min(st.highlighter.opacity, 0.5), width: tape ? Math.max(14, st.highlighter.width) : st.highlighter.width } });
  };
  const clickExtra = (t: ToolId, e: React.MouseEvent<HTMLElement>) => {
    if (t === "image") return onImage();
    if (t === "elements") return onElements();
    if (st.tool === t && (t === "eraser" || t === "lasso")) return openSettings(e);
    setTool(t);
  };
  const saveColor = (slot: number, color: string) => {
    const key = st.tool === "highlighter" ? "highlighterColors" : "penColors";
    const next = [...settings[key]];
    if (slot < 0) next.push(color); else next[slot] = color;
    updateSettings({ [key]: [...new Set(next)].slice(0, 10) } as any);
    setColor(color);
  };
  const removeColor = (slot: number) => {
    const key = st.tool === "highlighter" ? "highlighterColors" : "penColors";
    const next = settings[key].filter((_, i) => i !== slot);
    if (next.length) updateSettings({ [key]: next } as any);
    setPop(null);
  };
  const saveWidth = (slot: number, width: number) => {
    const key = st.tool === "highlighter" ? "highlighterWidths" : "penWidths";
    const next = [...settings[key]];
    next[slot] = width;
    updateSettings({ [key]: next.slice(0, 3) } as any);
    setWidth(width);
  };
  return <>
    {centerTarget && createPortal(
      <div className="general-tools" role="group" aria-label="Editing tools">
        {GENERAL_TOOLS.map(({ id, icon, label }) => <ToolButton key={id} icon={icon} label={id === "lasso" ? "Selection (tap again for options)" : label} caret={id === "lasso"} on={id === "ruler" ? st.ruler : st.tool === id} onClick={(e) => clickExtra(id, e)} />)}
      </div>,
      centerTarget,
    )}
    {dock && <div className="drawing-dock tools-main" role="toolbar" aria-label={dock === "eraser" ? "Eraser options" : dock === "shapes" ? "Shape options" : "Drawing controls"}>
      {dock === "ink" && <>
      <ToolButton icon="pen" label="Pen" caret on={st.tool === "pen" && !pencilOn} ink={st.pen.color} onClick={(e) => pickPen(st.pen.pen === "pencil" ? "ballpoint" : st.pen.pen, e)} />
      <ToolButton icon="pencil" label="Pencil" caret on={pencilOn} ink={st.pen.color} onClick={(e) => pickPen("pencil", e)} />
      <ToolButton icon="highlighter" label="Highlighter" caret on={st.tool === "highlighter" && !tapeOn} ink={st.highlighter.color} onClick={(e) => pickHighlighter(false, e)} />
      <ToolButton icon="tape" label="Tape" caret on={tapeOn} ink={st.highlighter.color} onClick={(e) => pickHighlighter(true, e)} />
      <span className="tool-divider" />
      </>}
      {dock === "eraser" && <>
        <div className="dock-seg" role="radiogroup" aria-label="Eraser mode">
          {ERASER_MODES.map(({ mode, label, title }) => <button key={mode} role="radio" aria-checked={st.eraser.mode === mode} className={st.eraser.mode === mode ? "on" : ""} onClick={() => tools.set({ eraser: { ...st.eraser, mode } })} title={title}><Icon name="eraser" size={18} /><span>{label}</span></button>)}
        </div>
        <span className="tool-divider" />
        {ERASER_SIZES.map((sz, i) => <button key={sz} className={`size-dot${st.eraser.size === sz ? " on" : ""}`} aria-pressed={st.eraser.size === sz} aria-label={`Eraser size ${i + 1}`} title={["Small", "Medium", "Large"][i]} onClick={() => tools.set({ eraser: { ...st.eraser, size: sz } })}><span style={{ width: 6 + i * 6, height: 6 + i * 6 }} /></button>)}
        <span className="tool-divider" />
        <button className={`tool-btn${st.eraser.highlighterOnly ? " on" : ""}`} aria-pressed={st.eraser.highlighterOnly} aria-label="Erase highlighter only" title="Erase highlighter only" onClick={() => tools.set({ eraser: { ...st.eraser, highlighterOnly: !st.eraser.highlighterOnly } })}><Icon name="highlighter" size={22} /></button>
        <button className="tool-btn" aria-label="Clear this page" title="Clear this page" onClick={onClearPage}><Icon name="trash" size={21} /></button>
      </>}
      {dock === "shapes" && <>
        {SHAPE_KINDS.map(({ kind, icon, label }) => <button key={kind} className={`tool-btn${st.shapes.kind === kind ? " on" : ""}`} aria-pressed={st.shapes.kind === kind} aria-label={label} title={label} onClick={() => tools.set({ shapes: { ...st.shapes, kind } })}><Icon name={icon} size={22} /></button>)}
        <span className="tool-divider" />
      </>}
      {styleControls && widths.slice(0, 3).map((w, i) => <button key={i} className={`width-line${Math.abs(w - curWidth) < .01 ? " on" : ""}`} aria-label={`Stroke size ${i + 1}`} onClick={(e) => Math.abs(w - curWidth) < .01 ? setPop({ anchor: e.currentTarget.getBoundingClientRect(), kind: "width", slot: i }) : setWidth(w)}><span style={{ height: Math.max(1.5, Math.min(7, st.tool === "highlighter" ? w / 4 : w * 1.25)) }} /></button>)}
      {styleControls && <span className="tool-divider" />}
      {styleControls && colors.map((c, i) => <button key={`${c}-${i}`} className={`color-dot${c.toLowerCase() === curColor.toLowerCase() ? " on" : ""}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={(e) => c.toLowerCase() === curColor.toLowerCase() ? setPop({ anchor: e.currentTarget.getBoundingClientRect(), kind: "color", slot: i }) : setColor(c)}>{c.toLowerCase() === curColor.toLowerCase() && <Icon name="chevronDown" size={10} />}</button>)}
      {styleControls && <button className="color-add" aria-label="Add colour" onClick={(e) => setPop({ anchor: e.currentTarget.getBoundingClientRect(), kind: "color", slot: -1 })}><Icon name="plus" size={14} /></button>}
    </div>}
    {pop && <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={pop.kind === "settings" ? 318 : pop.kind === "color" ? 232 : 300}>
      {pop.kind === "color" && <div className="ink-popover"><div className="ink-popover-head"><strong>{st.tool === "highlighter" ? "Highlighter colour" : "Pen colour"}</strong>{pop.slot >= 0 && colors.length > 1 && <button className="ink-delete" onClick={() => removeColor(pop.slot)}>Delete</button>}</div><ColorGrid value={curColor} extra={st.recentColors} onChange={(c) => { saveColor(pop.slot, c); setPop(null); }} /></div>}
      {pop.kind === "width" && <StrokeSettings
        width={curWidth}
        min={st.tool === "highlighter" ? 4 : 0.4}
        max={st.tool === "highlighter" ? 40 : 12}
        defaultWidth={(st.tool === "highlighter" ? DEFAULT_SETTINGS.highlighterWidths : DEFAULT_SETTINGS.penWidths)[pop.slot] ?? curWidth}
        onWidth={(w) => saveWidth(pop.slot, w)}
        {...(st.tool === "pen" && st.pen.pen !== "pencil" ? { dash: st.pen.dash ?? "solid", onDash: (d: DashStyle) => tools.set({ pen: { ...tools.get().pen, dash: d } }) } : {})}
      />}
      {pop.kind === "settings" && <ToolSettings onClearPage={onClearPage} />}
    </Popover>}
  </>;
}

/** `caret`: show a small chevron on the active button (only where tapping it again opens its settings). */
function ToolButton({ icon, label, on, ink, caret, onClick }: { icon: string; label: string; on: boolean; ink?: string; caret?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return <button className={`tool-btn${on ? " on" : ""}${caret ? " has-caret" : ""}`} onClick={onClick} aria-label={label} aria-pressed={on} title={label}><Icon name={icon} size={22} />{ink && <span className="tool-ink" style={{ background: ink }} />}{on && caret && <span className="tool-caret" aria-hidden="true"><Icon name="chevronDown" size={10} /></span>}</button>;
}

function dashArray(dash: "solid" | "dashed" | "dotted" | undefined, lw: number) {
  return dash === "dashed" ? `${lw * 3} ${lw * 2.2}` : dash === "dotted" ? `0.001 ${lw * 2}` : undefined;
}

type DashStyle = "solid" | "dashed" | "dotted";

/**
 * Stroke settings for one size preset (opened by tapping the selected size in the tool bar):
 * thickness with a mm readout and a reset to the preset's default, plus solid / dashed /
 * dotted line style for pens.
 */
function StrokeSettings({ width, min, max, defaultWidth, onWidth, dash, onDash }: { width: number; min: number; max: number; defaultWidth: number; onWidth: (w: number) => void; dash?: DashStyle; onDash?: (d: DashStyle) => void }) {
  const isDefault = (dash ?? "solid") === "solid" && Math.abs(width - defaultWidth) < 0.01;
  return (
    <div className="stroke-settings">
      <div className="stroke-settings-head">
        <span>Stroke settings</span>
        <output className="stroke-mm" aria-label="Thickness in millimetres">{(width * PT_TO_MM).toFixed(2)} mm</output>
        <button className="icon-btn small" aria-label="Reset this size" title="Reset to default" disabled={isDefault} onClick={() => (onWidth(defaultWidth), onDash?.("solid"))}>
          <Icon name="restore" size={16} />
        </button>
      </div>
      {onDash && (
        <div className="dash-options" role="radiogroup" aria-label="Line style">
          {(["solid", "dashed", "dotted"] as const).map((d) => (
            <button key={d} role="radio" aria-checked={(dash ?? "solid") === d} className={(dash ?? "solid") === d ? "on" : ""} onClick={() => onDash(d)}>
              <svg viewBox="0 0 48 10" aria-hidden="true">
                <line x1="5" y1="5" x2="43" y2="5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={dashArray(d, 2.4)} />
              </svg>
              <span>{d === "solid" ? "Solid" : d === "dashed" ? "Dashed" : "Dotted"}</span>
            </button>
          ))}
        </div>
      )}
      <label className="thickness">
        <span>Thickness</span>
        <span className="thickness-track">
          <svg viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">
            <path d="M2 6 L98 1 Q100 6 98 11 Z" />
          </svg>
          <input type="range" min={min} max={max} step={0.1} value={width} onChange={(e) => onWidth(Number(e.target.value))} aria-label="Thickness" />
        </span>
      </label>
    </div>
  );
}

/** Sample stroke drawn with the real graphite renderer (pressure rises then eases off). */
function PencilPreview({ color, width }: { color: string; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = 260, H = 76, dpr = Math.max(1, window.devicePixelRatio || 1);
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pts: number[] = [];
    for (let i = 0; i <= 80; i++) {
      const t = i / 80, u = 1 - t;
      // same curve as the pen preview: M28 48 C65 90 97 5 218 48
      const x = u * u * u * 28 + 3 * u * u * t * 65 + 3 * u * t * t * 97 + t * t * t * 218;
      const y = u * u * u * 48 + 3 * u * u * t * 90 + 3 * u * t * t * 5 + t * t * t * 48;
      pts.push(x, y, 0.18 + 0.72 * Math.sin(Math.PI * Math.min(1, t * 1.15)));
    }
    const now = Date.now();
    const stroke: Stroke = { id: "pencil-preview", kind: "stroke", pen: "pencil", color, width: Math.max(1.6, width * 1.6), pts, t0: now, t1: now };
    drawItem(ctx, stroke, { usePressure: true });
  }, [color, width]);
  return <canvas ref={ref} className="stroke-preview pencil-preview" aria-label="Pencil stroke preview" role="img" />;
}

function ToolSettings({ onClearPage }: { onClearPage: () => void }) {
  const st = useStore(tools, (s) => s);
  const settings = useStore(settingsStore, (s) => s);
  const isPen = st.tool === "pen";
  const isPencil = isPen && st.pen.pen === "pencil";
  const lassoSelect = st.lasso.select ?? "touch";
  const title = st.tool === "lasso" ? "Lasso" : st.tool === "eraser" ? "Eraser" : st.tool === "shapes" ? "Shapes" : st.tool === "highlighter" && st.highlighter.straight ? "Tape" : st.tool === "highlighter" ? "Highlighter" : st.pen.pen === "pencil" ? "Pencil" : "Pen";
  return <div className="tool-settings"><strong>{title}</strong>
    {isPencil && <><PencilPreview color={st.pen.color} width={st.pen.width} /><button className={`settings-toggle${settings.shapeHold ? " on" : ""}`} aria-pressed={settings.shapeHold} onClick={() => updateSettings({ shapeHold: !settings.shapeHold })}><span>Draw and Hold</span><i /></button><p className="tool-setting-hint">Hold the pencil still at the end of a stroke to snap it into a clean line, circle, rectangle or triangle.</p></>}
    {isPen && !isPencil && <><svg className="stroke-preview pen-preview" viewBox="0 0 260 76"><path d="M28 48 C65 90 97 5 218 48" stroke={st.pen.color} strokeWidth={Math.max(2, st.pen.width * 1.6)} fill="none" strokeLinecap="round" strokeDasharray={dashArray(st.pen.dash, Math.max(2, st.pen.width * 1.6))} /></svg><div className="pen-kinds">{(["fountain", "ballpoint", "brush"] as const).map((pen) => <button key={pen} className={st.pen.pen === pen ? "on" : ""} onClick={() => tools.set({ pen: { ...st.pen, pen } })}><Icon name={pen === "ballpoint" ? "pen" : pen === "fountain" ? "pencil" : "highlighter"} size={21} /><span>{pen === "ballpoint" ? "Ball pen" : pen === "fountain" ? "Fountain" : "Brush"}</span></button>)}</div></>}
    {(st.tool === "pen" || st.tool === "highlighter") && <label className="tool-setting-range"><span>Stroke stabilization <output>{Math.round((st.tool === "pen" ? st.pen.stabilization : st.highlighter.stabilization) * 100)}%</output></span><input type="range" min="0" max="1" step=".05" value={st.tool === "pen" ? st.pen.stabilization : st.highlighter.stabilization} onChange={(e) => st.tool === "pen" ? tools.set({ pen: { ...st.pen, stabilization: Number(e.target.value) } }) : tools.set({ highlighter: { ...st.highlighter, stabilization: Number(e.target.value) } })} /></label>}
    {isPen && <button className={`settings-toggle${settings.scribbleErase !== false ? " on" : ""}`} aria-pressed={settings.scribbleErase !== false} onClick={() => updateSettings({ scribbleErase: settings.scribbleErase === false })} title="Scrub quickly back and forth over writing to erase it"><span>Scribble to erase</span><i /></button>}
    {st.tool === "highlighter" && <label className="tool-setting-range"><span>Opacity <output>{Math.round(st.highlighter.opacity * 100)}%</output></span><input type="range" min=".15" max=".85" step=".05" value={st.highlighter.opacity} onChange={(e) => tools.set({ highlighter: { ...st.highlighter, opacity: Number(e.target.value) } })} /></label>}
    {st.tool === "eraser" && <><div className="setting-seg three">{ERASER_MODES.map(({ mode, label }) => <button key={mode} className={st.eraser.mode === mode ? "on" : ""} onClick={() => tools.set({ eraser: { ...st.eraser, mode } })}>{label}</button>)}</div><label className="tool-setting-range"><span>Eraser size <output>{st.eraser.size}</output></span><input type="range" min="2" max="40" value={st.eraser.size} onChange={(e) => tools.set({ eraser: { ...st.eraser, size: Number(e.target.value) } })} /></label><button className={`settings-toggle${st.eraser.highlighterOnly ? " on" : ""}`} onClick={() => tools.set({ eraser: { ...st.eraser, highlighterOnly: !st.eraser.highlighterOnly } })}><span>Erase highlighter only</span><i /></button><button className="btn small ghost danger" onClick={onClearPage}>Clear this page</button></>}
    {st.tool === "lasso" && <><div className="setting-seg" role="radiogroup" aria-label="Lasso selects"><button role="radio" aria-checked={lassoSelect === "touch"} className={lassoSelect === "touch" ? "on" : ""} onClick={() => tools.set({ lasso: { ...st.lasso, select: "touch" } })}>Touch</button><button role="radio" aria-checked={lassoSelect === "enclose"} className={lassoSelect === "enclose" ? "on" : ""} onClick={() => tools.set({ lasso: { ...st.lasso, select: "enclose" } })}>Enclose</button></div><p className="tool-setting-hint">{lassoSelect === "touch" ? "Selects anything the lasso touches — you don't need to circle the whole thing." : "Selects only what you circle completely."}</p></>}
    {st.tool === "shapes" && <div className="shape-grid">{(["auto", "line", "arrow", "rectangle", "ellipse", "triangle"] as ShapeTool[]).map((kind) => <button key={kind} className={st.shapes.kind === kind ? "on" : ""} onClick={() => tools.set({ shapes: { ...st.shapes, kind } })}>{kind}</button>)}</div>}
  </div>;
}
