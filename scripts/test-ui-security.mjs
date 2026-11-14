// Real-browser focus/keyboard regressions; uses installed Chrome/Edge and Vite.
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const browser = process.env.NOTEFIRA_TEST_BROWSER || ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!browser) throw new Error("Install Chrome/Edge or set NOTEFIRA_TEST_BROWSER.");
const profile = await mkdtemp(join(tmpdir(), "notefira-ui-test-"));
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false }, clearScreen: false });
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", `http://127.0.0.1:${port}/tests/browser/security-ui.html`]);
  let output = "";
  child.stdout.on("data", (d) => output += d);
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 30000);
  await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
  const result = output.match(/UI_SECURITY_(?:PASS|FAIL):[^<]*/)?.[0];
  if (!result?.startsWith("UI_SECURITY_PASS")) throw new Error(result || "Browser regression did not finish");
  console.log(result);
} finally {
  await server.close();
  const resolvedProfile = resolve(profile);
  if (dirname(resolvedProfile) !== resolve(tmpdir()) || !basename(resolvedProfile).startsWith("notefira-ui-test-")) throw new Error("Unexpected temporary profile path");
  await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
