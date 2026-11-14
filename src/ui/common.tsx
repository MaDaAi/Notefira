import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createStore, useStore, toasts } from "../state/store";
import { Icon } from "./icons";

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------
export interface MenuItem {
  label?: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  sep?: boolean;
  heading?: string;
  onClick?: () => void;
  render?: () => ReactNode;
}

const menuStore = createStore<{ open: { x: number; y: number; items: MenuItem[]; key: number } | null }>({ open: null });

export function openMenu(at: { clientX: number; clientY: number } | DOMRect | HTMLElement, items: MenuItem[]) {
  let x: number, y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  } else if ("clientX" in at) {
    x = at.clientX;
    y = at.clientY;
  } else {
    x = at.left;
    y = at.bottom + 4;
  }
  menuStore.set({ open: { x, y, items, key: Date.now() } });
}
export function closeMenu() {
  menuStore.set({ open: null });
}

export function MenuHost() {
  const open = useStore(menuStore, (s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(open.x, window.innerWidth - r.width - 8));
    const y = open.y + r.height > window.innerHeight - 8 ? Math.max(8, open.y - r.height - 8) : open.y;
    setPos({ x, y });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const menu = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    buttons()[0]?.focus();
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu();
    };
    const key = (e: KeyboardEvent) => {
      const items = buttons();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let index: number | undefined;
      if (e.key === "ArrowDown") index = (current + 1) % items.length;
      if (e.key === "ArrowUp") index = (current - 1 + items.length) % items.length;
      if (e.key === "Home") index = 0;
      if (e.key === "End") index = items.length - 1;
      if (index !== undefined && items.length) { e.preventDefault(); items[index]?.focus(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
      if (e.key === "Tab") closeMenu();
    };
    const timer = setTimeout(() => window.addEventListener("pointerdown", down), 0);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", closeMenu);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", closeMenu);
      if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body || menu?.contains(document.activeElement))) previous.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="menu" ref={ref} style={{ left: pos.x || open.x, top: pos.y || open.y }} role="menu" aria-label="Actions" key={open.key}>
      {open.items.map((it, i) =>
        it.sep ? (
          <hr key={i} />
        ) : it.heading ? (
          <div key={i} className="menu-label">
            {it.heading}
          </div>
        ) : it.render ? (
          <div key={i} className="menu-item">
            {it.render()}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onClick={() => {
              closeMenu();
              it.onClick?.();
            }}
          >
            {it.icon ? <Icon name={it.icon} size={18} /> : <span style={{ width: 18 }} />}
            <span className="grow">{it.label}</span>
            {it.checked && <Icon name="check" size={16} />}
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
const dialogStack: HTMLElement[] = [];
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, wide, labelledBy }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; labelledBy?: string }) {
  const generatedId = useId();
  const titleId = labelledBy ?? generatedId;
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const root = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialogStack.push(root);
    const top = () => dialogStack[dialogStack.length - 1] === root;
    const focusables = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length && !el.closest('[hidden], [inert], [aria-hidden="true"]'));
    if (!root.contains(document.activeElement)) (focusables().find((el) => el.matches("[autofocus]")) ?? focusables()[0] ?? root).focus({ preventScroll: true });
    const k = (e: KeyboardEvent) => {
      if (!top() || document.querySelector('[role="menu"]')) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const items = focusables();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length || index < 0 || (e.shiftKey && index === 0) || (!e.shiftKey && index === items.length - 1)) {
          e.preventDefault();
          (e.shiftKey ? items[items.length - 1] ?? root : items[0] ?? root).focus();
        }
      }
    };
    const focus = (e: FocusEvent) => {
      if (top() && e.target instanceof Element && !root.contains(e.target) && !e.target.closest('[role="menu"]')) (focusables()[0] ?? root).focus({ preventScroll: true });
    };
    window.addEventListener("keydown", k, true);
    document.addEventListener("focusin", focus);
    return () => {
      dialogStack.splice(dialogStack.indexOf(root), 1);
      window.removeEventListener("keydown", k, true);
      document.removeEventListener("focusin", focus);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={"dialog" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn small" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

interface AskReq {
  id: number;
  kind: "confirm" | "prompt";
  title: string;
  message?: string;
  value?: string;
  ok?: string;
  danger?: boolean;
  resolve: (v: any) => void;
}
const askStore = createStore<{ list: AskReq[] }>({ list: [] });
let askId = 0;

export function confirmDialog(title: string, message?: string, ok = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => askStore.set((s) => ({ list: [...s.list, { id: ++askId, kind: "confirm", title, message, ok, danger, resolve }] })));
}
export function promptDialog(title: string, value = "", ok = "Save", message?: string): Promise<string | null> {
  return new Promise((resolve) => askStore.set((s) => ({ list: [...s.list, { id: ++askId, kind: "prompt", title, value, ok, message, resolve }] })));
}

export function AskHost() {
  const list = useStore(askStore, (s) => s.list);
  const cur = list[0];
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (cur?.kind === "prompt") {
      setVal(cur.value ?? "");
      setTimeout(() => inputRef.current?.select(), 30);
    }
  }, [cur?.id]);
  if (!cur) return null;
  const done = (v: any) => {
    cur.resolve(v);
    askStore.set((s) => ({ list: s.list.filter((x) => x.id !== cur.id) }));
  };
  return (
    <Dialog
      title={cur.title}
      onClose={() => done(cur.kind === "confirm" ? false : null)}
      footer={
        <>
          <button className="btn" onClick={() => done(cur.kind === "confirm" ? false : null)}>
            Cancel
          </button>
          <button className={"btn " + (cur.danger ? "danger" : "primary")} onClick={() => done(cur.kind === "confirm" ? true : val)}>
            {cur.ok}
          </button>
        </>
      }
    >
      {cur.message && <p style={{ margin: 0 }} className="muted">{cur.message}</p>}
      {cur.kind === "prompt" && (
        <input
          ref={inputRef}
          className="input"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done(val);
          }}
          autoFocus
        />
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export function ToastHost() {
  const list = useStore(toasts, (s) => s.list);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>
          <span className="grow">{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                toasts.set((s) => ({ list: s.list.filter((x) => x.id !== t.id) }));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------
export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)} />;
}

