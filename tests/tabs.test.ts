// Two browser tabs (or windows) editing the same notebook. Each tab has its own
// editor session holding its own copy; they share one database. A save from a
// tab with an older copy must never silently remove the other tab's edits.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDB, setDbName } from "../src/storage/db";
import * as repo from "../src/storage/repo";
import { DocSession } from "../src/editor/session";
import { mergeItems, mergePageIds } from "../src/model/merge";
import type { Item } from "../src/model/types";

beforeAll(() => setDbName(`tabs-${Math.random().toString(36).slice(2)}`));
afterAll(() => closeDB());

const text = (id: string, t: string) => ({ id, kind: "text", x: 0, y: 0, w: 10, h: 10, text: t }) as Item;

/** Open the notebook the way a new tab does: its own copy straight from storage. */
async function openTab(docId: string) {
  const doc = (await repo.getDoc(docId))!;
  return new DocSession(doc, await repo.loadPages(doc));
}

async function storedTexts(docId: string) {
  const doc = (await repo.getDoc(docId))!;
  const { pages } = await repo.loadPages(doc);
  return doc.pageIds.map((id) => pages.get(id)!.items.map((i: any) => i.text));
}

describe("two tabs editing the same notebook", () => {
  it("a stale tab's save keeps the other tab's new strokes", async () => {
    const d = await repo.createDoc({ title: "Shared" });
    const page = d.pageIds[0];
    const tab1 = await openTab(d.id);
    const tab2 = await openTab(d.id); // opened before tab1 saved: stale from now on
    tab1.addItems(page, [text("a", "written in tab 1")]);
    await tab1.flush();
    tab2.addItems(page, [text("b", "written in tab 2")]);
    await tab2.flush();
    expect(await storedTexts(d.id)).toEqual([["written in tab 1", "written in tab 2"]]);
    // tab 2 now shows both, and keeps working from the merged state
    expect(tab2.pages.get(page)!.items.map((i) => i.id)).toEqual(["a", "b"]);
    tab2.addItems(page, [text("c", "more in tab 2")]);
    await tab2.flush();
    expect(await storedTexts(d.id)).toEqual([["written in tab 1", "written in tab 2", "more in tab 2"]]);
  });

  it("deletions and edits from both tabs are combined; an edited stroke beats a deletion", async () => {
    const d = await repo.createDoc({ title: "Edits" });
    const page = d.pageIds[0];
    const setup = await openTab(d.id);
    setup.addItems(page, [text("x", "x"), text("y", "y"), text("z", "z")]);
    await setup.flush();
    const tab1 = await openTab(d.id);
    const tab2 = await openTab(d.id);
    tab1.setItems(page, tab1.pages.get(page)!.items.filter((i) => i.id !== "x").map((i) => (i.id === "z" ? { ...i, text: "z edited in 1" } : i)) as Item[]);
    await tab1.flush();
    tab2.setItems(page, tab2.pages.get(page)!.items.filter((i) => i.id !== "y" && i.id !== "z"));
    await tab2.flush();
    // x deleted (tab 1), y deleted (tab 2), z deleted by tab 2 but edited by tab 1: kept
    expect(await storedTexts(d.id)).toEqual([["z edited in 1"]]);
  });

  it("pages added in both tabs are all kept, and a stale page list does not drop pages", async () => {
    const d = await repo.createDoc({ title: "Pages" });
    const tab1 = await openTab(d.id);
    const tab2 = await openTab(d.id);
    const p1 = { ...tab1.pages.get(d.pageIds[0])!, id: "page-from-1", items: [text("p1", "page 1 note")] };
    tab1.setPageList([...tab1.doc.pageIds, p1.id], [p1]);
    await tab1.flush();
    const p2 = { ...tab2.pages.get(d.pageIds[0])!, id: "page-from-2", items: [text("p2", "page 2 note")] };
    tab2.setPageList([...tab2.doc.pageIds, p2.id], [p2]);
    await tab2.flush();
    const stored = (await repo.getDoc(d.id))!;
    expect(stored.pageIds).toEqual([d.pageIds[0], "page-from-1", "page-from-2"]);
    expect(await storedTexts(d.id)).toEqual([[], ["page 1 note"], ["page 2 note"]]);
  });

  it("a page deleted in one tab but written on in another is kept", async () => {
    const d = await repo.createDoc({ title: "Keep", pages: 2 });
    const second = d.pageIds[1];
    const tab1 = await openTab(d.id);
    const tab2 = await openTab(d.id);
    tab1.addItems(second, [text("k", "important")]);
    await tab1.flush();
    tab2.setPageList([d.pageIds[0]]);
    await tab2.flush();
    expect((await repo.getDoc(d.id))!.pageIds).toEqual(d.pageIds);
    expect(await storedTexts(d.id)).toEqual([[], ["important"]]);
    expect(tab2.doc.pageIds).toEqual(d.pageIds);
  });

  it("a stale tab does not revert a rename or favourite made elsewhere", async () => {
    const d = await repo.createDoc({ title: "Old name" });
    const tab2 = await openTab(d.id);
    await repo.saveDoc({ ...(await repo.getDoc(d.id))!, title: "New name", favorite: true });
    tab2.addItems(d.pageIds[0], [text("t", "hi")]);
    await tab2.flush();
    const stored = (await repo.getDoc(d.id))!;
    expect(stored.title).toBe("New name");
    expect(stored.favorite).toBe(true);
  });

  it("edits made while a merging save is in flight are not lost", async () => {
    const d = await repo.createDoc({ title: "In flight" });
    const page = d.pageIds[0];
    const tab1 = await openTab(d.id);
    const tab2 = await openTab(d.id);
    tab1.addItems(page, [text("one", "tab 1")]);
    await tab1.flush();
    tab2.addItems(page, [text("two", "tab 2")]);
    const saving = tab2.flush();
    tab2.addItems(page, [text("three", "tab 2 while saving")]);
    await saving;
    await tab2.flush();
    expect(await storedTexts(d.id)).toEqual([["tab 1", "tab 2", "tab 2 while saving"]]);
  });

  it("merge rules", () => {
    const a = text("a", "a");
    const b = text("b", "b");
    expect(mergeItems([a, b], [a, b, text("m", "m")], [a, b, text("t", "t")]).map((i) => i.id)).toEqual(["a", "b", "t", "m"]);
    expect(mergeItems([a, b], [b], [a, b]).map((i) => i.id)).toEqual(["b"]);
    expect(mergeItems([a, b], [b], [{ ...a, text: "changed" } as Item, b]).map((i) => (i as any).text)).toEqual(["changed", "b"]);
    expect(mergePageIds(["1", "2"], ["2", "1"], ["1", "2"])).toEqual(["2", "1"]); // only I reordered
    expect(mergePageIds(["1", "2"], ["1", "2", "m"], ["1", "t", "2"])).toEqual(["1", "t", "2", "m"]);
  });
});
