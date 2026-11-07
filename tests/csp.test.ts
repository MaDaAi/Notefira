import { describe, expect, it } from "vitest";
import { cspDirectives, cspString, staticPageCsp, tesseractSources } from "../csp.config";
import tessPkg from "tesseract.js/package.json";
import tessDefaults from "../node_modules/tesseract.js/src/worker/browser/defaultOptions.js?raw";
import tessCore from "../node_modules/tesseract.js/src/worker-script/browser/getCore.js?raw";
import googleSrc from "../src/sync/google.ts?raw";
import driveSrc from "../src/sync/drive.ts?raw";
import viteConfig from "../vite.config.ts?raw";
import accessibility from "../public/legal/accessibility.html?raw";
import cookies from "../public/legal/cookies.html?raw";
import privacy from "../public/legal/privacy.html?raw";
import terms from "../public/legal/terms.html?raw";
import notFound from "../public/404.html?raw";

async function sha(s: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
}

describe("Content Security Policy", () => {
  const d = cspDirectives();
  const all = Object.values(d).flat();

  it("never allows inline script, eval, or whole-host wildcards", () => {
    expect(all).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("'unsafe-eval'");
    expect(all.some((s) => s === "*" || s === "https:" || s === "http:" || s.includes("*"))).toBe(false);
    // only path-scoped external sources: no bare origins such as https://cdn.jsdelivr.net
    for (const s of all.filter((x) => x.startsWith("https://"))) expect(new URL(s).pathname.length).toBeGreaterThan(1);
  });

  it("locks down plugins, base URLs, form posts and mixed content", () => {
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'none'"]);
    expect(d).toHaveProperty("upgrade-insecure-requests");
    expect(d["default-src"]).toEqual(["'self'"]);
  });

  it("allows only the exact OCR engine version Notefira ships with", () => {
    const ocr = tesseractSources();
    expect(ocr.worker).toBe(`https://cdn.jsdelivr.net/npm/tesseract.js@v${tessPkg.version}/dist/worker.min.js`);
    // the library builds these URLs itself; if it changes how, this must be revisited
    expect(tessDefaults).toContain("https://cdn.jsdelivr.net/npm/tesseract.js@v${version}/dist/worker.min.js");
    expect(tessCore).toContain("https://cdn.jsdelivr.net/npm/tesseract.js-core@v${coreVersion.substring(1)}");
    expect(d["script-src"]).toEqual(expect.arrayContaining([ocr.worker, ocr.core]));
    expect(d["connect-src"]).toEqual(expect.arrayContaining([ocr.core, ocr.lang]));
  });

  it("allows every Google endpoint the sync code calls, and nothing broader", () => {
    const google = googleSrc + driveSrc;
    const used = [...google.matchAll(/https:\/\/(?:www|oauth2)\.googleapis\.com\/[\w/.-]+/g)].map((m) => m[0]).filter((u) => !u.includes("/auth/"));
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) {
      if (u.endsWith("/token")) continue; // desktop sign-in only (the desktop app has its own policy)
      expect(d["connect-src"].some((src) => (src.endsWith("/") ? (u + "/").startsWith(src) : u === src))).toBe(true);
    }
  });

  it("is added to the built index.html only (the dev server needs inline scripts)", () => {
    const vite = viteConfig;
    expect(vite).toContain("const CSP = cspString();");
    expect(vite).toMatch(/name: "notefira-csp",\s+apply: "build"/);
    expect(cspString()).not.toMatch(/"/);
  });

  it("protects the legal pages and the 404 page, whose inline code is pinned by hash", async () => {
    for (const html of [accessibility, cookies, privacy, terms]) {
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${staticPageCsp()}" />`);
      expect(html).not.toMatch(/<script|<style|style="/);
    }
    const page = notFound;
    expect(page).not.toContain("\r"); // the hashes are of the exact bytes (see .gitattributes)
    const script = page.match(/<script>([\s\S]*?)<\/script>/)![1];
    const style = page.match(/<style>([\s\S]*?)<\/style>/)![1];
    expect(page).toContain(`content="${staticPageCsp({ script: [await sha(script)], style: [await sha(style)] })}"`);
  });
});
