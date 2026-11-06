// Spaced repetition scheduling (SM-2 family, as used by most flashcard apps).
import type { Card, CardSide, ID } from "../model/types";
import { uid } from "../model/util";

export type Grade = 0 | 1 | 2 | 3; // again, hard, good, easy
export const DAY = 86_400_000;

export function newCard(front: CardSide, back: CardSide, src?: { docId?: ID; pageId?: ID }, now = Date.now()): Card {
  return { id: uid(), front, back, docId: src?.docId, pageId: src?.pageId, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now, created: now, updated: now };
}

export function schedule(card: Card, grade: Grade, now = Date.now()): Card {
  let { ease, interval, reps, lapses } = card;
  if (grade === 0) {
    reps = 0;
    lapses += 1;
    ease = Math.max(1.3, ease - 0.2);
    interval = 0;
    return { ...card, ease, interval, reps, lapses, due: now + 10 * 60_000, updated: now };
  }
  reps += 1;
  if (reps === 1) interval = grade === 3 ? 4 : grade === 1 ? 1 : 1;
  else if (reps === 2) interval = grade === 1 ? 3 : grade === 3 ? 8 : 6;
  else {
    const mult = grade === 1 ? 1.2 : grade === 3 ? ease * 1.3 : ease;
    interval = Math.max(interval + 1, Math.round(interval * mult));
  }
  if (grade === 1) ease = Math.max(1.3, ease - 0.15);
  if (grade === 3) ease = ease + 0.15;
  interval = Math.min(interval, 3650);
  return { ...card, ease, interval, reps, lapses, due: now + interval * DAY, updated: now };
}

export function isDue(c: Card, now = Date.now()) {
  return c.due <= now;
}

export function nextIntervalLabel(card: Card, grade: Grade, now = Date.now()): string {
  const n = schedule(card, grade, now);
  const ms = n.due - now;
  if (ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)} h`;
  const d = Math.round(ms / DAY);
  if (d < 31) return `${d} d`;
  if (d < 365) return `${Math.round(d / 30)} mo`;
  return `${(d / 365).toFixed(1)} y`;
}

export function deckStats(cards: Card[], now = Date.now()) {
  return {
    total: cards.length,
    due: cards.filter((c) => isDue(c, now)).length,
    learning: cards.filter((c) => c.reps === 0).length,
    mature: cards.filter((c) => c.interval >= 21).length,
  };
}
