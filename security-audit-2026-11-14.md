# Notefira security audit — November 14, 2026

## Overview

Inspected `C:/Users/manso/Documents/Notefira`, version 0.1.14, starting commit `81191b75e4a89121a7af20734ccfb2df00a6aba6`, initially clean working tree. GitHub connector confirmed public repository MaDaAi/Notefira and default branch main. Read-only HTTP inspection of https://madaai.github.io/Notefira/ returned 200; HTTP redirected to HTTPS, privacy page returned 200, .env and .git/config returned 404. Local changes described here have NOT been pushed or deployed. Score combines locally verified source fixes with outstanding live/platform findings; it is not the current deployed site's score.

Stack: React/TypeScript, Vite, IndexedDB, custom offline service worker, optional Google Drive/GIS integration, PDF.js, local Tesseract OCR, optional browser speech recognition, Tauri/Rust desktop shell. No application backend, passwords, payment processing, multi-tenant database, webhooks or LLM agent.

Threat model: notes/PDFs/audio, Google access and refresh tokens, synced Drive assets, repository/deployment authority are assets. Entry points include notebook/PDF/image/backup imports, system clipboard, Drive downloads, CDN OCR scripts, native IPC and local browser storage. Imported files and clipboard are untrusted; Google is the authorization boundary, not the local UI. Plausible attackers can distribute hostile files/clipboard data, compromise a dependency, frame the public site, or access an unlocked device/browser profile. Account compromise and malicious same-origin code are relevant; no intrusive scan or production-data mutation was attempted.

## Security scorecard

**FAILED: 4 / 70**

| Measure | Count |
|---|---:|
| FAIL | 4 |
| UNKNOWN | 12 |
| FAIL + UNKNOWN | 16 |
| PASS | 25 |
| NOT APPLICABLE | 29 |
| TOTAL | 70 |

PASS + FAIL + UNKNOWN + N/A = 25 + 4 + 12 + 29 = 70.
NOT PASSED / UNVERIFIED = FAIL + UNKNOWN = 16.
Applicable-check pass rate = 25 / 41 = 61.0%. This measures verified evidence, not a probability of safety. UNKNOWN is not a confirmed vulnerability. N/A items remain in the 70-item total.

## Follow-up implementation requested by owner

Owner authorized continued fixes and factual legal/privacy improvements, with major changes flagged first. Confirmed the project is free/noncommercial in Ontario and the support address is controlled by the owner. No payments or analytics were added, and no blanket age gate was introduced. General-purpose use does not automatically require one; child-directed collection or known collection from children requires separate analysis (official FTC/OPC sources are linked in docs/LEGAL-RELEASE-REVIEW.md).

Additional changes:

