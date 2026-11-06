// Original line icon set for Notefira (24×24, stroke = currentColor).
import type { CSSProperties } from "react";

const P: Record<string, string> = {
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7 M12 17.2h.01",
  home: "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z",
  folder: "M3.5 7a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  star: "m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z",
  trash: "M4.5 7h15 M9.5 7V4.8h5V7 M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7 M10 11v6 M14 11v6",
  cards: "M7 6.5V5a1.5 1.5 0 0 1 1.5-1.5h10A1.5 1.5 0 0 1 20 5v10a1.5 1.5 0 0 1-1.5 1.5H17 M4 8.5A1.5 1.5 0 0 1 5.5 7h10A1.5 1.5 0 0 1 17 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5z",
  search: "M10.8 18a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4Z M16 16l4.5 4.5",
  // 8-tooth gear (generated geometrically) with a centre hole
  settings: "M10.08 4.85 L10.5 2.52 A9.6 9.6 0 0 1 13.5 2.52 L13.92 4.85 A7.4 7.4 0 0 1 15.7 5.59 L17.64 4.23 A9.6 9.6 0 0 1 19.77 6.36 L18.41 8.3 A7.4 7.4 0 0 1 19.15 10.08 L21.48 10.5 A9.6 9.6 0 0 1 21.48 13.5 L19.15 13.92 A7.4 7.4 0 0 1 18.41 15.7 L19.77 17.64 A9.6 9.6 0 0 1 17.64 19.77 L15.7 18.41 A7.4 7.4 0 0 1 13.92 19.15 L13.5 21.48 A9.6 9.6 0 0 1 10.5 21.48 L10.08 19.15 A7.4 7.4 0 0 1 8.3 18.41 L6.36 19.77 A9.6 9.6 0 0 1 4.23 17.64 L5.59 15.7 A7.4 7.4 0 0 1 4.85 13.92 L2.52 13.5 A9.6 9.6 0 0 1 2.52 10.5 L4.85 10.08 A7.4 7.4 0 0 1 5.59 8.3 L4.23 6.36 A9.6 9.6 0 0 1 6.36 4.23 L8.3 5.59 A7.4 7.4 0 0 1 10.08 4.85 Z M15.2 12a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0Z",
  cloud: "M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.5 9.5 4.5 4.5 0 0 0 7 18.5Z",
  cloudOff: "M7 18.5h10.5 M20.5 15.5a4 4 0 0 0-2.4-4.95A6 6 0 0 0 9 6 M6.5 9.5A4.5 4.5 0 0 0 7 18.5 M3 3l18 18",
  cloudSync: "M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.5 9.5 4.5 4.5 0 0 0 7 18.5Z M10 13.5l2-2 2 2 M12 11.5V16",
  grid: "M4.5 4.5h6v6h-6z M13.5 4.5h6v6h-6z M4.5 13.5h6v6h-6z M13.5 13.5h6v6h-6z",
  list: "M9.5 6.5h10 M9.5 12h10 M9.5 17.5h10 M4.5 5.5h2v2h-2z M4.5 11h2v2h-2z M4.5 16.5h2v2h-2z",
  plus: "M12 5v14 M5 12h14",
  more: "M6 12h.01 M12 12h.01 M18 12h.01",
  moreV: "M12 6h.01 M12 12h.01 M12 18h.01",
  chevronDown: "m6.5 9.5 5.5 5.5 5.5-5.5",
  chevronRight: "m9.5 6.5 5.5 5.5-5.5 5.5",
  chevronLeft: "m14.5 6.5-5.5 5.5 5.5 5.5",
  back: "M15 5.5 8.5 12l6.5 6.5",
  close: "M6.5 6.5l11 11 M17.5 6.5l-11 11",
  check: "m5.5 12.5 4 4 9-9",
  pen: "M15.2 4.8a2.2 2.2 0 0 1 3.1 0l.9.9a2.2 2.2 0 0 1 0 3.1L9 19l-4.5 1 1-4.5z M13.5 6.5l4 4",
  eraser: "M8.5 19.5h11 M4.9 14.6l8.8-8.8a2 2 0 0 1 2.8 0l2.7 2.7a2 2 0 0 1 0 2.8L12 18.5H8.8z M9.5 10l5.5 5.5",
  highlighter: "M9 15.5l-3 3.5h5l1.5-1.5 M9 15.5l7.7-10a1.8 1.8 0 0 1 2.6-.3l.5.4a1.8 1.8 0 0 1 .2 2.6L12.5 17 M9 15.5l3.5 1.5",
  pencil: "M4 20l1.2-4.8L16.4 4a2.1 2.1 0 0 1 3 0l.6.6a2.1 2.1 0 0 1 0 3L8.8 18.8z M14.8 5.6l3.6 3.6 M5.2 15.2l3.6 3.6",
  tape: "M6 4.5h12v4H6z M7.5 8.5h9v11h-9z M10 12h4 M10 15h4",
  shapes: "M10 10.5a4.5 4.5 0 1 1 0-.01 M13.5 13.5h7v7h-7z M8.5 13.5 4 21h9z",
  lasso: "M6.6 15.8C4.4 14.7 3 13 3 11c0-3.9 4-7 9-7s9 3.1 9 7-4 7-9 7c-1 0-2-.1-2.9-.4 M6.6 15.8a2 2 0 1 0 3.5 1.8 2 2 0 0 0-3.5-1.8Z M8 19.5c-.5 1-.4 1.7 0 2",
  elements: "M12 3.5 14.6 9l5.9.6-4.4 3.9 1.3 5.8L12 16.3 6.6 19.3l1.3-5.8L3.5 9.6 9.4 9z",
  image: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z M20 15.5l-4.5-4.5L6 20",
  text: "M5 6.5V5h14v1.5 M12 5v14 M9 19h6",
  laser: "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1",
  zoombox: "M3.5 14.5h17v6h-17z M7 4h10v6H7z M12 10v4.5",
  ruler: "M3.3 15.8 15.8 3.3l4.9 4.9L8.2 20.7z M7 12.1l1.7 1.7 M9.8 9.3l2.6 2.6 M12.6 6.5l1.7 1.7",
  hand: "M8 12V6.5a1.5 1.5 0 0 1 3 0V11 M11 10V4.5a1.5 1.5 0 0 1 3 0V11 M14 10.5V6a1.5 1.5 0 0 1 3 0v7 M8 12.5V10a1.5 1.5 0 0 0-3 0v4c0 4 2.7 7 6.5 7h.5c3.5 0 5-2.5 5-6",
  undo: "M9 14 4.5 9.5 9 5 M4.5 9.5h10a5 5 0 0 1 0 10H11",
  redo: "M15 14l4.5-4.5L15 5 M19.5 9.5h-10a5 5 0 0 0 0 10H13",
  bookmark: "M6.5 4.5h11v16l-5.5-4-5.5 4z",
  bookmarkOn: "M6.5 4.5h11v16l-5.5-4-5.5 4z",
  share: "M12 15V4 M8 7.5 12 3.5l4 4 M5.5 12v6.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V12",
  download: "M12 4v11 M7.5 11 12 15.5 16.5 11 M5 19.5h14",
  upload: "M12 15.5V4.5 M7.5 9 12 4.5 16.5 9 M5 19.5h14",
  sidebar: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z M9.5 4v16",
  pages: "M8 4.5h8.5a1.5 1.5 0 0 1 1.5 1.5v10 M5.5 7.5h9A1.5 1.5 0 0 1 16 9v10a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 19V9a1.5 1.5 0 0 1 1.5-1.5Z",
  pageAdd: "M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z M14 3.5V8h4.5 M12 11v6 M9 14h6",
  mic: "M12 14.5a3 3 0 0 0 3-3v-5a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z M6.5 11a5.5 5.5 0 0 0 11 0 M12 16.5v4",
  play: "M7.5 5.2v13.6a.6.6 0 0 0 .9.5l11-6.8a.6.6 0 0 0 0-1L8.4 4.7a.6.6 0 0 0-.9.5Z",
  pause: "M8 5.5v13 M16 5.5v13",
  stop: "M6.5 6.5h11v11h-11z",
  sparkle: "M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  copy: "M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5z M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H9",
  cut: "M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M8.5 7.5 20 17 M8.5 16.5 20 7",
  paste: "M9 4.5h6v3H9z M15 5.5h2.5A1.5 1.5 0 0 1 19 7v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V7a1.5 1.5 0 0 1 1.5-1.5H9",
  duplicate: "M8 8h11v11H8z M16 8V5H5v11h3 M13.5 11v5 M11 13.5h5",
  rotate: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4.5v4h-4",
  crop: "M6.5 3v14.5H21 M3 6.5h14.5V21",
  present: "M3.5 4.5h17v11h-17z M12 15.5V20 M8 20h8 M9.5 8l5 2.5-5 2.5z",
  split: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z M12 4v16",
  key: "M14.5 13a4.5 4.5 0 1 0-4.3-3.2L3.5 16.5V20h3.5v-2h2v-2h2l1.4-1.4A4.5 4.5 0 0 0 14.5 13Z M15.5 8.5h.01",
  mail: "M3.5 6h17v12h-17z M3.5 6.5l8.5 6.5 8.5-6.5",
  box: "M4 7.5 12 3.5l8 4v9l-8 4-8-4z M4 7.5l8 4 8-4 M12 11.5v9",
  book: "M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5z M5 19.5A1.5 1.5 0 0 0 6.5 21H19",
  outline: "M5 6h14 M8 10h11 M8 14h11 M5 18h14",
  palette: "M12 20.5a8.5 8.5 0 1 1 8.5-8.5c0 2.2-1.8 3-3.5 3h-1.8a1.7 1.7 0 0 0-1.2 2.9c.7.8.2 2.6-2 2.6Z M7.5 12h.01 M9.5 8h.01 M14.5 8h.01",
  lock: "M6.5 10.5h11v9.5h-11z M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5",
  print: "M7 9V4h10v5 M6 17.5H4.5V10a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v7.5H18 M7 14h10v6H7z",
  fullscreen: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
  zoomIn: "M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z M15.5 15.5 20 20 M10.5 7.5v6 M7.5 10.5h6",
  zoomOut: "M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z M15.5 15.5 20 20 M7.5 10.5h6",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 11v5.5 M12 7.6h.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7v5l3 2",
  move: "M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3",
  history: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9 M4.5 4.5V9H9 M12 8v4l3 2",
  file: "M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z M14 3.5V8h4.5",
  pdf: "M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z M14 3.5V8h4.5 M8.5 16.5v-4h1.5a1.2 1.2 0 0 1 0 2.4H8.5",
  wand: "M4 20 15 9 M13.5 6.5l1-1 M18.5 11.5l1-1 M17 4l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5z",
  sigma: "M17.5 6V4.5h-11l6 7.5-6 7.5h11V18",
  arrowRight: "M5 12h14 M13.5 6.5 19 12l-5.5 5.5",
  enter: "M19 5.5v6a3 3 0 0 1-3 3H5.5 M9 10.5l-4 4 4 4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4.5 20.5a7.5 7.5 0 0 1 15 0",
  tag: "M3.5 12.5V4.5h8l9 9-8 8z M8 9h.01",
  quick: "M13 3.5 5.5 13H12l-1 7.5L18.5 11H12z",
  restore: "M4 12a8 8 0 1 0 2.4-5.7L4 8.5 M4 4v4.5h4.5",
  // simple geometric glyphs for the Shapes bar
  shapeLine: "M5 19 19 5",
  shapeArrow: "M5 19 19 5 M11.5 5H19v7.5",
  shapeRect: "M4.5 6.5h15v11h-15z",
  shapeEllipse: "M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z",
  shapeTriangle: "M12 5 20 19H4z",
};

