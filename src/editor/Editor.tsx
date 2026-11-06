import { useEffect, useState } from "react";
import { app, useStore, closeTab, goLibrary, persistSession, openDoc } from "../state/store";
import { DocPane } from "./DocPane";
import { Toolbar } from "./Toolbar";
import { Icon, AppMark } from "../ui/icons";
import { sendEditorCommand } from "./tools";
import { useAsync, openMenu } from "../ui/common";
import * as repo from "../storage/repo";
import { useLibraryVersion } from "../screens/library/Cover";
import { releaseSession } from "./session";

export function Editor() {
  const { tabs, active, split } = useStore(app, (s) => ({ tabs: s.tabs, active: s.active, split: s.split }));
  const v = useLibraryVersion();
  const { data: docs } = useAsync(() => repo.listDocs(), [v]);
  const [focus, setFocus] = useState<"left" | "right">("left");
  const [toolbarLeft, setToolbarLeft] = useState<HTMLDivElement | null>(null);
  const [toolbarCenter, setToolbarCenter] = useState<HTMLDivElement | null>(null);
  const [toolbarRight, setToolbarRight] = useState<HTMLDivElement | null>(null);
  const titles = new Map((docs ?? []).map((d) => [d.id, d]));

  // drop tabs whose documents were deleted
  useEffect(() => {
    if (!docs) return;
    for (const t of tabs) {
      const d = titles.get(t);
      if (!d || d.deletedAt) closeTab(t);
    }
  }, [docs]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "w" && active) {
        e.preventDefault();
        close(active);
      } else if (e.key === "Tab" && tabs.length > 1) {
        e.preventDefault();
        const i = tabs.indexOf(active ?? "");
        const next = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
        app.set({ active: next });
        persistSession();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [tabs, active]);

  const close = (id: string) => {
    closeTab(id);
    if (!app.get().tabs.includes(id)) releaseSession(id);
  };

  if (!active) return null;
  const right = split && split !== active ? split : null;

  return (
    <div className="editor">
      <div className="tabbar" role="tablist">
        <button className="icon-btn tab-home" onClick={() => goLibrary()} aria-label="Library" title="Library">
          <AppMark size={22} />
        </button>
        <div className="tabs">
          {tabs.map((t) => {
            const d = titles.get(t);
            const on = t === active || t === right;
            return (
              <div key={t} className={"tab" + (on ? " on" : "") + (t === active ? " primary" : "")} role="tab" aria-selected={t === active}>
                <button
                  className="tab-main"
                  onClick={() => {
                    app.set({ active: t, split: right === t ? null : right });
                    persistSession();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e, [
                      { label: "Open side by side", icon: "split", disabled: t === active, onClick: () => (app.set({ split: t }), persistSession()) },
                      { label: "Close", icon: "close", onClick: () => close(t) },
                      { label: "Close other tabs", onClick: () => tabs.filter((x) => x !== t).forEach(close) },
                    ]);
                  }}
                  title={d?.title}
                >
                  <span className="ellipsis">{d?.title ?? "…"}</span>
                </button>
                <button className="tab-x" onClick={() => close(t)} aria-label={`Close ${d?.title ?? "tab"}`}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className={"icon-btn" + (right ? " on" : "")}
          aria-label="Split view"
          title="Split view"
          onClick={(e) => {
            if (right) {
              app.set({ split: null });
              persistSession();
              return;
            }
            const others = (docs ?? []).filter((d) => !d.deletedAt && d.id !== active).sort((a, b) => b.opened - a.opened).slice(0, 10);
            openMenu(e.currentTarget, [
              { heading: "Open side by side" },
              ...others.map((d) => ({ label: d.title, icon: "book", onClick: () => openDoc(d.id, { split: true }) })),
              ...(others.length ? [] : [{ label: "No other notebooks yet", disabled: true }]),
            ]);
          }}
        >
          <Icon name="split" />
        </button>
      </div>
      <div className="primary-toolbar" role="toolbar" aria-label="Notebook controls">
        <div className="primary-toolbar-left" ref={setToolbarLeft} />
        <div className="primary-toolbar-center" ref={setToolbarCenter} />
        <div className="primary-toolbar-right" ref={setToolbarRight} />
      </div>
      <div className={"panes" + (right ? " split" : "")}>
        <Toolbar centerTarget={toolbarCenter} onImage={() => sendEditorCommand("image")} onElements={() => sendEditorCommand("elements")} onClearPage={() => sendEditorCommand("clear-page")} />
        <DocPane key={"L" + active} docId={active} active={!right || focus === "left"} onActivate={() => setFocus("left")} splitSide={right ? "left" : undefined} toolbarLeft={toolbarLeft} toolbarRight={toolbarRight} />
        {right && <DocPane key={"R" + right} docId={right} active={focus === "right"} onActivate={() => setFocus("right")} splitSide="right" toolbarLeft={toolbarLeft} toolbarRight={toolbarRight} />}
      </div>
    </div>
  );
}
