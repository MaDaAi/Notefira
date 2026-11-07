import { Dialog } from "../ui/common";
import { diagnostics, settingsStore } from "../state/store";
import { saveFile, platformName, openExternal, isTauri } from "../platform/native";
import { APP_VERSION } from "../version";
import { DISCUSSIONS_URL, ISSUES_URL, PRIVATE_EMAIL, REPO_URL, SECURITY_URL } from "../project";
import { storageEstimate } from "../storage/repo";
import { formatBytes } from "../model/util";
import { googleSignInAvailable } from "../sync/config";

export const SHORTCUTS: [string, string][] = [
  ["P", "Pen"],
  ["H", "Highlighter"],
  ["E", "Eraser"],
  ["L", "Lasso"],
  ["S", "Shapes"],
  ["T", "Text"],
  ["I", "Insert image"],
  ["K", "Laser pointer"],
  ["R", "Ruler"],
  ["Z", "Zoom window"],
  ["V", "Read-only (scroll & follow links)"],
  ["Ctrl/⌘ Z  ·  Ctrl/⌘ Shift Z / Y", "Undo · Redo"],
  ["Ctrl/⌘ C · X · V · D", "Copy · Cut · Paste · Duplicate selection"],
  ["Delete / Backspace", "Delete selection"],
  ["Ctrl/⌘ F", "Search in document"],
  ["Ctrl/⌘ K", "Search all notebooks"],
  ["Ctrl/⌘ N", "New notebook (library) / new page (editor)"],
  ["Ctrl/⌘ + / − / 0", "Zoom in / out / fit width"],
  ["PageUp / PageDown, ← →", "Previous / next page"],
  ["Ctrl/⌘ B", "Bookmark page"],
  ["Ctrl/⌘ W", "Close tab"],
  ["Ctrl/⌘ Tab", "Next tab"],
  ["Ctrl/⌘ P", "Print"],
  ["F5", "Presentation mode"],
  ["F11", "Full screen"],
  ["Space + drag / middle mouse", "Pan"],
  ["Ctrl/⌘ + scroll, pinch", "Zoom"],
  ["?", "This help"],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const exportLogs = async () => {
    const est = await storageEstimate().catch(() => ({ usage: 0, quota: 0, persisted: false }));
    const s = settingsStore.get();
    const text = [
      `Notefira diagnostics`,
      `Version: ${APP_VERSION}`,
      `Platform: ${platformName()} — ${navigator.userAgent}`,
      `Online: ${navigator.onLine}`,
      `Storage: ${formatBytes(est.usage)} of ${formatBytes(est.quota)} (persistent: ${est.persisted})`,
      `Google sign-in available: ${googleSignInAvailable()}`,
      ``,
      `Log (no notebook content, no keys):`,
      diagnostics() || "(empty)",
    ].join("\n");
    await saveFile(`notefira-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`, new Blob([text], { type: "text/plain" }), "text/plain");
  };
  return (
    <Dialog title="Help & keyboard shortcuts" onClose={onClose} wide footer={<><button className="btn" onClick={exportLogs}>Export diagnostic log</button><button className="btn primary" onClick={onClose}>Done</button></>}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "6px 24px" }} className="small">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--c-line)", padding: "6px 0" }}>
            <span>{v}</span>
            <span className="kbd-key">{k}</span>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Stylus tips: with “palm rejection” on, once a stylus is detected your fingers scroll and zoom while the stylus writes. Hold the pen still at the end of a stroke to turn it into a clean shape. Two fingers pinch to zoom.
      </p>
    </Dialog>
  );
}

export type InfoTopic = "terms" | "privacy" | "licenses" | "support";

const INFO: Record<InfoTopic, { title: string; body: string[]; page?: string; links?: { label: string; href: string }[] }> = {
  terms: {
    title: "Terms of Service",
    body: [
      "Notefira is free and provided as is, without warranty. You keep ownership of everything you write, import or record.",
      "Optional services you connect, such as Google Drive, are governed by those providers' own terms.",
    ],
    page: "terms.html",
  },
  privacy: {
    title: "Privacy Policy",
    body: [
      "Your notebooks are stored in this browser or app on this device. The Notefira project runs no server and does not receive your notebooks.",
      "Optional features contact other services only when you use them: Google Drive sync (your own Drive, limited drive.file permission), handwriting/OCR search (downloads its engine from a public CDN the first time) and live transcription (your browser's speech service may process the audio).",
      "No analytics, tracking cookies or advertising.",
    ],
    page: "privacy.html",
  },
  licenses: {
    title: "Open-source components",
    body: [
      "Notefira is built with open-source software including React (MIT), pdf.js by Mozilla (Apache-2.0), pdf-lib (MIT), perfect-freehand (MIT), Tesseract.js (Apache-2.0), the Figtree typeface (SIL Open Font License 1.1) and Tauri (MIT/Apache-2.0). The full license texts are included with the app.",
      "Google and the Google “G” logo are trademarks of Google LLC. Notefira is not affiliated with or endorsed by Google.",
    ],
    page: "third-party-licenses.txt",
    links: [{ label: "Notefira's source code (MIT License)", href: REPO_URL }],
  },
  support: {
    title: "Get help",
    body: [
      "Notefira's support happens on GitHub. Ask questions in Discussions, and report bugs or request features in Issues. Posts there are public, so please don't include private notes or personal information.",
      "Use “Help → Export diagnostic log” to save a log file you can attach to a bug report. It lists app events, error messages, your browser version and storage use, and is designed to leave out notebook content — please read it before sending.",
      "Browser storage can be cleared by your browser or device, so keep your own copies: use Settings → Backup & storage to save a complete backup file regularly.",
    ],
    links: [
      { label: "Ask a question (Discussions)", href: DISCUSSIONS_URL },
      { label: "Report a bug or request a feature (Issues)", href: ISSUES_URL },
      { label: "Report a security problem privately", href: SECURITY_URL },
      { label: `Privacy or legal questions: ${PRIVATE_EMAIL}`, href: `mailto:${PRIVATE_EMAIL}` },
    ],
  },
};

/** A web or e-mail link that opens outside Notefira (in the system browser on desktop). */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!isTauri()) return;
        e.preventDefault();
        openExternal(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

export function InfoDialog({ topic, onClose }: { topic: InfoTopic; onClose: () => void }) {
  const t = INFO[topic];
  return (
    <Dialog title={t.title} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      {t.body.map((p, i) => (
        <p key={i} style={{ margin: 0 }}>
          {p}
        </p>
      ))}
      {t.links && (
        <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
          {t.links.map((l) => (
            <li key={l.href}>
              <ExternalLink href={l.href}>{l.label}</ExternalLink>
            </li>
          ))}
        </ul>
      )}
      {t.page && (
        <p style={{ margin: 0 }}>
          <a href={`./legal/${t.page}`} target="_blank" rel="noopener noreferrer">
            {topic === "licenses" ? "Read the full license texts" : `Read the full ${t.title}`}
          </a>
        </p>
      )}
    </Dialog>
  );
}