const FILLED = new Set(["bookmarkOn", "play", "star-filled"]);

export function Icon({ name, size = 20, style, className, filled }: { name: keyof typeof P | string; size?: number; style?: CSSProperties; className?: string; filled?: boolean }) {
  const d = P[name] ?? P.info;
  const fill = filled || FILLED.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={style} className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Multi-colour "G" used on the Google sign-in button (drawn from arcs, per Google's sign-in button guidelines). */
export function GoogleG({ size = 24 }: { size?: number }) {
  return (
    <svg width={size + 1} height={size} viewBox="0 0 25 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12.5v4.3h6.18a5.3 5.3 0 0 1-2.3 3.47v2.88h3.72c2.17-2 3.4-4.95 3.4-8.38Z" />
      <path fill="#34A853" d="M12.5 23.5c3.1 0 5.7-1.03 7.6-2.79l-3.72-2.88c-1.03.69-2.35 1.1-3.88 1.1-2.98 0-5.51-2.02-6.41-4.73H2.25v2.97A11.5 11.5 0 0 0 12.5 23.5Z" />
      <path fill="#FBBC05" d="M6.09 14.2a6.9 6.9 0 0 1 0-4.4V6.83H2.25a11.5 11.5 0 0 0 0 10.34l3.84-2.97Z" />
      <path fill="#EA4335" d="M12.5 5.07c1.68 0 3.19.58 4.38 1.71l3.3-3.3A11.06 11.06 0 0 0 12.5.5 11.5 11.5 0 0 0 2.25 6.83l3.84 2.97c.9-2.71 3.43-4.73 6.41-4.73Z" />
    </svg>
  );
}

/** Notefira tile mark (four rounded tiles in the brand palette). */
export function TilesMark({ size = 21 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="0" y="0" width="10" height="10" rx="2" fill="#45bfdb" />
      <rect x="11" y="0" width="10" height="10" rx="2" fill="#f2a541" />
      <rect x="0" y="11" width="10" height="10" rx="2" fill="#7d6ff0" />
      <rect x="11" y="11" width="10" height="10" rx="2" fill="#ef6f6c" />
    </svg>
  );
}

/** Notefira app mark: a rounded square with a stylised nib. */
export function AppMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="nfg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5fd0e8" />
          <stop offset="1" stopColor="#2a9fc0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#nfg)" />
      <path d="M20 46V18h4l16 20V18h4v28h-4L24 26v20z" fill="#fff" />
      <path d="M44 46c4-1 6-4 6-8" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** "Notefira" wordmark rendered as SVG text sized to a 310×48 box. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 310 48" role="img" aria-label="Notefira">
      <text x="-2" y="44" fill="currentColor" fontFamily="Figtree, 'Segoe UI', sans-serif" fontSize="62" fontWeight="500" letterSpacing="-1.5" textLength="312" lengthAdjust="spacingAndGlyphs">
        Notefira
      </text>
    </svg>
  );
}
