import type { ID, Item } from "../model/types";
import type { ViewportController } from "./viewport";
import type { DocSession } from "./session";
import { itemBounds, translateItem, unionRect } from "../engine/geometry";
import { uid } from "../model/util";
import { canvasToBlob, renderItemsToCanvas } from "../engine/render";
import { putAsset, getAsset } from "../storage/repo";
import { imageSize } from "../services/transfer";
import { toast } from "../state/store";

const MARK = "notefira-clip:";
let clip: { items: Item[]; assets: { id: ID; blob: Blob }[] } | null = null;
let pasteCount = 0;

export function freshIds(items: Item[]): Item[] {
  return items.map((i) => ({ ...i, id: uid() }));
}

export async function copySelection(vp: ViewportController) {
  const items = vp.selectionItems();
  if (!items.length) return;
  const assets: { id: ID; blob: Blob }[] = [];
  for (const it of items)
    if (it.kind === "image") {
      const a = await getAsset(it.asset);
      if (a) assets.push({ id: a.id, blob: a.blob });
    }
  clip = { items, assets };
  pasteCount = 0;
  try {
    const b = unionRect(items.map(itemBounds))!;
    const png = await canvasToBlob(renderItemsToCanvas(items, b, 2, ""));
    const CI = (window as any).ClipboardItem;
    if (CI && navigator.clipboard?.write) await navigator.clipboard.write([new CI({ "text/plain": new Blob([MARK + JSON.stringify({ items })], { type: "text/plain" }), "image/png": png })]);
    else await navigator.clipboard?.writeText(MARK + JSON.stringify({ items }));
  } catch {
    /* system clipboard unavailable — the internal clipboard still works */
  }
}

export function hasClip() {
  return !!clip;
}

/** Paste the internal clipboard (or a Notefira clip from the system clipboard) onto a page. */
export async function pasteItems(vp: ViewportController, session: DocSession, at?: { pageId: ID; x: number; y: number }) {
  let items = clip?.items;
  if (!items) {
    try {
      const t = await navigator.clipboard?.readText();
      if (t?.startsWith(MARK)) items = JSON.parse(t.slice(MARK.length)).items;
    } catch {
      /* ignore */
    }
  }
  if (!items?.length) return false;
  const target = at ?? vp.lastPointer() ?? vp.visibleCenter();
  if (!target) return false;
  const page = session.page(target.pageId);
  if (!page) return false;
  // images copied from another notebook need their own asset copies
  const assetMap = new Map<ID, ID>();
  for (const a of clip?.assets ?? []) {
    const exists = await getAsset(a.id);
    if (!exists || exists.docId !== session.doc.id) {
      const n = await putAsset(a.blob, session.doc.id);
      assetMap.set(a.id, n.id);
    }
  }
  const b = unionRect(items.map(itemBounds))!;
  pasteCount++;
  const sameSpot = !at && clip && b.x + b.w <= page.w + 40 && pasteCount > 0;
  const dx = sameSpot ? 14 * pasteCount : target.x - (b.x + b.w / 2);
  const dy = sameSpot ? 14 * pasteCount : target.y - (b.y + b.h / 2);
  const placed = freshIds(items).map((it) => {
    const moved = translateItem(it, dx, dy);
    return moved.kind === "image" && assetMap.has(moved.asset) ? { ...moved, asset: assetMap.get(moved.asset)! } : moved;
  });
  session.addItems(page.id, placed, "Paste");
  vp.setSelection({ pageId: page.id, ids: new Set(placed.map((i) => i.id)) });
  return true;
}

export async function insertImageFile(vp: ViewportController, session: DocSession, file: Blob, at?: { pageId: ID; x: number; y: number }) {
  if (!file.type.startsWith("image/")) {
    toast("That file is not an image.", "error");
    return;
  }
  const target = at ?? vp.visibleCenter();
  if (!target) return;
  const page = session.page(target.pageId)!;
  const a = await putAsset(file, session.doc.id, (file as File).name);
  const dim = await imageSize(file);
  const k = Math.min((page.w * 0.6) / dim.w, (page.h * 0.5) / dim.h, 1);
  const w = Math.max(20, dim.w * k),
    h = Math.max(20, dim.h * k);
  const x = Math.min(Math.max(8, target.x - w / 2), page.w - w - 8);
  const y = Math.min(Math.max(8, target.y - h / 2), page.h - h - 8);
  const item: Item = { id: uid(), kind: "image", x, y, w, h, rot: 0, asset: a.id, t0: Date.now() };
  session.addItems(page.id, [item], "Insert image");
  vp.setSelection({ pageId: page.id, ids: new Set([item.id]) });
}
