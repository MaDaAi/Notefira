# Legal and privacy release review — November 14, 2026

This records facts and remaining owner decisions. It is not a legal opinion or a promise that claims cannot be brought. Public pages remain the user-facing disclosures. No hosting change, new analytics/payment service, age gate, encryption migration or release was performed.

## Facts confirmed by the owner

- Notefira is currently free and non-commercial, based in Ontario, Canada.
- The owner controls notefirasupport@gmail.com.
- No payment plan has been decided. No payment collection, paid terms or refund policy should be invented now.
- The owner wants a general-purpose notebook without an unnecessary age restriction. The app is not being redesigned or marketed specifically for children as part of this change.
- No analytics is being added. Local notes, optional Google Drive sync, optional CDN OCR downloads and optional browser speech are the relevant data flows.

## Implemented safeguards and factual corrections

- Existing Terms, Privacy, Cookies, Accessibility and third-party licenses remain linked from the welcome screen.
- Privacy now accurately says synced recordings can be copied to Google Drive. It no longer says uninstalling necessarily erases all local data.
- Cookies/data-removal instructions direct users to the actual Delete all function and distinguish local copies from Drive copies. Avoid broad claims that consent rules are identical in all countries.
- Privacy explains general-purpose use and parental review of optional services without collecting birth dates or claiming that a birthday prompt satisfies children's privacy law.
- Existing terms cover user content rights, permission to import/share/record, backups, free pricing, open-source licensing and non-waivable consumer rights. No arbitration, indemnity, refund commitment or fictional company details were inserted.
- Recording UI reminds users to obtain permission to record/share and identifies optional Drive copying. Speech recognition remains unchecked by default with provider-processing disclosure.
- Dialog titles, focus handling, nested confirmation behavior and menu keyboard navigation have real-browser regression coverage. This is not full WCAG certification; canvas/text alternatives and assistive technology coverage remain incomplete.
- Imports have bounded file sizes/batches and raster metadata checks before decoding. New raster imports support PNG/JPEG/GIF/WebP; convert other formats first. Existing stored notebook assets are not deleted or converted.
- License generation now recognizes names such as LICENSE-MIT, retaining notices it previously missed. No license or copyright owner was invented.

## Items requiring review before any major change

| Item | Why it matters | Concrete next decision |
|---|---|---|
| Payments or subscriptions | Adds billing, tax, renewal, cancellation, consumer and payment-provider obligations. | Decide what is being sold before implementing payments; obtain jurisdiction-specific terms/refund review then. |
| A child-directed edition, school integrations, analytics or additional collection | Children's privacy depends on actual audience and data practices, not whether the app is free. Third-party data processing must also be assessed. | Review providers, applicable consent/parental authorization and minimization before enabling these features. |
| Encryption | Changes backup formats, recovery and sync; lost keys can make notes unrecoverable. | Choose recovery/key design before migrating any stored notebooks. |
| Hosting | GitHub Pages cannot apply the project's custom response headers. | Approve a header-capable host/proxy if framing/nosniff response controls are required. No account or DNS changes made. |
| Desktop release | OAuth listener is missing; native lockfile, credential-store behavior, signing/updater and file permissions need native verification. | Complete a Rust-enabled build/test pass before distributing desktop installers. Do not silently disable an advertised feature. |
| Owner identity and legal advice | User-facing project/location/email are confirmed; governing law does not override mandatory rights elsewhere. | Have qualified counsel review terms and actual audience before a commercial launch or materially larger rollout. Do not publish a fabricated address. |

## Operational gaps code cannot settle

1. Set an actual support-email retention/deletion practice; do not claim a fixed duration until it is adopted. Keep private reports out of public GitHub issues. Requests from known children require particular care; do not ask them to send notebook contents.
2. Confirm MFA and recovery methods for GitHub/Google owner accounts, protected deployment/branch settings, security alerts and an incident response contact. No access settings were changed.
3. Keep independent backups. The automated synthetic backup restore checks notebook/page content, attachments, recording/transcript, folders, study cards and stickers in a fresh database; the owner should still practice restoring an exported real backup on another device.
4. Check logo/name rights and assets supplied by others. Open-source licensing and a disclaimer do not establish trademark clearance or ownership of imported media.
5. Legacy package tr46@0.0.3 declares MIT but its npm package and matching historical source tag contain no LICENSE file. Confirm whether it is redistributed in the actual target artifact and obtain the applicable notice if needed; do not fabricate an author notice. Optional native canvas binaries also require a distribution-specific notice review before desktop packaging.
6. Review external OCR engine/language-data notices as well as bundled npm code. The current English data is downloaded on demand; future self-hosting must retain its upstream Apache notices. Do not assume every downloaded asset is covered merely because a JavaScript wrapper is Apache-licensed.

## Official sources consulted

- [Canada OPC — Summary of privacy laws](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/02_05_d_15): PIPEDA coverage depends on commercial activities, not a blanket requirement applying to every hobby project.
- [Canada OPC — Meaningful consent](https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/appropriate-handling-of-personal-information/collecting-personal-information-and-consent/consent/gl_omc_201805/): where consent is required, meaningful consent and parental involvement for those unable to consent matter.
- [FTC — COPPA FAQs](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions): child-directed services and general-audience services with actual knowledge of collection from children require specific analysis; an age gate is not universal immunity.
- [Ontario — Website accessibility](https://www.ontario.ca/page/how-make-websites-accessible): statutory coverage depends on organization type/size. Improvements here are usability safeguards, not a certification of legal compliance.
- [Canada Criminal Code](https://laws.justice.gc.ca/eng/acts/C-46/section-184.html): recording law is fact/jurisdiction-specific; the UI reminder does not purport to determine whether a recording is lawful.
- [Tesseract language-data upstream](https://github.com/naptha/tessdata): identifies the downloaded English data and upstream license context.

Check the rules and business facts again before launch changes. The above legal applicability statements are cautious inferences from official sources, not a clearance to operate in every jurisdiction.
