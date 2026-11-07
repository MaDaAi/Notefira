import { useEffect, useState, useSyncExternalStore } from "react";
import { app, useStore, loadSettings, restoreSession, toast, openDoc, settingsStore, updateSettings, log, ONBOARD_FLAG, markBooted } from "./state/store";
import { openDB } from "./storage/db";
import { loadTools } from "./editor/tools";
import { flushAll, hasUnsavedSessions, recoverJournals } from "./editor/session";
import { autoPurgeTrash } from "./storage/repo";
import { initAuth } from "./sync/google";
import { applyTestSwitch } from "./sync/config";
import { startSyncScheduler } from "./sync/scheduler";
import { Welcome } from "./screens/Welcome";
import { Library } from "./screens/library/Library";
import { Editor } from "./editor/Editor";
import { SettingsDialog } from "./screens/Settings";
import { HelpDialog } from "./screens/HelpDialog";
import { MenuHost, AskHost, ToastHost } from "./ui/common";
import { takeLaunchFiles } from "./platform/native";
import { importFiles } from "./services/transfer";
import { activateWaitingServiceWorker, subscribeUpdate, updateSnapshot } from "./pwa";

async function handleLaunchFiles(files: File[]) {
  if (!files.length) return;
  const res = await importFiles(files, null);
  res.messages.forEach((m) => toast(m, "info"));
  if (res.docs[0]) openDoc(res.docs[0].id);
}

export function App() {
  const { ready, screen, active, helpOpen } = useStore(app, (s) => ({ ready: s.ready, screen: s.screen, active: s.active, helpOpen: s.helpOpen }));
  const onboarded = useStore(settingsStore, (s) => s.onboarded);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // First-time visitors see the welcome screen immediately; storage opens in the background.
        let quick = false;
        try {
          quick = localStorage.getItem(ONBOARD_FLAG) !== "1";
        } catch {
          quick = true;
        }
        if (quick) app.set({ ready: true, screen: "welcome" });
        applyTestSwitch(); // ?google-test=on|off (see sync/config.ts)
        await openDB();
        const s = await loadSettings();
        await Promise.all([loadTools(), initAuth()]);
        markBooted();
        if (s.onboarded) await restoreSession();
        app.set({ ready: true, screen: s.onboarded ? (app.get().active ? app.get().screen : "library") : "welcome" });
        const url = new URL(location.href);
        const action = url.searchParams.get("action");
        if (action === "new-notebook" || action === "import-pdf") {
          app.set({ launchAction: action, ...(s.onboarded ? { screen: "library" as const } : {}) });
          url.searchParams.delete("action");
          history.replaceState(history.state, "", url);
        }
        const recovered = await recoverJournals();
        if (recovered.length) toast(`Recovered unsaved changes in: ${recovered.join(", ")}`, "success", undefined, 7000);
        autoPurgeTrash().catch(() => {});
        startSyncScheduler().catch((e) => log("error", String(e)));
        handleLaunchFiles(await takeLaunchFiles());
        // PWA file handling (installed app opened with a file)
        const lq = (window as any).launchQueue;
        if (lq?.setConsumer)
          lq.setConsumer(async (params: any) => {
            const files: File[] = [];
            for (const h of params.files ?? []) files.push(await h.getFile());
            if (files.length) {
              updateSettings({ onboarded: true });
              handleLaunchFiles(files);
            }
          });
      } catch (e: any) {
        setFatal(e?.message ?? String(e));
      }
    })();
  }, []);

  if (fatal)
    return (
      <div className="empty" style={{ height: "100%" }}>
        <h3>Notefira couldn't start</h3>
        <p>{fatal}</p>
        <p className="small">If you're in a private/incognito window, offline storage may be disabled. Try a normal window or the desktop app.</p>
        <button className="btn" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    );
  if (!ready) return null;

  let body;
  if (!onboarded || screen === "welcome") body = <Welcome />;
  else if (screen === "editor" && active) body = <Editor />;
  else body = <Library />;

  return (
    <>
      {body}
      <SettingsDialog />
      {helpOpen && <HelpDialog onClose={() => app.set({ helpOpen: false })} />}
      <MenuHost />
      <AskHost />
      <ToastHost />
      <UpdatePrompt />
    </>
  );
}

function UpdatePrompt() {
  const waiting = useSyncExternalStore(subscribeUpdate, updateSnapshot, () => null);
  const [busy, setBusy] = useState(false);
  if (!waiting) return null;
  const restart = async () => {
    setBusy(true);
    await flushAll();
    if (await hasUnsavedSessions()) {
      setBusy(false);
      toast("Notefira couldn't save every open edit yet. The update will wait; try Restart again in a moment.", "error");
      return;
    }
    activateWaitingServiceWorker();
  };
  return (
    <div className="pwa-update" role="status" aria-live="polite">
      <span>Update available</span>
      <button className="btn small" onClick={() => void restart()} disabled={busy}>
        {busy ? "Saving…" : "Restart"}
      </button>
    </div>
  );
}
