import type { Item } from "../model/types";
import { safeParse, validateItem } from "../model/format";

export const CLIP_MARK = "notefira-clip:";
export const MAX_CLIP_CHARS = 8 * 1024 * 1024;
export const MAX_CLIP_ITEMS = 10_000;

/** System clipboard contents are untrusted, just like imported notebooks. */
export function parseClipboardItems(text: string): Item[] | null {
  if (!text.startsWith(CLIP_MARK) || text.length > MAX_CLIP_CHARS) return null;
  try {
    const items: unknown = safeParse(text.slice(CLIP_MARK.length))?.items;
    if (!Array.isArray(items) || !items.length || items.length > MAX_CLIP_ITEMS || !items.every(validateItem)) return null;
    return items;
  } catch {
    return null;
  }
}
