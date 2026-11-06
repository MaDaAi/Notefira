import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getSession, type DocSession } from "./session";
import { ViewportController, type Selection } from "./viewport";
import type { ID, ImageEl, Item, LinkEl, TextEl } from "../model/types";
import { Icon } from "../ui/icons";
import { openMenu, promptDialog, confirmDialog, type MenuItem } from "../ui/common";
import { app, useStore, toast, openDoc, goLibrary, settingsStore } from "../state/store";
import { PageSidebar, rotatePage } from "./PageSidebar";
import { TextEditor } from "./TextEditor";
import { SearchPanel, ElementsPanel, ZoomWindow, Presentation } from "./panels";
import { AudioPanel, type AudioPanelApi } from "../audio/AudioPanel";
import { tools, setTool, TOOL_KEYS, editorBus } from "./tools";
import { copySelection, pasteItems, insertImageFile, freshIds, hasClip } from "./clipboard";
import { translateItem, itemBounds, unionRect } from "../engine/geometry";
import * as docOps from "./docOps";
import * as actions from "../services/docActions";
import { RecognizeDialog, FlashcardDialog, LinkDialog, CropDialog, PageTemplateDialog, VersionHistory } from "./dialogs";
import { ChangeCoverDialog } from "../screens/library/Dialogs";
import { pickFiles, openExternal, toggleFullscreen } from "../platform/native";
import { recState } from "../audio/recorder";
import { uid } from "../model/util";
import { SyncBadge } from "../screens/library/SyncBadge";
import { onChange } from "../storage/repo";

type Panel = "search" | "audio" | "elements" | null;

