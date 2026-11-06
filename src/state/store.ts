import { useRef, useSyncExternalStore } from "react";
import type { ID, Settings } from "../model/types";
import { DEFAULT_TOOLBAR } from "../model/types";
import { kvGet, kvSet } from "../storage/db";
import { uid } from "../model/util";

export function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === "function" ? (patch as (s: T) => Partial<T>)(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

function shallowEqual(a: any, b: any) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/** Subscribe to a slice of a store. Selected objects are compared shallowly so selectors may build new objects. */
export function useStore<T, R>(store: ReturnType<typeof createStore<T>>, sel: (s: T) => R): R {
  const cache = useRef<{ state: T; value: R } | null>(null);
  const get = () => {
    const st = store.get();
    const c = cache.current;
    if (c && c.state === st) return c.value;
    const v = sel(st);
    if (c && shallowEqual(c.value, v)) {
      c.state = st;
      return c.value;
    }
    cache.current = { state: st, value: v };
    return v;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fingerDrawing: true,
  palmRejection: true,
  pressure: true,
  shapeHold: true,
  scribbleErase: true,
  toolbar: DEFAULT_TOOLBAR,
  presets: [
    { id: "p1", tool: "pen", pen: "ballpoint", color: "#130d0c", width: 1.6 },
    { id: "p2", tool: "pen", pen: "fountain", color: "#1d4fd8", width: 2.2 },
    { id: "p3", tool: "pen", pen: "brush", color: "#c62828", width: 3.5 },
    { id: "p4", tool: "highlighter", pen: "highlighter", color: "#ffe14d", width: 12 },
  ],
  penColors: ["#111111", "#ffffff", "#2878ff", "#ff4b4b", "#39b86b"],
  highlighterColors: ["#111111", "#ffffff", "#2878ff", "#ff4b4b", "#39b86b"],
  penWidths: [1, 1.8, 3],
  highlighterWidths: [8, 14, 22],
  googleClientId: (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: "",
  autoSync: true,
  libraryView: "grid",
  librarySort: "updated",
  defaultTemplate: "ruled",
  defaultPaper: "a4",
  defaultOrientation: "portrait",
  onboarded: false,
};

export const settingsStore = createStore<Settings>(DEFAULT_SETTINGS);

const SECRET_KEYS = ["googleClientSecret"] as const;

/**
 * Theme to use for stored settings. Older builds defaulted to "light" and saved the whole
 * settings object, so a stored "light" without `themeExplicit` is that old default, not a
 * choice: use the dark default. "dark"/"system", or anything picked since the flag existed,
 * is respected as is.
 */
export function resolveSavedTheme(saved: Partial<Settings>): Settings["theme"] {
  if (!saved.theme) return DEFAULT_SETTINGS.theme;
  if (saved.theme === "light" && !saved.themeExplicit) return DEFAULT_SETTINGS.theme;
  return saved.theme;
}

export async function loadSettings() {
  const saved = await kvGet<Partial<Settings>>("settings", {});
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  merged.theme = resolveSavedTheme(saved);
  try {
    localStorage.setItem(THEME_HINT, merged.theme);
  } catch {
    /* ignore */
  }
  const { getSecret, purgeLegacyPlaintextSecrets } = await import("../platform/native");
  await purgeLegacyPlaintextSecrets().catch(() => {});
  for (const k of SECRET_KEYS) merged[k] = (await getSecret(k).catch(() => "")) || "";
  if (!merged.googleClientId) merged.googleClientId = DEFAULT_SETTINGS.googleClientId;
  // keep any new default tools visible
  merged.toolbar = (merged.toolbar || DEFAULT_TOOLBAR).filter((t) => (DEFAULT_TOOLBAR as string[]).includes(t) || t === "hand");
  settingsStore.set(merged);
  applyTheme(merged.theme);
  try {
    localStorage.setItem(ONBOARD_FLAG, merged.onboarded ? "1" : "0");
  } catch {
    /* ignore */
  }
  return merged;
}

export const ONBOARD_FLAG = "nf-onboarded";
/** Last applied theme setting, read by index.html before the app loads to avoid a light flash. */
export const THEME_HINT = "nf-theme";
let bootResolve: () => void = () => {};
/** Resolves once local storage and settings are loaded (actions on the welcome screen wait for it). */
export const booted = new Promise<void>((r) => (bootResolve = r));
export function markBooted() {
  bootResolve();
}

export async function updateSettings(patch: Partial<Settings>) {
  await booted;
  if (patch.theme) {
    patch = { ...patch, themeExplicit: true };
    try {
      localStorage.setItem(THEME_HINT, patch.theme!);
    } catch {
      /* ignore */
    }
  }
  settingsStore.set(patch);
  if ("onboarded" in patch) {
    try {
      localStorage.setItem(ONBOARD_FLAG, patch.onboarded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }
  const { setSecret } = await import("../platform/native");
  for (const k of SECRET_KEYS) if (k in patch) await setSecret(k, (patch as any)[k] ?? "");
  const plain: Partial<Settings> = { ...settingsStore.get() };
  for (const k of SECRET_KEYS) delete plain[k];
  await kvSet("settings", plain);
  if (patch.theme) applyTheme(patch.theme);
}

let mql: MediaQueryList | null = null;
export function applyTheme(theme: Settings["theme"]) {
  if (typeof document === "undefined") return;
  const resolve = () => {
    const dark = theme === "dark" || (theme === "system" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };
  resolve();
  if (!mql && window.matchMedia) {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener?.("change", () => applyTheme(settingsStore.get().theme));
  }
}

// ---------------------------------------------------------------------------
// Navigation / workspace
// ---------------------------------------------------------------------------
export type Section = "home" | "documents" | "favorites" | "study" | "trash" | "search";

export interface AppState {
  ready: boolean;
  screen: "welcome" | "library" | "editor";
  section: Section;
  folderId: ID | null;
  query: string;
  tabs: ID[];
  active: ID | null;
  split: ID | null;
  /** page to jump to when a document opens (search results, links) */
  jump: { docId: ID; pageId: ID; q?: string } | null;
  settingsOpen: string | null;
  helpOpen: boolean;
}

export const app = createStore<AppState>({
  ready: false,
  screen: "welcome",
  section: "home",
  folderId: null,
  query: "",
  tabs: [],
  active: null,
  split: null,
  jump: null,
  settingsOpen: null,
  helpOpen: false,
});

export function persistSession() {
  const s = app.get();
  kvSet("session", { tabs: s.tabs, active: s.active, split: s.split, screen: s.screen === "welcome" ? "library" : s.screen, section: s.section, folderId: s.folderId }).catch(() => {});
}

export async function restoreSession() {
  const s = await kvGet<Partial<AppState> | null>("session", null);
  if (s) app.set({ tabs: s.tabs ?? [], active: s.active ?? null, split: s.split ?? null, section: s.section ?? "home", folderId: s.folderId ?? null, screen: (s.screen as any) ?? "library" });
}

export function openDoc(id: ID, opts: { split?: boolean; pageId?: ID; q?: string } = {}) {
  app.set((s) => {
    const tabs = s.tabs.includes(id) ? s.tabs : [...s.tabs, id];
    if (opts.split) return { tabs, split: id, screen: "editor", active: s.active && s.active !== id ? s.active : s.active ?? id, jump: opts.pageId ? { docId: id, pageId: opts.pageId, q: opts.q } : null };
    return { tabs, active: id, screen: "editor", jump: opts.pageId ? { docId: id, pageId: opts.pageId, q: opts.q } : null };
  });
  persistSession();
}

export function closeTab(id: ID) {
  app.set((s) => {
    const idx = s.tabs.indexOf(id);
    const tabs = s.tabs.filter((t) => t !== id);
    let active = s.active;
    if (active === id) active = tabs[Math.min(idx, tabs.length - 1)] ?? null;
    const split = s.split === id ? null : s.split;
    return { tabs, active, split, screen: active ? s.screen : "library" };
  });
  persistSession();
}

export function goLibrary(section?: Section, folderId?: ID | null) {
  app.set((s) => ({ screen: "library", section: section ?? s.section, folderId: folderId === undefined ? s.folderId : folderId }));
  persistSession();
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export interface Toast {
  id: string;
  text: string;
  kind: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}
export const toasts = createStore<{ list: Toast[] }>({ list: [] });
export function toast(text: string, kind: Toast["kind"] = "info", action?: Toast["action"], ms = 4200) {
  const t: Toast = { id: uid(), text, kind, action };
  toasts.set((s) => ({ list: [...s.list.slice(-3), t] }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((x) => x.id !== t.id) })), action ? ms + 3000 : ms);
  log(kind === "error" ? "error" : "info", text);
}

// ---------------------------------------------------------------------------
// Diagnostics log (ring buffer, exportable from the help menu)
// ---------------------------------------------------------------------------
const logBuf: string[] = [];
export function log(level: "info" | "warn" | "error", msg: string) {
  logBuf.push(`${new Date().toISOString()} [${level}] ${msg}`);
  if (logBuf.length > 500) logBuf.shift();
}
export function diagnostics() {
  return logBuf.join("\n");
}
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => log("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => log("error", `Unhandled: ${String((e as PromiseRejectionEvent).reason)}`));
}
