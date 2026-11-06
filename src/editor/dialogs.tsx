import { useEffect, useRef, useState } from "react";
import { Dialog, useAsync } from "../ui/common";
import type { Deck, Doc, ID, ImageEl } from "../model/types";
import * as repo from "../storage/repo";
import { newCard } from "../study/srs";
import { addCardToDeck } from "../study/Study";
import { toast } from "../state/store";
import { getAsset } from "../storage/repo";
import { TemplateGrid, TemplatePreview } from "../screens/library/NewNotebook";
import { PAPER_COLORS, PAPER_SIZES, pageSize, templateBg } from "../model/templates";
import type { Background, Settings, TemplateId } from "../model/types";
import { formatDate } from "../model/util";
import { auth } from "../sync/google";
import { drive } from "../sync/scheduler";
import { restoreDriveRevision } from "../sync/engine";
import { useStore } from "../state/store";

export function RecognizeDialog({ title, initial, busy, onClose, onReplace, onInsert, latex }: { title: string; initial: string; busy: boolean; onClose: () => void; onReplace?: (t: string) => void; onInsert: (t: string) => void; latex?: boolean }) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(text).then(() => toast("Copied", "success"))} disabled={!text}>
            Copy
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => onInsert(text)} disabled={!text}>
            Insert as text box
          </button>
          {onReplace && (
            <button className="btn primary" onClick={() => onReplace(text)} disabled={!text}>
              Replace handwriting
            </button>
          )}
        </>
      }
    >
      {busy ? (
        <div className="row">
          <span className="spinner" /> Recognising…
        </div>
      ) : (
        <textarea className="input" style={{ minHeight: 140, fontFamily: latex ? "ui-monospace, monospace" : undefined }} value={text} onChange={(e) => setText(e.target.value)} />
      )}
      {latex && !busy && <p className="small muted" style={{ margin: 0 }}>LaTeX source — paste into any LaTeX editor, Overleaf or a Markdown note with maths support.</p>}
    </Dialog>
  );
}

export function FlashcardDialog({ image, docId, pageId, onClose }: { image: ID; docId: ID; pageId: ID; onClose: () => void }) {
  const v = useAsync(() => repo.listDecks(), []);
  const decks = (v.data ?? []).filter((d) => !d.deletedAt);
  const [deckId, setDeckId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [imgOn, setImgOn] = useState<"front" | "back">("front");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    repo.assetUrl(image).then(setUrl);
  }, [image]);
  useEffect(() => {
    if (!deckId && decks.length) setDeckId(decks.find((d) => d.docId === docId)?.id ?? decks[0].id);
  }, [decks.length]);
  const save = async () => {
    const card = newCard(imgOn === "front" ? { image, text: front || undefined } : { text: front }, imgOn === "back" ? { image, text: back || undefined } : { text: back }, { docId, pageId });
    const doc = await repo.getDoc(docId);
    const d: Deck = await addCardToDeck(deckId === "__new" || !deckId ? null : deckId, card, newName.trim() || doc?.title || "My study set");
    toast(`Card added to “${d.name}”`, "success");
    onClose();
  };
  return (
    <Dialog
      title="Make flashcard"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={imgOn === "front" ? false : !front.trim()}>
            Add card
          </button>
        </>
      }
    >
      {url && <img src={url} alt="Selection" style={{ maxWidth: "100%", maxHeight: 180, objectFit: "contain", border: "1px solid var(--c-line)", borderRadius: 8, alignSelf: "center" }} />}
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button className={imgOn === "front" ? "on" : ""} onClick={() => setImgOn("front")}>
          Selection is the question
        </button>
        <button className={imgOn === "back" ? "on" : ""} onClick={() => setImgOn("back")}>
          Selection is the answer
        </button>
      </div>
      <label className="field">
        {imgOn === "front" ? "Extra question text (optional)" : "Question"}
        <input value={front} onChange={(e) => setFront(e.target.value)} />
      </label>
      {imgOn === "front" && (
        <label className="field">
          Answer
          <textarea value={back} onChange={(e) => setBack(e.target.value)} />
        </label>
      )}
      <label className="field">
        Study set
        <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value="__new">New study set…</option>
        </select>
      </label>
      {(deckId === "__new" || !decks.length) && (
        <label className="field">
          New study set name
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Biology 101" />
        </label>
      )}
    </Dialog>
  );
}