export function DocPane({ docId, active, onActivate, splitSide, toolbarLeft, toolbarRight }: { docId: ID; active: boolean; onActivate: () => void; splitSide?: "left" | "right"; toolbarLeft: HTMLElement | null; toolbarRight: HTMLElement | null }) {
  const [session, setSession] = useState<DocSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<ViewportController | null>(null);
  const [current, setCurrent] = useState(0);
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 900 && !splitSide);
  const [sideTab, setSideTab] = useState<"pages" | "bookmarks" | "outline">("pages");
  const [panel, setPanel] = useState<Panel>(null);
  const [edit, setEdit] = useState<{ pageId: ID; id: ID } | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [recog, setRecog] = useState<{ mode: "text" | "math"; busy: boolean; text: string } | null>(null);
  const [card, setCard] = useState<{ image: ID; pageId: ID } | null>(null);
  const [linkFor, setLinkFor] = useState(false);
  const [crop, setCrop] = useState<ImageEl | null>(null);
  const [tplDialog, setTplDialog] = useState<{ mode: "page" | "add"; index: number } | null>(null);
  const [history, setHistory] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const audioApi = useRef<AudioPanelApi | null>(null);
  const zoombox = useStore(tools, (s) => s.zoombox);
  const recording = useStore(recState, (s) => s.recording && s.docId === docId);
  const jump = useStore(app, (s) => (s.jump?.docId === docId ? s.jump : null));
  const panelRef = useRef<Panel>(null);
  panelRef.current = panel;

  // load the session
  useEffect(() => {
    let alive = true;
    setSession(null);
    setError(null);
    getSession(docId).then(
      (s) => alive && setSession(s),
      (e) => alive && setError(e?.message ?? String(e)),
    );
    return () => {
      alive = false;
    };
  }, [docId]);

  useEffect(() => {
    if (!session) return;
    if (session.corrupted.length) toast(`${session.corrupted.length} page(s) of “${session.doc.title}” failed an integrity check and were repaired. Older versions are in Version history.`, "error", undefined, 9000);
    return session.subscribe(() => setVersion((v) => v + 1));
  }, [session]);

  useEffect(() => onChange((t) => t === "doc-reload:" + docId && setVersion((v) => v + 1)), [docId]);

  // create the viewport controller
  useEffect(() => {
    if (!session || !hostRef.current) return;
    const vp = new ViewportController(hostRef.current, {
      onCurrentPage: setCurrent,
      onSelection: (s) => setSel(s ? { ...s } : null),
      onEditText: (e) => {
        vp.clearSelection();
        setEdit(e);
      },
      onRequestImage: async (pageId, x, y) => {
        const f = await pickFiles(".png,.jpg,.jpeg,.webp,.gif", false);
        if (f[0]) await insertImageFile(vp, session, f[0], { pageId, x, y });
      },
      onFollowLink: (l) => followLink(l),
      onView: () => setTick((t) => t + 1),
      onStrokeTap: (s) => {
        if (panelRef.current === "audio" && audioApi.current?.seekToStroke(s)) return;
      },
    });
    vp.setSession(session);
    vpRef.current = vp;
    const themeObs = new MutationObserver(() => vp.refreshTheme());
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      themeObs.disconnect();
      vp.destroy();
      vpRef.current = null;
    };
  }, [session]);

  // jump requests (search results, links, flashcard sources)
  useEffect(() => {
    if (!jump || !session || !vpRef.current) return;
    const vp = vpRef.current;
    setTimeout(() => {
      vp.scrollToPage(jump.pageId);
      vp.flashPage(jump.pageId);
      if (jump.q) setPanel("search");
    }, 60);
    const q = jump.q;
    app.set({ jump: null });
    if (q) setTimeout(() => setSearchInit(q), 0);
  }, [jump, session]);
  const [searchInit, setSearchInit] = useState<string | undefined>();

  useEffect(() => {
    if (zoombox && vpRef.current) vpRef.current.ensureZoomBox();
  }, [zoombox]);

  const followLink = useCallback(
    async (l: LinkEl | TextEl) => {
      const vp = vpRef.current;
      if (l.kind === "link" && l.pageId) {
        vp?.scrollToPage(l.pageId);
        vp?.flashPage(l.pageId);
        return;
      }
      const url = l.kind === "text" ? l.link : l.url;
      if (!url) return;
      if (await confirmDialog("Open link?", url, "Open")) openExternal(url).catch((e) => toast(e.message, "error"));
    },
    [session],
  );

  const vp = vpRef.current;
  const s = session;
  const page = s ? s.page(s.doc.pageIds[current] ?? s.doc.pageIds[0]) : undefined;
  const bookmarked = !!(s && page && s.doc.bookmarks.includes(page.id));

  const goPage = (id: ID) => {
    vp?.scrollToPage(id);
    if (window.innerWidth < 700) setSidebar(false);
  };

  const addPage = (index: number) => {
    if (!s) return;
    const ref = s.page(s.doc.pageIds[Math.max(0, index - 1)]) ?? page;
    const p = s.newPageLike(ref);
    s.insertPage(index, p);
    setTimeout(() => vpRef.current?.scrollToPage(p.id), 30);
  };

  // ---------------------------------------------------------------- selection actions
  const selItems = (): Item[] => vp?.selectionItems() ?? [];
  const deleteSel = () => {
    if (!s || !vp?.selection) return;
    s.removeItems(vp.selection.pageId, vp.selection.ids, "Delete");
    vp.clearSelection();
  };
  const duplicateSel = () => {
    if (!s || !vp?.selection) return;
    const copies = freshIds(selItems()).map((i) => translateItem(i, 14, 14));
    s.addItems(vp.selection.pageId, copies, "Duplicate");
    vp.setSelection({ pageId: vp.selection.pageId, ids: new Set(copies.map((c) => c.id)) });
  };
  const recolorSel = (color: string) => {
    if (!s || !vp?.selection) return;
    const map = new Map<ID, Item[]>();
    for (const it of selItems()) {
      if (it.kind === "stroke") map.set(it.id, [{ ...it, color }]);
      else if (it.kind === "text") map.set(it.id, [{ ...it, color }]);
    }
    s.replaceItems(vp.selection.pageId, map, "Colour");
  };
  const reorderSel = (front: boolean) => {
    if (!s || !vp?.selection) return;
    const pid = vp.selection.pageId;
    const ids = vp.selection.ids;
    const items = s.page(pid)!.items;
    const picked = items.filter((i) => ids.has(i.id));
    const rest = items.filter((i) => !ids.has(i.id));
    s.setItems(pid, front ? [...rest, ...picked] : [...picked, ...rest], front ? "Bring to front" : "Send to back");
  };
  const runRecognize = async (mode: "text" | "math") => {
    if (!vp) return;
    setRecog({ mode, busy: true, text: "" });
    try {
      const text = await docOps.recognizeSelection(vp, mode);
      setRecog({ mode, busy: false, text });
    } catch (e: any) {
      setRecog(null);
      toast(e.message, "error");
    }
  };

  const selectionMenu = (anchor: HTMLElement) => {
    const items = selItems();
    const single = items.length === 1 ? items[0] : null;
    const hasInk = items.some((i) => i.kind === "stroke");
    const m: MenuItem[] = [
      { label: "Copy", icon: "copy", kbd: "Ctrl C", onClick: () => copySelection(vp!) },
      {
        label: "Cut",
        icon: "cut",
        kbd: "Ctrl X",
        onClick: async () => {
          await copySelection(vp!);
          deleteSel();
        },
      },
      { label: "Duplicate", icon: "duplicate", kbd: "Ctrl D", onClick: duplicateSel },
      { label: "Delete", icon: "trash", kbd: "Del", danger: true, onClick: deleteSel },
      { sep: true },
      ...(single?.kind === "text" ? [{ label: "Edit text", icon: "text", onClick: () => (vp!.clearSelection(), setEdit({ pageId: sel!.pageId, id: single.id })) }] : []),
      ...(single?.kind === "image" ? [{ label: "Crop image", icon: "crop", onClick: () => setCrop(single as ImageEl) }] : []),
      ...(hasInk
        ? [
            { label: "Convert to text", icon: "text", onClick: () => runRecognize("text") },
            { label: "Recognise maths (LaTeX)", icon: "sigma", onClick: () => runRecognize("math") },
          ]
        : []),
      {
        label: "Make flashcard",
        icon: "cards",
        onClick: async () => {
          const img = await docOps.selectionImageAsset(vp!, docId);
          if (img && sel) setCard({ image: img, pageId: sel.pageId });
        },
      },
      {
        label: "Save as element",
        icon: "elements",
        onClick: async () => {
          const n = await promptDialog("Save as element", "My element", "Save");
          if (n) {
            await docOps.saveSelectionAsSticker(vp!, n);
            toast("Saved to Elements", "success");
          }
        },
      },
      { label: "Add link", icon: "link", onClick: () => setLinkFor(true) },
      { label: "Copy as image", icon: "image", onClick: () => docOps.copySelectionAsImage(vp!) },
      { sep: true },
      { label: "Bring to front", icon: "upload", onClick: () => reorderSel(true) },
      { label: "Send to back", icon: "download", onClick: () => reorderSel(false) },
    ];
    openMenu(anchor, m);
  };

  // ---------------------------------------------------------------- keyboard, paste, drop
  useEffect(() => {
    if (!active || !s) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,select,[contenteditable=true],.dialog,.menu")) return;
      const v = vpRef.current;
      if (!v) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z" && !e.shiftKey) (e.preventDefault(), s.undo());
      else if (mod && ((k === "z" && e.shiftKey) || k === "y")) (e.preventDefault(), s.redo());
      else if (mod && k === "c" && v.selection) (e.preventDefault(), copySelection(v));
      else if (mod && k === "x" && v.selection) {
        e.preventDefault();
        copySelection(v).then(deleteSel);
      } else if (mod && k === "d" && v.selection) (e.preventDefault(), duplicateSel());
      else if (mod && k === "a") {
        e.preventDefault();
        const p = s.page(s.doc.pageIds[v.currentPageIndex]);
        if (p?.items.length) {
          setTool("lasso");
          v.setSelection({ pageId: p.id, ids: new Set(p.items.map((i) => i.id)) });
        }
      } else if (mod && k === "f") (e.preventDefault(), setPanel("search"));
      else if (mod && k === "n") (e.preventDefault(), addPage(v.currentPageIndex + 1));
      else if (mod && k === "b") {
        e.preventDefault();
        toggleBookmark();
      } else if (mod && k === "p") (e.preventDefault(), actions.print(docId));
      else if (mod && (k === "=" || k === "+")) (e.preventDefault(), v.zoomBy(1.2));
      else if (mod && k === "-") (e.preventDefault(), v.zoomBy(1 / 1.2));
      else if (mod && k === "0") (e.preventDefault(), v.fitWidth());
      else if ((k === "delete" || k === "backspace") && v.selection) (e.preventDefault(), deleteSel());
      else if (k === "escape") {
        if (v.selection) v.clearSelection();
        else if (panel) setPanel(null);
      } else if (k === "f5") (e.preventDefault(), setPresenting(true));
      else if ((k === "pagedown" || (k === "arrowright" && !v.selection) || (k === "arrowdown" && e.altKey)) && !mod) {
        e.preventDefault();
        const id = s.doc.pageIds[Math.min(s.doc.pageIds.length - 1, v.currentPageIndex + 1)];
        v.scrollToPage(id);
      } else if ((k === "pageup" || (k === "arrowleft" && !v.selection) || (k === "arrowup" && e.altKey)) && !mod) {
        e.preventDefault();
        v.scrollToPage(s.doc.pageIds[Math.max(0, v.currentPageIndex - 1)]);
      } else if (v.selection && k.startsWith("arrow")) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = k === "arrowleft" ? -d : k === "arrowright" ? d : 0,
          dy = k === "arrowup" ? -d : k === "arrowdown" ? d : 0;
        s.replaceItems(v.selection.pageId, new Map(selItems().map((i) => [i.id, [translateItem(i, dx, dy)]])), "Nudge");
      } else if (!mod && !e.altKey && TOOL_KEYS[k]) setTool(TOOL_KEYS[k]!);
      else if (!mod && e.key === "?") app.set({ helpOpen: true });
    };
    const paste = async (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,[contenteditable=true]")) return;
      const v = vpRef.current;
      if (!v) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault();
      if (text.startsWith("notefira-clip:") || (hasClip() && !files.length && !text)) return void pasteItems(v, s);
      if (files.length) {
        for (const f of files) await insertImageFile(v, s, f, v.lastPointer() ?? undefined);
        return;
      }
      if (hasClip() && !text) return void pasteItems(v, s);
      if (text.trim()) {
        const c = v.lastPointer() ?? v.visibleCenter();
        if (!c) return;
        const tb = docOps.textBoxFor(text.slice(0, 20000), c.x, c.y, 300, 14);
        if (/^https?:\/\/\S+$/.test(text.trim())) tb.link = text.trim();
        s.addItems(c.pageId, [tb], "Paste text");
      } else if (hasClip()) pasteItems(v, s);
    };
    window.addEventListener("keydown", key);
    document.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("paste", paste);
    };
  }, [active, s, panel, docId]);

  const bus = useStore(editorBus, (b) => b);
  useEffect(() => {
    if (!active || !bus.cmd || !s) return;
    const v = vpRef.current;
    if (!v) return;
    if (bus.cmd === "elements") setPanel("elements");
    else if (bus.cmd === "image")
      pickFiles(".png,.jpg,.jpeg,.webp,.gif", true).then(async (files) => {
        for (const f of files) await insertImageFile(v, s, f);
        if (files.length) setTool("lasso");
      });
    else if (bus.cmd === "clear-page") {
      const p = s.page(s.doc.pageIds[v.currentPageIndex]);
      if (p) confirmDialog("Clear this page?", "All writing, text and images on this page will be removed. You can undo this.", "Clear", true).then((ok) => ok && s.setItems(p.id, [], "Clear page"));
    }
  }, [bus.n]);

  const onDrop = async (e: React.DragEvent) => {
    const v = vpRef.current;
    if (!s || !v || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    for (const f of files) {
      if (f.type.startsWith("image/")) await insertImageFile(v, s, f);
      else if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
        const n = await docOps.insertPdfPages(s, f, v.currentPageIndex + 1);
        toast(`Inserted ${n} PDF page(s)`, "success");
      } else toast(`${f.name}: drop it on the library to import it as a notebook.`, "info");
    }
  };

  const toggleBookmark = () => {
    if (!s) return;
    const pid = s.doc.pageIds[vpRef.current?.currentPageIndex ?? 0];
    const bm = s.doc.bookmarks.includes(pid);
    s.setDoc({ bookmarks: bm ? s.doc.bookmarks.filter((b) => b !== pid) : [...s.doc.bookmarks, pid] }, true, "Bookmark");
    toast(bm ? "Bookmark removed" : `Page ${(vpRef.current?.currentPageIndex ?? 0) + 1} bookmarked`, "info");
  };

  const withProgress = async (label: string, fn: (p: (d: number, t: number) => void) => Promise<unknown>) => {
    setProgress(label + "…");
    try {
      await fn((d, t) => setProgress(`${label} ${d}/${t}…`));
    } catch (e: any) {
      toast(e?.message ?? String(e), "error");
    } finally {
      setProgress(null);
    }
  };

  const moreMenu = (anchor: HTMLElement) => {
    if (!s || !vp) return;
    const cur = s.page(s.doc.pageIds[vp.currentPageIndex])!;
    openMenu(anchor, [
      { heading: "Document" },
      { label: "Rename…", icon: "text", onClick: () => actions.renameDoc(s.doc).then(() => setVersion((x) => x + 1)) },
      { label: "Change cover…", icon: "palette", onClick: () => setCoverOpen(true) },
      { label: "Paper template…", icon: "pages", onClick: () => setTplDialog({ mode: "page", index: vp.currentPageIndex }) },
      { label: s.doc.layout === "vertical" ? "Scroll horizontally" : "Scroll vertically", icon: "move", onClick: () => (s.setDoc({ layout: s.doc.layout === "vertical" ? "horizontal" : "vertical" }, true, "Layout"), setTimeout(() => vpRef.current?.fitWidth(), 30)) },
      { label: s.doc.favorite ? "Remove from Favourites" : "Add to Favourites", icon: "star", onClick: () => s.setDoc({ favorite: !s.doc.favorite }) },
      { label: "Version history…", icon: "history", onClick: () => setHistory(true) },
      { heading: "Pages" },
      { label: "Add page with template…", icon: "pageAdd", onClick: () => setTplDialog({ mode: "add", index: vp.currentPageIndex + 1 }) },
      {
        label: "Insert PDF pages…",
        icon: "pdf",
        onClick: async () => {
          const f = await pickFiles(".pdf", false);
          if (f[0]) withProgress("Inserting PDF", async () => toast(`Inserted ${await docOps.insertPdfPages(s, f[0], vp.currentPageIndex + 1)} page(s)`, "success"));
        },
      },
      { label: "Duplicate page", icon: "duplicate", onClick: () => s.duplicatePages([cur.id]) },
      { label: "Rotate page", icon: "rotate", onClick: () => rotatePage(s, cur.id) },
      {
        label: "Clear page",
        icon: "eraser",
        onClick: async () => {
          if (await confirmDialog("Clear this page?", "All writing, text and images on this page will be removed. You can undo this.", "Clear", true)) s.setItems(cur.id, [], "Clear page");
        },
      },
      { label: "Delete page", icon: "trash", danger: true, onClick: () => s.deletePages([cur.id]) },
      { heading: "Study & search" },
      { label: "Recognise handwriting (searchable)", icon: "wand", onClick: () => withProgress("Recognising", (p) => docOps.indexHandwriting(s, p).then((n) => toast(`Recognised ${n} page(s) — they're now searchable`, "success"))) },
      { label: "Make scanned pages searchable (OCR)", icon: "search", onClick: () => withProgress("OCR", (p) => docOps.ocrDocument(s, p).then((n) => toast(n ? `OCR finished on ${n} page(s)` : "No scanned pages needed OCR", "success"))) },
      { label: "Audio recordings", icon: "mic", onClick: () => setPanel("audio") },
      { label: "Present", icon: "present", kbd: "F5", onClick: () => setPresenting(true) },
      { heading: "Export" },
      { label: "Export as PDF", icon: "pdf", onClick: () => actions.exportPdf(docId) },
      { label: "Export this page as PDF", icon: "pdf", onClick: () => actions.exportPdf(docId, [cur.id]) },
      { label: "Export this page as image", icon: "image", onClick: () => docOps.exportPageImage(cur, `${s.doc.title} p${vp.currentPageIndex + 1}`) },
      { label: "Export as Notefira notebook", icon: "download", onClick: () => actions.exportNotebook(docId) },
      { label: "Print…", icon: "print", kbd: "Ctrl P", onClick: () => actions.print(docId) },
      { heading: "View" },
      { label: "Fit width", icon: "zoomOut", kbd: "Ctrl 0", onClick: () => vp.fitWidth() },
      { label: "Fit page", icon: "zoomOut", onClick: () => vp.fitPage() },
      { label: "Full screen", icon: "fullscreen", kbd: "F11", onClick: () => toggleFullscreen() },
      { label: "Open another notebook side by side…", icon: "split", onClick: () => goLibrary("home") },
    ]);
  };

  // ---------------------------------------------------------------- render
  if (error)
    return (
      <div className="pane">
        <div className="empty">
          <Icon name="info" size={36} />
          <h3>Couldn't open this notebook</h3>
          <p>{error}</p>
          <button className="btn" onClick={() => goLibrary()}>
            Back to library
          </button>
        </div>
      </div>
    );

  const selRect = sel && vp ? vp.selectionScreenRect() : null;
  return (
    <div className={"pane" + (active ? " active" : "")} onPointerDownCapture={onActivate}>
      {active && toolbarLeft && createPortal(
        <div className="doc-head-l">
          <button className="icon-btn" onClick={() => goLibrary()} aria-label="Home" title="Home (notebook library)">
            <Icon name="home" />
          </button>
          <button className={"icon-btn" + (sidebar ? " on" : "")} onClick={() => setSidebar(!sidebar)} aria-label="Page thumbnails" title="Pages, bookmarks & outline">
            <Icon name="sidebar" />
          </button>
          <button className={"icon-btn" + (panel === "search" ? " on" : "")} onClick={() => setPanel(panel === "search" ? null : "search")} aria-label="Search in notebook" title="Search (Ctrl F)">
            <Icon name="search" />
          </button>
          <button className={"icon-btn" + (bookmarked ? " on" : "")} onClick={toggleBookmark} aria-label="Bookmark page" title="Bookmark page (Ctrl B)">
            <Icon name={bookmarked ? "bookmarkOn" : "bookmark"} />
          </button>
          <button
            className="icon-btn hide-xs"
            aria-label="Share"
            title="Share / export"
            onClick={(e) =>
              openMenu(e.currentTarget, [
                { label: "Share as PDF…", icon: "share", onClick: () => actions.share(docId, "pdf") },
                { label: "Share as Notefira notebook…", icon: "share", onClick: () => actions.share(docId, "notefira") },
                { label: "Export as PDF", icon: "pdf", onClick: () => actions.exportPdf(docId) },
                { label: "Print…", icon: "print", onClick: () => actions.print(docId) },
              ])
            }
          >
            <Icon name="share" />
          </button>
        </div>,
        toolbarLeft,
      )}
      {active && toolbarRight && createPortal(
        <div className="doc-head-r">
          {progress && (
            <span className="row small muted hide-sm">
              <span className="spinner" />
              {progress}
            </span>
          )}
          {s?.lastError && (
            <span className="small" style={{ color: "var(--c-danger)" }} title={s.lastError}>
              Not saved
            </span>
          )}
          <button className={"icon-btn" + (panel === "audio" ? " on" : "") + (recording ? " rec" : "")} onClick={() => setPanel(panel === "audio" ? null : "audio")} aria-label="Audio recording" title="Record audio">
            <Icon name="mic" />
          </button>
          <button className="icon-btn" onClick={() => vp && addPage(vp.currentPageIndex + 1)} aria-label="Add page" title="Add page after this one (Ctrl N)">
            <Icon name="pageAdd" />
          </button>
          <SyncBadge compact />
          <button className="icon-btn" onClick={(e) => moreMenu(e.currentTarget)} aria-label="More" title="More">
            <Icon name="more" />
          </button>
        </div>,
        toolbarRight,
      )}
      <div className="doc-body">
        {sidebar && s && <PageSidebar session={s} current={current} onGo={goPage} onAddPage={addPage} tab={sideTab} setTab={setSideTab} />}
        <div className="doc-canvas-wrap">
          <div className="vp" ref={hostRef} tabIndex={0} onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()} onDrop={onDrop} aria-label="Notebook page canvas" />
          {s && (
            <div className="undo-pill" role="group" aria-label="History" onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => s.undo()} disabled={!s.canUndo} aria-label="Undo" title={`Undo ${s.undoLabel ?? ""} (Ctrl Z)`}>
                <Icon name="undo" size={20} />
              </button>
              <button onClick={() => s.redo()} disabled={!s.canRedo} aria-label="Redo" title="Redo (Ctrl Shift Z)">
                <Icon name="redo" size={20} />
              </button>
            </div>
          )}
          {!s && (
            <div className="vp-loading">
              <span className="spinner" />
            </div>
          )}
          {s && vp && edit && <TextEditor key={edit.id} vp={vp} session={s} edit={edit} tick={tick} onDone={() => setEdit(null)} />}
          {s && vp && sel && selRect && !edit && (
            <div className="sel-quick" style={{ left: Math.max(8, Math.min(selRect.x + selRect.w / 2 - 120, (hostRef.current?.clientWidth ?? 600) - 250)), top: Math.max(8, selRect.y - 92) }} onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => copySelection(vp)} aria-label="Copy" title="Copy">
                <Icon name="copy" size={18} />
              </button>
              <button onClick={duplicateSel} aria-label="Duplicate" title="Duplicate">
                <Icon name="duplicate" size={18} />
              </button>
              <button onClick={deleteSel} aria-label="Delete" title="Delete">
                <Icon name="trash" size={18} />
              </button>
              <button
                aria-label="Colour"
                title="Colour"
                onClick={(e) =>
                  openMenu(e.currentTarget, [
                    {
                      render: () => (
                        <div className="row" style={{ flexWrap: "wrap", gap: 6, width: 200 }}>
                          {["#130d0c", "#1d4fd8", "#c62828", "#16a34a", "#ea7a1a", "#8b5cf6", "#45bfdb", "#db2777", "#5c5c5c", "#ffffff"].map((c) => (
                            <button key={c} className="color-dot" style={{ background: c }} aria-label={c} onClick={() => recolorSel(c)} />
                          ))}
                        </div>
                      ),
                    },
                  ])
                }
              >
                <Icon name="palette" size={18} />
              </button>
              <button onClick={() => runRecognize("text")} aria-label="Convert to text" title="Convert handwriting to text">
                <Icon name="text" size={18} />
              </button>
              <button onClick={(e) => selectionMenu(e.currentTarget)} aria-label="More selection actions" title="More">
                <Icon name="more" size={18} />
              </button>
            </div>
          )}
          {s && vp && (
            <div className="zoom-chip">
              <button onClick={() => vp.zoomBy(1 / 1.2)} aria-label="Zoom out">
                −
              </button>
              <button
                onClick={(e) =>
                  openMenu(e.currentTarget, [
                    { label: "Fit width", onClick: () => vp.fitWidth() },
                    { label: "Fit page", onClick: () => vp.fitPage() },
                    ...[0.5, 0.75, 1, 1.5, 2, 3].map((z) => ({ label: `${Math.round(z * 100)}%`, onClick: () => vp.zoomAt(z * (96 / 72), vp.vw / 2, vp.vh / 2) })),
                  ])
                }
              >
                {Math.round((vp.zoom * 72 * 100) / 96)}%
              </button>
              <button onClick={() => vp.zoomBy(1.2)} aria-label="Zoom in">
                +
              </button>
            </div>
          )}
          {s && vp && zoombox && <ZoomWindow session={s} vp={vp} tick={tick} onClose={() => tools.set({ zoombox: false })} />}
        </div>
        {s && vp && panel === "search" && <SearchPanel session={s} vp={vp} initial={searchInit} onClose={() => setPanel(null)} />}
        {s && vp && panel === "elements" && <ElementsPanel session={s} vp={vp} onClose={() => setPanel(null)} />}
        {s && panel === "audio" && (
          <AudioPanel
            docId={docId}
            apiRef={audioApi}
            onClose={() => setPanel(null)}
            onFade={(r) => {
              const v = vpRef.current;
              if (!v) return;
              v.fadeAfter = r ? r.after : null;
              v.fadeUntil = r ? r.until : null;
              v.requestBase();
            }}
          />
        )}
      </div>

      {recog && (
        <RecognizeDialog
          title={recog.mode === "math" ? "Maths → LaTeX" : "Handwriting → text"}
          initial={recog.text}
          busy={recog.busy}
          latex={recog.mode === "math"}
          onClose={() => setRecog(null)}
          onInsert={(t) => {
            if (vp && s) docOps.insertTextBelowSelection(vp, s, t, recog.mode === "math");
            setRecog(null);
          }}
          onReplace={
            recog.mode === "text"
              ? (t) => {
                  if (vp && s) docOps.replaceSelectionWithText(vp, s, t);
                  setRecog(null);
                }
              : undefined
          }
        />
      )}
      {card && <FlashcardDialog image={card.image} docId={docId} pageId={card.pageId} onClose={() => setCard(null)} />}
      {linkFor && s && (
        <LinkDialog
          doc={s.doc}
          onClose={() => setLinkFor(false)}
          onSave={(target) => {
            const b = vp?.selectionBounds();
            if (b && vp?.selection) {
              const l: LinkEl = { id: uid(), kind: "link", x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4, rot: 0, ...target };
              s.addItems(vp.selection.pageId, [l], "Link");
              toast("Link added — open it in read-only mode or with Ctrl/⌘-click", "success");
            }
            setLinkFor(false);
          }}
        />
      )}
      {crop && s && (
        <CropDialog
          el={crop}
          onClose={() => setCrop(null)}
          onSave={(c) => {
            const pid = vp?.selection?.pageId ?? s.doc.pageIds[current];
            const old = crop.crop ?? { x: 0, y: 0, w: 1, h: 1 };
            const fullW = crop.w / old.w,
              fullH = crop.h / old.h;
            const next: ImageEl = { ...crop, crop: c, w: fullW * c.w, h: fullH * c.h, x: crop.x + (c.x - old.x) * fullW, y: crop.y + (c.y - old.y) * fullH };
            s.replaceItems(pid, new Map([[crop.id, [next]]]), "Crop");
            setCrop(null);
          }}
        />
      )}
      {tplDialog && s && page && (
        <PageTemplateDialog
          title={tplDialog.mode === "add" ? "Add page" : "Paper template"}
          initial={tplDialog.mode === "add" ? s.doc.defaultBg : page.bg}
          size={{ w: page.w, h: page.h }}
          applyAll={tplDialog.mode === "page"}
          onClose={() => setTplDialog(null)}
          onApply={(bg, dim, scope) => {
            if (tplDialog.mode === "add") {
              const p = docOps.addPageWithBg(s, tplDialog.index, bg, dim);
              setTimeout(() => vpRef.current?.scrollToPage(p.id), 30);
            } else if (scope === "new") s.setDoc({ defaultBg: bg }, true, "Template");
            else {
              const targets = scope === "all" ? s.orderedPages() : [page];
              for (const p of targets) if (p.bg.type === "template") s.updatePage(p.id, { bg, w: dim.w, h: dim.h }, "Template");
              if (scope === "all") s.setDoc({ defaultBg: bg });
              if (targets.some((p) => p.bg.type === "pdf")) toast("PDF pages keep their PDF background.", "info");
            }
            setTplDialog(null);
          }}
        />
      )}
      {history && s && <VersionHistory doc={s.doc} onClose={() => setHistory(false)} />}
      {coverOpen && s && <ChangeCoverDialog doc={s.doc} onClose={() => (setCoverOpen(false), s.reloadFromStorage())} />}
      {presenting && s && <Presentation session={s} start={current} onClose={() => setPresenting(false)} />}
    </div>
  );
}

export { openDoc, settingsStore, unionRect, itemBounds };
