import { useEffect, useState } from "react";
import { Dialog, Switch, useAsync, confirmDialog } from "../ui/common";
import { app, settingsStore, updateSettings, useStore, toast } from "../state/store";
import { DEFAULT_TOOLBAR, type ToolId } from "../model/types";
import { TOOL_LABELS } from "../editor/tools";
import { Icon } from "../ui/icons";
import { auth, signIn, signOut } from "../sync/google";
import { syncStore, syncNow } from "../sync/scheduler";
import { syncLabel } from "./library/SyncBadge";
import { exportBackup, importBackup } from "../services/transfer";
import { saveFile, pickFiles, isTauri, checkForDesktopUpdate, platformName, secretStorageMode } from "../platform/native";
import { storageEstimate, requestPersistentStorage, getDoc, listDocs, onChange } from "../storage/repo";
import { formatBytes } from "../model/util";
import { kvGet, kvSet } from "../storage/db";
import { resolveSyncIssue, dismissDamagedRemote, type Conflict, type DamagedRemote } from "../sync/engine";
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
  useEffect(() => {
    const load = () => {
      listDocs().then((ds) => setDocs(ds.filter((d) => d.syncIssue)));
      kvGet<DamagedRemote[]>("damagedRemote", []).then((l) => setDamaged(l.filter((x) => !x.dismissed)));
    };
    load();
    return onChange((t) => (t === "library" || t.startsWith("doc:")) && load());
  }, [version]);
  if (!docs.length && !damaged.length) return null;
  const act = async (id: string, a: "upload" | "keep-local") => {
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
        </div>
      ))}
      {damaged.map((x) => (
        <div key={x.fileId} className="set-row">
          <span className="grow small">“{x.name}” in Google Drive is damaged, so it wasn't added to this device. The file is still in Drive, where you can restore an earlier version.</span>
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
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  useEffect(() => {
    kvGet<Conflict[]>("conflicts", []).then(setConflicts);
  }, [st.lastSync]);
  const [secretMode, setSecretMode] = useState<"keychain" | "session-only" | null>(null);
  useEffect(() => {
    secretStorageMode().then(setSecretMode).catch(() => setSecretMode("session-only"));
  }, []);
  const origin = typeof location !== "undefined" ? location.origin : "";
  return (
    <>
      <div className="ai-note">
        <Icon name="cloud" size={18} />
        <div className="small">
          Notefira keeps everything on this device and, when you sign in, mirrors every notebook (strokes, pages, images, PDFs, audio, templates, folders and study sets) to a <strong>Notefira</strong> folder in your Google Drive in its editable format. It needs a free Google OAuth client ID — create one in Google Cloud Console → APIs &amp; Services → Credentials (type <em>Web application</em>, authorised JavaScript origin <code>{origin}</code>; for the desktop app use type <em>Desktop app</em>), and enable the Google Drive API. The app only requests the <code>drive.file</code> permission, so it can see only the files it created. By connecting Google Drive you agree to the <a href="./legal/terms.html" target="_blank" rel="noopener noreferrer">Terms</a> and <a href="./legal/privacy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
        </div>
      </div>
      {secretMode && (
        <p className="small muted" role="note" style={{ margin: 0 }}>
          {!isTauri()
            ? "On the web, Notefira never stores long-term Google sign-in tokens. A short-lived access token lasts only until you close this tab; after that you'll be asked to sign in again to keep syncing."
            : secretMode === "keychain"
              ? "Your Google sign-in is kept in your system's secure keychain."
              : "Your system's secure keychain isn't available, so Notefira won't store your Google sign-in (or client secret) at all. You'll need to sign in again each time you open Notefira. Nothing is saved unencrypted."}
        </p>
      )}
      <label className="field">
        Google OAuth client ID
        <input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="1234567890-abc….apps.googleusercontent.com" spellCheck={false} />
      </label>
      {isTauri() && (
        <label className="field">
          Client secret (only for “Desktop app” clients; stored in your OS keychain)
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value.trim())} spellCheck={false} />
        </label>
      )}
      <div className="row">
        <button className="btn" onClick={() => updateSettings({ googleClientId: clientId, googleClientSecret: secret }).then(() => toast("Saved", "success"))}>
          Save
        </button>
        {!acc.account ? (
          <button
            className="btn primary"
            disabled={!clientId || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await updateSettings({ googleClientId: clientId, googleClientSecret: secret });
                const a = await signIn();
                toast(`Signed in as ${a.email}`, "success");
              } catch (e: any) {
                toast(e.message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spinner" /> : null} Sign in with Google
          </button>
        ) : (
          <>
            <button className="btn primary" onClick={() => syncNow(true)} disabled={st.state === "syncing"}>
              Sync now
            </button>
            <button
              className="btn"
              onClick={async () => {
                if (await confirmDialog("Sign out of Google Drive?", "Your notebooks stay on this device, including changes that haven't uploaded yet, and the copies in Drive stay in Drive. Syncing stops until you sign in again.")) await signOut();
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
      {acc.account && <SyncDecisions version={st.lastSync} />}
      {conflicts.length > 0 && (
        <>
          <strong>Conflicts kept as copies</strong>
          {conflicts.map((c) => (
            <div key={c.copyId} className="set-row">
              <span className="grow small">
                “{c.title}” was changed on two devices ({new Date(c.at).toLocaleString()}).
              </span>
              <button className="btn small" onClick={async () => (await getDoc(c.docId)) && (openDoc(c.docId), app.set({ settingsOpen: null }))}>
                Mine
              </button>
              <button className="btn small" onClick={async () => (await getDoc(c.copyId)) && (openDoc(c.copyId, { split: true }), app.set({ settingsOpen: null }))}>
                Other copy
              </button>
              <button
                className="icon-btn small"
                aria-label="Dismiss"
                onClick={async () => {
                  const n = conflicts.filter((x) => x.copyId !== c.copyId);
                  await kvSet("conflicts", n);
                  setConflicts(n);
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function BackupSettings() {
  const est = useAsync(() => storageEstimate(), []);
  const [busy, setBusy] = useState<string | null>(null);
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
    </>
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
