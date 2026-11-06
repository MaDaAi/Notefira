import * as repo from "../storage/repo";
import type { Doc, ID, Page } from "../model/types";

export interface SearchHit {
  docId: ID;
  pageId?: ID;
  pageIndex?: number;
  kind: "title" | "pdf" | "typed" | "handwriting" | "ocr" | "outline" | "card" | "audio";
  snippet: string;
  score: number;
}

function norm(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function snippetAround(text: string, q: string, radius = 60): string {
  const i = norm(text).indexOf(norm(q));
  if (i < 0) return text.slice(0, radius * 2);
  const a = Math.max(0, i - radius),
    b = Math.min(text.length, i + q.length + radius);
  return (a > 0 ? "…" : "") + text.slice(a, b).replace(/\s+/g, " ") + (b < text.length ? "…" : "");
}

export function pageTypedText(p: Page): string {
  return p.items
    .filter((i) => i.kind === "text")
    .map((i) => (i as any).text as string)
    .join("\n");
}

/** Search every notebook: titles, PDF text, typed text, recognised handwriting, OCR, outlines, flashcards, transcripts. */
export async function searchAll(query: string, limit = 200): Promise<SearchHit[]> {
  const q = norm(query.trim());
  if (!q) return [];
  const [docs, pages, texts, decks] = await Promise.all([repo.listDocs(), repo.listAllPages(), repo.listAllTexts(), repo.listDecks()]);
  const live = new Map<ID, Doc>(docs.filter((d) => !d.deletedAt).map((d) => [d.id, d]));
  const hits: SearchHit[] = [];
  const pageIndex = (d: Doc, pid: ID) => d.pageIds.indexOf(pid);
  for (const d of live.values()) {
    if (norm(d.title).includes(q)) hits.push({ docId: d.id, kind: "title", snippet: d.title, score: 100 });
    for (const o of d.outline) if (norm(o.title).includes(q)) hits.push({ docId: d.id, pageId: o.pageId, pageIndex: pageIndex(d, o.pageId), kind: "outline", snippet: o.title, score: 80 });
  }
  for (const p of pages) {
    const d = live.get(p.docId);
    if (!d || !d.pageIds.includes(p.id)) continue;
    const typed = pageTypedText(p);
    if (typed && norm(typed).includes(q)) hits.push({ docId: d.id, pageId: p.id, pageIndex: pageIndex(d, p.id), kind: "typed", snippet: snippetAround(typed, query), score: 60 });
    if (p.recognized && norm(p.recognized).includes(q)) hits.push({ docId: d.id, pageId: p.id, pageIndex: pageIndex(d, p.id), kind: "handwriting", snippet: snippetAround(p.recognized, query), score: 55 });
  }
  for (const t of texts) {
    const d = live.get(t.docId);
    if (!d || !d.pageIds.includes(t.pageId)) continue;
    if (norm(t.text).includes(q)) hits.push({ docId: d.id, pageId: t.pageId, pageIndex: pageIndex(d, t.pageId), kind: t.source === "ocr" ? "ocr" : "pdf", snippet: snippetAround(t.text, query), score: 50 });
  }
  for (const deck of decks) {
    if (deck.deletedAt) continue;
    for (const c of deck.cards) {
      const txt = `${c.front.text ?? ""} ${c.back.text ?? ""}`;
      if (c.docId && live.has(c.docId) && norm(txt).includes(q)) hits.push({ docId: c.docId, pageId: c.pageId, kind: "card", snippet: snippetAround(txt, query), score: 30 });
    }
  }
  try {
    const all = await Promise.all([...live.keys()].map((id) => repo.listRecordings(id)));
    for (const recs of all)
      for (const r of recs)
        for (const line of r.transcript)
          if (norm(line.text).includes(q)) {
            hits.push({ docId: r.docId, kind: "audio", snippet: `🎙 ${r.title}: ${snippetAround(line.text, query)}`, score: 40 });
            break;
          }
  } catch {
    /* ignore */
  }
  hits.sort((a, b) => b.score - a.score || (live.get(b.docId)!.updated ?? 0) - (live.get(a.docId)!.updated ?? 0));
  return hits.slice(0, limit);
}

/** Positions of matches on one page (PDF text runs + typed text boxes) for in-document highlighting. */
export async function pageMatches(page: Page, query: string): Promise<repo.TextRun[]> {
  const q = norm(query.trim());
  if (!q) return [];
  const out: repo.TextRun[] = [];
  const t = await repo.getPageText(page.id);
  if (t) for (const r of t.runs) if (norm(r.s).includes(q)) out.push(r);
  for (const it of page.items) if (it.kind === "text" && norm(it.text).includes(q)) out.push({ s: it.text, x: it.x, y: it.y, w: it.w, h: it.h });
  return out;
}

export interface DocHit {
  pageId: ID;
  index: number;
  snippet: string;
  kind: SearchHit["kind"];
}

export async function searchDoc(doc: Doc, pages: Map<ID, Page>, query: string): Promise<DocHit[]> {
  const q = norm(query.trim());
  if (!q) return [];
  const texts = new Map((await repo.listDocTexts(doc.id)).map((t) => [t.pageId, t]));
  const out: DocHit[] = [];
  doc.pageIds.forEach((pid, index) => {
    const p = pages.get(pid);
    if (!p) return;
    const pdf = texts.get(pid);
    if (pdf && norm(pdf.text).includes(q)) out.push({ pageId: pid, index, snippet: snippetAround(pdf.text, query), kind: pdf.source === "ocr" ? "ocr" : "pdf" });
    const typed = pageTypedText(p);
    if (typed && norm(typed).includes(q)) out.push({ pageId: pid, index, snippet: snippetAround(typed, query), kind: "typed" });
    if (p.recognized && norm(p.recognized).includes(q)) out.push({ pageId: pid, index, snippet: snippetAround(p.recognized, query), kind: "handwriting" });
  });
  for (const o of doc.outline) if (norm(o.title).includes(q)) out.push({ pageId: o.pageId, index: doc.pageIds.indexOf(o.pageId), snippet: o.title, kind: "outline" });
  return out;
}
