// Google OAuth for Drive sync.
//  - Web / PWA: Google Identity Services token flow (popup). Access tokens are
//    short-lived, kept in memory and in sessionStorage for the tab only.
//  - Desktop (Tauri): authorization-code flow with PKCE through the system
//    browser and a loopback redirect; the refresh token is kept in the OS keychain.
// No client secret is ever part of the web app. The client ID comes from the
// build (VITE_GOOGLE_CLIENT_ID; see ./config.ts); users never enter it.

import { createStore, settingsStore, log } from "../state/store";
import { isTauri, getSecret, setSecret, openExternal } from "../platform/native";
import { kvGet, kvSet } from "../storage/db";
import { CLIENT_ID_RE, googleClientId } from "./config";

export const SCOPES = "https://www.googleapis.com/auth/drive.file openid email profile";

export interface Account {
  email: string;
  name: string;
  picture?: string;
}

export const auth = createStore<{ account: Account | null; needsReconnect: boolean }>({ account: null, needsReconnect: false });

let token: { value: string; exp: number } | null = null;
const SESSION_KEY = "notefira-gtoken";

export class AuthRequired extends Error {
  // an explicit name: class names are shortened in production builds, so checks must not rely on them
  name = "AuthRequired";
  constructor(msg = "Please reconnect your Google account.") {
    super(msg);
  }
}

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_PERMISSION_MESSAGE =
  "Notefira needs permission to use its own files in your Google Drive. Please sign in again and tick the box “See, edit, create, and delete only the specific Google Drive files you use with this app”.";

/** Google's consent screen lets people untick Drive access; without it nothing can sync. */
export function hasDriveScope(granted: string | undefined): boolean {
  // older responses may omit the list; then Drive itself reports a missing permission later
  if (granted === undefined) return true;
  return granted.split(/\s+/).includes(DRIVE_FILE_SCOPE);
}

export async function initAuth() {
  const acc = await kvGet<Account | null>("account", null);
  auth.set({ account: acc });
  try {
    const t = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (t && t.exp > Date.now() + 60_000) token = t;
  } catch {
    /* ignore */
  }
}

function clientId() {
  const id = googleClientId();
  if (!CLIENT_ID_RE.test(id)) throw new Error("Google sign-in isn't available in this version of Notefira.");
  return id;
}

// ---------------------------------------------------------------------------
// Web: Google Identity Services
// ---------------------------------------------------------------------------
let gisPromise: Promise<any> | null = null;
function loadGis(): Promise<any> {
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve((window as any).google);
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => resolve((window as any).google);
      s.onerror = () => {
        gisPromise = null;
        reject(new Error("Could not reach Google sign-in. Check your internet connection."));
      };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

function webToken(prompt: "" | "consent" | "select_account", hint?: string): Promise<{ access_token: string; expires_in: number; scope?: string }> {
  return loadGis().then(
    (google) =>
      new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: clientId(),
          scope: SCOPES,
          prompt,
          ...(hint ? { login_hint: hint } : {}),
          callback: (resp: any) => {
            if (resp.error) reject(new AuthRequired(resp.error_description || resp.error));
            else resolve(resp);
          },
          error_callback: (err: any) => reject(new AuthRequired(err?.message || err?.type || "Sign-in was cancelled.")),
        });
        client.requestAccessToken();
      }),
  );
}

