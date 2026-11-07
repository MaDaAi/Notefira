import { useEffect, useMemo, useState, type DragEvent } from "react";
import { app, useStore, settingsStore, updateSettings, goLibrary, openDoc, toast, type Section } from "../../state/store";
import * as repo from "../../storage/repo";
import type { Doc, Folder, ID } from "../../model/types";
import { Icon, AppMark } from "../../ui/icons";
import { openMenu, promptDialog, confirmDialog, useAsync, type MenuItem } from "../../ui/common";
import { DocCover, useLibraryVersion } from "./Cover";
import { NewNotebookDialog } from "./NewNotebook";
import { ChangeCoverDialog, MoveDialog } from "./Dialogs";
import * as actions from "../../services/docActions";
import { APP_VERSION } from "../../version";
import { pickFiles } from "../../platform/native";
import { importFiles } from "../../services/transfer";
import { formatDate } from "../../model/util";
import { SyncBadge, DocSyncIcon } from "./SyncBadge";
import { StorageChoice } from "./StorageChoice";
import { googleSignInAvailable } from "../../sync/config";
import { syncNow } from "../../sync/scheduler";
import { Dialog } from "../../ui/common";
import { SearchResults } from "./SearchResults";
import { StudyScreen } from "../../study/Study";
import { createDoc } from "../../storage/repo";
import { templateBg, pageSize } from "../../model/templates";

const FOLDER_COLORS = ["#7aa7c7", "#45bfdb", "#f2a541", "#3c9d5d", "#7d6ff0", "#ef6f6c", "#9a8f85"];

