import { useStore, app } from "../../state/store";
import { syncStore, syncNow } from "../../sync/scheduler";
import type { SyncSummary } from "../../sync/engine";
import type { Doc } from "../../model/types";
import { auth, signIn } from "../../sync/google";
import { Icon } from "../../ui/icons";
import { formatDate } from "../../model/util";
import { toast } from "../../state/store";

/** What the library shows for one notebook: nothing when it is in sync. */
export function docSyncStatus(d: Doc, account: string | null): { icon: string; label: string; warn: boolean } | null {
  if (!account || d.deletedAt) return null;
  if (d.localOnly) return { icon: "cloudOff", label: d.cloudRemoval ? "On this device only — removing the Google Drive copy at the next sync" : d.remoteId ? "On this device only — a copy is still in Google Drive" : "On this device only (not synced)", warn: false };
  const acc = account.trim().toLowerCase();
  if (d.syncIssue?.dismissed) return { icon: "cloudOff", label: "Kept on this device only", warn: false };
  if (d.syncIssue) return { icon: "cloudOff", label: d.syncIssue.kind === "missing" ? "Removed from Google Drive — needs your decision" : d.syncIssue.kind === "damaged" ? "Drive copy is damaged — needs your decision" : "Linked to another Google account — needs your decision", warn: true };
  if (d.syncAccount && d.syncAccount !== acc) return { icon: "cloudOff", label: "Linked to another Google account — needs your decision", warn: true };
  if (d.rev !== d.syncedRev) return { icon: "cloudSync", label: "Saved on this device, waiting to upload", warn: false };
  return null;
}

export function DocSyncIcon({ doc }: { doc: Doc }) {
  const email = useStore(auth, (x) => x.account?.email ?? null);
  const st = docSyncStatus(doc, email);
  const conflict = doc.conflictOf && !doc.deletedAt;
  if (!st && !conflict) return null;
  if (!st)
    return (
      <span className="lib-conflict" title="A second version kept after edits on two devices — choose in Settings → Cloud sync">
        Conflict
      </span>
    );
  return (
    <span className={"lib-sync" + (st.warn ? " warn" : "")} role="img" aria-label={st.label} title={st.label}>
      <Icon name={st.icon} size={14} />
    </span>
  );
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

export function syncLabel(state: string, lastSync: number | null, progress: { phase: string; done: number; total: number } | null, summary?: SyncSummary) {
  const pending = summary?.pending ?? 0;
  switch (state) {
    case "syncing":
      return progress ? `${progress.phase}${progress.total > 1 ? ` ${progress.done}/${progress.total}` : ""}…` : "Syncing…";
    case "offline":
      return pending ? `Offline — ${n(pending, "notebook", "notebooks")} will upload when you're back online` : "Offline — changes are saved and will sync later";
    case "error":
      return "Sync problem — will retry";
    case "paused":
      return pending ? `Automatic sync is off — ${n(pending, "notebook", "notebooks")} not uploaded` : "Automatic sync is off";
    case "signed-out":
      return "Saved on this device";
    case "pending":
      return pending ? `${n(pending, "notebook", "notebooks")} waiting to upload` : "Changes waiting to sync";
    case "attention":
      return `${n(summary?.attention ?? 0, "notebook needs", "notebooks need")} your decision`;
    case "conflict":
      return "Edited on two devices — both versions kept";
    default:
      return lastSync ? `Synced ${formatDate(lastSync)}` : "Ready to sync";
  }
}

export function SyncBadge({ compact }: { compact?: boolean }) {
  const s = useStore(syncStore, (x) => x);
  const acc = useStore(auth, (x) => x);
  const icon = s.state === "syncing" ? "cloudSync" : s.state === "offline" || s.state === "error" || s.state === "attention" ? "cloudOff" : "cloud";
  const label = acc.needsReconnect ? (s.summary.pending ? `Reconnect Google Drive — ${s.summary.pending} waiting` : "Reconnect Google Drive") : syncLabel(s.state, s.lastSync, s.progress, s.summary);
  const click = async () => {
    if (acc.account && acc.needsReconnect) {
      try {
        await signIn({ reconnect: true });
      } catch (e: any) {
        toast(e?.message ?? String(e), "error");
      }
      return;
    }
    if (!acc.account || s.state === "attention" || s.state === "conflict") return app.set({ settingsOpen: "cloud" });
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
