// Background sync orchestration: debounced after edits, periodic, on reconnect,
// with exponential back-off after failures. Progress is exposed for the UI.
import { createStore, settingsStore, log, toast } from "../state/store";
import { auth, getToken, invalidateToken, AuthRequired } from "./google";
import { DriveClient } from "./drive";
import { syncOnce, type SyncProgress, type SyncReport } from "./engine";
import { onChange } from "../storage/repo";
import { flushAll } from "../editor/session";
import { kvGet } from "../storage/db";

export type SyncState = "signed-out" | "idle" | "syncing" | "offline" | "error" | "paused";

export const syncStore = createStore<{ state: SyncState; progress: SyncProgress | null; lastSync: number | null; error: string | null; lastReport: SyncReport | null; pending: boolean }>({
  state: "signed-out",
  progress: null,
  lastSync: null,
  error: null,
  lastReport: null,
  pending: false,
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

export function scheduleSync(delay = 8000) {
  if (!auth.get().account) return;
  syncStore.set({ pending: true });
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

export async function syncNow(manual = false): Promise<void> {
  if (running) return running;
  if (!auth.get().account) {
    syncStore.set({ state: "signed-out" });
    return;
  }
  if (!manual && !settingsStore.get().autoSync) {
    syncStore.set({ state: "paused", pending: false });
    return;
  }
  if (!navigator.onLine) {
    syncStore.set({ state: "offline" });
    return;
  }
  running = (async () => {
    syncStore.set({ state: "syncing", error: null, pending: false });
    try {
      await flushAll();
      const rep = await syncOnce(drive(), (p) => syncStore.set({ progress: p }));
      failures = 0;
      syncStore.set({ state: "idle", lastSync: Date.now(), progress: null, lastReport: rep, error: rep.errors.length ? rep.errors.join("\n") : null });
      if (rep.conflicts) toast(`${rep.conflicts} notebook(s) were edited on two devices. Both versions were kept (look for “conflicted copy”).`, "info", undefined, 8000);
      if (rep.errors.length) log("warn", "Sync finished with errors: " + rep.errors.join("; "));
    } catch (e: any) {
      failures++;
      const offline = !navigator.onLine || e?.status === 0;
      const msg = e instanceof AuthRequired ? "Reconnect your Google account to keep syncing." : e?.message ?? String(e);
      syncStore.set({ state: offline ? "offline" : "error", error: msg, progress: null });
      log("error", "Sync failed: " + msg);
      if (!(e instanceof AuthRequired)) {
        const delay = Math.min(10 * 60_000, 5000 * 2 ** Math.min(failures, 7));
        clearTimeout(timer);
        timer = setTimeout(() => void syncNow(), delay);
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

export async function startSyncScheduler() {
  if (started) return;
  started = true;
  syncStore.set({ lastSync: await kvGet<number | null>("lastSync", null), state: auth.get().account ? "idle" : "signed-out" });
  auth.subscribe(() => {
    const signedIn = !!auth.get().account;
    const s = syncStore.get().state;
    if (!signedIn && s !== "signed-out") syncStore.set({ state: "signed-out" });
    if (signedIn && s === "signed-out") syncStore.set({ state: "idle" });
  });
  onChange((topic) => {
    if (topic === "library" || topic === "decks" || topic.startsWith("recordings:")) scheduleSync(10_000);
  });
  window.addEventListener("online", () => scheduleSync(1500));
  window.addEventListener("offline", () => syncStore.set({ state: "offline" }));
  setInterval(() => scheduleSync(0), 3 * 60_000);
  if (auth.get().account) scheduleSync(2500);
}
