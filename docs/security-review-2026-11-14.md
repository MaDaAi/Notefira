# Notefira security review — November 14, 2026 (second pass)

## Overview

- **Project:** Notefira, a free local-first notebook web app (React 18, TypeScript, Vite 7) with a PWA and a Tauri desktop shell; optional Google Drive sync; hosted on GitHub Pages.
- **Reviewed:** commit `7f474b0` (an AI-assisted hardening update made with Codex) on top of v0.1.14, the GitHub repository's public settings and workflows, and the live site https://madaai.github.io/Notefira/.
- **Scope exclusions:** no intrusive scanning; no access to the owner's GitHub or Google Cloud settings pages; no desktop (Tauri) build was produced or run; palm rejection was not re-tested on an iPad.
- **Verdict:** **CONDITIONALLY READY.** There are no exploitable vulnerabilities in the code. One regression introduced by the reviewed commit was fixed. The remaining items are platform limits and owner account settings.

## Security scorecard (all original 70)

**FAILED: 1 / 70**

| Measure | Count |
|---|---:|
| **FAIL (confirmed not passed)** | 1 |
| **UNKNOWN (not verified)** | 2 |
| **FAIL + UNKNOWN (not passed or unverified)** | 3 |
| PASS (verified) | 33 |
| NOT APPLICABLE (justified) | 34 |
| **TOTAL** | **70** |

PASS + FAIL + UNKNOWN + NOT APPLICABLE = 33 + 1 + 2 + 34 = 70. NOT PASSED / UNVERIFIED = FAIL + UNKNOWN = 3.

Most N/A items exist because Notefira has no server, database, payments, user accounts or AI service. UNKNOWN means the item could not be verified here; it does not mean a vulnerability was found.

## All 70 individual checks

