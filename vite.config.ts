import { defineConfig, type Plugin } from "vite";
import { cspString } from "./csp.config";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const APP_VERSION: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/**
 * Emits sw.js with a precache list of every built file, so the installed
 * PWA (and the web app after its first visit) works fully offline.
 */
function serviceWorker(): Plugin {
  return {
    name: "notefira-sw",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
      const assets = ["./", "./index.html", "./manifest.webmanifest", "./theme-init.js", "./legal/legal.css", "./legal/privacy.html", "./legal/terms.html", "./legal/cookies.html", "./legal/accessibility.html", "./legal/third-party-licenses.txt", "./icons/icon.svg", "./icons/icon-192.png", "./icons/apple-touch-icon-180.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./screenshots/notefira-library-wide.png", ...files.filter((f) => f !== "index.html").map((f) => "./" + f)];
      const version = createHash("sha256").update(files.sort().join("|") + Date.now()).digest("hex").slice(0, 12);
      const source = `// Notefira service worker (generated at build time)
const VERSION = ${JSON.stringify(version)};
const PRECACHE = "notefira-app-" + VERSION;
const RUNTIME = "notefira-runtime-v1";
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener("install", (e) => {
  // Activate immediately only on first install. Updates wait for the user so a
  // live editing session never starts using a mixture of old and new assets.
  e.waitUntil(caches.open(PRECACHE).then((c) => c.addAll(ASSETS)).then(() => self.registration.active ? undefined : self.skipWaiting()));
});
self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("notefira-app-") && k !== PRECACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
// OCR engine + language data are fetched from a CDN on first use; keep them for offline use.
const RUNTIME_HOSTS = ["cdn.jsdelivr.net", "tessdata.projectnaptha.com", "unpkg.com"];
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") {
      e.respondWith(fetch(req).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("./index.html", { ignoreSearch: true }).then((index) => index || caches.match("./")))));
      return;
    }
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(RUNTIME).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(RUNTIME).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }))));
  }
  // Google sign-in / Drive requests are never cached.
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/** Content Security Policy for the published web app (build only — see csp.config.ts). */
const CSP = cspString();

function contentSecurityPolicy(): Plugin {
  return {
    name: "notefira-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

// Relative base so the same build works on a static web host, as an
// installed PWA, and inside the Tauri desktop webview.
export default defineConfig({
  base: "./",
  plugins: [react(), serviceWorker(), contentSecurityPolicy()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  clearScreen: false,
  server: { strictPort: true, port: 1420 },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    target: "es2021",
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          pdf: ["pdfjs-dist"],
          pdflib: ["pdf-lib"],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
} as any);
