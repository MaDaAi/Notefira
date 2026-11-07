import { useState } from "react";
import { AppMark, GoogleG, Icon, Wordmark } from "../ui/icons";
import { app, settingsStore, toast, updateSettings, goLibrary, booted, useStore } from "../state/store";
import { signIn } from "../sync/google";
import { googleSignInAvailable } from "../sync/config";
import { InfoDialog, type InfoTopic } from "./HelpDialog";
import { APP_VERSION } from "../version";

export function Welcome() {
  useStore(settingsStore, (s) => s.googleClientId); // development override can change availability
  // offered when this build has Notefira's Google client (see sync/config.ts); nothing to set up
  const googleConfigured = googleSignInAvailable();
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
            Continue without Google
          </button>
          {googleConfigured && (
            <button className="nf-auth-btn" onClick={() => void google()} disabled={!!busy}>
              {busy === "google" ? <span className="spinner" /> : <GoogleG size={18} />}
              Continue with Google
            </button>
          )}
        </div>
        <p className="nf-auth-hint">{googleConfigured ? "Your notebooks are always saved on this device. With Google, they're also kept in your own Google Drive, on all your devices." : "Your notebooks are saved on this device."}</p>
        {googleConfigured && (
          <p className="nf-auth-consent">
            Notefira has no accounts of its own: Google confirms who you are, and your notebooks go only to your own Google Drive. You can connect Google later in Settings. By continuing with Google you agree to the <a href="./legal/terms.html">Terms</a> and <a href="./legal/privacy.html">Privacy Policy</a>.
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
        <span className="nf-auth-version">v{APP_VERSION}</span>
      </footer>
      {info && <InfoDialog topic={info} onClose={() => setInfo(null)} />}
    </main>
  );
}