| ID | Name | Status | Severity | Evidence | Fix | Verification |
|---|---|---|---|---|---|---|
| 01 | Exposed database credentials | NOT APPLICABLE | INFORMATIONAL | No server or database exists: notebooks live in the browser (IndexedDB) and optionally in each user's own Google Drive. Source, history, dist and live bundle scans found no DB credentials. | None | git log -p pattern scan; live bundle grep |
| 02 | Public .env files | PASS | INFORMATIONAL | .gitignore excludes .env/.env.*; no env file is tracked or was ever committed; live /.env returns 404. | None | git ls-files; git log --name-only; curl live /.env -> 404 |
| 03 | Hardcoded API keys or secrets | PASS | INFORMATIONAL | Only the public Google OAuth client ID is embedded (not a secret). No client secret, tokens or private keys in source or full history; the only GOCSPX matches are tests asserting absence. | None | git log --all -p secret-pattern scan (2 hits, both test assertions) |
| 04 | Weak or missing authentication | PASS | LOW | No private server routes. Optional sign-in is Google Identity Services (web token popup) or PKCE+state loopback (desktop). Google enforces identity; Notefira holds no accounts or passwords. | None | Code review of src/sync/google.ts; live Google sign-in and Drive sync verified on 2026-11-07 (v0.1.13); token-restore validation covered by tests/auth-import-security.test.ts. Not re-run live after 7f474b0. |
| 05 | Missing server-side authorization | NOT APPLICABLE | INFORMATIONAL | No application server. Authorization to Drive data is enforced by Google with the drive.file scope (only files Notefira created). | None | Architecture review |
| 06 | Cross-user data access | NOT APPLICABLE | INFORMATIONAL | Each user's data is in their own browser and their own Google Drive; there is no shared store the app controls. | None | Architecture review |
| 07 | Open database permissions | NOT APPLICABLE | INFORMATIONAL | No database server. | None | Architecture review |
| 08 | Misconfigured Firebase / Supabase / S3 | NOT APPLICABLE | INFORMATIONAL | None of these services are used. | None | package.json and source review |
| 09 | Unprotected admin routes | NOT APPLICABLE | INFORMATIONAL | No admin pages, endpoints or dashboards exist. | None | Source review; static GitHub Pages hosting |
| 10 | Production debug tools exposed | PASS | INFORMATIONAL | Developer settings render only in dev builds (DEV_BUILD); no source maps; tests/browser fixture is not in dist (live 404). | None | dist inspection; curl live tests/browser/security-ui.html -> 404 |
| 11 | Build logs leaking secrets | PASS | INFORMATIONAL | Workflows use no secrets at all; only public build variables (client ID, sign-in flag). No step prints credentials. | None | Review of .github/workflows/*.yml |
| 12 | Verbose production errors | PASS | INFORMATIONAL | No server responses. Client shows short user-facing messages; no stack traces rendered. | None | Source review of toasts/dialogs |
| 13 | Secrets in Git history | PASS | INFORMATIONAL | Full history scan for Google/GitHub/Slack/OpenAI/private-key patterns found no secrets. (Separate privacy note: one commit's author metadata shows a personal email; not a secret.) | None | git log --all -p pattern scan |
| 14 | Secrets shipped in frontend JavaScript | PASS | INFORMATIONAL | Live bundle contains the public client ID and no client secret (GOCSPX count 0). | None | curl live assets/index-*.js \| grep |
| 15 | Client-side-only security checks | NOT APPLICABLE | INFORMATIONAL | No entitlements, roles or paid features. Data-access security is enforced by Google, not the UI. | None | Architecture review |
| 16 | Missing input validation | PASS | MEDIUM | Imports, backups, clipboard and Drive data pass strict schema/size validation. ORIGINAL ISSUE (fixed): 7f474b0 made one malformed library record reject the whole Drive library file, which then got rewritten without other devices' folders/study sets. Now malformed records are skipped individually. | src/sync/engine.ts: filter folders/decks with validateFolder/validateDeck instead of rejecting the file | New test in tests/sync.test.ts fails on 7f474b0 and passes after the fix |
| 17 | SQL injection | NOT APPLICABLE | INFORMATIONAL | No SQL database. | None | Architecture review |
| 18 | NoSQL injection | PASS | INFORMATIONAL | Drive API queries use fixed strings; Drive IDs are checked by safeId before being placed in URLs; IndexedDB uses key lookups, not query strings. | None | Review of src/sync/drive.ts |
| 19 | Cross-site scripting (XSS) | PASS | INFORMATIONAL | No innerHTML/dangerouslySetInnerHTML/eval sinks; links limited to http/https/mailto after confirmation; strict CSP (no unsafe-inline/eval) deployed. | None | grep for sinks; tests/csp.test.ts; live CSP check |
| 20 | Cross-site request forgery (CSRF) | NOT APPLICABLE | INFORMATIONAL | No cookie-authenticated server endpoints; Google APIs use bearer tokens. | None | Architecture review |
| 21 | Insecure file uploads | PASS | INFORMATIONAL | Imports are size-capped, signature-checked (PDF magic, raster headers), dimension/batch-limited and stored as data in IndexedDB, never executed or served. | None | tests/import-limits.test.ts; src/services/importLimits.ts |
| 22 | Path traversal | PASS | INFORMATIONAL | Web build has no filesystem access. Drive IDs are validated (safeId). Desktop reads only user-chosen or OS-launched files through Tauri's fs plugin without a broad scope. | None | src/sync/drive.ts; src-tauri/capabilities/default.json |
| 23 | Server-side request forgery (SSRF) | NOT APPLICABLE | INFORMATIONAL | No server makes requests. (Client also checks the Drive resumable-upload URL origin.) | None | Architecture review; tests/drive-security.test.ts |
| 24 | Broken password-reset flows | NOT APPLICABLE | INFORMATIONAL | No passwords or reset flow; Google manages accounts. | None | Architecture review |
| 25 | Weak session management | PASS | INFORMATIONAL | Access tokens live in memory or the tab's sessionStorage only, are shape/expiry-checked on restore, and are revoked on sign-out; desktop refresh token uses the OS keychain. | None | src/sync/google.ts; tests/auth-import-security.test.ts |
| 26 | Weak or incorrectly validated JWTs | NOT APPLICABLE | INFORMATIONAL | The app does not decode or trust JWTs. | None | Source review |
| 27 | Overly permissive CORS | NOT APPLICABLE | INFORMATIONAL | No API of our own; static hosting only. | None | Architecture review |
| 28 | Missing rate limits | NOT APPLICABLE | INFORMATIONAL | No server endpoints to rate-limit. Client sync is throttled (minimum gap, backoff) and Google enforces API quotas. | None | src/sync/scheduler.ts |
| 29 | Unprotected staging or test environments | NOT APPLICABLE | INFORMATIONAL | No staging deployment exists; testing is local only. | None | GitHub Pages has one site; no other environments |
| 30 | Default credentials left unchanged | PASS | INFORMATIONAL | No default accounts, passwords or shared tokens; test data is synthetic. | None | Source/history review |
| 31 | Webhook signatures not verified | NOT APPLICABLE | INFORMATIONAL | No webhooks. | None | Architecture review |
| 32 | Frontend-only payment checks | NOT APPLICABLE | INFORMATIONAL | Notefira is free; no payments. | None | Architecture review |
| 33 | IDOR / BOLA | NOT APPLICABLE | INFORMATIONAL | No object API of our own; Google authorizes every Drive file request. | None | Architecture review |
| 34 | APIs trusting user-controlled roles or IDs | NOT APPLICABLE | INFORMATIONAL | No roles and no API of our own. | None | Architecture review |
| 35 | Sensitive data in logs | PASS | INFORMATIONAL | No server logs. Client sync log records counts/status, not note content; tokens are never logged; revoke sends the token in a POST body. | None | Review of src/sync/*.ts |
| 36 | Sensitive source maps or build artifacts | PASS | INFORMATIONAL | No .map files in dist; live map URL 404; internal docs/CSV/tests not served. | None | find dist -name *.map; curl live -> 404s |
| 37 | Vulnerable or abandoned dependencies | PASS | INFORMATIONAL | npm audit: 0 vulnerabilities (all and production-only) after the Vite 7 / Vitest 4 upgrade; CI now fails on moderate+ advisories. | None | npm audit; npm audit --omit=dev; workflows |
| 38 | Malicious or compromised packages | PASS | LOW | Lockfile with integrity hashes; only three packages run install scripts (esbuild, fsevents, tesseract.js), all well-known. Validation workflow uses --ignore-scripts. | None | package-lock.json hasInstallScript review |
| 39 | Prompt injection | NOT APPLICABLE | INFORMATIONAL | No LLM or AI agent. OCR runs locally with Tesseract. | None | src/ai/ocr.ts only |
| 40 | AI tools bypassing user permissions | NOT APPLICABLE | INFORMATIONAL | No AI tools or agents. | None | Source review |
| 41 | Excess database privileges | NOT APPLICABLE | INFORMATIONAL | No database. (Google access is least-privilege: drive.file only.) | None | src/sync/google.ts scopes |
| 42 | Missing audit logs | NOT APPLICABLE | INFORMATIONAL | No server, admin actions or multi-user data to audit. | None | Architecture review |
| 43 | No security monitoring or alerts | UNKNOWN | LOW | No server to monitor. Repository-level alerting (Dependabot alerts, secret scanning, push protection) cannot be confirmed from the public API. | Owner: enable Dependabot alerts, secret scanning and push protection in GitHub settings | GitHub API security_and_analysis not visible without owner access |
| 44 | No tested backup / restore plan | PASS | INFORMATIONAL | In-app backup export/restore with validation; Drive sync copy; deletion confirmations offer a backup first. | None | tests/backup-restore.test.ts |
| 45 | Public internal dashboards | NOT APPLICABLE | INFORMATIONAL | No dashboards. | None | Architecture review |
| 46 | Missing security headers | FAIL | LOW | CSP (meta), HTTPS redirect and HSTS are in place, but GitHub Pages cannot send frame-ancestors/X-Frame-Options or nosniff, so the site can be framed (clickjacking). | Optional: host behind a provider that sends the existing public/_headers (e.g. Cloudflare Pages) with frame-ancestors 'none' | curl -I live: only Strict-Transport-Security present |
| 47 | Unsafe cookie settings | NOT APPLICABLE | INFORMATIONAL | Notefira sets no cookies. | None | Source review; cookies.html |
| 48 | Sensitive data unprotected in transit / at rest | PASS | INFORMATIONAL | All network traffic is HTTPS (HSTS, upgrade-insecure-requests). Local notes are unencrypted by design and this is disclosed; Drive data is protected by Google. | None | Live headers; privacy.html |
| 49 | Poor tenant isolation | NOT APPLICABLE | INFORMATIONAL | No multi-tenant system. | None | Architecture review |
| 50 | Over-trusting AI-generated code | PASS | MEDIUM | ORIGINAL ISSUE (fixed): the AI-made commit 7f474b0 shipped a sync regression (see 16), a garbled package description, and no version bump. Its diff was reviewed line by line; CI pins and tests verified. | Fixed regression, description and version (0.1.15) | Full test suite, typecheck, build, browser UI test |
| 51 | Mass assignment / over-posting | NOT APPLICABLE | INFORMATIONAL | No server API accepting client objects. | None | Architecture review |
| 52 | Command / OS injection | PASS | INFORMATIONAL | No shell use; desktop open_external validates the URL scheme and uses the webbrowser crate. | None | src-tauri/src/lib.rs |
| 53 | Unsafe deserialization | PASS | INFORMATIONAL | safeParse JSON (no prototype keys), strict schema validation, SHA-256 integrity, decompression limits. | None | src/model/format.ts; tests/format.test.ts |
| 54 | Misconfigured OAuth / OIDC / social login | PASS | INFORMATIONAL | Least scope (drive.file); no client secret; desktop uses PKCE + state; Google rejects unlisted origins (confirmed by origin_mismatch on an unlisted test address). | None | src/sync/google.ts; live test on 2026-11-07 |
| 55 | No MFA on privileged accounts | UNKNOWN | MEDIUM | Cannot verify MFA on the GitHub account that owns the repository and the Google Cloud project. | Owner: confirm 2FA on GitHub and Google | Not verifiable from here |
| 56 | Account enumeration | NOT APPLICABLE | INFORMATIONAL | No sign-up, login or reset responses of our own. | None | Architecture review |
| 57 | Business-logic abuse | NOT APPLICABLE | INFORMATIONAL | No prices, credits, quotas or trials. | None | Architecture review |
| 58 | Race conditions | PASS | INFORMATIONAL | Atomic read-then-write transactions, Web Locks so one tab syncs at a time, three-way page merge. | None | tests/sync.test.ts; tests/tabs.test.ts |
| 59 | Webhook replay / duplicate processing | NOT APPLICABLE | INFORMATIONAL | No webhooks. | None | Architecture review |
| 60 | Overpowered CI/CD credentials | PASS | LOW | Workflows default to contents: read; pages/id-token only on the deploy job; persist-credentials false; no secrets. Note: main has no branch protection. | Recommended: protect main (block force-push and deletion) | Workflow review; GitHub API branches: main unprotected |
| 61 | Untrusted build actions or scripts | PASS | INFORMATIONAL | Only official actions/* actions, each pinned to a commit SHA that matches its official v3/v4 release tag. | None | GitHub API tag lookup for all 4 SHAs |
| 62 | Unpinned build dependencies | PASS | INFORMATIONAL | package-lock.json used with npm ci; actions pinned by SHA; build tools pinned to exact versions. | None | Workflow and package.json review |
| 63 | Security checks fail open | PASS | INFORMATIONAL | Sync stops on auth/permission errors and pauses when the Drive folder is gone; invalid imports are rejected; CSP blocks by default. | None | tests/sync.test.ts; tests/polish.test.ts |
| 64 | Missing resource limits | PASS | INFORMATIONAL | File, image, pixel, batch, clipboard, decompression, library and Drive-download size limits. | None | tests/import-limits.test.ts; tests/drive-security.test.ts; tests/clipboard.test.ts |
| 65 | AI sensitive-information disclosure | NOT APPLICABLE | INFORMATIONAL | No AI service receives user data. | None | Source review |
| 66 | Unsafe use of AI output | NOT APPLICABLE | INFORMATIONAL | No generative AI output is used. | None | Source review |
| 67 | AI agents have excessive agency | NOT APPLICABLE | INFORMATIONAL | No AI agents in the product. | None | Source review |
| 68 | Sensitive browser storage | PASS | INFORMATIONAL | Google tokens are memory/sessionStorage only and validated; notes stored locally by design (disclosed) with Delete all available. | None | src/sync/google.ts; src/services/wipe.ts; privacy.html |
| 69 | Open redirects | PASS | INFORMATIONAL | No redirect parameters. The 404 page only links to the same-origin site root. | None | public/404.html; tests/csp.test.ts |
| 70 | Unsecured GraphQL / WebSocket / realtime endpoints | NOT APPLICABLE | INFORMATIONAL | None exist. | None | Architecture review |

## Separate privacy / legal / process findings (not part of the 70)

| Topic | Status | Evidence | Action |
|---|---|---|---|
| Personal email in public commit metadata | FAIL | Commit `7f474b0` is authored with the owner's personal Gmail address; the other 16 commits use the GitHub no-reply address. Public repositories expose commit emails. | Owner: set `user.email` to the GitHub no-reply address in every clone/tool (including the Codex workspace), and turn on GitHub's "Keep my email addresses private" and "Block command line pushes that expose my email". Removing it from history needs a history rewrite and force push; only do this with explicit owner approval. |
| Local path in published audit report | Fixed | `security-audit-2026-11-14.md` named a local Windows user folder. | Replaced with a neutral description. Still present in the history of `7f474b0`. |
| Owner location in published notes | Owner decision | `docs/LEGAL-RELEASE-REVIEW.md` states the province the project is run from. | Keep it if intended (it helps decide which laws apply); remove it otherwise. |
| Privacy policy accuracy | PASS | Codex's correction is accurate: recordings are part of synced notebooks (`collectDocFile` includes recordings), so they are copied to Drive. | None |
| Version discipline | Fixed | `7f474b0` changed the app without a version bump (still 0.1.14). | Bumped to 0.1.15 (web + desktop). |
| Branch protection | Recommended | `main` is unprotected. | Owner: add a rule blocking force pushes and deletion of `main`. |
| Repository security alerts | UNKNOWN | Dependabot/secret scanning status is not visible publicly. | Owner: enable Dependabot alerts, secret scanning and push protection. |
| Accessibility | PASS (partial) | Dialog focus trapping, labelled dialogs and keyboard menus added and covered by an 18-assertion real-browser test. The policy no longer claims a full contrast audit. | A full manual WCAG review is still advised. |
| Third-party licenses | PASS | `third-party-licenses.txt` regenerated, now including LICENSE-MIT style files. | None |

## Changes and testing

**Files changed in this pass (uncommitted):**
- `src/sync/engine.ts`: malformed folders or study sets in the Drive library file are skipped one at a time. Before this fix, `7f474b0` treated the whole file as unreadable and then rewrote it with only this device's folders, which could drop folders and study sets added on other devices. Rollback: revert this hunk.
- `tests/sync.test.ts`: regression test, confirmed to **fail on `7f474b0`** and pass with the fix.
- `package.json`: repaired the garbled description; version 0.1.15 (with `package-lock.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`).
- `security-audit-2026-11-14.md`: removed a local Windows user path.
- `security-checks.csv`: this ledger. `docs/security-review-2026-11-14.md`: this report.

**Reviewed and kept from `7f474b0`:**
- CI least privilege and SHA pins, all verified against the official release tags;
- `npm audit` gate and a UI test job;
- import, size and pixel limits;
- Drive download caps and upload-URL check;
- clipboard validation and session-token checks;
- accessible dialogs and menus;
- accurate privacy and cookie wording;
- the Vite 7 / Vitest 4 upgrade.

**Commands run (results):**
- `npx vitest run`: all tests pass.
- `npx tsc --noEmit -p .`: OK.
- `npm run build`: OK.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.
- `npm run test:ui-security`: UI_SECURITY_PASS, 18 browser assertions.
- Secret-pattern scan of the full Git history: no secrets.
- GitHub API: both workflows succeeded for `7f474b0`; only `main` is public; `main` is unprotected.
- Live site:
  - the strict CSP is served;
  - HTTPS redirect and HSTS are in place;
  - `.env`, `.git/config`, source, source maps, tests and internal docs all return 404;
  - no client secret in the bundle.

**Not run:**
- a desktop (Tauri) build;
- a live Google sign-in after `7f474b0`;
- iPad testing;
- any authenticated GitHub or Google Cloud settings review.

## Readiness

**CONDITIONALLY READY.** These conditions are owner actions, not code defects:
1. Stop future commits from using the personal email, and decide whether to rewrite history for the one that did.
2. Confirm 2FA on GitHub and Google.
3. Enable repository security alerts and branch protection.
4. Optionally move hosting to a provider that can send anti-framing headers.

No checklist can guarantee immunity from attacks or legal claims.
