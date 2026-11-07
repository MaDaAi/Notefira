import { useEffect, useState, type ReactNode } from "react";
import { Dialog, Switch, useAsync, confirmDialog } from "../ui/common";
import { app, settingsStore, updateSettings, useStore, toast } from "../state/store";
import { DEFAULT_TOOLBAR, type ToolId } from "../model/types";
import { TOOL_LABELS } from "../editor/tools";
import { GoogleG, Icon } from "../ui/icons";
import { auth, signIn, signOut, GOOGLE_ACCESS_URL } from "../sync/google";
import { syncStore, syncNow, startSyncingAgain, deleteDriveDataAndSignOut } from "../sync/scheduler";
import { deleteAllLocalData } from "../services/wipe";
import { syncLabel } from "./library/SyncBadge";
import { DEV_BUILD, googleSignInAvailable } from "../sync/config";
import { exportBackup, importBackup } from "../services/transfer";
import { saveFile, pickFiles, isTauri, checkForDesktopUpdate, platformName, secretStorageMode } from "../platform/native";
import { storageEstimate, requestPersistentStorage, getDoc, listDocs, onChange } from "../storage/repo";
import { formatBytes } from "../model/util";
import { kvGet, kvSet } from "../storage/db";
import { resolveSyncIssue, dismissDamagedRemote, dismissNotice, resolveConflictChoice, type Conflict, type DamagedRemote, type SyncNotice } from "../sync/engine";
import type { Doc } from "../model/types";
import { openDoc } from "../state/store";
import { PAPER_SIZES } from "../model/templates";
import { APP_VERSION } from "../version";

const SECTIONS = [
  ["general", "General", "settings"],
  ["stylus", "Stylus & touch", "pen"],
  ["toolbar", "Toolbar & pens", "grid"],
  ["cloud", "Cloud sync", "cloud"],
  ["backup", "Backup & storage", "box"],
  ["about", "About", "info"],
] as const;

