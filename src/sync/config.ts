// Which Google OAuth client Notefira uses, and whether "Continue with Google" is offered.
//
// - Production: the client ID comes from the build (GitHub repository variable
//   VITE_GOOGLE_CLIENT_ID). Users never see or enter it. No client secret is
//   ever part of the web app.
// - Public availability: the button is shown to everyone only when the build
//   says so (VITE_GOOGLE_SIGNIN=public), i.e. after the Google app is
//   published. Until then it appears only in browsers switched into test mode
//   by opening the site with ?google-test=on (and Google itself still lets only
//   the listed test users sign in). ?google-test=off switches it back.
// - Development builds (npm run dev) may override the client ID in
//   Settings → Cloud sync → Developer settings; production builds ignore that.

import { settingsStore } from "../state/store";

export const CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const env = ((import.meta as any).env ?? {}) as Record<string, string | boolean | undefined>;

/** True in local development builds only (removed from production bundles). */
export const DEV_BUILD = env.DEV === true;
const BUILD_CLIENT_ID = String(env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
const BUILD_PUBLIC = String(env.VITE_GOOGLE_SIGNIN ?? "") === "public";
const TEST_KEY = "notefira-google-test";

/** Read ?google-test=on|off once at startup and remember it in this browser only. */
export function applyTestSwitch(search = typeof location !== "undefined" ? location.search : "") {
  try {
    const v = new URLSearchParams(search).get("google-test");
    if (v === "on") localStorage.setItem(TEST_KEY, "1");
    if (v === "off") localStorage.removeItem(TEST_KEY);
  } catch {
    /* private mode: nothing to remember */
  }
}

export function testMode(): boolean {
  try {
    return localStorage.getItem(TEST_KEY) === "1";
  } catch {
    return false;
  }
}

/** The client ID to use ("" when this build has none). */
export function googleClientId(): string {
  if (DEV_BUILD) {
    const override = (settingsStore.get().googleClientId ?? "").trim();
    if (override) return override;
  }
  return BUILD_CLIENT_ID;
}

/** Whether "Continue with Google" is offered in this browser. */
export function googleSignInAvailable(): boolean {
  if (!CLIENT_ID_RE.test(googleClientId())) return false;
  return BUILD_PUBLIC || DEV_BUILD || testMode();
}
