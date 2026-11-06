// Notefira's version, taken from package.json at build time (see vite.config.ts).
// Bump it with `npm version patch --no-git-tag-version` for every update; the build
// copies it into the desktop app's config too (scripts/sync-version.mjs).
declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