export function SettingsDialog() {
  const section = useStore(app, (s) => s.settingsOpen);
  const s = useStore(settingsStore, (x) => x);
  if (!section) return null;
  const close = () => app.set({ settingsOpen: null });
  return (
    <Dialog title="Settings" onClose={close} wide>
      <div className="settings">
        <nav className="settings-nav">
          {SECTIONS.map(([id, label, icon]) => (
            <button key={id} className={"nav-item" + (section === id ? " on" : "")} onClick={() => app.set({ settingsOpen: id })}>
              <Icon name={icon} size={18} />
              <span className="grow">{label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {section === "general" && (
            <>
              <Row label="Appearance">
                <div className="seg">
                  {(["light", "dark", "system"] as const).map((t) => (
                    <button key={t} className={s.theme === t ? "on" : ""} onClick={() => updateSettings({ theme: t })}>
                      {t === "light" ? "Light" : t === "dark" ? "Dark" : "System"}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Default paper size">
                <select className="input" style={{ width: 180 }} value={s.defaultPaper} onChange={(e) => updateSettings({ defaultPaper: e.target.value as any })}>
                  {Object.entries(PAPER_SIZES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Default orientation">
                <div className="seg">
                  <button className={s.defaultOrientation === "portrait" ? "on" : ""} onClick={() => updateSettings({ defaultOrientation: "portrait" })}>
                    Portrait
                  </button>
                  <button className={s.defaultOrientation === "landscape" ? "on" : ""} onClick={() => updateSettings({ defaultOrientation: "landscape" })}>
                    Landscape
                  </button>
                </div>
              </Row>
              <Row label="Show welcome screen next launch" hint="Shows the start screen with sign-in and import options again.">
                <Switch on={!s.onboarded} onChange={(v) => updateSettings({ onboarded: !v })} label="Show welcome screen" />
              </Row>
            </>
          )}
          {section === "stylus" && (
            <>
              <Row label="Draw with finger" hint="When off, fingers only scroll and zoom.">
                <Switch on={s.fingerDrawing} onChange={(v) => updateSettings({ fingerDrawing: v })} label="Draw with finger" />
              </Row>
              <Row label="Palm rejection" hint="Once a stylus is detected, touches scroll and zoom instead of drawing.">
                <Switch on={s.palmRejection} onChange={(v) => updateSettings({ palmRejection: v })} label="Palm rejection" />
              </Row>
              <Row label="Pressure sensitivity" hint="Stroke width follows stylus pressure (fountain and brush pens).">
                <Switch on={s.pressure} onChange={(v) => updateSettings({ pressure: v })} label="Pressure sensitivity" />
              </Row>
              <Row label="Draw and hold to make shapes" hint="Keep the pen still at the end of a stroke to snap it to a line, circle, rectangle or triangle.">
                <Switch on={s.shapeHold} onChange={(v) => updateSettings({ shapeHold: v })} label="Shape recognition" />
              </Row>
              <Row label="Scribble to erase" hint="Scrub quickly back and forth over writing with a pen or pencil to erase it.">
                <Switch on={s.scribbleErase !== false} onChange={(v) => updateSettings({ scribbleErase: v })} label="Scribble to erase" />
              </Row>
            </>
          )}
          {section === "toolbar" && <ToolbarSettings />}
          {section === "cloud" && <CloudSettings />}
          {section === "backup" && <BackupSettings />}
          {section === "about" && <About />}
        </div>
      </div>
    </Dialog>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="grow">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function ToolbarSettings() {
  const s = useStore(settingsStore, (x) => x);
  const all: ToolId[] = DEFAULT_TOOLBAR;
  const list = s.toolbar;
  const move = (i: number, d: number) => {
    const n = [...list];
    const [m] = n.splice(i, 1);
    n.splice(Math.max(0, Math.min(n.length, i + d)), 0, m);
    updateSettings({ toolbar: n });
  };
  return (
    <>
      <p className="muted small" style={{ margin: 0 }}>
        Choose which tools appear in the toolbar and their order.
      </p>
      {list.map((t, i) => (
        <div key={t} className="set-row">
          <span className="grow">{TOOL_LABELS[t]}</span>
          <button className="icon-btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
            <Icon name="chevronLeft" size={16} style={{ transform: "rotate(90deg)" }} />
          </button>
          <button className="icon-btn small" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
            <Icon name="chevronRight" size={16} style={{ transform: "rotate(90deg)" }} />
          </button>
          <Switch on label={`Show ${TOOL_LABELS[t]}`} onChange={() => list.length > 1 && updateSettings({ toolbar: list.filter((x) => x !== t) })} />
        </div>
      ))}
      {all
        .filter((t) => !list.includes(t))
        .map((t) => (
          <div key={t} className="set-row">
            <span className="grow muted">{TOOL_LABELS[t]}</span>
            <Switch on={false} label={`Show ${TOOL_LABELS[t]}`} onChange={() => updateSettings({ toolbar: [...list, t] })} />
          </div>
        ))}
      <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => updateSettings({ toolbar: DEFAULT_TOOLBAR })}>
        Reset toolbar
      </button>
      <strong>Favourite pens</strong>
      {s.presets.map((p) => (
        <div key={p.id} className="set-row">
          <svg width="40" height="16" viewBox="0 0 40 16" aria-hidden="true">
            <path d="M3 12 C 12 2, 22 15, 37 4" stroke={p.color} strokeWidth={Math.min(9, Math.max(1.5, p.tool === "highlighter" ? p.width / 2 : p.width * 1.4))} strokeOpacity={p.tool === "highlighter" ? 0.5 : 1} fill="none" strokeLinecap="round" />
          </svg>
          <span className="grow small">
            {p.tool === "highlighter" ? "Highlighter" : p.pen[0].toUpperCase() + p.pen.slice(1)} · {p.width}
          </span>
          <button className="icon-btn small" onClick={() => updateSettings({ presets: s.presets.filter((x) => x.id !== p.id) })} aria-label="Remove preset">
            <Icon name="trash" size={16} />
          </button>
        </div>
      ))}
      <p className="muted small" style={{ margin: 0 }}>
        Add favourites with the + button next to the pen colours in the editor.
      </p>
    </>
  );
}

const ISSUE_TEXT: Record<string, (d: Doc) => string> = {
  missing: () => "is no longer in your Google Drive (deleted on another device or in Drive). It's still on this device.",
  "other-account": (d) => `is linked to ${d.syncIssue?.detail ?? "another Google account"}. It won't be copied into this account unless you choose to.`,
  damaged: () => "has a damaged copy in Google Drive, so it wasn't applied. Your copy on this device is unchanged.",
};
const UPLOAD_LABEL: Record<string, string> = { missing: "Upload again", "other-account": "Copy to this account", damaged: "Replace Drive copy" };

/** Notebooks that stopped syncing until the user decides. Nothing here is ever deleted automatically. */
function SyncDecisions({ version }: { version: unknown }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [damaged, setDamaged] = useState<DamagedRemote[]>([]);
  const [notices, setNotices] = useState<SyncNotice[]>([]);
  useEffect(() => {
    const load = () => {
      listDocs().then((ds) => setDocs(ds.filter((d) => d.syncIssue && !d.deletedAt)));
      kvGet<DamagedRemote[]>("damagedRemote", []).then((l) => setDamaged(l.filter((x) => !x.dismissed)));
      kvGet<SyncNotice[]>("syncNotices", []).then(setNotices);
    };
    load();
    return onChange((t) => (t === "library" || t.startsWith("doc:")) && load());
  }, [version]);
  if (!docs.length && !damaged.length && !notices.length) return null;
  const act = async (id: string, a: "upload" | "keep-local" | "trash") => {
    await resolveSyncIssue(id, a);
    if (a === "upload") syncNow(true);
  };
  return (
    <>
      <strong>Needs your decision</strong>
      {docs.map((d) => (
        <div key={d.id} className="set-row" style={{ flexWrap: "wrap" }}>
          <span className="grow small" style={{ minWidth: 200 }}>
            “{d.title}” {d.syncIssue!.dismissed ? "is kept on this device only." : ISSUE_TEXT[d.syncIssue!.kind]?.(d)}
          </span>
          <button className="btn small" onClick={() => (openDoc(d.id), app.set({ settingsOpen: null }))}>
            Open
          </button>
          <button className="btn small" onClick={() => act(d.id, "upload")}>
            {UPLOAD_LABEL[d.syncIssue!.kind] ?? "Upload"}
          </button>
          {!d.syncIssue!.dismissed && (
            <button className="btn small" onClick={() => act(d.id, "keep-local")}>
              Keep on this device only
            </button>
          )}
          {d.syncIssue!.kind === "missing" && (
            <button className="btn small" onClick={() => act(d.id, "trash")} title="Moves it to Notefira's Trash, where you can still restore it">
              Move to Trash
            </button>
          )}
        </div>
      ))}
      {notices.map((x) => (
        <div key={x.id} className="set-row">
          <span className="grow small">“{x.title}” was deleted on this device, but another device had changed it since, so the newer version was kept and is back in your library.</span>
          <button
            className="btn small"
            onClick={async () => {
              await dismissNotice(x.id);
              setNotices((l) => l.filter((y) => y.id !== x.id));
            }}
          >
            OK
          </button>
        </div>
      ))}
      {damaged.map((x) => (
        <div key={x.fileId} className="set-row">
          <span className="grow small">
            {x.reason === "duplicate"
              ? `Google Drive has a second, different version of a notebook (“${x.name}”). It couldn't be safely copied to this device, so it was left in Drive. Notefira will try again on the next sync.`
              : `“${x.name}” in Google Drive is damaged, so it wasn't added to this device. The file is still in Drive, where you can restore an earlier version.`}
          </span>
          <button
            className="btn small"
            onClick={async () => {
              await dismissDamagedRemote(x.fileId);
              setDamaged((l) => l.filter((y) => y.fileId !== x.fileId));
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
    </>
  );
}

function CloudSettings() {
  const s = useStore(settingsStore, (x) => x);
  const acc = useStore(auth, (x) => x);
  const st = useStore(syncStore, (x) => x);
  const [clientId, setClientId] = useState(s.googleClientId);
  const [secret, setSecret] = useState(s.googleClientSecret);
  const [busy, setBusy] = useState(false);
  const [deleteDrive, setDeleteDrive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // conflicted copies are marked on the notebooks themselves, so every signed-in device shows the same list
  const [conflicts, setConflicts] = useState<{ copy: Doc; original: Doc | undefined }[]>([]);
  useEffect(() => {
    const load = () =>
      listDocs().then((ds) =>
        setConflicts(
          ds.filter((d) => d.conflictOf && !d.deletedAt).map((copy) => ({ copy, original: ds.find((o) => o.id === copy.conflictOf) })),
        ),
      );
    load();
    return onChange((t) => (t === "library" || t === "sync-status") && load());
  }, [st.lastSync]);
  const [secretMode, setSecretMode] = useState<"keychain" | "session-only" | null>(null);
  useEffect(() => {
    secretStorageMode().then(setSecretMode).catch(() => setSecretMode("session-only"));
  }, []);
  const available = googleSignInAvailable();
  const signInNow = async () => {
    setBusy(true);
    try {
      const a = await signIn();
      toast(`Signed in as ${a.email}`, "success");
    } catch (e: any) {
      toast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="ai-note">
        <Icon name="cloud" size={18} />
        <div className="small">
          {available ? (
            <>
              Continue with Google to keep your notebooks — pages, handwriting, PDFs, images, audio, folders and study sets — in a <strong>Notefira Sync</strong> folder in your own Google Drive, and on every device where you sign in. Notefira can only see and change the files it creates itself — none of your other Drive files. Notefira has no accounts of its own: Google confirms who you are. By continuing with Google you agree to the{" "}
              <a href="./legal/terms.html" target="_blank" rel="noopener noreferrer">
                Terms
              </a>{" "}
              and{" "}
              <a href="./legal/privacy.html" target="_blank" rel="noopener noreferrer">
                Privacy Policy
              </a>
              .
            </>
          ) : (
            <>Google Drive sync isn't available in this version of Notefira yet. Your notebooks are saved on this device; use Backup &amp; storage to keep copies.</>
          )}
        </div>
      </div>
      {available && secretMode && (
        <p className="small muted" role="note" style={{ margin: 0 }}>
          {!isTauri()
            ? "On the web, Notefira never stores long-term Google sign-in tokens. A short-lived access token lasts only until you close this tab; after that you'll be asked to reconnect."
            : secretMode === "keychain"
              ? "Your Google sign-in is kept in your system's secure keychain."
              : "Your system's secure keychain isn't available, so Notefira won't store your Google sign-in at all. You'll need to sign in again each time you open Notefira. Nothing is saved unencrypted."}
        </p>
      )}
      {DEV_BUILD && (
        <details className="small" style={{ border: "1px dashed var(--c-line)", borderRadius: 8, padding: "6px 10px" }}>
          <summary>Developer settings (development builds only)</summary>
          <p className="muted" style={{ margin: "6px 0" }}>
            Override the Google OAuth client for local testing. Production builds ignore this and use the client built into the app.
          </p>
          <label className="field">
            OAuth client ID override
            <input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="1234567890-abc….apps.googleusercontent.com" spellCheck={false} />
          </label>
          {isTauri() && (
            <label className="field">
              Desktop client secret (stored in the OS keychain)
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value.trim())} spellCheck={false} />
            </label>
          )}
          <button className="btn small" onClick={() => updateSettings({ googleClientId: clientId, googleClientSecret: secret }).then(() => toast("Saved", "success"))}>
            Save
          </button>
        </details>
      )}
      <div className="row">
        {!acc.account ? (
          available && (
            <button className="btn primary" disabled={busy} onClick={() => void signInNow()}>
              {busy ? <span className="spinner" /> : <GoogleG size={16} />} Continue with Google
            </button>
          )
        ) : (
          <>
            {acc.needsReconnect ? (
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    await signIn({ reconnect: true });
                  } catch (e: any) {
                    toast(e?.message ?? String(e), "error");
                  }
                }}
              >
                Reconnect
              </button>
            ) : (
              <button className="btn primary" onClick={() => syncNow(true)} disabled={st.state === "syncing"}>
                Sync now
              </button>
            )}
            <button
              className="btn"
              onClick={async () => {
                if (!(await confirmDialog("Sign out of Google Drive?", "Your notebooks stay on this device, including changes that haven't uploaded yet, and the copies in Drive stay in Drive. Syncing stops, and Notefira asks Google to remove its access."))) return;
                const { revoked } = await signOut();
                setNotice(revoked ? "signed-out" : "signed-out-unconfirmed");
              }}
            >
              Sign out
            </button>
          </>
        )}
      </div>
      {acc.account && (
        <>
          <Row label={acc.account.email} hint={syncLabel(st.state, st.lastSync, st.progress, st.summary) + (st.error ? ` — ${st.error}` : "")}>
            <span />
          </Row>
          <Row label="Sync automatically" hint="In the background after changes, every few minutes and when the connection returns.">
            <Switch on={s.autoSync} onChange={(v) => updateSettings({ autoSync: v })} label="Sync automatically" />
          </Row>
          {st.lastReport && (
            <p className="small muted" style={{ margin: 0 }}>
              Last sync: {st.lastReport.uploaded} uploaded, {st.lastReport.downloaded} downloaded, {st.lastReport.conflicts} conflict(s).
            </p>
          )}
        </>
      )}
      {acc.account && st.folderGone && (
        <div className="ai-note" role="alert">
          <Icon name="cloudOff" size={18} />
          <div className="small">
            <strong>Your “Notefira Sync” folder is no longer in Google Drive.</strong> It was deleted there or on another device, so syncing is paused and nothing was uploaded. Your notebooks on this device are unchanged.
            <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
              <button
                className="btn small"
                onClick={async () => {
                  if (await confirmDialog("Start syncing again?", "A new “Notefira Sync” folder is created in your Google Drive and this device's notebooks are uploaded to it (except those kept on this device only).", "Start syncing again")) await startSyncingAgain();
                }}
              >
                Start syncing again
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  const { revoked } = await signOut();
                  setNotice(revoked ? "signed-out" : "signed-out-unconfirmed");
                }}
              >
                Stop syncing (sign out)
              </button>
            </div>
          </div>
        </div>
      )}
      {acc.account && <SyncDecisions version={st.lastSync} />}
      {available && (
        <p className="small muted" style={{ margin: 0 }}>
          <a href={GOOGLE_ACCESS_URL} target="_blank" rel="noopener noreferrer">
            Manage Google access
          </a>{" "}
          — see or remove Notefira's access to your Google account at any time.
        </p>
      )}
      {acc.account && (
        <Row label="Delete Notefira's data from Google Drive" hint="Moves all Notefira notebooks, attachments and settings in your Drive to the Google Drive trash, then signs you out. Notebooks on this device stay.">
          <button className="btn small danger" onClick={() => setDeleteDrive(true)}>
            Delete from Drive…
          </button>
        </Row>
      )}
      {deleteDrive && (
        <TypeToConfirm
          title="Delete Notefira's data from Google Drive?"
          action="Move to Google Drive trash"
          onClose={() => setDeleteDrive(false)}
          onConfirm={async () => {
            const r = await deleteDriveDataAndSignOut();
            setDeleteDrive(false);
            setNotice(r.revoked ? `drive-deleted:${r.trashed}` : `drive-deleted-unconfirmed:${r.trashed}`);
          }}
        >
          <p style={{ marginTop: 0 }}>
            Everything Notefira created in <strong>{acc.account?.email}</strong>'s Google Drive — every notebook (including conflicted copies), its PDFs, images and audio, your folder names and study sets, and the “Notefira Sync” folder — is <strong>moved to the Google Drive trash</strong>. You are then signed out on this device.
          </p>
          <ul className="small" style={{ paddingLeft: 18 }}>
            <li>
              <strong>Google Drive trash is not permanent deletion.</strong> Google keeps trashed files for 30 days, then deletes them permanently. To delete them permanently now, empty your{" "}
              <a href="https://drive.google.com/drive/trash" target="_blank" rel="noopener noreferrer">
                Google Drive trash
              </a>{" "}
              — that cannot be undone.
            </li>
            <li>Notebooks on this device are not deleted (use Settings → Backup &amp; storage for that).</li>
            <li>Other devices signed in to this account stop syncing and ask what to do; they never re-upload by themselves.</li>
          </ul>
        </TypeToConfirm>
      )}
      {notice && <SignOutNotice kind={notice} onClose={() => setNotice(null)} />}
      {acc.account && (
        <details className="small muted">
          <summary>What is stored where</summary>
          <p style={{ margin: "6px 0" }}>
            <strong>On this device:</strong> every notebook, page, PDF, image, recording, folder and study set — Notefira works fully offline. Changes are saved here first, instantly.
          </p>
          <p style={{ margin: "6px 0" }}>
            <strong>In your Google Drive</strong> (“Notefira Sync” folder): a copy of each notebook as a <code>.notefira</code> file, its PDFs, images and audio (stored once each), and your folders and study sets. Signing in on another device restores all of it automatically.
          </p>
          <p style={{ margin: "6px 0" }}>
            <strong>Offline:</strong> keep working; the status shows how many notebooks are waiting, and they upload by themselves when you're back online. Signing out keeps everything on this device, including changes not uploaded yet.
          </p>
        </details>
      )}
      {conflicts.length > 0 && (
        <>
          <strong>Edited on two devices</strong>
          {conflicts.map(({ copy, original }) => {
            const name = original?.title ?? copy.title.replace(/ \((conflicted|duplicate) copy, .*\)$/, "");
            const short = name.length > 28 ? name.slice(0, 27) + "…" : name;
            return (
              <div key={copy.id} className="set-row" style={{ flexWrap: "wrap" }}>
                <span className="grow small" style={{ minWidth: 200 }}>
                  “{name}” was changed on two devices, so both versions were kept: the notebook itself and “{copy.title}”. Nothing is removed until you choose.
                </span>
                <button
                  className="btn small"
                  title="Opens both versions side by side; nothing changes"
                  onClick={() => {
                    if (original && !original.deletedAt) openDoc(original.id);
                    openDoc(copy.id, { split: true });
                    app.set({ settingsOpen: null });
                  }}
                >
                  Compare
                </button>
                {original && !original.deletedAt && (
                  <button
                    className="btn small"
                    title="Moves the other version to Trash, where you can still restore it"
                    onClick={async () => {
                      await resolveConflictChoice(copy.id, "keep-mine");
                      toast("The other version was moved to Trash", "info");
                    }}
                  >
                    Keep only “{short}”
                  </button>
                )}
                <button className="btn small" title="Keeps both as separate notebooks" onClick={() => resolveConflictChoice(copy.id, "keep-both")}>
                  Keep both
                </button>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function BackupSettings() {
  const est = useAsync(() => storageEstimate(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [wipe, setWipe] = useState(false);
  return (
    <>
      <Row label="Storage used on this device" hint={est.data ? `${formatBytes(est.data.usage)} of about ${formatBytes(est.data.quota)} available${est.data.persisted ? " · protected from automatic clean-up" : ""}` : "…"}>
        {est.data && !est.data.persisted && !isTauri() && (
          <button
            className="btn small"
            onClick={async () => {
              const ok = await requestPersistentStorage();
              toast(ok ? "Storage is now protected from automatic clean-up" : "The browser declined; install Notefira as an app to protect storage.", ok ? "success" : "info");
              est.reload();
            }}
          >
            Protect storage
          </button>
        )}
      </Row>
      <Row label="Full backup" hint="One file with every notebook (including PDFs, images and audio), folders, study sets and elements.">
        <button
          className="btn"
          disabled={!!busy}
          onClick={async () => {
            setBusy("export");
            try {
              const bytes = await exportBackup();
              await saveFile(`Notefira backup ${new Date().toISOString().slice(0, 10)}.nfbackup`, bytes, "application/x-notefira-backup");
            } catch (e: any) {
              toast(e.message, "error");
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "export" ? <span className="spinner" /> : <Icon name="download" size={16} />} Create backup
        </button>
      </Row>
      <Row label="Restore from backup" hint="Notebooks in the backup replace their current versions here (the current versions stay in Version history).">
        <button
          className="btn"
          disabled={!!busy}
          onClick={async () => {
            const f = await pickFiles(".nfbackup", false);
            if (!f[0]) return;
            setBusy("import");
            try {
              const r = await importBackup(new Uint8Array(await f[0].arrayBuffer()));
              toast(`Restored ${r.docs} notebook(s)`, "success");
            } catch (e: any) {
              toast(e.message, "error");
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "import" ? <span className="spinner" /> : <Icon name="upload" size={16} />} Restore…
        </button>
      </Row>
      <Row label="Delete all Notefira data on this device" hint="Permanently deletes every notebook, PDF, image, recording, study set and setting stored here. Copies in Google Drive are not affected.">
        <button className="btn small danger" onClick={() => setWipe(true)}>
          Delete all…
        </button>
      </Row>
      {wipe && (
        <TypeToConfirm
          title="Delete all Notefira data on this device?"
          action="Delete permanently"
          onClose={() => setWipe(false)}
          onConfirm={async () => {
            await deleteAllLocalData();
            location.reload();
          }}
        >
          <p style={{ marginTop: 0 }}>
            <strong>This permanently deletes, on this device:</strong> all notebooks, pages, handwriting, PDFs, images, audio recordings, study sets, folders and settings, and the link to your Google account (you are signed out). <strong>It cannot be undone</strong> — there is no trash for this.
          </p>
          <p>
            Copies in your Google Drive are <strong>not</strong> deleted: if you sign in again, synced notebooks come back from Drive. To delete those too, first use Settings → Cloud sync → Delete from Drive.
          </p>
        </TypeToConfirm>
      )}
    </>
  );
}

/** Explicit confirmation for irreversible or far-reaching deletions: backup offered first, then type DELETE. */
function TypeToConfirm({ title, action, children, onClose, onConfirm }: { title: string; action: string; children: ReactNode; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<"backup" | "go" | null>(null);
  const backup = async () => {
    setBusy("backup");
    try {
      const bytes = await exportBackup();
      await saveFile(`Notefira backup ${new Date().toISOString().slice(0, 10)}.nfbackup`, bytes, "application/x-notefira-backup");
    } catch (e: any) {
      toast(e?.message ?? String(e), "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => void backup()} disabled={!!busy} style={{ marginRight: "auto" }}>
            {busy === "backup" ? <span className="spinner" /> : <Icon name="download" size={16} />} Download a backup first
          </button>
          <button className="btn" onClick={onClose} disabled={busy === "go"}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={typed.trim() !== "DELETE" || !!busy}
            onClick={async () => {
              setBusy("go");
              try {
                await onConfirm();
              } catch (e: any) {
                toast(e?.message ?? String(e), "error");
                setBusy(null);
              }
            }}
          >
            {busy === "go" && <span className="spinner" />} {action}
          </button>
        </>
      }
    >
      {children}
      <label className="field">
        Type DELETE to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="nf-delete-help" />
      </label>
      <p id="nf-delete-help" className="small muted" style={{ marginBottom: 0 }}>
        We recommend downloading a backup first. It is saved as a file on this device.
      </p>
    </Dialog>
  );
}

/** What happened at sign-out, and how to remove Notefira's Google access if Google didn't confirm it. */
function SignOutNotice({ kind, onClose }: { kind: string; onClose: () => void }) {
  const [what, count] = kind.split(":");
  const confirmed = what === "signed-out" || what === "drive-deleted";
  return (
    <Dialog
      title={what.startsWith("drive-deleted") ? "Moved to Google Drive trash" : "Signed out"}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          OK
        </button>
      }
    >
      {what.startsWith("drive-deleted") && (
        <p style={{ marginTop: 0 }}>
          {count} file(s) were moved to your{" "}
          <a href="https://drive.google.com/drive/trash" target="_blank" rel="noopener noreferrer">
            Google Drive trash
          </a>
          . Google deletes them permanently after 30 days, or now if you empty the trash (that cannot be undone).
        </p>
      )}
      {confirmed ? (
        <p style={{ marginBottom: 0 }}>Google confirmed that Notefira's access to your Google account was removed.</p>
      ) : (
        <p style={{ marginBottom: 0 }}>
          Syncing has stopped on this device, but Notefira couldn't confirm with Google that its access was removed (this happens when the short-lived sign-in has already expired). To remove it, open{" "}
          <a href={GOOGLE_ACCESS_URL} target="_blank" rel="noopener noreferrer">
            your Google Account's third-party connections
          </a>
          , choose Notefira and remove its access.
        </p>
      )}
    </Dialog>
  );
}

function About() {
  const [upd, setUpd] = useState<string | null>(null);
  return (
    <>
      <Row label={`Notefira ${APP_VERSION}`} hint={`Running as: ${platformName()}`}>
        <span />
      </Row>
      <Row label="Updates" hint={upd ?? (isTauri() ? "Checks the signed release feed." : "The web app updates itself when a new version is published.")}>
        <button className="btn small" onClick={async () => setUpd(await checkForDesktopUpdate())}>
          Check for updates
        </button>
      </Row>
      <Row label="Help & keyboard shortcuts">
        <button className="btn small" onClick={() => app.set({ helpOpen: true, settingsOpen: null })}>
          Open
        </button>
      </Row>
    </>
  );
}
