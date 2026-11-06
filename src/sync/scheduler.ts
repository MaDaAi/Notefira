// Background sync orchestration: debounced after edits, periodic, on reconnect,
// with exponential back-off after failures. Progress is exposed for the UI.
import { createStore, settingsStore, log, toast } from "../state/store";
import { auth, getToken, invalidateToken, AuthRequired } from "./google";
import { DriveClient } from "./drive";
import { setBeforeApply, syncOnce, syncSummary, type SyncProgress, type SyncReport, type SyncSummary } from "./engine";
import { onChange } from "../storage/repo";
import { flushAll } from "../editor/session";
import { kvGet } from "../storage/db";

/**
 * What the badge shows. "synced" is only used after Drive confirmed every change;
 * "pending" means local changes are waiting; "attention" means a notebook needs
 * the user's decision; "conflict" means a notebook was edited on two devices and
 * both versions were kept.
 */
export type SyncState = "signed-out" | "synced" | "syncing" | "pending" | "offline" | "conflict" | "attention" | "error" | "paused";

export const syncStore = createStore<{
  state: SyncState;
  progress: SyncProgress | null;
  lastSync: number | null;
  error: string | null;
  lastReport: SyncReport | null;
  pending: boolean;
  summary: SyncSummary;
}>({
  state: "signed-out",
  progress: null,
  lastSync: null,
  error: null,
  lastReport: null,
  pending: false,
  summary: { pending: 0, attention: 0, conflicts: 0 },
});

let client: DriveClient | null = null;
export function drive(): DriveClient {
  if (!client) client = new DriveClient(() => getToken(), () => invalidateToken());
  return client;
}

let running: Promise<void> | null = null;
let timer: any = null;
let failures = 0;
let started = false;
let lastFailed = false;

/** Recompute the badge state from the database (pending changes, notebooks needing a decision, conflicts). */
export async function refreshSyncState() {
  const acc = auth.get().account;
  const summary = await syncSummary(acc?.email ?? null).catch(() => syncStore.get().summary);
  const cur = syncStore.get();
  let state: SyncState;
  if (!acc) state = "signed-out";
  else if (running) state = "syncing";
  else if (typeof navigator !== "undefined" && !navigator.onLine) state = "offline";
  else if (lastFailed) state = cur.state === "offline" ? "offline" : "error";
  else if (summary.attention) state = "attention";
  else if (summary.conflicts) state = "conflict";
  else if (summary.pending || cur.pending) state = !settingsStore.get().autoSync ? "paused" : "pending";
  else if (!settingsStore.get().autoSync && !cur.lastSync) state = "paused";
  else state = "synced";
  syncStore.set({ summary, state });
}

export function scheduleSync(delay = 8000) {
  if (!auth.get().account) return;
  syncStore.set({ pending: true });
  void refreshSyncState();
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

/** Only one tab syncs at a time; another tab holding the lock is already doing the work. */
async function withSyncLock(fn: () => Promise<void>) {
  const locks = (typeof navigator !== "undefined" && (navigator as any).locks) || null;
  if (!locks) return fn();
  await locks.request("notefira-sync", { ifAvailable: true }, async (lock: unknown) => {
    if (lock) await fn();
  });
}

export async function syncNow(manual = false): Promise<void> {
  if (running) return running;
  const acc = auth.get().account;
  if (!acc) {
    syncStore.set({ state: "signed-out" });
    return;
  }
  if (!manual && !settingsStore.get().autoSync) {
    await refreshSyncState();
    return;
  }
  if (!navigator.onLine) {
    syncStore.set({ state: "offline" });
    void refreshSyncState();
    return;
  }
  running = (async () => {
    syncStore.set({ state: "syncing", error: null, pending: false });
    try {
      await withSyncLock(async () => {
        await flushAll();
        const rep = await syncOnce(drive(), acc.email, (p) => syncStore.set({ progress: p }));
        failures = 0;
        lastFailed = rep.errors.length > 0;
        syncStore.set({
          lastSync: await kvGet<number | null>("lastSync", null),
          progress: null,
          lastReport: rep,
          error: rep.errors.length ? rep.errors.join("\n") : null,
        });
        if (rep.conflicts) toast(`${rep.conflicts} notebook(s) were edited on two devices. Both versions were kept (look for “conflicted copy”).`, "info", undefined, 8000);
        if (rep.attention) toast(`${rep.attention} notebook(s) need your decision before they can sync. Nothing was deleted. See Settings → Google Drive.`, "info", undefined, 10000);
        // never log notebook titles or contents
        if (rep.errors.length) log("warn", `Sync finished with ${rep.errors.length} error(s)`);
        if (rep.deferred || rep.errors.length) {
          clearTimeout(timer);
          timer = setTimeout(() => void syncNow(), rep.deferred ? 3000 : 60_000);
        }
      });
    } catch (e: any) {
      failures++;
      lastFailed = true;
      const offline = !navigator.onLine || e?.status === 0;
      const msg = e instanceof AuthRequired ? "Reconnect your Google account to keep syncing." : e?.message ?? String(e);
      syncStore.set({ state: offline ? "offline" : "error", error: msg, progress: null });
      log("error", "Sync failed" + (e?.status ? ` (HTTP ${e.status})` : ""));
      if (!(e instanceof AuthRequired)) {
        const delay = Math.min(10 * 60_000, 5000 * 2 ** Math.min(failures, 7));
        clearTimeout(timer);
        timer = setTimeout(() => void syncNow(), delay);
      }
    } finally {
      running = null;
      await refreshSyncState();
    }
  })();
  return running;
}

export async function startSyncScheduler() {
  if (started) return;
  started = true;
  // an open notebook saves its unsaved strokes before a download is applied; the engine then sees the edit and keeps both versions
  setBeforeApply(() => flushAll());
  syncStore.set({ lastSync: await kvGet<number | null>("lastSync", null) });
  await refreshSyncState();
  let lastEmail = auth.get().account?.email ?? null;
  auth.subscribe(() => {
    const email = auth.get().account?.email ?? null;
    if (email !== lastEmail) {
      // a different account: "last synced" belonged to the previous one
      lastEmail = email;
      lastFailed = false;
      syncStore.set({ lastSync: null, lastReport: null, error: null });
    }
    void refreshSyncState();
  });
  onChange((topic) => {
    if (topic === "library" || topic === "decks" || topic.startsWith("recordings:")) scheduleSync(10_000);
  });
  window.addEventListener("online", () => scheduleSync(1500));
  window.addEventListener("offline", () => void refreshSyncState());
  setInterval(() => scheduleSync(0), 3 * 60_000);
  if (auth.get().account) scheduleSync(2500);
}