export const SWATCHES = [
  "#130d0c",
  "#5c5c5c",
  "#ffffff",
  "#1d4fd8",
  "#45bfdb",
  "#16a34a",
  "#c62828",
  "#ea7a1a",
  "#f5c518",
  "#8b5cf6",
  "#db2777",
  "#7c4a2d",
  "#ffe14d",
  "#8be28b",
  "#ff9ec7",
  "#9ad6ff",
];

export function ColorGrid({ value, onChange, extra = [] }: { value: string; onChange: (c: string) => void; extra?: string[] }) {
  const all = [...new Set([...extra, ...SWATCHES])];
  return (
    <div className="color-grid">
      {all.map((c) => (
        <button key={c} className={"color-dot" + (c.toLowerCase() === value.toLowerCase() ? " on" : "")} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => onChange(c)} />
      ))}
      <label className="color-dot" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)", position: "relative", overflow: "hidden" }} title="Custom colour">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} style={{ opacity: 0, position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer" }} aria-label="Custom colour" />
      </label>
    </div>
  );
}

export function Popover({ anchor, onClose, children, width = 280 }: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = anchor.left + anchor.width / 2 - r.width / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    let y = anchor.bottom + 8;
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, anchor.top - r.height - 8);
    setPos({ x, y });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => window.addEventListener("pointerdown", down), 0);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu popover" style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, width, padding: 12 }}>
      {children}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: string | null }>({ data: undefined, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, loading: false, error: null }),
      (e) => alive && setState({ data: undefined, loading: false, error: e?.message ?? String(e) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function Markdownish({ text }: { text: string }) {
  // Minimal, safe renderer for AI responses: headings, bullets, bold, paragraphs (no HTML injection).
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
  };
  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>
              ))}
            </ul>
          );
        const h = /^(#{1,4})\s+(.*)$/.exec(lines[0]);
        if (h && lines.length === 1) return <h4 key={i}>{inline(h[2])}</h4>;
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {inline(l.replace(/^#{1,4}\s+/, ""))}
                {j < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
