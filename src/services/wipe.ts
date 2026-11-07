// "Delete all Notefira data on this device": the local database (notebooks,
// pages, PDFs, images, recordings, study sets, settings, the linked Google
// account), Notefira's browser storage and the desktop keychain entry. Copies in
// Google Drive are not touched (that is a separate, explicit action).
import { deleteDatabase } from "../storage/db";
import { setSecret, isTauri } from "../platform/native";
import { auth, signOut } from "../sync/google";

/** Browser-storage keys Notefira writes (see the Cookie Policy). */
const KEYS = ["nf-onboarded", "nf-theme", "notefira-journal", "notefira-google-test"];

export async function deleteAllLocalData(): Promise<void> {
  if (auth.get().account) await signOut().catch(() => {});
  await deleteDatabase();
  try {
    for (const k of KEYS) localStorage.removeItem(k);
    sessionStorage.removeItem("notefira-gtoken");
  } catch {
    /* storage unavailable: nothing stored there */
  }
  if (isTauri()) await setSecret("googleRefresh", "").catch(() => {});
}
