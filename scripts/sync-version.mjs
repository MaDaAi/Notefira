// Copies the version from package.json into the desktop app's config files
// (src-tauri/tauri.conf.json and src-tauri/Cargo.toml) so every build of
// Notefira — web and desktop — reports the same version. Run by `npm run build`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version "${version}" is not MAJOR.MINOR.PATCH`);

const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = readFileSync(confPath, "utf8");
const confNext = conf.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
if (confNext !== conf) writeFileSync(confPath, confNext);

const cargoPath = join(root, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
// only the [package] version (the first `version = ` line)
const cargoNext = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
if (cargoNext !== cargo) writeFileSync(cargoPath, cargoNext);

console.log(`version ${version} (web + desktop)`);
