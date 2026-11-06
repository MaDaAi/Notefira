// Platform abstraction: the same code runs in browsers, installed PWAs and the
// Tauri desktop shell. Native capabilities are loaded lazily only inside Tauri.

import { kvGet, kvDelete } from "../storage/db";

export function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

export function platformName(): string {
  if (isTauri()) return "desktop";
  const standalone = typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone);
  return standalone ? "installed web app" : "browser";
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
export async function pickFiles(accept: string, multiple = false): Promise<File[]> {
  if (isTauri()) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const exts = accept
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("."))
        .map((s) => s.slice(1));
      const res = await open({ multiple, filters: exts.length ? [{ name: "Supported files", extensions: exts }] : undefined });
      if (!res) return [];
      const paths = Array.isArray(res) ? res : [res];
      const files: File[] = [];
      for (const p of paths) {
        const bytes = await readFile(p as string);
        const name = String(p).split(/[\\/]/).pop() || "file";
        files.push(new File([bytes], name, { type: mimeFromName(name) }));
      }
      return files;
    } catch (e) {
      console.warn("Native file dialog failed, falling back", e);
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    document.body.appendChild(input);
    input.onchange = () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    };
    // Some browsers never fire change on cancel; clean up when focus returns.
    window.addEventListener(
      "focus",
      () =>
        setTimeout(() => {
          if (!input.files?.length) {
            resolve([]);
            input.remove();
          }
        }, 800),
      { once: true },
    );
    input.click();
  });
}

export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  return (
    {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      notefira: "application/x-notefira",
      nfbackup: "application/x-notefira-backup",
      json: "application/json",
      webm: "audio/webm",
      m4a: "audio/mp4",
    } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}

/** Save a file to disk: native dialog on desktop, File System Access API or a download in browsers. */
export async function saveFile(name: string, data: Blob | Uint8Array, mime = "application/octet-stream"): Promise<boolean> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const ext = name.split(".").pop() || "";
      const path = await save({ defaultPath: name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
      if (!path) return false;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return true;
    } catch (e) {
      console.warn("Native save failed, falling back", e);
    }
  }
  const w = window as any;
  if (w.showSaveFilePicker && window.isSecureContext) {
    try {
      const ext = name.split(".").pop() || "";
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: ext ? [{ description: ext.toUpperCase(), accept: { [mime]: ["." + ext] } }] : undefined });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e: any) {
      if (e?.name === "AbortError") return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

/** Share through the OS share sheet where available, otherwise save the file. */
export async function shareFile(name: string, blob: Blob, title: string): Promise<"shared" | "saved" | "cancelled"> {
  const file = new File([blob], name, { type: blob.type });
  const nav: any = navigator;
  if (!isTauri() && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return "shared";
    } catch (e: any) {
      if (e?.name === "AbortError") return "cancelled";
    }
  }
  return (await saveFile(name, blob, blob.type)) ? "saved" : "cancelled";
}

export async function openExternal(url: string) {
  if (!/^(https?:|mailto:)/i.test(url)) throw new Error("Only web and e-mail links can be opened.");
  if (isTauri()) {
    try {
      await invoke("open_external", { url });
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Files passed on the command line / by double-clicking a .notefira or .pdf file (desktop only). */
export async function takeLaunchFiles(): Promise<File[]> {
  if (!isTauri()) return [];
  try {
    const paths = await invoke<string[]>("take_opened_files");
    if (!paths?.length) return [];
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const out: File[] = [];
    for (const p of paths) {
      const bytes = await readFile(p);
      const name = p.split(/[\\/]/).pop() || "file";
      out.push(new File([bytes], name, { type: mimeFromName(name) }));
    }
    return out;
  } catch {
    return [];
  }
}

export async function toggleFullscreen() {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen?.();
}

// ---------------------------------------------------------------------------
// Secrets (the desktop Google refresh token and the optional desktop OAuth client
// secret) are stored ONLY in the operating system's secure credential store —
// macOS Keychain, Windows Credential Manager or Linux Secret Service — through the
// desktop app. There is deliberately no plaintext fallback: when secure storage is
// unavailable (in browsers, or on a desktop without a working keychain) secrets are
// kept in memory for the current session only and are forgotten when Notefira closes,
// so you sign in again next time. The web app never receives long-lived Google tokens.
// ---------------------------------------------------------------------------
const SECRET_NAMES = ["googleClientSecret", "googleRefresh"] as const;
const sessionSecrets = new Map<string, string>();
let keychainWorks: boolean | null = null; // null = not yet known

/** "keychain": secrets persist securely. "session-only": they last until Notefira closes. */
export async function secretStorageMode(): Promise<"keychain" | "session-only"> {
  if (!isTauri()) return "session-only";
  if (keychainWorks === null) {
    try {
      await invoke<string | null>("secret_get", { name: "__notefira_probe" });
      keychainWorks = true;
    } catch {
      keychainWorks = false;
    }
  }
  return keychainWorks ? "keychain" : "session-only";
}

export async function getSecret(name: string): Promise<string> {
  if (isTauri() && keychainWorks !== false) {
    try {
      const v = (await invoke<string | null>("secret_get", { name })) ?? "";
      keychainWorks = true;
      return v || sessionSecrets.get(name) || "";
    } catch {
      keychainWorks = false;
    }
  }
  return sessionSecrets.get(name) ?? "";
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (isTauri() && keychainWorks !== false) {
    try {
      if (value) await invoke("secret_set", { name, value });
      else await invoke("secret_delete", { name });
      keychainWorks = true;
      sessionSecrets.delete(name);
      return;
    } catch {
      keychainWorks = false;
    }
  }
  if (value) sessionSecrets.set(name, value);
  else sessionSecrets.delete(name);
}

/**
 * Earlier versions fell back to storing secrets unencrypted in the local database.
 * Move any such values into the OS keychain when it works, then delete the plaintext
 * copies (on the web, and when no keychain is available, they are simply deleted).
 */
export async function purgeLegacyPlaintextSecrets(): Promise<void> {
  for (const name of SECRET_NAMES) {
    const key = "secret:" + name;
    const legacy = await kvGet<string | null>(key, null).catch(() => null);
    if (legacy === null) continue;
    if (legacy && isTauri() && (await secretStorageMode()) === "keychain") {
      await setSecret(name, legacy).catch(() => {});
    }
    await kvDelete(key).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Desktop updates
// ---------------------------------------------------------------------------
export async function checkForDesktopUpdate(): Promise<string> {
  if (!isTauri()) return "Updates for the web version are applied automatically when you reload.";
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return "Notefira is up to date.";
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return `Installed version ${update.version}.`;
  } catch (e: any) {
    return "Update check failed: " + (e?.message ?? String(e)) + " (the release must be signed and published — see docs/DESKTOP.md).";
  }
}
