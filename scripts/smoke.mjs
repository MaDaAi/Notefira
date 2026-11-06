// Smoke test: serve dist/ on a temporary port, load it in headless Chrome/Edge,
// print console output and the rendered DOM, then shut everything down.
// Usage: node scripts/smoke.mjs [path-to-browser] [--shot=file.png] [--width=1440]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const args = process.argv.slice(2);
const browser =
  args.find((a) => !a.startsWith("--")) ??
  ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const shot = args.find((a) => a.startsWith("--shot="))?.slice(7);
const width = Number(args.find((a) => a.startsWith("--width="))?.slice(8) ?? 1440);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = normalize(join(root, p));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  const flags = ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${join(tmpdir(), "nf-smoke-" + Date.now())}`, `--window-size=${width},900`, "--virtual-time-budget=8000", "--enable-logging=stderr", "--v=0"];
  flags.push(shot ? `--screenshot=${shot}` : "--dump-dom");
  const p = spawn(browser, [...flags, url]);
  let out = "",
    err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => p.kill(), 45000);
  p.on("close", () => {
    clearTimeout(timer);
    server.close();
    const logs = err.split("\n").filter((l) => /CONSOLE|Uncaught|Error/i.test(l));
    console.log("---- console ----\n" + logs.join("\n"));
    console.log("---- dom ----\n" + out.slice(0, 4000));
  });
});
