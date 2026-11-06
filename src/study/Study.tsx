import { useEffect, useMemo, useState } from "react";
import type { Card, CardSide, Deck, ID } from "../model/types";
import * as repo from "../storage/repo";
import { useAsync, Dialog, confirmDialog, promptDialog, openMenu } from "../ui/common";
import { useLibraryVersion } from "../screens/library/Cover";
import { Icon } from "../ui/icons";
import { deckStats, isDue, newCard, nextIntervalLabel, schedule, type Grade } from "./srs";
import { uid, formatDate } from "../model/util";
import { openDoc, toast } from "../state/store";

export async function addCardToDeck(deckId: ID | null, card: Card, deckName = "My study set"): Promise<Deck> {
  const decks = await repo.listDecks();
  let deck = deckId ? decks.find((d) => d.id === deckId) : undefined;
  if (!deck) deck = { id: uid(), name: deckName, cards: [], created: Date.now(), updated: Date.now() };
  deck = { ...deck, cards: [...deck.cards, card] };
  await repo.saveDeck(deck);
  return deck;
}

export function CardFace({ side }: { side: CardSide }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (side.image) repo.assetUrl(side.image).then(setUrl);
  }, [side.image]);
  return (
    <div className="card-face">
      {url && <img src={url} alt={side.text ? "" : "Image on this card"} />}
      {side.text && <div className="card-text">{side.text}</div>}
      {!url && !side.text && <span className="muted">(empty)</span>}
    </div>
  );
}

