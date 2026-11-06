import { useEffect, useRef, useState } from "react";
import type { DocSession } from "./session";
import type { ID, Page } from "../model/types";
import { pageThumb } from "../screens/library/Cover";
import { Icon } from "../ui/icons";
import { openMenu, promptDialog } from "../ui/common";
import { uid } from "../model/util";
import { rotateItems90 } from "../engine/geometry";

function Thumb({ page }: { page: Page }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVis(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!vis) return;
    let alive = true;
    const t = setTimeout(() => pageThumb(page, 220).then((u) => alive && setUrl(u)), 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [vis, page]);
  return (
    <div ref={ref} className="pthumb-img" style={{ aspectRatio: `${page.w} / ${page.h}` }}>
      {url ? <img src={url} alt="" draggable={false} /> : null}
    </div>
  );
}

export function rotatePage(s: DocSession, id: ID) {
  const p = s.page(id);
  if (!p) return;
  const bg = p.bg.type === "pdf" ? { ...p.bg, rot: (p.bg.rot + 90) % 360 } : p.bg;
  s.updatePage(id, { w: p.h, h: p.w, bg, items: rotateItems90(p.items, p.h) }, "Rotate page");
}

export function PageSidebar({ session, current, onGo, onAddPage, tab, setTab }: { session: DocSession; current: number; onGo: (id: ID) => void; onAddPage: (index: number) => void; tab: "pages" | "bookmarks" | "outline"; setTab: (t: "pages" | "bookmarks" | "outline") => void }) {
  const doc = session.doc;
  const pages = session.orderedPages();
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const [sel, setSel] = useState<Set<ID>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; from: number; startY: number; active: boolean } | null>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${current}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const pageMenu = (p: Page, i: number, at: HTMLElement | { clientX: number; clientY: number }) => {
    const targets = sel.size > 1 && sel.has(p.id) ? [...sel] : [p.id];
    const bm = doc.bookmarks.includes(p.id);
    openMenu(at, [
      { label: "Add page before", icon: "pageAdd", onClick: () => onAddPage(i) },
      { label: "Add page after", icon: "pageAdd", onClick: () => onAddPage(i + 1) },
      { label: targets.length > 1 ? `Duplicate ${targets.length} pages` : "Duplicate", icon: "duplicate", onClick: () => session.duplicatePages(targets) },
      { label: "Rotate 90°", icon: "rotate", onClick: () => targets.forEach((id) => rotatePage(session, id)) },
      { label: bm ? "Remove bookmark" : "Bookmark", icon: "bookmark", onClick: () => session.setDoc({ bookmarks: bm ? doc.bookmarks.filter((b) => b !== p.id) : [...doc.bookmarks, p.id] }, true, "Bookmark") },
      {
        label: "Add to outline…",
        icon: "outline",
        onClick: async () => {
          const t = await promptDialog("Outline entry", `Page ${i + 1}`, "Add");
          if (t?.trim()) session.setDoc({ outline: [...doc.outline, { id: uid(), title: t.trim(), pageId: p.id, level: 0 }].sort((a, b) => doc.pageIds.indexOf(a.pageId) - doc.pageIds.indexOf(b.pageId)) }, true, "Outline");
        },
      },
      { label: "Move to first", icon: "upload", disabled: i === 0, onClick: () => session.movePage(i, 0) },
      { label: "Move to last", icon: "download", disabled: i === pages.length - 1, onClick: () => session.movePage(i, pages.length - 1) },
      { sep: true },
      {
        label: targets.length > 1 ? `Delete ${targets.length} pages` : "Delete page",
        icon: "trash",
        danger: true,
        onClick: () => {
          session.deletePages(targets);
          setSel(new Set());
        },
      },
    ]);
  };

  // pointer-based drag to reorder (works with mouse, touch and pen)
  const onPointerDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    dragRef.current = { id: e.pointerId, from: i, startY: e.clientY, active: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.active && Math.abs(e.clientY - d.startY) > 8) {
      d.active = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (!d.active) return;
    const items = [...(listRef.current?.querySelectorAll("[data-index]") ?? [])] as HTMLElement[];
    let over = items.length - 1;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        over = Number(el.dataset.index);
        break;
      }
    }
    setDrag({ from: d.from, over });
    const lr = listRef.current!.getBoundingClientRect();
    if (e.clientY < lr.top + 40) listRef.current!.scrollTop -= 12;
    if (e.clientY > lr.bottom - 40) listRef.current!.scrollTop += 12;
  };
  const onPointerUp = (e: React.PointerEvent, i: number, p: Page) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.active && drag) {
      const to = drag.over > drag.from ? drag.over - 1 : drag.over;
      if (to !== drag.from) session.movePage(drag.from, Math.max(0, Math.min(pages.length - 1, to)));
      setDrag(null);
      return;
    }
    setDrag(null);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s);
        n.has(p.id) ? n.delete(p.id) : n.add(p.id);
        return n;
      });
      return;
    }
    setSel(new Set());
    onGo(p.id);
    void i;
  };

  return (
    <aside className="page-side">
      <div className="seg page-side-tabs">
        <button className={tab === "pages" ? "on" : ""} onClick={() => setTab("pages")}>
          Pages
        </button>
        <button className={tab === "bookmarks" ? "on" : ""} onClick={() => setTab("bookmarks")}>
          Bookmarks
        </button>
        <button className={tab === "outline" ? "on" : ""} onClick={() => setTab("outline")}>
          Outline
        </button>
      </div>
      {tab === "pages" && (
        <div className="pthumbs" ref={listRef} onPointerMove={onPointerMove}>
          {pages.map((p, i) => (
            <div key={p.id} data-index={i} className={"pthumb" + (i === current ? " on" : "") + (sel.has(p.id) ? " sel" : "") + (drag && drag.over === i && drag.from !== i ? " drop-before" : "")}>
              <button
                className="pthumb-btn"
                aria-current={i === current ? "page" : undefined}
                onPointerDown={(e) => onPointerDown(e, i)}
                onPointerUp={(e) => onPointerUp(e, i, p)}
                // Enter / Space fire a click with detail 0 (no pointer events), so keyboard users can open pages too.
                onClick={(e) => e.detail === 0 && onGo(p.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  pageMenu(p, i, e);
                }}
                aria-label={`Page ${i + 1}`}
              >
                <Thumb page={p} />
                {doc.bookmarks.includes(p.id) && (
                  <span className="pthumb-bm">
                    <Icon name="bookmarkOn" size={14} />
                  </span>
                )}
              </button>
              <div className="pthumb-foot">
                <span>{i + 1}</span>
                <button className="icon-btn small" onClick={(e) => pageMenu(p, i, e.currentTarget)} aria-label={`Page ${i + 1} options`}>
                  <Icon name="chevronDown" size={14} />
                </button>
              </div>
            </div>
          ))}
          {drag && drag.over === pages.length - 1 && <div />}
          <button className="pthumb-add" onClick={() => onAddPage(pages.length)}>
            <Icon name="plus" size={18} /> Add page
          </button>
        </div>
      )}
      {tab === "bookmarks" && (
        <div className="pthumbs">
          {doc.bookmarks.length === 0 && <p className="muted small" style={{ padding: 12 }}>No bookmarks. Use the bookmark button in the top bar (Ctrl/⌘ B) to mark the current page.</p>}
          {doc.bookmarks.map((id) => {
            const i = doc.pageIds.indexOf(id);
            const p = session.page(id);
            if (!p) return null;
            return (
              <div key={id} className={"pthumb" + (i === current ? " on" : "")}>
                <button className="pthumb-btn" aria-label={`Go to bookmarked page ${i + 1}`} onClick={() => onGo(id)}>
                  <Thumb page={p} />
                </button>
                <div className="pthumb-foot">
                  <span>Page {i + 1}</span>
                  <button className="icon-btn small" aria-label="Remove bookmark" onClick={() => session.setDoc({ bookmarks: doc.bookmarks.filter((b) => b !== id) }, true, "Bookmark")}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {tab === "outline" && (
        <div className="outline-list">
          {doc.outline.length === 0 && <p className="muted small" style={{ padding: 12 }}>No outline yet. Add headings for quick navigation; they also become PDF bookmarks when exporting.</p>}
          {doc.outline.map((o) => (
            <div key={o.id} className="outline-row" style={{ paddingLeft: 8 + o.level * 14 }}>
              <button className="grow outline-title" onClick={() => onGo(o.pageId)}>
                {o.title}
                <span className="muted small"> · p.{doc.pageIds.indexOf(o.pageId) + 1}</span>
              </button>
              <button
                className="icon-btn small"
                aria-label="Outline entry options"
                onClick={(e) =>
                  openMenu(e.currentTarget, [
                    {
                      label: "Rename",
                      icon: "text",
                      onClick: async () => {
                        const t = await promptDialog("Rename outline entry", o.title);
                        if (t?.trim()) session.setDoc({ outline: doc.outline.map((x) => (x.id === o.id ? { ...x, title: t.trim() } : x)) }, true, "Outline");
                      },
                    },
                    { label: "Indent", icon: "chevronRight", onClick: () => session.setDoc({ outline: doc.outline.map((x) => (x.id === o.id ? { ...x, level: Math.min(4, x.level + 1) } : x)) }, true, "Outline") },
                    { label: "Outdent", icon: "chevronLeft", onClick: () => session.setDoc({ outline: doc.outline.map((x) => (x.id === o.id ? { ...x, level: Math.max(0, x.level - 1) } : x)) }, true, "Outline") },
                    { label: "Delete", icon: "trash", danger: true, onClick: () => session.setDoc({ outline: doc.outline.filter((x) => x.id !== o.id) }, true, "Outline") },
                  ])
                }
              >
                <Icon name="more" size={16} />
              </button>
            </div>
          ))}
          <button
            className="pthumb-add"
            onClick={async () => {
              const pid = doc.pageIds[current];
              const t = await promptDialog("Add outline entry for this page", `Page ${current + 1}`, "Add");
              if (t?.trim() && pid) session.setDoc({ outline: [...doc.outline, { id: uid(), title: t.trim(), pageId: pid, level: 0 }].sort((a, b) => doc.pageIds.indexOf(a.pageId) - doc.pageIds.indexOf(b.pageId)) }, true, "Outline");
            }}
          >
            <Icon name="plus" size={18} /> Add current page
          </button>
        </div>
      )}
    </aside>
  );
}
