import { useEffect, useRef, useState } from "react";
import type { Cover as CoverT, Doc, Page } from "../../model/types";
import * as db from "../../storage/db";
import { assetUrl, onChange } from "../../storage/repo";
import { renderPageToCanvasAsync, canvasToBlob } from "../../engine/render";

// Thumbnail cache: docId@rev -> object URL
const thumbs = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export async function pageThumb(page: Page, width = 320, key?: string): Promise<string | null> {
  const k = key ?? `${page.id}@${page.updated}@${width}`;
  const hit = thumbs.get(k);
  if (hit) return hit;
  let p = inflight.get(k);
  if (!p) {
    p = (async () => {
      try {
        const c = await renderPageToCanvasAsync(page, width, { showLinks: false });
        const url = URL.createObjectURL(await canvasToBlob(c, "image/png"));
        c.width = c.height = 0;
        thumbs.set(k, url);
        if (thumbs.size > 400) {
          const first = thumbs.keys().next().value as string;
          URL.revokeObjectURL(thumbs.get(first)!);
          thumbs.delete(first);
        }
        return url;
      } catch {
        return null;
      } finally {
        inflight.delete(k);
      }
    })();
    inflight.set(k, p);
  }
  return p;
}

/** Lazily renders the first page of a document when it scrolls into view. */
export function FirstPageThumb({ doc }: { doc: Doc }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      const page = await db.get<Page>("pages", doc.pageIds[0]);
      if (!page) return;
      const u = await pageThumb(page, 320, `${doc.id}@${doc.rev}@${page.updated}`);
      if (alive) setUrl(u);
    })();
    return () => {
      alive = false;
    };
  }, [visible, doc.id, doc.rev, doc.pageIds[0]]);
  return (
    <div ref={ref} className="thumb-page">
      {url ? <img src={url} alt="" draggable={false} /> : <div className="thumb-skel" />}
    </div>
  );
}

export function CoverArt({ cover, title }: { cover: CoverT; title?: string }) {
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    if (cover.type === "image") assetUrl(cover.asset).then(setImg);
  }, [cover.type === "image" ? cover.asset : ""]);
  if (cover.type === "image")
    return (
      <div className="cover" style={{ backgroundImage: img ? `url(${img})` : undefined, backgroundSize: "cover", backgroundPosition: "center" }}>
        <div className="cover-spine" />
      </div>
    );
  const color = cover.type === "color" ? cover.color : "#45bfdb";
  const pattern = cover.type === "color" ? cover.pattern : "plain";
  return (
    <div className={`cover pat-${pattern}`} style={{ background: color }}>
      <div className="cover-spine" />
      {title && <div className="cover-label">{title}</div>}
    </div>
  );
}

export function DocCover({ doc }: { doc: Doc }) {
  if (doc.cover.type === "page") return <FirstPageThumb doc={doc} />;
  return <CoverArt cover={doc.cover} title={doc.title} />;
}

export function useLibraryVersion() {
  const [v, setV] = useState(0);
  useEffect(
    () =>
      onChange((t) => {
        if (t === "library" || t === "decks" || t === "stickers") setV((x) => x + 1);
      }),
    [],
  );
  return v;
}

export const COVER_COLORS = ["#45bfdb", "#1f3b57", "#e4572e", "#f2a541", "#3c9d5d", "#7d6ff0", "#ef6f6c", "#2d2a32", "#c9b79c", "#8fb8de", "#b04b77", "#f5f0e6"];
export const COVER_PATTERNS: ("plain" | "lines" | "dots" | "wave" | "grid")[] = ["plain", "lines", "dots", "wave", "grid"];
