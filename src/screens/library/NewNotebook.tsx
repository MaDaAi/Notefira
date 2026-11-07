import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../ui/common";
import type { Background, Cover, ID, Settings, TemplateId } from "../../model/types";
import { PAPER_COLORS, PAPER_SIZES, TEMPLATES, pageSize, templateBg, templateShapes } from "../../model/templates";
import { CoverArt, COVER_COLORS, COVER_PATTERNS } from "./Cover";
import { createDoc, putAsset, listStickers } from "../../storage/repo";
import { googleSignInAvailable } from "../../sync/config";
import { StorageChoice } from "./StorageChoice";
import { settingsStore, updateSettings, openDoc, toast } from "../../state/store";
import { pickFiles } from "../../platform/native";
import { kvGet, kvSet } from "../../storage/db";
import { uid } from "../../model/util";
import { getImage } from "../../engine/render";

export interface CustomTemplate {
  id: ID;
  name: string;
  asset: ID;
  w: number;
  h: number;
}

export async function listCustomTemplates(): Promise<CustomTemplate[]> {
  return kvGet<CustomTemplate[]>("customTemplates", []);
}

export async function addCustomTemplate(): Promise<CustomTemplate | null> {
  const files = await pickFiles(".png,.jpg,.jpeg,.webp", false);
  if (!files[0]) return null;
  const a = await putAsset(files[0], null, files[0].name);
  const bmp = await createImageBitmap(files[0]);
  const ratio = bmp.height / bmp.width;
  bmp.close();
  const w = 595;
  const t: CustomTemplate = { id: uid(), name: files[0].name.replace(/\.[^.]+$/, ""), asset: a.id, w, h: Math.round(w * ratio) };
  await kvSet("customTemplates", [...(await listCustomTemplates()), t]);
  return t;
}
void listStickers;