export function LinkDialog({ doc, onClose, onSave }: { doc: Doc; onClose: () => void; onSave: (target: { url?: string; pageId?: ID }) => void }) {
  const [mode, setMode] = useState<"url" | "page">("url");
  const [url, setUrl] = useState("https://");
  const [page, setPage] = useState(1);
  const valid = mode === "url" ? /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url.trim()) : page >= 1 && page <= doc.pageIds.length;
  return (
    <Dialog
      title="Add link"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => onSave(mode === "url" ? { url: url.trim() } : { pageId: doc.pageIds[page - 1] })}>
            Add link
          </button>
        </>
      }
    >
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>
          Web address
        </button>
        <button className={mode === "page" ? "on" : ""} onClick={() => setMode("page")}>
          Page in this notebook
        </button>
      </div>
      {mode === "url" ? (
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
      ) : (
        <label className="field">
          Page number (1–{doc.pageIds.length})
          <input type="number" min={1} max={doc.pageIds.length} value={page} onChange={(e) => setPage(Number(e.target.value))} />
        </label>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Links open in read-only mode (hand tool) or with Ctrl/⌘-click, and are kept in exported PDFs.
      </p>
    </Dialog>
  );
}

export function CropDialog({ el, onClose, onSave }: { el: ImageEl; onClose: () => void; onSave: (crop: { x: number; y: number; w: number; h: number }) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState(el.crop ?? { x: 0, y: 0, w: 1, h: 1 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: string; sx: number; sy: number; c: typeof crop } | null>(null);
  useEffect(() => {
    let u: string | null = null;
    getAsset(el.asset).then((a) => {
      if (a) setUrl((u = URL.createObjectURL(a.blob)));
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [el.asset]);
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const dx = (e.clientX - d.sx) / r.width,
      dy = (e.clientY - d.sy) / r.height;
    let { x, y, w, h } = d.c;
    if (d.mode === "move") {
      x = Math.min(1 - w, Math.max(0, x + dx));
      y = Math.min(1 - h, Math.max(0, y + dy));
    } else {
      if (d.mode.includes("e")) w = Math.min(1 - x, Math.max(0.05, w + dx));
      if (d.mode.includes("s")) h = Math.min(1 - y, Math.max(0.05, h + dy));
      if (d.mode.includes("w")) {
        const nx = Math.min(x + w - 0.05, Math.max(0, x + dx));
        w += x - nx;
        x = nx;
      }
      if (d.mode.includes("n")) {
        const ny = Math.min(y + h - 0.05, Math.max(0, y + dy));
        h += y - ny;
        y = ny;
      }
    }
    setCrop({ x, y, w, h });
  };
  const start = (mode: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, c: crop };
  };
  return (
    <Dialog
      title="Crop image"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
            Reset
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(crop)}>
            Crop
          </button>
        </>
      }
    >
      <div ref={box} className="crop-box" onPointerMove={move} onPointerUp={() => (drag.current = null)}>
        {url && <img src={url} alt="Image being cropped" draggable={false} />}
        <div className="crop-rect" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} onPointerDown={start("move")}>
          {["nw", "ne", "sw", "se"].map((h) => (
            <span key={h} className={"crop-h " + h} onPointerDown={start(h)} />
          ))}
        </div>
      </div>
    </Dialog>
  );
}

