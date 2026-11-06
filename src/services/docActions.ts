import * as repo from "../storage/repo";
import type { Doc, ID } from "../model/types";
import { toast, openDoc, app } from "../state/store";
import { confirmDialog, promptDialog } from "../ui/common";
import { saveFile, shareFile } from "../platform/native";
import { exportNotefira, guessName } from "./transfer";
import { exportDocToPdf } from "./pdfExport";
import { printPages } from "./print";
import { releaseSession, getSession } from "../editor/session";
import { closeTab } from "../state/store";

export const busyStore = { set: (_: string | null) => {} };

async function pagesOf(docId: ID) {
  const s = await getSession(docId);
  await s.flush();
  return { doc: s.doc, pages: s.pages };
}

export async function renameDoc(doc: Doc) {
  const name = await promptDialog("Rename notebook", doc.title, "Rename");
  if (name == null || !name.trim()) return;
  const cur = await repo.getDoc(doc.id);
  if (cur) await repo.saveDoc({ ...cur, title: name.trim().slice(0, 200) });
  const sess = await getSession(doc.id).catch(() => null);
  if (sess) sess.doc = { ...sess.doc, title: name.trim().slice(0, 200) };
}

export async function toggleFavorite(doc: Doc) {
  const cur = await repo.getDoc(doc.id);
  if (cur) await repo.saveDoc({ ...cur, favorite: !cur.favorite }, false);
}

export async function duplicate(doc: Doc) {
  const d = await repo.duplicateDoc(doc.id);
  if (d) toast(`Duplicated “${doc.title}”`, "success", { label: "Open", run: () => openDoc(d.id) });
}

export async function trash(doc: Doc) {
  await releaseSession(doc.id);
  closeTab(doc.id);
  await repo.trashDoc(doc.id);
  toast(`Moved “${doc.title}” to Trash`, "info", { label: "Undo", run: () => repo.restoreDoc(doc.id) });
}

export async function deleteForever(doc: Doc) {
  if (!(await confirmDialog("Delete forever?", `“${doc.title}” will be permanently deleted from this device${doc.remoteId ? " and from Google Drive" : ""}. This cannot be undone.`, "Delete", true))) return;
  await releaseSession(doc.id);
  closeTab(doc.id);
  await repo.purgeDoc(doc.id);
}

export async function exportPdf(docId: ID, pageIds?: ID[]) {
  const t = toast("Preparing PDF…", "info");
  void t;
  try {
    const { doc, pages } = await pagesOf(docId);
    const bytes = await exportDocToPdf(doc, pages, { pageIds });
    const ok = await saveFile(guessName(doc.title, "pdf"), bytes, "application/pdf");
    if (ok) toast("PDF exported", "success");
  } catch (e: any) {
    toast("PDF export failed: " + (e?.message ?? e), "error");
  }
}

export async function exportNotebook(docId: ID) {
  try {
    const doc = await repo.getDoc(docId);
    if (!doc) return;
    await getSession(docId).then((s) => s.flush());
    const bytes = await exportNotefira(docId);
    const ok = await saveFile(guessName(doc.title, "notefira"), bytes, "application/x-notefira");
    if (ok) toast("Notebook exported (fully editable .notefira file)", "success");
  } catch (e: any) {
    toast("Export failed: " + (e?.message ?? e), "error");
  }
}

export async function share(docId: ID, as: "pdf" | "notefira" = "pdf") {
  try {
    const { doc, pages } = await pagesOf(docId);
    const bytes = as === "pdf" ? await exportDocToPdf(doc, pages) : await exportNotefira(docId);
    const blob = new Blob([bytes as BlobPart], { type: as === "pdf" ? "application/pdf" : "application/x-notefira" });
    const r = await shareFile(guessName(doc.title, as), blob, doc.title);
    if (r === "saved") toast("Saved — sharing isn't available here, so the file was saved instead.", "info");
  } catch (e: any) {
    toast("Sharing failed: " + (e?.message ?? e), "error");
  }
}

export async function print(docId: ID, pageIds?: ID[]) {
  try {
    const { doc, pages } = await pagesOf(docId);
    const list = (pageIds ?? doc.pageIds).map((id) => pages.get(id)!).filter(Boolean);
    toast(`Preparing ${list.length} page(s) for printing…`, "info");
    await printPages(doc.title, list);
  } catch (e: any) {
    toast("Printing failed: " + (e?.message ?? e), "error");
  }
}

export function openSplit(docId: ID) {
  const s = app.get();
  if (!s.active || s.active === docId) {
    openDoc(docId);
    toast("Open another notebook to view side by side.", "info");
    return;
  }
  openDoc(docId, { split: true });
}