export function TemplatePreview({ bg, w = 70, ratio = 1.41 }: { bg: Background; w?: number; ratio?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = Math.round(w * ratio);
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    const pw = 595,
      ph = pw * ratio;
    ctx.scale((w * dpr) / pw, (w * dpr) / pw);
    if (bg.type === "template") {
      ctx.fillStyle = bg.paper;
      ctx.fillRect(0, 0, pw, ph);
      if (bg.template === "custom" && bg.asset) {
        const img = getImage(bg.asset);
        if (img) ctx.drawImage(img as CanvasImageSource, 0, 0, pw, ph);
        else setTimeout(() => c.dispatchEvent(new Event("redraw")), 200);
      }
      const s = templateShapes(bg, pw, ph);
      for (const [x1, y1, x2, y2, col, lw] of s.lines) {
        ctx.strokeStyle = col;
        ctx.lineWidth = lw * 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      for (const [x, y, r, col] of s.dots) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(x, y, r * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [JSON.stringify(bg), w, ratio]);
  return <canvas ref={ref} style={{ width: w, height: Math.round(w * ratio), borderRadius: 6, boxShadow: "0 0 0 1px var(--c-line)", display: "block" }} />;
}

export function TemplateGrid({ value, paper, onChange, ratio = 1.41 }: { value: { template: TemplateId; asset?: ID }; paper: string; onChange: (t: TemplateId, asset?: ID) => void; ratio?: number }) {
  const [custom, setCustom] = useState<CustomTemplate[]>([]);
  useEffect(() => {
    listCustomTemplates().then(setCustom);
  }, []);
  return (
    <div className="template-grid">
      {TEMPLATES.map((t) => (
        <button key={t.id} className={"template-cell" + (value.template === t.id ? " on" : "")} onClick={() => onChange(t.id)}>
          <TemplatePreview bg={templateBg(t.id, paper)} ratio={ratio} />
          <span>{t.label}</span>
        </button>
      ))}
      {custom.map((t) => (
        <button key={t.id} className={"template-cell" + (value.template === "custom" && value.asset === t.asset ? " on" : "")} onClick={() => onChange("custom", t.asset)}>
          <TemplatePreview bg={templateBg("custom", "#ffffff", t.asset)} ratio={ratio} />
          <span>{t.name}</span>
        </button>
      ))}
      <button
        className="template-cell add"
        onClick={async () => {
          try {
            const t = await addCustomTemplate();
            if (t) {
              setCustom(await listCustomTemplates());
              onChange("custom", t.asset);
            }
          } catch (e: any) {
            toast(e?.message ?? "Could not add template", "error");
          }
        }}
      >
        <div className="template-add">+</div>
        <span>Custom…</span>
      </button>
    </div>
  );
}

export function CoverPicker({ value, onChange }: { value: Cover; onChange: (c: Cover) => void }) {
  const color = value.type === "color" ? value.color : COVER_COLORS[0];
  const pattern = value.type === "color" ? value.pattern : "plain";
  return (
    <div className="col" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="cover-grid">
        {COVER_PATTERNS.map((p) => (
          <button key={p} className={"cover-cell" + (value.type === "color" && pattern === p ? " on" : "")} onClick={() => onChange({ type: "color", color, pattern: p })} aria-label={`Pattern ${p}`}>
            <CoverArt cover={{ type: "color", color, pattern: p }} />
          </button>
        ))}
        <button className={"cover-cell" + (value.type === "page" ? " on" : "")} onClick={() => onChange({ type: "page" })} title="Use the first page as the cover">
          <div className="cover cover-firstpage">First page</div>
        </button>
        <button
          className={"cover-cell" + (value.type === "image" ? " on" : "")}
          onClick={async () => {
            const f = await pickFiles(".png,.jpg,.jpeg,.webp", false);
            if (!f[0]) return;
            const a = await putAsset(f[0], null, f[0].name);
            onChange({ type: "image", asset: a.id });
          }}
        >
          {value.type === "image" ? <CoverArt cover={value} /> : <div className="cover cover-firstpage">Photo…</div>}
        </button>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {COVER_COLORS.map((c) => (
          <button key={c} className={"color-dot" + (value.type === "color" && color === c ? " on" : "")} style={{ background: c }} onClick={() => onChange({ type: "color", color: c, pattern })} aria-label={`Cover colour ${c}`} />
        ))}
      </div>
    </div>
  );
}

export function NewNotebookDialog({ folderId, onClose }: { folderId: ID | null; onClose: () => void }) {
  const s = settingsStore.get();
  const [title, setTitle] = useState("");
  const [cover, setCover] = useState<Cover>({ type: "color", color: COVER_COLORS[Math.floor(Math.random() * 6)], pattern: "plain" });
  const [tpl, setTpl] = useState<{ template: TemplateId; asset?: ID }>({ template: s.defaultTemplate });
  const [paper, setPaper] = useState("#ffffff");
  const [size, setSize] = useState<Settings["defaultPaper"]>(s.defaultPaper);
  const [orient, setOrient] = useState<Settings["defaultOrientation"]>(s.defaultOrientation);
  const [busy, setBusy] = useState(false);
  const [localOnly, setLocalOnly] = useState(false); // Google Drive by default
  const cloud = googleSignInAvailable();
  const dim = pageSize(size, orient);

  const create = async () => {
    setBusy(true);
    try {
      const bg = templateBg(tpl.template, paper, tpl.asset);
      const doc = await createDoc({ title: title || "Untitled notebook", folderId, bg, w: dim.w, h: dim.h, cover, localOnly: cloud && localOnly });
      await updateSettings({ defaultTemplate: tpl.template === "custom" ? s.defaultTemplate : tpl.template, defaultPaper: size, defaultOrientation: orient });
      onClose();
      openDoc(doc.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New notebook"
      onClose={onClose}
      wide
      footer={
        <>
          {cloud && <StorageChoice localOnly={localOnly} onChange={setLocalOnly} />}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy}>
            Create
          </button>
        </>
      }
    >
      <div className="newnb">
        <div className="newnb-preview">
          {cover.type === "page" ? <TemplatePreview bg={templateBg(tpl.template, paper, tpl.asset)} w={150} ratio={dim.h / dim.w} /> : <CoverArt cover={cover} title={title || "Untitled notebook"} />}
        </div>
        <div className="newnb-form">
          <label className="field">
            Title
            <input autoFocus value={title} placeholder="Untitled notebook" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} maxLength={120} />
          </label>
          <div className="field">
            Cover
            <CoverPicker value={cover} onChange={setCover} />
          </div>
        </div>
      </div>
      <div className="field">
        Paper
        <TemplateGrid value={tpl} paper={paper} ratio={dim.h / dim.w} onChange={(t, asset) => setTpl({ template: t, asset })} />
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
        <label className="field" style={{ minWidth: 160 }}>
          Size
          <select value={size} onChange={(e) => setSize(e.target.value as any)}>
            {Object.entries(PAPER_SIZES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          Orientation
          <div className="seg">
            <button className={orient === "portrait" ? "on" : ""} onClick={() => setOrient("portrait")}>
              Portrait
            </button>
            <button className={orient === "landscape" ? "on" : ""} onClick={() => setOrient("landscape")}>
              Landscape
            </button>
          </div>
        </div>
        <div className="field">
          Paper colour
          <div className="row">
            {PAPER_COLORS.map((p) => (
              <button key={p.id} className={"color-dot" + (paper === p.id ? " on" : "")} style={{ background: p.id }} title={p.label} aria-label={p.label} onClick={() => setPaper(p.id)} />
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