export function StudyScreen({ onMenu }: { onMenu: () => void }) {
  const v = useLibraryVersion();
  const { data: decks } = useAsync(() => repo.listDecks(), [v]);
  const [open, setOpen] = useState<ID | null>(null);
  const [studying, setStudying] = useState<ID | "all" | null>(null);
  const live = (decks ?? []).filter((d) => !d.deletedAt);
  const allDue = live.flatMap((d) => d.cards).filter((c) => isDue(c)).length;
  const deck = live.find((d) => d.id === open);

  if (studying) return <StudySession decks={studying === "all" ? live : live.filter((d) => d.id === studying)} onClose={() => setStudying(null)} />;
  if (deck) return <DeckView deck={deck} onBack={() => setOpen(null)} onStudy={() => setStudying(deck.id)} />;

  return (
    <>
      <header className="lib-head">
        <button className="icon-btn burger" onClick={onMenu} aria-label="Open menu">
          <Icon name="sidebar" />
        </button>
        <div className="lib-crumbs grow">
          <h1>Study sets</h1>
        </div>
        <button className="btn" disabled={!allDue} onClick={() => setStudying("all")}>
          Study all due ({allDue})
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            const name = await promptDialog("New study set", "", "Create");
            if (name?.trim()) {
              const d: Deck = { id: uid(), name: name.trim(), cards: [], created: Date.now(), updated: Date.now() };
              await repo.saveDeck(d);
              setOpen(d.id);
            }
          }}
        >
          <Icon name="plus" size={18} /> <span className="hide-sm">New set</span>
        </button>
      </header>
      <div className="lib-scroll">
        {live.length === 0 ? (
          <div className="empty">
            <Icon name="cards" size={40} />
            <h3>No study sets yet</h3>
            <p>Create flashcards here, from a lasso selection in any notebook (“Make flashcard”), or let AI generate them from a notebook.</p>
          </div>
        ) : (
          <div className="deck-grid">
            {live.map((d) => {
              const st = deckStats(d.cards);
              return (
                <div key={d.id} className="deck-card">
                  <button className="deck-main" onClick={() => setOpen(d.id)}>
                    <div className="deck-stack">
                      <Icon name="cards" size={28} />
                    </div>
                    <div className="deck-title">{d.name}</div>
                    <div className="muted small">
                      {st.total} cards · <span style={{ color: st.due ? "var(--c-accent-ink)" : undefined }}>{st.due} due</span>
                    </div>
                  </button>
                  <div className="row" style={{ padding: "0 12px 12px" }}>
                    <button className="btn small accent grow" disabled={!st.due} onClick={() => setStudying(d.id)}>
                      Study
                    </button>
                    <button
                      className="icon-btn small"
                      aria-label="Study set options"
                      onClick={(e) =>
                        openMenu(e.currentTarget, [
                          {
                            label: "Rename",
                            icon: "text",
                            onClick: async () => {
                              const n = await promptDialog("Rename study set", d.name);
                              if (n?.trim()) await repo.saveDeck({ ...d, name: n.trim() });
                            },
                          },
                          {
                            label: "Reset progress",
                            icon: "restore",
                            onClick: async () => {
                              if (await confirmDialog("Reset progress?", "All cards become new again.")) await repo.saveDeck({ ...d, cards: d.cards.map((c) => ({ ...c, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: Date.now() })) });
                            },
                          },
                          {
                            label: "Delete",
                            icon: "trash",
                            danger: true,
                            onClick: async () => {
                              if (await confirmDialog("Delete study set?", `“${d.name}” and its ${d.cards.length} cards will be deleted.`, "Delete", true)) await repo.saveDeck({ ...d, deletedAt: Date.now() });
                            },
                          },
                        ])
                      }
                    >
                      <Icon name="more" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function DeckView({ deck, onBack, onStudy }: { deck: Deck; onBack: () => void; onStudy: () => void }) {
  const [edit, setEdit] = useState<Card | "new" | null>(null);
  const st = deckStats(deck.cards);
  const save = (cards: Card[]) => repo.saveDeck({ ...deck, cards });
  return (
    <>
      <header className="lib-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back to study sets">
          <Icon name="back" />
        </button>
        <div className="lib-crumbs grow">
          <h1>{deck.name}</h1>
          <span className="muted small hide-sm">
            {st.total} cards · {st.due} due · {st.mature} mature
          </span>
        </div>
        <button className="btn" onClick={() => setEdit("new")}>
          <Icon name="plus" size={16} /> <span className="hide-sm">Card</span>
        </button>
        <button className="btn primary" disabled={!st.due} onClick={onStudy}>
          Study ({st.due})
        </button>
      </header>
      <div className="lib-scroll">
        {deck.cards.length === 0 && (
          <div className="empty">
            <Icon name="cards" size={40} />
            <h3>No cards yet</h3>
            <p>Add a card, or use the lasso in a notebook and choose “Make flashcard”.</p>
          </div>
        )}
        <div className="card-list">
          {deck.cards.map((c) => (
            <div key={c.id} className="card-row">
              <button className="card-row-main" onClick={() => setEdit(c)}>
                <CardFace side={c.front} />
                <CardFace side={c.back} />
              </button>
              <div className="card-row-meta">
                <span className="muted small">{isDue(c) ? "Due now" : `Due ${formatDate(c.due)}`}</span>
                {c.docId && (
                  <button className="btn small ghost" onClick={() => openDoc(c.docId!, { pageId: c.pageId })}>
                    Source
                  </button>
                )}
                <button className="icon-btn small" aria-label="Delete card" onClick={() => save(deck.cards.filter((x) => x.id !== c.id))}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {edit && (
        <CardEditor
          card={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSave={(front, back) => {
            if (edit === "new") save([...deck.cards, newCard(front, back)]);
            else save(deck.cards.map((x) => (x.id === edit.id ? { ...x, front, back, updated: Date.now() } : x)));
            setEdit(null);
          }}
        />
      )}
    </>
  );
}

function CardEditor({ card, onClose, onSave }: { card: Card | null; onClose: () => void; onSave: (f: CardSide, b: CardSide) => void }) {
  const [front, setFront] = useState(card?.front.text ?? "");
  const [back, setBack] = useState(card?.back.text ?? "");
  return (
    <Dialog
      title={card ? "Edit card" : "New card"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!front.trim() && !card?.front.image} onClick={() => onSave({ ...card?.front, text: front }, { ...card?.back, text: back })}>
            Save
          </button>
        </>
      }
    >
      {card?.front.image && <CardFace side={{ image: card.front.image }} />}
      <label className="field">
        Front (question)
        <textarea value={front} onChange={(e) => setFront(e.target.value)} autoFocus />
      </label>
      {card?.back.image && <CardFace side={{ image: card.back.image }} />}
      <label className="field">
        Back (answer)
        <textarea value={back} onChange={(e) => setBack(e.target.value)} />
      </label>
    </Dialog>
  );
}

function StudySession({ decks, onClose }: { decks: Deck[]; onClose: () => void }) {
  const [queue, setQueue] = useState<{ deckId: ID; card: Card }[]>(() =>
    decks
      .flatMap((d) => d.cards.filter((c) => isDue(c)).map((card) => ({ deckId: d.id, card })))
      .sort((a, b) => a.card.due - b.card.due),
  );
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const cur = queue[0];
  const grade = async (g: Grade) => {
    if (!cur) return;
    const next = schedule(cur.card, g);
    const deck = (await repo.listDecks()).find((d) => d.id === cur.deckId);
    if (deck) await repo.saveDeck({ ...deck, cards: deck.cards.map((c) => (c.id === next.id ? next : c)) });
    setQueue((q) => {
      const rest = q.slice(1);
      return g === 0 ? [...rest, { deckId: cur.deckId, card: next }] : rest;
    });
    setDone((d) => d + 1);
    setFlipped(false);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped(true);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) grade((Number(e.key) - 1) as Grade);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const total = useMemo(() => queue.length + done, []);
  return (
    <div className="study">
      <header className="lib-head">
        <button className="icon-btn" onClick={onClose} aria-label="End session">
          <Icon name="close" />
        </button>
        <div className="grow">
          <div className="progress">
            <div style={{ width: `${total ? (100 * done) / Math.max(total, done + queue.length) : 100}%` }} />
          </div>
        </div>
        <span className="muted small">{queue.length} left</span>
      </header>
      {cur ? (
        <div className="study-stage">
          <button className={"flashcard" + (flipped ? " flipped" : "")} onClick={() => setFlipped(!flipped)} aria-label="Flip card">
            <div className="flashcard-inner">
              <div className="flashcard-side front">
                <CardFace side={cur.card.front} />
              </div>
              <div className="flashcard-side back">
                <CardFace side={cur.card.back} />
              </div>
            </div>
          </button>
          {flipped ? (
            <div className="grade-row">
              {(["Again", "Hard", "Good", "Easy"] as const).map((l, i) => (
                <button key={l} className={"btn grade g" + i} onClick={() => grade(i as Grade)}>
                  <strong>{l}</strong>
                  <span className="small muted">{nextIntervalLabel(cur.card, i as Grade)}</span>
                </button>
              ))}
            </div>
          ) : (
            <button className="btn primary" onClick={() => setFlipped(true)}>
              Show answer <span className="kbd-key">Space</span>
            </button>
          )}
        </div>
      ) : (
        <div className="empty">
          <Icon name="check" size={40} />
          <h3>All done!</h3>
          <p>You reviewed {done} card{done === 1 ? "" : "s"}. Come back later for the next review.</p>
          <button className="btn primary" onClick={onClose}>
            Finish
          </button>
        </div>
      )}
    </div>
  );
}