export function PageTemplateDialog({ title, initial, size, onClose, onApply, applyAll }: { title: string; initial: Background; size: { w: number; h: number }; onClose: () => void; onApply: (bg: Background, dim: { w: number; h: number }, scope: "this" | "all" | "new") => void; applyAll?: boolean }) {
  const init = (initial.type === "template" ? initial : templateBg("blank")) as Extract<Background, { type: "template" }>;
  const [tpl, setTpl] = useState<{ template: TemplateId; asset?: ID }>({ template: init.template, asset: init.asset });
  const [paper, setPaper] = useState(init.paper);
  const [paperSize, setPaperSize] = useState<Settings["defaultPaper"] | "same">("same");
  const [orient, setOrient] = useState<"portrait" | "landscape">(size.w > size.h ? "landscape" : "portrait");
  const [scope, setScope] = useState<"this" | "all" | "new">("this");
  const dim = paperSize === "same" ? (orient === (size.w > size.h ? "landscape" : "portrait") ? size : { w: size.h, h: size.w }) : pageSize(paperSize, orient);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onApply(templateBg(tpl.template, paper, tpl.asset), dim, scope)}>
            Apply
          </button>
        </>
      }
    >
      <div className="row" style={{ alignItems: "flex-start", gap: 20 }}>
        <TemplatePreview bg={templateBg(tpl.template, paper, tpl.asset)} w={110} ratio={dim.h / dim.w} />
        <div className="grow">
          <TemplateGrid value={tpl} paper={paper} ratio={dim.h / dim.w} onChange={(t, asset) => setTpl({ template: t, asset })} />
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
        <label className="field">
          Size
          <select value={paperSize} onChange={(e) => setPaperSize(e.target.value as any)}>
            <option value="same">Keep current</option>
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
              <button key={p.id} className={"color-dot" + (paper === p.id ? " on" : "")} style={{ background: p.id }} aria-label={p.label} onClick={() => setPaper(p.id)} />
            ))}
          </div>
        </div>
        {applyAll && (
          <div className="field">
            Apply to
            <div className="seg">
              <button className={scope === "this" ? "on" : ""} onClick={() => setScope("this")}>
                This page
              </button>
              <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>
                All pages
              </button>
              <button className={scope === "new" ? "on" : ""} onClick={() => setScope("new")}>
                New pages only
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function VersionHistory({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const local = useAsync(() => repo.listRevisions(doc.id), [doc.id]);
  const acc = useStore(auth, (s) => s.account);
  const remote = useAsync(async () => (acc && doc.remoteId && navigator.onLine ? drive().listRevisions(doc.remoteId) : []), [doc.remoteId, acc?.email]);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Version history" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <p className="small muted" style={{ margin: 0 }}>
        Restoring a version keeps the current state as another version, so it can be undone.
      </p>
      <strong>On this device</strong>
      {(local.data ?? []).length === 0 && <span className="muted small">No saved versions yet (one is kept each time you open the notebook, before cloud updates and before restores).</span>}
      {(local.data ?? []).map((r) => (
        <div key={r.id} className="row ver-row">
          <span className="grow">
            {new Date(r.created).toLocaleString()} <span className="muted small">· {r.reason} · {r.pages.length} pages</span>
          </span>
          <button
            className="btn small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await repo.restoreSnapshot(doc.id, r.doc, r.pages);
              setBusy(false);
              toast("Version restored", "success");
              onClose();
            }}
          >
            Restore
          </button>
        </div>
      ))}
      {acc && doc.remoteId && (
        <>
          <strong>Google Drive</strong>
          {remote.loading && <span className="spinner" />}
          {remote.error && <span className="error-text">{remote.error}</span>}
          {(remote.data ?? []).map((r) => (
            <div key={r.id} className="row ver-row">
              <span className="grow">{formatDate(Date.parse(r.modifiedTime))} <span className="muted small">· {new Date(r.modifiedTime).toLocaleString()}</span></span>
              <button
                className="btn small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await restoreDriveRevision(drive(), doc.id, doc.remoteId!, r.id);
                    toast("Drive version restored", "success");
                    onClose();
                  } catch (e: any) {
                    toast(e.message, "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Restore
              </button>
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}