// ---------------------------------------------------------------------------
// Desktop: PKCE + loopback
// ---------------------------------------------------------------------------
function b64url(bytes: Uint8Array) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function desktopSignIn(): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const port = await invoke<number>("oauth_listen");
  const redirect = `http://127.0.0.1:${port}`;
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({ client_id: clientId(), redirect_uri: redirect, response_type: "code", scope: SCOPES, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", state }).toString();
  const code = await new Promise<string>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Sign-in timed out.")), 5 * 60_000);
    const un = await listen<string>("oauth-callback", (ev) => {
      clearTimeout(timer);
      un();
      const q = new URL(ev.payload, redirect).searchParams;
      if (q.get("state") !== state) return reject(new Error("Sign-in response did not match (state mismatch)."));
      const c = q.get("code");
      c ? resolve(c) : reject(new AuthRequired(q.get("error") || "Sign-in was cancelled."));
    });
    await openExternal(url);
  });
  const body = new URLSearchParams({ code, client_id: clientId(), code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" });
  const secret = settingsStore.get().googleClientSecret;
  if (secret) body.set("client_secret", secret);
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = await r.json();
  if (!r.ok) throw new AuthRequired(j.error_description || j.error || "Token exchange failed");
  return j;
}

async function desktopRefresh(): Promise<{ access_token: string; expires_in: number }> {
  const refresh = await getSecret("googleRefresh");
  if (!refresh) throw new AuthRequired();
  const body = new URLSearchParams({ refresh_token: refresh, client_id: clientId(), grant_type: "refresh_token" });
  const secret = settingsStore.get().googleClientSecret;
  if (secret) body.set("client_secret", secret);
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = await r.json();
  if (!r.ok) {
    if (j.error === "invalid_grant") await setSecret("googleRefresh", "");
    throw new AuthRequired(j.error_description || "Please reconnect your Google account.");
  }
  return j;
}

// ---------------------------------------------------------------------------
function storeToken(t: { access_token: string; expires_in: number }) {
  token = { value: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(token));
  } catch {
    /* ignore */
  }
}

async function fetchAccount(): Promise<Account> {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token!.value}` } });
  if (!r.ok) throw new Error("Could not read your Google account.");
  const j = await r.json();
  return { email: j.email, name: j.name || j.email, picture: j.picture };
}

export async function signIn(opts: { reconnect?: boolean } = {}): Promise<Account> {
  if (!navigator.onLine) throw new Error("You're offline. Connect to the internet to sign in.");
  // reconnecting suggests the account already in use, so one click is usually enough
  const hint = opts.reconnect ? auth.get().account?.email : undefined;
  const t = isTauri() ? await desktopSignIn() : await webToken(hint ? "" : "select_account", hint);
  if (!hasDriveScope((t as any).scope)) {
    // signed in without ticking Drive access: don't keep a token that cannot sync
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.access_token)}`, { method: "POST" }).catch(() => {});
    throw new Error(DRIVE_PERMISSION_MESSAGE);
  }
  storeToken(t);
  if ((t as any).refresh_token) await setSecret("googleRefresh", (t as any).refresh_token);
  const acc = await fetchAccount();
  await kvSet("account", acc);
  auth.set({ account: acc, needsReconnect: false });
  log("info", "Signed in to Google Drive");
  const { scheduleSync } = await import("./scheduler");
  scheduleSync(500);
  return acc;
}

/**
 * A valid access token. The desktop app renews it silently with its stored
 * sign-in. The web app never opens a Google window by itself (that would pop up
 * in the middle of writing, or be blocked): it asks the user to reconnect, and
 * everything keeps being saved on the device meanwhile.
 */
export async function getToken(): Promise<string> {
  if (token && token.exp > Date.now()) return token.value;
  if (!auth.get().account) throw new AuthRequired("Not signed in.");
  if (!isTauri()) {
    auth.set({ needsReconnect: true });
    throw new AuthRequired("Your Google sign-in expired. Reconnect to keep syncing; your changes are saved on this device.");
  }
  try {
    const t = await desktopRefresh();
    storeToken(t);
    auth.set({ needsReconnect: false });
    return token!.value;
  } catch (e) {
    auth.set({ needsReconnect: true });
    throw e instanceof AuthRequired ? e : new AuthRequired((e as Error)?.message);
  }
}

export function invalidateToken() {
  token = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Where people remove an app's access to their Google account themselves. */
export const GOOGLE_ACCESS_URL = "https://myaccount.google.com/connections";

/** Ask Google to revoke a token (and with it Notefira's access). True only when Google confirms. */
export async function revokeToken(tok: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetchImpl("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tok }).toString(), signal: ctl.signal });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Stop syncing on this device and ask Google to revoke Notefira's access.
 * `revoked` is true only if Google confirmed it; a web tab only holds a
 * short-lived token, so after it expires there is nothing left to revoke from
 * here and the user is pointed to their Google Account instead.
 */
export async function signOut(): Promise<{ revoked: boolean }> {
  const t = token?.value;
  const refresh = isTauri() ? await getSecret("googleRefresh").catch(() => "") : "";
  invalidateToken();
  const revoked = refresh ? await revokeToken(refresh) : t ? await revokeToken(t) : false;
  await setSecret("googleRefresh", "");
  await kvSet("account", null);
  auth.set({ account: null, needsReconnect: false });
  return { revoked };
}
