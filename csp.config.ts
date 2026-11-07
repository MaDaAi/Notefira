// Content Security Policy for the published web app.
//
// GitHub Pages cannot send custom response headers, so the policy is delivered as a
// <meta http-equiv="Content-Security-Policy"> tag that the build adds to index.html
// (the dev server needs inline scripts and its own websocket, so it gets none).
// The desktop app has its own policy in src-tauri/tauri.conf.json.
//
// Every entry is the narrowest source that still lets Notefira work:
//  - its own files ('self');
//  - Google Identity Services, only under accounts.google.com/gsi/ (optional Google sign-in);
//  - the Google Drive and sign-in APIs Notefira calls, by exact path;
//  - the Tesseract text-recognition engine and its English data, pinned to the exact
//    versions Notefira ships with (downloaded from cdn.jsdelivr.net on first use).
// No 'unsafe-inline' and no 'unsafe-eval'. 'wasm-unsafe-eval' only allows compiling
// WebAssembly (the OCR engine); it does not allow eval() or new Function().
import tesseractPkg from "./node_modules/tesseract.js/package.json"; // relative, so the Vite config bundler inlines it

/** The exact Tesseract.js URLs the library uses by default (see its defaultOptions / getCore). */
export function tesseractSources() {
  const tess = tesseractPkg as { version: string; dependencies: Record<string, string> };
  const coreSpec: string = tess.dependencies["tesseract.js-core"]; // e.g. "^5.1.1"; the library drops the first character
  return {
    worker: `https://cdn.jsdelivr.net/npm/tesseract.js@v${tess.version}/dist/worker.min.js`,
    core: `https://cdn.jsdelivr.net/npm/tesseract.js-core@v${coreSpec.substring(1)}/`,
    lang: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/",
  };
}

export function cspDirectives(): Record<string, string[]> {
  const ocr = tesseractSources();
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'", "https://accounts.google.com/gsi/client", ocr.worker, ocr.core],
    "style-src": ["'self'", "https://accounts.google.com/gsi/style"],
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'", "data:"],
    "media-src": ["'self'", "blob:"],
    "connect-src": [
      "'self'",
      // The OCR engine first tries to fetch() its WebAssembly from an embedded data: URL.
      // A data: URL carries its own bytes, so allowing it cannot send anything off the device.
      "data:",
      "https://accounts.google.com/gsi/",
      "https://www.googleapis.com/drive/v3/",
      "https://www.googleapis.com/upload/drive/v3/",
      "https://www.googleapis.com/oauth2/v3/userinfo",
      "https://oauth2.googleapis.com/revoke",
      ocr.core,
      ocr.lang,
    ],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["https://accounts.google.com/gsi/"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "upgrade-insecure-requests": [],
  };
}

export function cspString(directives = cspDirectives()): string {
  return Object.entries(directives)
    .map(([k, v]) => [k, ...v].join(" "))
    .join("; ");
}

/** Policy for the static legal pages and the 404 page: no scripts at all except the hashed ones listed. */
export function staticPageCsp(extra: { script?: string[]; style?: string[] } = {}): string {
  return cspString({
    "default-src": ["'none'"],
    "script-src": extra.script?.length ? extra.script : ["'none'"],
    "style-src": ["'self'", ...(extra.style ?? [])],
    "img-src": ["'self'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  });
}