- src/services/importLimits.ts, src/services/transfer.ts and src/editor/clipboard.ts: pre-read web file checks, raster signature/dimension preflight, 64 MiB image/40 MP/16,384 px limits, 128-file/256 MiB image batch budgets, validation before notebook/asset creation, and fallback blob URL cleanup. New image imports accept PNG/JPEG/GIF/WebP; other formats must be converted. Existing stored assets are not deleted or converted. Embedded/native paths remain an explicit resource-budget limitation rather than a claimed full fix.
- src/ui/common.tsx: every dialog receives a linked accessible title; focus enters/stays/restores correctly, only the top nested dialog handles Escape, menus support arrows/Home/End/Escape, delayed listeners are cleaned up.
- src/audio/AudioPanel.tsx: recording permission/sharing reminder and Drive-copy explanation next to recording controls. Browser speech remains off by default.
- public/legal/privacy.html and cookies.html: corrected recording sync, data-erasure/uninstall claims, support correspondence and general-purpose/parental-review guidance. No invented company identity, payment commitments or global compliance guarantee.
- public/legal/accessibility.html: removed an unverified full contrast-check claim and kept the explicit lack of full conformance certification.
- index.html and public/legal/*.html: explicit referrer meta controls. This does not fix response-only framing/nosniff controls on GitHub Pages.
- scripts/licenses.mjs: includes LICENSE-MIT and similarly named notice files. License uncertainty remains documented rather than inventing missing notices.
- .github/workflows/security-checks.yml: read-only PR/push validation with immutable action SHAs, npm advisory gate, tests, production build and browser UI checks. No deployment credentials or pull_request_target trigger.
- package.json, scripts/test-ui-security.mjs, tests/browser/security-ui.html and security-ui.tsx: reproducible headless browser focus/keyboard and valid-image decoding regression command using installed Chrome/Edge.
- tests/import-limits.test.ts and tests/backup-restore.test.ts: pre-allocation resource rejection and complete synthetic backup recovery regression.
- docs/LEGAL-RELEASE-REVIEW.md: verified facts, current protections, official legal research and owner/legal/platform decisions. In particular no fixed email-retention promise, trademark clearance, pediatric/privacy certification, hosting migration or encryption design was fabricated.

Follow-up verification: 178 unit/integration tests pass in 15 files; real Chrome UI regression passes 18 assertions; typecheck and production build pass; npm advisory audit reports zero vulnerabilities. Browser startup smoke and git diff whitespace checks also run. No actual Google sign-in, hosted CI run, native build or deployment was performed. Targeted checks do not establish full accessibility or global legal compliance.

## Confirmed open findings

1. **MEDIUM — Resource budgets (64):** new raster imports now have byte/pixel/batch limits and web notebook/backup files have pre-read size checks. Embedded/restored image assets can still reach src/engine/render.ts without raster metadata preflight, and the native picker reads bytes before frontend limits. A deliberately oversized file can exhaust memory or freeze a tab. Streaming Drive downloads now stop at 1 GiB, but that cap can still be too large for constrained devices. Apply consistent pre-read bounds and image dimension/batch budgets, then test realistic large notebooks on target hardware before choosing tighter limits.
2. **MEDIUM — Desktop OAuth incomplete (54):** frontend invokes `oauth_listen`; Rust registers no loopback listener command. This is a confirmed broken desktop authentication flow, not a proven bypass. Implement a localhost-only one-use listener with cleanup/timeouts and test PKCE/state end to end, or explicitly disable desktop Google sign-in. Rust toolchain is unavailable here.
3. **LOW — Header/CSP gaps (46):** live GitHub Pages sends HSTS and the app has a restrictive meta CSP, but no response nosniff, explicit referrer policy or framing protection. `_headers` does not take effect there. A meta tag cannot substitute for CSP frame-ancestors or X-Frame-Options. Desktop CSP also permits unsafe-eval and broader origins; tightening it requires native feature testing. A header-capable host/proxy is an owner deployment decision.
4. **LOW — Desktop reproducibility (62):** no Cargo.lock exists for the desktop application. Broad major Rust ranges are not an immutable build. Generate, review and commit a verified lockfile with a working Rust toolchain; run cargo audit and platform builds before distributing installers.

## Changes and verification

| File | Change / purpose |
|---|---|
| package.json, package-lock.json | Targeted dev-tool upgrades: Vite 7.3.8, Vitest 4.1.12, plugin-react 5.2.0; Node engine floor recorded. Runtime app packages not indiscriminately upgraded. |
| README.md | Updated Node requirement for patched toolchain. |
| .github/workflows/deploy-pages.yml | Actions pinned to upstream tag-resolved commit SHAs; build has read-only content permission; Pages/OIDC rights only on deployment job; checkout credential persistence disabled; timeouts and moderate-or-higher npm audit gate added. |
| src/editor/clipboardFormat.ts, src/editor/clipboard.ts | Parse system clipboard with safe JSON, shape/link validation, 8 MiB text limit and 10,000-item cap. |
| src/model/format.ts | Validate folders, nested study cards and sticker content/preview. |
| src/services/transfer.ts | Validate backup library records before any restore writes; apply existing 1 GiB/PDF magic checks to insertion route too. |
| src/sync/engine.ts | Reject malformed library shapes from Drive before merging them into the local database. |
| src/sync/drive.ts | Stream downloads with a hard byte cap, including revisions; reject unexpected resumable upload origins/paths. |
| src/sync/google.ts | Check restored token shape and expiry; revoke missing-scope tokens using a POST body instead of a query URL. |
| tests/clipboard.test.ts, tests/drive-security.test.ts, tests/auth-import-security.test.ts | 18 added security regressions covering hostile clipboard, stream cancellation, upload destination, session token, PDF insertion and backup validation. |
| security-checks.csv, security-audit-2026-11-14.md | All 70 evidence-backed outcomes and this report. |

Actual checks run:

- Initial `npm ci --ignore-scripts`: completed. Avoided executing dependency install hooks. The installed platform esbuild binary supported builds without those hooks.
- Baseline `npm test`: 153 tests passed in 10 files. Existing baseline Node-only PDF worker warning was observed; this was not a browser PDF failure.
- Initial `npm audit --json`: 6 affected package entries (3 moderate, 1 high, 2 critical), all in dev/test tooling and its transitive graph. The critical labels do not establish a remotely exploitable flaw in the static website. Vitest UI exploit prerequisites were not enabled by the normal `vitest run` script.
- After targeted upgrades `npm audit --json`: 0 reported vulnerabilities. This is registry advisory coverage, not proof of no vulnerabilities; Rust was not scanned.
- Final `npm test`: 171 tests passed in 13 files.
- `npm run typecheck`: passed. An intermediate test-only Object.hasOwn/ES2021 mismatch was corrected to hasOwnProperty; subsequent typecheck and build passed.
- `npm run build`: passed after fixes. Existing nonfatal classic theme script and mixed static/dynamic import warnings remain; generated files are usable.
- `node scripts/smoke.mjs`: Chrome rendered the production welcome page without application exceptions or CSP violations in captured output. Browser extension registry warnings and an Apple PWA metadata deprecation are environmental/metadata warnings. This is a startup smoke test, not a full editor, Drive, audio, OCR or accessibility test.
- Local credential-pattern scan: 322 historical Git blobs across 16 available commits, source and production output; zero matching credential patterns. Values were never printed. Does not detect all possible secret formats or inaccessible refs.
- Lock inspection: all 199 dependency entries had integrity metadata. Install hooks inventoried for esbuild, optional fsevents and Tesseract. Integrity does not prove a publisher is benign.
- Production artifact inspection: no .map files, .env files or unintended TypeScript/Rust sources found.
- Upstream `git ls-remote` resolved each existing action's major-version tag before pinning its SHA.
- Live unauthenticated GETs only; no user notes or Google account data accessed.
- `git diff --check`: passed (Git warned about automatic LF/CRLF conversion for the generated license file, whose text has no semantic diff).

Not performed: desktop compilation/signing/update verification, cargo audit, a real Google login/cross-account test, hosted CI execution, account MFA/branch protection/Pages settings review, exhaustive malicious dependency/provenance review, authenticated penetration testing, full backup recovery drill or a full keyboard/screen-reader audit.

Rollback: changes are uncommitted and reviewable with git diff; restore individual changed files from the starting commit if necessary while retaining audit artifacts. Clipboard now rejects oversized/invalid external content; malformed backups fail before writes, and malformed Drive library entries are not merged. Resource caps and stricter validators may reject previously accepted corrupt input. Do not roll back patched tooling solely to bypass an audit failure.

## Separate privacy, legal, accessibility, IP and platform review

| Category | Status | Evidence / next action |
|---|---|---|
| Privacy disclosures | UNKNOWN | Existing linked policy covers local storage, GitHub hosting, Google scopes, CDN OCR, speech, support and deletion. Ontario/noncommercial status and support-address ownership were confirmed by the owner; actual support-message retention and jurisdictional applicability remain unverified. Owner confirmed Ontario/noncommercial status and control of the support address. Privacy/cookies text corrected for synced recordings, uninstall retention and general-purpose age guidance; no fictitious business facts added. |
| Terms / business transparency | UNKNOWN | Existing terms state free app, MIT code, user content ownership and mandatory consumer-right exceptions; legal enforceability and actual publisher details need owner/legal review. |
| Cookies / tracking consent | PASS | Source shows essential theme/onboarding/journal storage, optional GIS and no analytics/ads; existing cookies page inventories storage. No evidence justifies adding a tracking-consent banner for the current feature set. Provider cookies and applicable jurisdictions still need owner review. |
| Refund / paid subscriptions | NOT APPLICABLE | No payments, paid trials or marketing subscription forms in source. |
| Form / optional-feature consent | UNKNOWN | Google, audio and speech are user-initiated with existing disclosure; source inspected but no microphone/speech/real Google consent flow exercised. |
| Data rights / retention / minors | UNKNOWN | Local export/wipe and Drive-trash functions exist; support-email retention, backup retention, audience facts and live deletion behavior unverified. Do not claim global compliance. |
| Local confidentiality | UNKNOWN | Notes and exported backups are intentionally unencrypted, explicitly disclosed. Device/browser profile access can reveal them; confirm intended sensitivity and full-disk/device protections. Refresh tokens use OS keychain with session-only fallback, tested outside native runtime. |
| Accessibility | FAIL | Shared Dialog naming/focus trapping/restoration and contextual-menu keyboard navigation are now fixed and covered by 18 browser assertions. Inserted image alternative text and screen-readable canvas content remain missing. Canvas content and inserted image alt text limitations are already disclosed. No full WCAG audit run; the targeted real-browser regressions are not certification. Repair and verify keyboard/screen-reader workflows before claiming conformance. |
| Marketing / testimonials | PASS | Reviewed source contains no fabricated testimonial or paid-plan/guaranteed-security claim. Accessibility policy appropriately avoids claiming full conformance. |
| Software licenses | UNKNOWN | MIT LICENSE and generated notices present; LICENSE-MIT matching fixed. Legacy tr46@0.0.3 lacks a license text in its package and matching source tag; actual redistribution scope and native/CDN notices require review. See docs/LEGAL-RELEASE-REVIEW.md. |
| Assets / trademarks / copyright | UNKNOWN | Figtree license notices and generated icon script present; third-party trademark disclaimer exists. No trademark clearance, asset provenance guarantee or rights to user-imported media established. |
| Third-party API rules | UNKNOWN | Minimal drive.file plus identity scopes declared; Google Limited Use statement exists. Cloud app publication/verification/branding and native client type unverified. |
| Desktop release | FAIL | OAuth listener missing, Cargo.lock absent; permissive native CSP; keyring platform feature/runtime, file-association opening/scopes, signed installers and updater configuration not built or verified. Do not distribute as a verified desktop release. |
| PWA / static release | UNKNOWN | Production startup, manifest/CSP tests and service-worker source checked. Full offline install/update/rollback across target browsers not exercised. |
| CI / governance | UNKNOWN | Workflow improved locally; hosted runs, protected branches/environments, owner MFA and alerts need verification. No remote changes made. |
| Mobile / extensions / multiplayer | NOT APPLICABLE | No dedicated native mobile app, browser extension or game backend in this repository. |
| Incident response | UNKNOWN | SECURITY.md provides private reporting guidance; actual alert routing, reporting enablement and owner response procedures not independently verified. |

Legal references consulted: [OPC PIPEDA requirements](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/) ties coverage to commercial activities; the existing policy's Ontario/noncommercial wording alone does not prove legal scope. EU/UK/US rules were not asserted universally. [GitHub Pages HTTPS documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https) supports the hosting/TLS review. [Vitest advisory](https://github.com/advisories/GHSA-5xrq-8626-4rwp) and [Tinypool advisory](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) were checked for development-tool exposure context. These are technical/legal research references, not a legal opinion.

## Readiness

**NOT READY for a fully verified web-and-desktop release.** The local web source is substantially improved and passes current tests/build/advisory checks, but the deployed website still runs its previous build. Desktop sign-in is demonstrably incomplete, native builds/dependencies are unverified, resource-budget gaps remain, and live headers/accessibility/account safeguards need work. The score is deliberately reduced by unknowns rather than treating untested controls as passing. No checklist guarantees immunity from attacks or legal claims.

Next actions in order: review/deploy the local web fixes through the normal repository process; verify hosted tests and real Google scopes/account isolation; set consistent import budgets; verify header-capable hosting if required; test backups; repair dialog/menu accessibility; install Rust to complete/disable desktop OAuth and audit/sign desktop builds; confirm owner MFA, protected deployment and incident notifications. Public deployment and legal-policy edits require explicit owner approval under the Security Audit skill; no such actions were performed here.

## All 70 individual checks

The current machine-readable ledger is security-checks.csv. Local fixes are not yet deployed.

| ID | Name | Status | Severity | Evidence | Fix / next action | Verification |
|---|---|---|---|---|---|---|
| 01 | Exposed database credentials | PASS | INFORMATIONAL | No network database credentials found in source, dist or 322 historical Git blobs; local IndexedDB only. | No code change; see evidence or outstanding verification | Pattern scan plus architecture review |
| 02 | Public .env files | PASS | INFORMATIONAL | .gitignore excludes .env variants; live /.env returned 404; build has no environment files. | No code change; see evidence or outstanding verification | Read-only live GET and output inspection |
| 03 | Hardcoded API keys or secrets | PASS | INFORMATIONAL | Credential-pattern scan found zero matches; OAuth client ID is intentionally public. | No code change; see evidence or outstanding verification | Source/build/history pattern scan; not exhaustive |
| 04 | Weak or missing authentication | UNKNOWN | MEDIUM | Optional Google identity uses GIS tokens; no real Google login/logout/recovery exercised. | No code change; see evidence or outstanding verification | Needs controlled Google account testing |
| 05 | Missing server-side authorization | UNKNOWN | MEDIUM | Drive authorization is delegated to Google with drive.file; provider configuration unavailable. | No code change; see evidence or outstanding verification | Needs live scope/access testing |
| 06 | Cross-user data access | UNKNOWN | MEDIUM | Synthetic account-switch tests pass; real cross-account Drive isolation untested. | No code change; see evidence or outstanding verification | tests/sync.test.ts; real-account test outstanding |
| 07 | Open database permissions | NOT APPLICABLE | INFORMATIONAL | No remotely exposed application database; IndexedDB is local to the browser profile. | No code change; see evidence or outstanding verification | Architecture review |
| 08 | Misconfigured Firebase / Supabase / S3 | NOT APPLICABLE | INFORMATIONAL | No Firebase, Supabase or S3 integration; Drive-specific access assessed in 05/06/54. | No code change; see evidence or outstanding verification | Dependency/source review |
| 09 | Unprotected admin routes | NOT APPLICABLE | INFORMATIONAL | No application admin routes or backend. | No code change; see evidence or outstanding verification | Source inventory |
| 10 | Production debug tools exposed | PASS | INFORMATIONAL | Developer OAuth settings are development-only; published app is a static production bundle. | No code change; see evidence or outstanding verification | src/screens/Settings.tsx; build inspection |
| 11 | Build logs leaking secrets | UNKNOWN | LOW | Workflow source does not print credentials; historical GitHub job logs were not retrieved. | No code change; see evidence or outstanding verification | CI log inspection outstanding |
| 12 | Verbose production errors | PASS | INFORMATIONAL | No backend stack traces served; React renders error messages as text; sync diagnostic log excludes notebook contents. | No code change; see evidence or outstanding verification | src/sync/scheduler.ts and React UI review |
| 13 | Secrets in Git history | PASS | INFORMATIONAL | 322 unique historical blobs across available refs scanned without credential-pattern matches. | No code change; see evidence or outstanding verification | 16 commits available; heuristic scan only |
| 14 | Secrets shipped in frontend JavaScript | PASS | INFORMATIONAL | Built bundles contain no scanned private credential patterns; only public OAuth configuration is intended. | No code change; see evidence or outstanding verification | Production output pattern scan |
| 15 | Client-side-only security checks | NOT APPLICABLE | INFORMATIONAL | Offline editing has no protected server entitlements; private Drive requests require Google's bearer authorization. | No code change; see evidence or outstanding verification | Architecture review; provider verification remains UNKNOWN in 05 |
| 16 | Missing input validation | PASS | INFORMATIONAL | Imported notebook validators plus new clipboard, backup library and synced library validators reject malformed structures. | Added shared clipboard and backup/sync library validation | 171-test suite including new hostile-input regressions |
| 17 | SQL injection | NOT APPLICABLE | INFORMATIONAL | No SQL database or SQL execution. | No code change; see evidence or outstanding verification | Source/dependency review |
| 18 | NoSQL injection | NOT APPLICABLE | INFORMATIONAL | No NoSQL query API; local IndexedDB operations use keys. | No code change; see evidence or outstanding verification | src/storage/db.ts |
| 19 | Cross-site scripting (XSS) | PASS | INFORMATIONAL | React text rendering, link scheme allowlist, no dangerous HTML sink for note data; clipboard uses same item validator. | No code change; see evidence or outstanding verification | Source review; format/clipboard malicious-link tests; not a penetration test |
| 20 | Cross-site request forgery (CSRF) | NOT APPLICABLE | INFORMATIONAL | No app cookie-authenticated mutation endpoints; Drive uses explicit Authorization headers. | No code change; see evidence or outstanding verification | src/sync/drive.ts |
| 21 | Insecure file uploads | PASS | INFORMATIONAL | No hosted uploads; notebook/PDF imports validate format and bounds; attachments are stored as blobs, not executable pages. | No code change; see evidence or outstanding verification | src/model/format.ts; PDF insertion regression tests |
| 22 | Path traversal | NOT APPLICABLE | INFORMATIONAL | No production server path resolution; native file operations use user-selected dialog paths and Tauri scopes. | No code change; see evidence or outstanding verification | src/platform/native.ts; desktop runtime not tested |
| 23 | Server-side request forgery (SSRF) | NOT APPLICABLE | INFORMATIONAL | No server fetch feature or backend; browser requests target fixed provider APIs. | No code change; see evidence or outstanding verification | Source inventory |
| 24 | Broken password-reset flows | NOT APPLICABLE | INFORMATIONAL | No app password/reset implementation; Google manages its own accounts. | No code change; see evidence or outstanding verification | Architecture review |
| 25 | Weak session management | PASS | INFORMATIONAL | Short-lived tab token expiry checked; logout clears token; restored values now require bounded type/shape/expiry. | Validate restored session token shape and expiry | src/sync/google.ts; new auth token tests |
| 26 | Weak or incorrectly validated JWTs | NOT APPLICABLE | INFORMATIONAL | Application does not parse JWTs or trust client-decoded claims; Google validates opaque access tokens. | No code change; see evidence or outstanding verification | src/sync/google.ts |
| 27 | Overly permissive CORS | NOT APPLICABLE | INFORMATIONAL | Public static Pages responses use wildcard CORS without private content; no credentialed application API. | No code change; see evidence or outstanding verification | Live response headers; provider CORS outside app control |
| 28 | Missing rate limits | PASS | INFORMATIONAL | Automatic sync has minimum spacing, per-tab coordination, retry backoff and Retry-After handling; no app login server. | No code change; see evidence or outstanding verification | tests/polish.test.ts; src/sync/scheduler.ts |
| 29 | Unprotected staging or test environments | UNKNOWN | LOW | Only the documented Pages deployment and local source were inspected; other test deployments not inventoried. | No code change; see evidence or outstanding verification | Owner/hosting inventory needed |
| 30 | Default credentials left unchanged | PASS | INFORMATIONAL | No real default passwords or shared service tokens found; test credentials are synthetic. | No code change; see evidence or outstanding verification | Source/history pattern review |
| 31 | Webhook signatures not verified | NOT APPLICABLE | INFORMATIONAL | No inbound webhooks. | No code change; see evidence or outstanding verification | Source inventory |
| 32 | Frontend-only payment checks | NOT APPLICABLE | INFORMATIONAL | Free app; no payments or premium entitlements. | No code change; see evidence or outstanding verification | package/source/terms review |
| 33 | IDOR / BOLA | UNKNOWN | MEDIUM | Drive identifiers are validated and Google handles object authorization; no controlled live object access tests. | No code change; see evidence or outstanding verification | src/sync/drive.ts; provider verification outstanding |
| 34 | APIs trusting user-controlled roles or IDs | NOT APPLICABLE | INFORMATIONAL | No application role/owner API accepts client identity claims; Google derives authority from bearer tokens. | No code change; see evidence or outstanding verification | Architecture review |
| 35 | Sensitive data in logs | PASS | INFORMATIONAL | Sync app log records counts/status rather than note titles/content; revoke token now sent in POST body instead of URL. | Use revokeToken POST body in missing-scope branch | src/sync/scheduler.ts; src/sync/google.ts; local source review |
| 36 | Sensitive source maps or build artifacts | PASS | INFORMATIONAL | Production build has no source maps or .env/TypeScript/Rust/config source artifacts. | No code change; see evidence or outstanding verification | dist inspection; public source availability is intentional |
| 37 | Vulnerable or abandoned dependencies | PASS | INFORMATIONAL | npm audit changed from six affected entries to zero after targeted Vite/Vitest/plugin upgrades. | Pin Vite 7.3.8, Vitest 4.1.12, React Vite plugin 5.2.0 | npm audit --json; 171 tests and production build; Rust audit unavailable |
| 38 | Malicious or compromised packages | UNKNOWN | MEDIUM | All 199 lockfile dependency entries have integrity; install scripts inventoried; provenance/malware not exhaustively verified. | No code change; see evidence or outstanding verification | npm ci --ignore-scripts; no third-party code uploaded |
| 39 | Prompt injection | NOT APPLICABLE | INFORMATIONAL | OCR is local text recognition; no LLM instruction-following agent/retrieval tools. | No code change; see evidence or outstanding verification | src/ai/ocr.ts |
| 40 | AI tools bypassing user permissions | NOT APPLICABLE | INFORMATIONAL | No AI tool execution or user-permission delegation to a model. | No code change; see evidence or outstanding verification | Source inventory |
| 41 | Excess database privileges | NOT APPLICABLE | INFORMATIONAL | No server database role; local IndexedDB follows browser-profile permissions. | No code change; see evidence or outstanding verification | src/storage/db.ts |
| 42 | Missing audit logs | NOT APPLICABLE | INFORMATIONAL | No server/admin/security-role operations requiring centralized audit trail; local diagnostics are available. | No code change; see evidence or outstanding verification | src/state/store.ts; source inventory |
| 43 | No security monitoring or alerts | UNKNOWN | LOW | Local diagnostics and new predeploy npm audit gate exist; repository security alerts and incident notifications unverified. | No code change; see evidence or outstanding verification | GitHub owner settings needed |
| 44 | No tested backup / restore plan | PASS | INFORMATIONAL | Full synthetic backup exported and restored into a fresh IndexedDB database, preserving notebooks, page text, attachments, recording/transcript, folders, deck/cards and stickers. | Added tests/backup-restore.test.ts; owner should still practice off-device backups. | Backup recovery regression passed; live Drive restore is not covered. |
| 45 | Public internal dashboards | NOT APPLICABLE | INFORMATIONAL | No app internal dashboard or metrics backend in source. | No code change; see evidence or outstanding verification | Source inventory; account dashboards outside scope |
| 46 | Missing security headers | FAIL | LOW | Live Pages sends HSTS and meta CSP, but lacks nosniff, explicit Referrer-Policy and framing protection; desktop CSP permits unsafe-eval. | Added explicit referrer meta to local app/legal pages; live header/framing control still needs hosting decision and native CSP verification. | Live response observed 2026-11-14; _headers is not applied on Pages |
| 47 | Unsafe cookie settings | NOT APPLICABLE | INFORMATIONAL | App sets no authentication cookies; Google cookies are managed by Google. | No code change; see evidence or outstanding verification | Source review and cookies policy |
| 48 | Sensitive data unprotected in transit / at rest | UNKNOWN | MEDIUM | Live HTTPS works and HTTP redirects; local notes/backups are intentionally unencrypted, disclosed in privacy policy; OS/Drive encryption and suitability unverified. | No code change; see evidence or outstanding verification | Live GET; public/legal/privacy.html; owner threat model needed |
| 49 | Poor tenant isolation | NOT APPLICABLE | INFORMATIONAL | No shared multi-tenant application backend; Google account switching assessed separately in 06. | No code change; see evidence or outstanding verification | Architecture review |
| 50 | Over-trusting AI-generated code | PASS | INFORMATIONAL | Source, trust boundaries and changed diffs reviewed; security regressions, typecheck, build and browser smoke run. | No code change; see evidence or outstanding verification | This audit; no assurance about all historical generation |
| 51 | Mass assignment / over-posting | PASS | INFORMATIONAL | Document fields allowlisted by pickDoc; no client-writable role/credit fields; new library validators check nested fields. | No code change; see evidence or outstanding verification | src/model/format.ts; tests/format.test.ts and auth-import-security.test.ts |
| 52 | Command / OS injection | PASS | INFORMATIONAL | Production source does not execute user input through a shell; native opener parses allowed URL schemes. | No code change; see evidence or outstanding verification | src-tauri/src/lib.rs; source review; native runtime untested |
| 53 | Unsafe deserialization | PASS | INFORMATIONAL | JSON uses prototype-key filtering for files and system clipboard; no executable object deserialization. | No code change; see evidence or outstanding verification | src/model/format.ts; tests/clipboard.test.ts |
| 54 | Misconfigured OAuth / OIDC / social login | FAIL | MEDIUM | Desktop sign-in invokes oauth_listen, but Rust invoke_handler registers no such command; sign-in cannot complete in desktop source. | Implement and test desktop loopback listener or disable unsupported desktop sign-in | src/sync/google.ts vs src-tauri/src/lib.rs; web OAuth remains unverified |
| 55 | No MFA on privileged accounts | UNKNOWN | HIGH | GitHub/Google owner MFA and account recovery protections cannot be established from source or repo metadata. | No code change; see evidence or outstanding verification | Owner settings verification needed |
| 56 | Account enumeration | NOT APPLICABLE | INFORMATIONAL | No app signup/password-reset account directory; Google manages login responses. | No code change; see evidence or outstanding verification | Architecture review |
| 57 | Business-logic abuse | NOT APPLICABLE | INFORMATIONAL | No billing, credits, trials, inventory or premium business states. | No code change; see evidence or outstanding verification | Source inventory |
| 58 | Race conditions | PASS | INFORMATIONAL | IndexedDB atomic revision checks and sync conflict preservation are exercised with synthetic concurrent edits. | No code change; see evidence or outstanding verification | tests/storage.test.ts; tests/sync.test.ts |
| 59 | Webhook replay / duplicate processing | NOT APPLICABLE | INFORMATIONAL | No webhook processing. | No code change; see evidence or outstanding verification | Source inventory |
| 60 | Overpowered CI/CD credentials | PASS | INFORMATIONAL | Local workflow now grants build only contents:read; Pages/OIDC permission only on deploy; checkout does not persist credentials. | Restrict CI permissions per job; pin action SHAs; set timeouts; add npm audit gate | .github/workflows/deploy-pages.yml source review; undeployed |
| 61 | Untrusted build actions or scripts | UNKNOWN | MEDIUM | Actions pinned and local scripts reviewed; third-party lifecycle scripts and hosted runner behavior not fully verified. | No code change; see evidence or outstanding verification | npm installed with --ignore-scripts; full supply-chain review outstanding |
| 62 | Unpinned build dependencies | FAIL | LOW | npm lock and action SHAs pinned locally; desktop Cargo.lock absent and Rust dependencies use broad major ranges. | Generate and audit Cargo.lock with Rust toolchain; npm and action pinning fixed | src-tauri/Cargo.toml; Cargo unavailable to generate/verify lockfile |
| 63 | Security checks fail open | PASS | INFORMATIONAL | Auth/permission failures stop sync; corrupt notebook integrity rejected in strict mode; credential store has no plaintext fallback. | No code change; see evidence or outstanding verification | tests/polish.test.ts; tests/storage.test.ts; tests/format.test.ts |
| 64 | Missing resource limits | FAIL | MEDIUM | New web file paths now check sizes before reading; new raster imports enforce 64 MiB, 40 MP, 16,384 px and batch limits. Embedded/restored image assets can still reach renderer without the new raster preflight; native picker reads files before frontend checks. | Added src/services/importLimits.ts, pre-read checks, metadata validation and image URL cleanup. Remaining render/native resource budgets require further work. | tests/import-limits.test.ts passes; remaining paths identified in src/engine/render.ts and src/platform/native.ts. |
| 65 | AI sensitive-information disclosure | NOT APPLICABLE | INFORMATIONAL | OCR runs on device; no model provider receives note text or recordings for AI retrieval. | No code change; see evidence or outstanding verification | src/ai/ocr.ts; optional browser speech separately disclosed |
| 66 | Unsafe use of AI output | NOT APPLICABLE | INFORMATIONAL | No generated SQL/HTML/commands executed; OCR text is plain text. | No code change; see evidence or outstanding verification | Source review |
| 67 | AI agents have excessive agency | NOT APPLICABLE | INFORMATIONAL | No autonomous AI agent or model-controlled tools/spending/deletion. | No code change; see evidence or outstanding verification | Source inventory |
| 68 | Sensitive browser storage | UNKNOWN | MEDIUM | Notes and recovery journal intentionally persist in IndexedDB/localStorage; token only in tab sessionStorage; device profile protections unverified. | No code change; see evidence or outstanding verification | Privacy policy and src/editor/session.ts; local encryption not claimed |
| 69 | Open redirects | PASS | INFORMATIONAL | App has no configurable redirect endpoint; imported links limited to http/https/mailto and opened with noopener,noreferrer. | No code change; see evidence or outstanding verification | src/model/format.ts; src/platform/native.ts; format tests |
| 70 | Unsecured GraphQL / WebSocket / realtime endpoints | NOT APPLICABLE | INFORMATIONAL | No app GraphQL/WebSocket/realtime backend; Vite development websocket is not production. | No code change; see evidence or outstanding verification | Source/build review |
