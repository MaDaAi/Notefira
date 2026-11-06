// Collects the license (and NOTICE) texts of every production dependency into
// public/legal/third-party-licenses.txt, so the published app ships the notices
// that MIT, Apache-2.0 and SIL OFL licenses require. Uses package-lock.json only;
// no extra dependencies. Run automatically by `npm run build`.
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const out = [];
const seen = new Set();

const entries = Object.entries(lock.packages ?? {})
  .filter(([path, meta]) => path.startsWith("node_modules/") && !meta.dev && !meta.devOptional)
  .sort(([a], [b]) => a.localeCompare(b));

for (const [path, meta] of entries) {
  const dir = join(root, path);
  if (!existsSync(dir)) continue; // optional platform package not installed here
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(f));
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? meta.license ?? "UNKNOWN";
  out.push(`${"=".repeat(78)}\n${id}\nLicense: ${license}${pkg.homepage ? `\nHomepage: ${pkg.homepage}` : ""}\n${"=".repeat(78)}\n`);
  if (files.length) for (const f of files) out.push(readFileSync(join(dir, f), "utf8").trim() + "\n");
  else out.push(`(No license file is included in this package; its package.json declares: ${license}.)\n`);
}

const header = `Notefira — open-source components\n\nNotefira includes the following open-source software. Each component is used under\nits own license, reproduced below.\n\nGoogle, Google Drive and the Google "G" logo are trademarks of Google LLC.\nNotefira is not affiliated with or endorsed by Google.\n\n`;
mkdirSync(join(root, "public", "legal"), { recursive: true });
writeFileSync(join(root, "public", "legal", "third-party-licenses.txt"), header + out.join("\n"));
console.log(`third-party-licenses.txt: ${seen.size} packages`);
