import { isTauri } from "./platform/native";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const installListeners = new Set<() => void>();
const updateListeners = new Set<() => void>();
let installPrompt: BeforeInstallPromptEvent | null = null;
let waitingWorker: ServiceWorker | null = null;
let reloadingForUpdate = false;

function emit(listeners: Set<() => void>) {
  listeners.forEach((listener) => listener());
}

export function isInstalledPwa(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || !!(navigator as any).standalone);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as BeforeInstallPromptEvent;
    emit(installListeners);
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    emit(installListeners);
  });
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", () => emit(installListeners));
}

export function subscribeInstall(listener: () => void) {
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}

export function installSnapshot() {
  return `${isInstalledPwa() ? "installed" : "browser"}:${installPrompt ? "prompt" : "manual"}`;
}

export function hasInstallPrompt() {
  return !!installPrompt;
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const prompt = installPrompt;
  if (!prompt) return "unavailable";
  await prompt.prompt();
  const choice = await prompt.userChoice;
  installPrompt = null;
  emit(installListeners);
  return choice.outcome;
}

export function manualInstallGuidance(): { kind: "safari" | "firefox" | "browser"; text: string } {
  const ua = navigator.userAgent;
  if (/Firefox\//i.test(ua)) return { kind: "firefox", text: "Firefox desktop does not support installing this app. Notefira still works normally in Firefox." };
  if (/Safari\//i.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR)\//i.test(ua)) return { kind: "safari", text: "In Safari, choose File → Add to Dock." };
  return { kind: "browser", text: "Use the Install icon in your browser's address bar or app menu." };
}

export function subscribeUpdate(listener: () => void) {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export function updateSnapshot() {
  return waitingWorker;
}

function setWaiting(worker: ServiceWorker | null) {
  waitingWorker = worker;
  emit(updateListeners);
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || isTauri() || location.protocol === "file:" || !import.meta.env.PROD) return;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) setWaiting(worker);
      });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadingForUpdate) void reloadWhenEditsAreSafe();
    });
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

async function reloadWhenEditsAreSafe() {
  const { flushAll, hasUnsavedSessions } = await import("./editor/session");
  for (;;) {
    await flushAll();
    if (!(await hasUnsavedSessions())) {
      location.reload();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export function activateWaitingServiceWorker() {
  if (!waitingWorker) return false;
  reloadingForUpdate = true;
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  return true;
}
