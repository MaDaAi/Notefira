import { useEffect, useState } from "react";
import type { Doc } from "../../model/types";
import { searchAll, type SearchHit } from "../../services/search";
import { openDoc } from "../../state/store";
import { DocCover } from "./Cover";
import { Icon } from "../../ui/icons";

const KIND: Record<SearchHit["kind"], string> = {
  title: "Title", pdf: "PDF text", typed: "Typed text", handwriting: "Handwriting",
  ocr: "Scanned text (OCR)", outline: "Outline", card: "Flashcard", audio: "Audio transcript",
};

export function SearchResults({ query, docs }: { query: string; docs: Doc[] }) {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    setHits(null);
    const timer = setTimeout(() => searchAll(query).then(setHits), 180);
    return () => clearTimeout(timer);
  }, [query]);
  const byDoc = new Map<string, SearchHit[]>();
  for (const hit of hits ?? []) byDoc.set(hit.docId, [...(byDoc.get(hit.docId) ?? []), hit]);
  return (
    <div className="search-results">
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted grow">{hits == null ? "Searching…" : `${hits.length} result${hits.length === 1 ? "" : "s"} for “${query}”`}</span>
      </div>
      {[...byDoc.entries()].map(([docId, list]) => {
        const doc = docs.find((item) => item.id === docId);
        if (!doc) return null;
        return (
          <div key={docId} className="search-doc">
            <button className="search-doc-head" onClick={() => openDoc(docId)}>
              <span className="search-thumb"><DocCover doc={doc} /></span>
              <span className="grow"><strong>{doc.title}</strong><span className="muted small"> · {list.length} match{list.length === 1 ? "" : "es"}</span></span>
            </button>
            {list.filter((hit) => hit.kind !== "title").slice(0, 8).map((hit, index) => (
              <button key={index} className="search-hit" onClick={() => openDoc(docId, { pageId: hit.pageId, q: query })}>
                <span className="search-kind">{KIND[hit.kind]}{hit.pageIndex != null && hit.pageIndex >= 0 ? ` · page ${hit.pageIndex + 1}` : ""}</span>
                <span className="search-snip">{hit.snippet}</span>
              </button>
            ))}
          </div>
        );
      })}
      {hits && !hits.length && (
        <div className="empty">
          <Icon name="search" size={36} />
          <h3>No matches</h3>
          <p>Search looks in titles, PDF text, typed text, outlines, flashcards, transcripts and locally recognised handwriting.</p>
        </div>
      )}
    </div>
  );
}
