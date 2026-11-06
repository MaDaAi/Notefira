import { useStore, app } from "../../state/store";
import { syncStore, syncNow } from "../../sync/scheduler";
import { auth, signIn } from "../../sync/google";
import { Icon } from "../../ui/icons";
import { formatDate } from "../../model/util";
import { toast } from "../../state/store";

export function syncLabel(state: string, lastSync: number | null, progress: { phase: string; done: number; total: number } | null) {
  switch (state) {
    case "syncing":
      return progress ? `${progress.phase}${progress.total > 1 ? ` ${progress.done}/${progress.total}` : ""}…` : "Syncing…";
    case "offline":
      return "Offline — changes are saved and will sync later";
    case "error":
      return "Sync problem — will retry";
    case "paused":
      return "Automatic sync is off";
    case "signed-out":
      return "Saved on this device";
    default:
      return lastSync ? `Synced ${formatDate(lastSync)}` : "Ready to sync";
  }
}

export function SyncBadge({ compact }: { compact?: boolean }) {
  const s = useStore(syncStore, (x) => x);
  const acc = useStore(auth, (x) => x);
  const icon = s.state === "syncing" ? "cloudSync" : s.state === "offline" || s.state === "error" ? "cloudOff" : "cloud";
  const label = acc.needsReconnect ? "Reconnect Google Drive" : syncLabel(s.state, s.lastSync, s.progress);
  const click = async () => {
    if (!acc.account) return app.set({ settingsOpen: "cloud" });
    if (acc.needsReconnect) {
      try {
        await signIn();
      } catch (e: any) {
        toast(e?.message ?? String(e), "error");
      }
      return;
    }
    syncNow(true);
  };
  if (compact)
    return (
      <button className={"icon-btn sync-" + s.state} onClick={click} title={label + (s.error ? `\n${s.error}` : "")} aria-label={label}>
        {s.state === "syncing" ? <span className="spinner" /> : <Icon name={icon} />}
      </button>
    );
  return (
    <button className={"sync-badge sync-" + s.state} onClick={click} title={s.error ?? label}>
      {s.state === "syncing" ? <span className="spinner" /> : <Icon name={icon} size={20} />}
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="sync-acc">{acc.account ? acc.account.email : "Google Drive sync off"}</span>
        <span className="sync-state">{label}</span>
      </span>
      {s.state === "syncing" && s.progress && s.progress.total > 1 && (
        <span className="progress" style={{ width: 40 }}>
          <div style={{ width: `${(100 * s.progress.done) / s.progress.total}%` }} />
        </span>
      )}
    </button>
  );
}
