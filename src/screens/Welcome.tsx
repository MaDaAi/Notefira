import { useState } from "react";
import { AppMark, GoogleG, Icon, Wordmark } from "../ui/icons";
import { app, settingsStore, toast, updateSettings, goLibrary, booted, useStore } from "../state/store";
import { signIn } from "../sync/google";
import { InfoDialog, type InfoTopic } from "./HelpDialog";

/** Same shape check the Google sync module applies before starting OAuth. */
const GOOGLE_CLIENT_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;

export function Welcome() {
  const clientId = useStore(settingsStore, (s) => s.googleClientId);
  // Only offered when a real Google OAuth client is configured (setup lives in Settings → Cloud sync).
  const googleConfigured = GOOGLE_CLIENT_RE.test((clientId ?? "").trim());
  const [busy, setBusy] = useState<"google" | "local" | null>(null);
  const [info, setInfo] = useState<InfoTopic | null>(null);

  const finish = async () => {
    await booted;
    await updateSettings({ onboarded: true });
    goLibrary("home");
  };

  const run = (kind: "google" | "local", fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } catch (error: any) {
      toast(error?.message ?? String(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const google = run("google", async () => {
    await booted;
    await signIn();
    await finish();
  });
  const local = run("local", finish);

  return (
    // The sign-in screen always uses Notefira's dark palette (shared theme tokens).
    <main className="nf-auth" data-theme="dark">
      <button className="nf-auth-help" aria-label="Help and diagnostics" onClick={() => app.set({ helpOpen: true })}>
        <Icon name="help" size={20} />
      </button>

      <section className="nf-auth-panel" aria-labelledby="nfAuthTitle">
        <div className="nf-auth-brand">
          <AppMark size={40} />
          <Wordmark className="nf-auth-wordmark" />
        </div>
        <h1 id="nfAuthTitle" className="nf-auth-title">Welcome to Notefira</h1>
        <p className="nf-auth-lede">Your notes, all in one place.</p>

        <div className="nf-auth-actions">
          <button className="nf-auth-btn primary" onClick={() => void local()} disabled={!!busy} autoFocus>
            {busy === "local" && <span className="spinner" />}
            Continue without an account
          </button>
          {googleConfigured && (
            <button className="nf-auth-btn" onClick={() => void google()} disabled={!!busy}>
              {busy === "google" ? <span className="spinner" /> : <GoogleG size={18} />}
              Sign in with Google
            </button>
          )}
        </div>
        <p className="nf-auth-hint">Your notebooks are saved on this device.</p>
        {googleConfigured && (
          <p className="nf-auth-consent">
            Signing in with Google is optional and connects your own Google Drive. By signing in you agree to the <a href="./legal/terms.html">Terms</a> and <a href="./legal/privacy.html">Privacy Policy</a>.
          </p>
        )}
      </section>

      <footer className="nf-auth-footer">
        <a href="./legal/terms.html">Terms</a>
        <a href="./legal/privacy.html">Privacy</a>
        <a href="./legal/cookies.html">Cookies</a>
        <a href="./legal/accessibility.html">Accessibility</a>
        <button onClick={() => setInfo("licenses")}>Open source</button>
        <button onClick={() => setInfo("support")}>Support</button>
      </footer>
      {info && <InfoDialog topic={info} onClose={() => setInfo(null)} />}
    </main>
  );
}