export function Library() {
  const { section, folderId, query, launchAction } = useStore(app, (s) => ({ section: s.section, folderId: s.folderId, query: s.query, launchAction: s.launchAction }));
  const settings = useStore(settingsStore, (s) => s);
  const v = useLibraryVersion();
  const { data } = useAsync(async () => ({ docs: await repo.listDocs(), folders: await repo.listFolders() }), [v]);
  const docs = data?.docs ?? [];
  const folders = data?.folders ?? [];
  const [newOpen, setNewOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<File[] | null>(null);
  const [localOnlyFor, setLocalOnlyFor] = useState<Doc | null>(null);
  const [coverFor, setCoverFor] = useState<Doc | null>(null);
  const [moveItems, setMoveItems] = useState<{ docs: ID[]; folders: ID[] } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [shortcutImportOpen, setShortcutImportOpen] = useState(false);

  useEffect(() => {
    setSelected(new Set());
    setSelecting(false);
  }, [section, folderId]);

  useEffect(() => {
    if (launchAction === "new-notebook") setNewOpen(true);
    if (launchAction === "import-pdf") setShortcutImportOpen(true);
    if (launchAction) app.set({ launchAction: null });
  }, [launchAction]);

  const liveDocs = docs.filter((d) => !d.deletedAt);
  const liveFolders = folders.filter((f) => !f.deletedAt);
  const sortFn = (a: Doc, b: Doc) => (settings.librarySort === "title" ? a.title.localeCompare(b.title) : settings.librarySort === "created" ? b.created - a.created : b.updated - a.updated);
  const crumbs = useMemo(() => {
    const out: Folder[] = [];
    let cur = folderId;
    let guard = 0;
    while (cur && guard++ < 50) {
      const f = liveFolders.find((x) => x.id === cur);
      if (!f) break;
      out.unshift(f);
      cur = f.parentId;
    }
    return out;
  }, [folderId, liveFolders]);

  const newMenu = (el: HTMLElement) =>
    openMenu(el, [
      { label: "Notebook", icon: "book", onClick: () => setNewOpen(true) },
      {
        label: "Quick note",
        icon: "quick",
        onClick: async () => {
          const s = settingsStore.get();
          const dim = pageSize(s.defaultPaper, s.defaultOrientation);
          const d = await createDoc({ title: `Quick note ${new Date().toLocaleDateString()}`, folderId: section === "documents" ? folderId : null, bg: templateBg(s.defaultTemplate), w: dim.w, h: dim.h });
          openDoc(d.id);
        },
      },
      {
        label: "Folder",
        icon: "folder",
        onClick: async () => {
          const name = await promptDialog("New folder", "New folder", "Create");
          if (name) {
            await repo.createFolder(name, section === "documents" ? folderId : null, FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)]);
            if (section !== "documents") goLibrary("documents", null);
          }
        },
      },
      { sep: true },
      { label: "Import PDF, image or notebook…", icon: "upload", onClick: () => doImport() },
    ]);

  const doImport = async (files?: File[]) => {
    const list = files ?? (await pickFiles(".pdf,.notefira,.nfbackup,.png,.jpg,.jpeg,.webp,.gif", true));
    if (!list.length) return;
    // with Google sync available, ask where the new notebooks should live (Google Drive by default)
    if (googleSignInAvailable() && list.some((f) => !/\.nfbackup$/i.test(f.name))) return setPendingImport(list);
    await runImport(list, false);
  };

  const runImport = async (list: File[], localOnly: boolean) => {
    toast(`Importing ${list.length} file(s)…`, "info");
    const res = await importFiles(list, section === "documents" ? folderId : null);
    if (localOnly) for (const d of res.docs) await repo.setLocalOnly(d.id, true);
    res.messages.forEach((m) => toast(m, m.includes(":") ? "error" : "info"));
    if (res.docs.length) toast(`Imported ${res.docs.length} notebook(s)`, "success", res.docs.length === 1 ? { label: "Open", run: () => openDoc(res.docs[0].id) } : undefined);
  };

  const docMenu = (d: Doc, at: { clientX: number; clientY: number } | HTMLElement) => {
    const items: MenuItem[] = d.deletedAt
      ? [
          { label: "Restore", icon: "restore", onClick: () => repo.restoreDoc(d.id) },
          { label: "Delete forever", icon: "trash", danger: true, onClick: () => actions.deleteForever(d) },
        ]
      : [
          { label: "Open", icon: "book", onClick: () => openDoc(d.id) },
          { label: "Open side by side", icon: "split", onClick: () => actions.openSplit(d.id) },
          { sep: true },
          { label: "Rename", icon: "text", onClick: () => actions.renameDoc(d) },
          ...(googleSignInAvailable()
            ? [
                d.localOnly
                  ? { label: "Sync with Google Drive", icon: "cloud", onClick: () => repo.setLocalOnly(d.id, false) }
                  : { label: "Keep on this device only…", icon: "cloudOff", onClick: () => setLocalOnlyFor(d) },
                ...(d.localOnly && d.remoteId && !d.cloudRemoval
                  ? [
                      {
                        label: "Remove copy from Google Drive…",
                        icon: "trash",
                        onClick: async () => {
                          if (
                            await confirmDialog(
                              `Remove “${d.title}” from Google Drive?`,
                              "Its copy in your Google Drive is moved to the Drive trash (Google keeps it there for 30 days) at the next sync, after Notefira checks that this device's copy is complete. The notebook stays on this device. Other devices signed in to your Google account keep their copies and will ask what to do.",
                              "Remove from Drive",
                              true,
                            )
                          ) {
                            await repo.requestCloudRemoval(d.id);
                            void syncNow(true);
                          }
                        },
                      },
                    ]
                  : []),
              ]
            : []),
          { label: "Change cover", icon: "palette", onClick: () => setCoverFor(d) },
          { label: d.favorite ? "Remove from Favourites" : "Add to Favourites", icon: "star", onClick: () => actions.toggleFavorite(d) },
          { label: "Duplicate", icon: "duplicate", onClick: () => actions.duplicate(d) },
          { label: "Move to…", icon: "folder", onClick: () => setMoveItems({ docs: [d.id], folders: [] }) },
          { sep: true },
          { label: "Export as PDF", icon: "pdf", onClick: () => actions.exportPdf(d.id) },
          { label: "Export as Notefira notebook", icon: "download", onClick: () => actions.exportNotebook(d.id) },
          { label: "Share…", icon: "share", onClick: () => actions.share(d.id) },
          { label: "Print…", icon: "print", onClick: () => actions.print(d.id) },
          { sep: true },
          { label: "Move to Trash", icon: "trash", danger: true, onClick: () => actions.trash(d) },
        ];
    openMenu(at, items);
  };

  const folderMenu = (f: Folder, at: { clientX: number; clientY: number } | HTMLElement) => {
    const items: MenuItem[] = f.deletedAt
      ? [
          { label: "Restore", icon: "restore", onClick: () => repo.restoreFolder(f.id) },
          {
            label: "Delete forever",
            icon: "trash",
            danger: true,
            onClick: async () => {
              if (await confirmDialog("Delete folder forever?", `“${f.name}” and every notebook inside it will be permanently deleted.`, "Delete", true)) await repo.purgeFolder(f.id);
            },
          },
        ]
      : [
          { label: "Open", icon: "folder", onClick: () => goLibrary("documents", f.id) },
          {
            label: "Rename",
            icon: "text",
            onClick: async () => {
              const n = await promptDialog("Rename folder", f.name, "Rename");
              if (n?.trim()) await repo.saveFolder({ ...f, name: n.trim() });
            },
          },
          { heading: "Colour" },
          {
            render: () => (
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {FOLDER_COLORS.map((c) => (
                  <button key={c} className={"color-dot" + (f.color === c ? " on" : "")} style={{ background: c }} aria-label={c} onClick={() => repo.saveFolder({ ...f, color: c })} />
                ))}
              </div>
            ),
          },
          { label: "Move to…", icon: "move", onClick: () => setMoveItems({ docs: [], folders: [f.id] }) },
          { sep: true },
          {
            label: "Move to Trash",
            icon: "trash",
            danger: true,
            onClick: async () => {
              await repo.trashFolder(f.id);
              toast(`Moved “${f.name}” to Trash`, "info", { label: "Undo", run: () => repo.restoreFolder(f.id) });
            },
          },
        ];
    openMenu(at, items);
  };

  // ---------- drag & drop
  const onDragStart = (e: DragEvent, kind: "doc" | "folder", id: ID) => {
    e.dataTransfer.setData("application/x-notefira-item", JSON.stringify({ kind, id }));
    e.dataTransfer.effectAllowed = "move";
  };
  const dropOnFolder = async (e: DragEvent, target: ID | null) => {
    const raw = e.dataTransfer.getData("application/x-notefira-item");
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const { kind, id } = JSON.parse(raw);
    try {
      if (kind === "doc") {
        const d = await repo.getDoc(id);
        if (d && d.folderId !== target) await repo.saveDoc({ ...d, folderId: target });
      } else if (id !== target) await repo.moveFolder(id, target);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };
  const onMainDrop = (e: DragEvent) => {
    setDragOver(false);
    if (e.dataTransfer.files?.length) {
      e.preventDefault();
      doImport([...e.dataTransfer.files]);
    }
  };

  // ---------- content per section
  let title = "Home";
  let folderList: Folder[] = [];
  let docList: Doc[] = [];
  if (section === "documents") {
    title = crumbs.length ? crumbs[crumbs.length - 1].name : "Documents";
    folderList = liveFolders.filter((f) => f.parentId === (folderId ?? null)).sort((a, b) => a.name.localeCompare(b.name));
    docList = liveDocs.filter((d) => (d.folderId ?? null) === (folderId ?? null)).sort(sortFn);
  } else if (section === "favorites") {
    title = "Favourites";
    docList = liveDocs.filter((d) => d.favorite).sort(sortFn);
  } else if (section === "trash") {
    title = "Trash";
    const trashedFolderIds = new Set(folders.filter((f) => f.deletedAt).map((f) => f.id));
    folderList = folders.filter((f) => f.deletedAt && !(f.parentId && trashedFolderIds.has(f.parentId)));
    docList = docs.filter((d) => d.deletedAt && !(d.folderId && trashedFolderIds.has(d.folderId))).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }
  const recents = [...liveDocs].sort((a, b) => b.opened - a.opened).slice(0, 10);

  const toggleSel = (id: ID) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const open = (d: Doc) => (selecting ? toggleSel(d.id) : d.deletedAt ? docMenu(d, document.activeElement as HTMLElement) : openDoc(d.id));

  const renderDocs = (list: Doc[], foldersHere: Folder[]) =>
    settings.libraryView === "grid" ? (
      <div className="lib-grid">
        {foldersHere.map((f) => (
          <div
            key={f.id}
            className="lib-card folder"
            draggable={!f.deletedAt}
            onDragStart={(e) => onDragStart(e, "folder", f.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => dropOnFolder(e, f.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              folderMenu(f, e);
            }}
          >
            <button className="lib-cover-btn" onClick={() => (f.deletedAt ? folderMenu(f, document.activeElement as HTMLElement) : goLibrary("documents", f.id))} aria-label={`Open folder ${f.name}`}>
              <div className="folder-art" style={{ color: f.color }}>
                <svg viewBox="0 0 120 92" width="100%" height="100%" aria-hidden="true">
                  <path d="M6 14a8 8 0 0 1 8-8h30l10 10h52a8 8 0 0 1 8 8v54a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="currentColor" opacity=".9" />
                  <path d="M6 30a8 8 0 0 1 8-8h92a8 8 0 0 1 8 8v48a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="currentColor" />
                  <path d="M6 30a8 8 0 0 1 8-8h92a8 8 0 0 1 8 8v4H6z" fill="#fff" opacity=".18" />
                </svg>
              </div>
            </button>
            <div className="lib-meta">
              <div className="lib-title">{f.name}</div>
              <button className="lib-more" onClick={(e) => folderMenu(f, e.currentTarget)} aria-label="Folder options">
                <span className="muted small">{liveDocs.filter((d) => d.folderId === f.id).length} items</span>
                <Icon name="chevronDown" size={16} />
              </button>
            </div>
          </div>
        ))}
        {list.map((d) => (
          <div
            key={d.id}
            className={"lib-card" + (selected.has(d.id) ? " selected" : "")}
            draggable={!d.deletedAt}
            onDragStart={(e) => onDragStart(e, "doc", d.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              docMenu(d, e);
            }}
          >
            <div className="lib-cover-wrap">
              <button className="lib-cover-btn" onClick={() => open(d)} aria-label={`Open ${d.title}`}>
                <DocCover doc={d} />
                {selecting && <span className={"lib-check" + (selected.has(d.id) ? " on" : "")}>{selected.has(d.id) && <Icon name="check" size={14} />}</span>}
              </button>
              {!selecting && !d.deletedAt && (
                <button
                  className={"lib-star" + (d.favorite ? " on" : "")}
                  onClick={(e) => (e.stopPropagation(), actions.toggleFavorite(d))}
                  aria-pressed={d.favorite}
                  aria-label={d.favorite ? `Remove ${d.title} from Favourites` : `Add ${d.title} to Favourites`}
                  title={d.favorite ? "Remove from Favourites" : "Add to Favourites"}
                >
                  <Icon name="star" size={18} filled={d.favorite} />
                </button>
              )}
            </div>
            <div className="lib-meta">
              <div className="lib-title" title={d.title}>
                {d.title}
                <DocSyncIcon doc={d} />
              </div>
              <button className="lib-more" onClick={(e) => docMenu(d, e.currentTarget)} aria-label="Notebook options">
                <span className="muted small">{d.deletedAt ? `Deleted ${formatDate(d.deletedAt)}` : formatDate(d.updated)}</span>
                <Icon name="chevronDown" size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div className="lib-list" role="list">
        {foldersHere.map((f) => (
          <div key={f.id} role="listitem" className="lib-row" draggable onDragStart={(e) => onDragStart(e, "folder", f.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropOnFolder(e, f.id)} onContextMenu={(e) => (e.preventDefault(), folderMenu(f, e))}>
            <button className="lib-row-main" onClick={() => (f.deletedAt ? folderMenu(f, document.activeElement as HTMLElement) : goLibrary("documents", f.id))}>
              <span className="lib-row-icon" style={{ color: f.color }}>
                <Icon name="folder" size={22} filled />
              </span>
              <span className="grow lib-title">{f.name}</span>
              <span className="muted small">{formatDate(f.updated)}</span>
            </button>
            <button className="icon-btn small" onClick={(e) => folderMenu(f, e.currentTarget)} aria-label="Folder options">
              <Icon name="more" />
            </button>
          </div>
        ))}
        {list.map((d) => (
          <div key={d.id} role="listitem" className={"lib-row" + (selected.has(d.id) ? " selected" : "")} draggable onDragStart={(e) => onDragStart(e, "doc", d.id)} onContextMenu={(e) => (e.preventDefault(), docMenu(d, e))}>
            <button className="lib-row-main" onClick={() => open(d)}>
              <span className="lib-row-thumb">
                <DocCover doc={d} />
              </span>
              <span className="grow lib-title">
                {d.title}
                <DocSyncIcon doc={d} />
              </span>
              <span className="muted small lib-row-pages">{d.pageIds.length === 1 ? "1 page" : `${d.pageIds.length} pages`}</span>
              <span className="muted small" style={{ minWidth: 80, textAlign: "right" }}>
                {formatDate(d.deletedAt ?? d.updated)}
              </span>
            </button>
            {!d.deletedAt && (
              <button
                className={"icon-btn small lib-row-star" + (d.favorite ? " on" : "")}
                onClick={() => actions.toggleFavorite(d)}
                aria-pressed={d.favorite}
                aria-label={d.favorite ? `Remove ${d.title} from Favourites` : `Add ${d.title} to Favourites`}
                title={d.favorite ? "Remove from Favourites" : "Add to Favourites"}
              >
                <Icon name="star" size={16} filled={d.favorite} />
              </button>
            )}
            <button className="icon-btn small" onClick={(e) => docMenu(d, e.currentTarget)} aria-label="Notebook options">
              <Icon name="more" />
            </button>
          </div>
        ))}
      </div>
    );

  const navItem = (s: Section, icon: string, label: string, count?: number) => (
    <button
      className={"nav-item" + (section === s && !(s === "documents" && folderId) ? " on" : "")}
      onClick={() => {
        goLibrary(s, s === "documents" ? null : folderId);
        setDrawer(false);
      }}
      onDragOver={s === "documents" ? (e) => e.preventDefault() : undefined}
      onDrop={s === "documents" ? (e) => dropOnFolder(e, null) : undefined}
    >
      <Icon name={icon} size={20} />
      <span className="grow">{label}</span>
      {count ? <span className="nav-count">{count}</span> : null}
    </button>
  );

  const folderTree = (parent: ID | null, depth: number): JSX.Element[] =>
    liveFolders
      .filter((f) => f.parentId === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((f) => [
        <button
          key={f.id}
          className={"nav-item sub" + (section === "documents" && folderId === f.id ? " on" : "")}
          style={{ paddingLeft: 14 + depth * 14 }}
          onClick={() => {
            goLibrary("documents", f.id);
            setDrawer(false);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => dropOnFolder(e, f.id)}
          onContextMenu={(e) => (e.preventDefault(), folderMenu(f, e))}
        >
          <span style={{ color: f.color, display: "inline-flex" }}>
            <Icon name="folder" size={18} filled />
          </span>
          <span className="grow ellipsis">{f.name}</span>
        </button>,
        ...folderTree(f.id, depth + 1),
      ]);

  const trashCount = docs.filter((d) => d.deletedAt).length;
  return (
    <div className="lib">
      <aside className={"lib-side" + (drawer ? " open" : "")}>
        <div className="lib-brand">
          <AppMark size={28} />
          <span>Notefira</span>
          <button className="icon-btn small drawer-close" onClick={() => setDrawer(false)} aria-label="Close menu">
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="lib-search">
          <Icon name="search" size={18} />
          <input
            type="search"
            placeholder="Search notebooks"
            value={query}
            onChange={(e) => app.set({ query: e.target.value, section: e.target.value ? "search" : section === "search" ? "home" : section, screen: "library" })}
            aria-label="Search all notebooks"
            id="global-search"
          />
        </label>
        <nav className="lib-nav">
          {navItem("home", "home", "Home")}
          {navItem("documents", "book", "Documents")}
          <div className="nav-tree">{folderTree(null, 1)}</div>
          {navItem("favorites", "star", "Favourites")}
          {navItem("study", "cards", "Study sets")}
          {navItem("trash", "trash", "Trash", trashCount)}
        </nav>
        <div className="lib-side-foot">
          <SyncBadge />
          <div className="row">
            <button className="nav-item" onClick={() => app.set({ settingsOpen: "general" })}>
              <Icon name="settings" size={20} />
              <span className="grow">Settings</span>
            </button>
            <button className="icon-btn" onClick={() => updateSettings({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" })} aria-label="Toggle dark mode">
              <Icon name={document.documentElement.dataset.theme === "dark" ? "sun" : "moon"} />
            </button>
            <button className="icon-btn" onClick={() => app.set({ helpOpen: true })} aria-label="Help">
              <Icon name="help" />
            </button>
          </div>
          <div className="lib-version" title="Notefira version">Notefira v{APP_VERSION}</div>
        </div>
      </aside>
      {drawer && <div className="lib-scrim" onClick={() => setDrawer(false)} />}
      <main
        className={"lib-main" + (dragOver ? " dragover" : "")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onMainDrop}
      >
        {section === "study" ? (
          <StudyScreen onMenu={() => setDrawer(true)} />
        ) : (
          <>
            <header className="lib-head">
              <button className="icon-btn burger" onClick={() => setDrawer(true)} aria-label="Open menu">
                <Icon name="sidebar" />
              </button>
              <div className="lib-crumbs grow">
                {section === "documents" && crumbs.length > 0 && (
                  <>
                    <button className="crumb" onClick={() => goLibrary("documents", null)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropOnFolder(e, null)}>
                      Documents
                    </button>
                    {crumbs.slice(0, -1).map((c) => (
                      <span key={c.id} className="row" style={{ gap: 2 }}>
                        <Icon name="chevronRight" size={16} />
                        <button className="crumb" onClick={() => goLibrary("documents", c.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropOnFolder(e, c.id)}>
                          {c.name}
                        </button>
                      </span>
                    ))}
                    <Icon name="chevronRight" size={16} />
                  </>
                )}
                <h1>{section === "search" ? "Search" : title}</h1>
              </div>
              {section !== "search" && section !== "trash" && (
                <>
                  <button className="btn primary new-btn" onClick={(e) => newMenu(e.currentTarget)}>
                    <Icon name="plus" size={18} />
                    <span className="hide-sm">New</span>
                  </button>
                  <div className="seg view-seg hide-xs" role="group" aria-label="View">
                    <button className={settings.libraryView === "grid" ? "on" : ""} onClick={() => updateSettings({ libraryView: "grid" })} aria-label="Grid view" aria-pressed={settings.libraryView === "grid"} title="Grid view">
                      <Icon name="grid" size={18} />
                    </button>
                    <button className={settings.libraryView === "list" ? "on" : ""} onClick={() => updateSettings({ libraryView: "list" })} aria-label="List view" aria-pressed={settings.libraryView === "list"} title="List view">
                      <Icon name="list" size={18} />
                    </button>
                  </div>
                  <button
                    className="icon-btn head-more-btn"
                    aria-label="Sort and select"
                    title="Sort and select"
                    onClick={(e) =>
                      openMenu(e.currentTarget, [
                        { heading: "Sort by" },
                        { label: "Date modified", checked: settings.librarySort === "updated", onClick: () => updateSettings({ librarySort: "updated" }) },
                        { label: "Date created", checked: settings.librarySort === "created", onClick: () => updateSettings({ librarySort: "created" }) },
                        { label: "Name", checked: settings.librarySort === "title", onClick: () => updateSettings({ librarySort: "title" }) },
                        { sep: true },
                        { label: settings.libraryView === "grid" ? "List view" : "Grid view", icon: settings.libraryView === "grid" ? "list" : "grid", onClick: () => updateSettings({ libraryView: settings.libraryView === "grid" ? "list" : "grid" }) },
                        { label: selecting ? "Done selecting" : "Select", icon: "check", onClick: () => setSelecting(!selecting) },
                      ])
                    }
                  >
                    <Icon name="more" />
                  </button>
                </>
              )}
              {section === "trash" && docList.length + folderList.length > 0 && (
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!(await confirmDialog("Empty Trash?", "Everything in the Trash will be permanently deleted.", "Empty Trash", true))) return;
                    for (const f of folderList) await repo.purgeFolder(f.id);
                    for (const d of docList) await repo.purgeDoc(d.id);
                  }}
                >
                  Empty Trash
                </button>
              )}
            </header>
            {selecting && (
              <div className="sel-bar">
                <span className="grow">{selected.size} selected</span>
                <button className="btn small" disabled={!selected.size} onClick={() => setMoveItems({ docs: [...selected], folders: [] })}>
                  Move
                </button>
                <button
                  className="btn small"
                  disabled={!selected.size}
                  onClick={async () => {
                    for (const id of selected) {
                      const d = liveDocs.find((x) => x.id === id);
                      if (d && !d.favorite) await actions.toggleFavorite(d);
                    }
                  }}
                >
                  Favourite
                </button>
                <button
                  className="btn small"
                  disabled={!selected.size}
                  onClick={async () => {
                    for (const id of selected) await actions.exportPdf(id);
                  }}
                >
                  Export PDF
                </button>
                <button
                  className="btn small danger"
                  disabled={!selected.size}
                  onClick={async () => {
                    for (const id of selected) await repo.trashDoc(id);
                    setSelected(new Set());
                    toast("Moved to Trash", "info");
                  }}
                >
                  Delete
                </button>
                <button className="btn small" onClick={() => setSelecting(false)}>
                  Done
                </button>
              </div>
            )}
            <div className="lib-scroll">
              {section === "search" ? (
                <SearchResults query={query} docs={liveDocs} />
              ) : section === "home" ? (
                <>
                  {recents.length > 0 ? (
                    <>
                      <h2 className="lib-h2">Recent</h2>
                      {renderDocs(recents, [])}
                    </>
                  ) : (
                    <div className="empty">
                      <Icon name="book" size={40} />
                      <h3>No notebooks yet</h3>
                      <p>Create a notebook or import a PDF to get started.</p>
                      <div className="row">
                        <button className="btn primary" onClick={() => setNewOpen(true)}>
                          New notebook
                        </button>
                        <button className="btn" onClick={() => doImport()}>
                          Import…
                        </button>
                      </div>
                    </div>
                  )}
                  {liveDocs.some((d) => d.favorite) && (
                    <>
                      <h2 className="lib-h2">Favourites</h2>
                      {renderDocs(liveDocs.filter((d) => d.favorite).sort(sortFn).slice(0, 10), [])}
                    </>
                  )}
                </>
              ) : docList.length + folderList.length === 0 ? (
                <div className="empty">
                  <Icon name={section === "trash" ? "trash" : section === "favorites" ? "star" : "folder"} size={40} />
                  <h3>{section === "trash" ? "Trash is empty" : section === "favorites" ? "No favourites yet" : "This folder is empty"}</h3>
                  <p>{section === "trash" ? "Deleted notebooks stay here for 30 days." : section === "favorites" ? "Star a notebook from its menu to see it here." : "Create a notebook or drop PDFs here."}</p>
                </div>
              ) : (
                renderDocs(docList, folderList)
              )}
            </div>
          </>
        )}
      </main>
      {newOpen && <NewNotebookDialog folderId={section === "documents" ? folderId : null} onClose={() => setNewOpen(false)} />}
      {localOnlyFor && <LocalOnlyDialog doc={localOnlyFor} onClose={() => setLocalOnlyFor(null)} />}
      {pendingImport && (
        <ImportDialog
          files={pendingImport}
          onClose={() => setPendingImport(null)}
          onImport={(localOnly) => {
            const list = pendingImport;
            setPendingImport(null);
            void runImport(list, localOnly);
          }}
        />
      )}
      {shortcutImportOpen && (
        <Dialog
          title="Import PDF"
          onClose={() => setShortcutImportOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShortcutImportOpen(false)}>Cancel</button>
              <button
                className="btn primary"
                onClick={async () => {
                  const files = await pickFiles(".pdf", false);
                  if (!files.length) return;
                  setShortcutImportOpen(false);
                  void doImport(files);
                }}
                autoFocus
              >
                Choose PDF
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>Choose a PDF to import into a new notebook.</p>
        </Dialog>
      )}
      {coverFor && <ChangeCoverDialog doc={coverFor} onClose={() => setCoverFor(null)} />}
      {moveItems && <MoveDialog items={moveItems} folders={liveFolders} onClose={() => setMoveItems(null)} />}
    </div>
  );
}

/** Confirms an import and where the new notebooks should live (Google Drive by default). */
function ImportDialog({ files, onClose, onImport }: { files: File[]; onClose: () => void; onImport: (localOnly: boolean) => void }) {
  const [localOnly, setLocalOnly] = useState(false);
  return (
    <Dialog
      title={files.length === 1 ? "Import file" : `Import ${files.length} files`}
      onClose={onClose}
      footer={
        <>
          <StorageChoice localOnly={localOnly} onChange={setLocalOnly} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onImport(localOnly)} autoFocus>
            Import
          </button>
        </>
      }
    >
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {files.slice(0, 6).map((f, i) => (
          <li key={i}>{f.name}</li>
        ))}
        {files.length > 6 && <li>and {files.length - 6} more</li>}
      </ul>
    </Dialog>
  );
}

/**
 * Switching a notebook to "this device only". If it was already synced, say plainly that a copy
 * remains in Google Drive, and offer (never by default) to move that copy to the Drive trash.
 */
function LocalOnlyDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [removeCloud, setRemoveCloud] = useState(false);
  const synced = !!doc.remoteId;
  const apply = async () => {
    await repo.setLocalOnly(doc.id, true);
    if (synced && removeCloud) {
      await repo.requestCloudRemoval(doc.id);
      void syncNow(true);
    }
    onClose();
  };
  return (
    <Dialog
      title={`Keep “${doc.title}” on this device only?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void apply()}>
            Keep on this device
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>It stays on this device and stops syncing. You can turn sync back on at any time.</p>
      {synced && (
        <>
          <p>
            <strong>A copy is still in your Google Drive</strong> (in the “Notefira Sync” folder), and on any other device signed in to your Google account. Keeping it on this device only does not delete those copies.
          </p>
          <label className="row small" style={{ alignItems: "flex-start", gap: 8 }}>
            <input type="checkbox" checked={removeCloud} onChange={(e) => setRemoveCloud(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              Also move the Google Drive copy to the Drive trash. Notefira first checks that this device's copy is complete; Google keeps trashed files for 30 days. Other devices keep their copies and will ask what to do.
            </span>
          </label>
        </>
      )}
    </Dialog>
  );
}
