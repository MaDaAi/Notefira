// Notefira document model. Everything here is plain JSON so that the same
// structures are stored in IndexedDB, written to .notefira files and synced to
// Google Drive. Coordinates are in PDF points (1/72 inch) in page space.

export type ID = string;

export type PenKind = "ballpoint" | "pencil" | "fountain" | "brush" | "highlighter";

export interface Stroke {
  id: ID;
  kind: "stroke";
  pen: PenKind;
  color: string;
  width: number;
  /** Per-stroke smoothing level (0..1), stored so reopened/exported ink is identical. */
  stabilization?: number;
  /** Per-stroke opacity, primarily used by highlighters. */
  opacity?: number;
  /** Flat [x, y, pressure, x, y, pressure, ...] in page coordinates. */
  pts: number[];
  /** Wall-clock time (ms since epoch) when the stroke started / ended — used for audio sync. */
  t0: number;
  t1: number;
  /** Geometric shape (recognised or drawn with the shape tool): rendered as an even polyline. */
  shape?: boolean;
  /** Closed shape (polygon / ellipse). */
  closed?: boolean;
  fill?: string;
  /** Line style for pens (omitted = solid). Dashed/dotted strokes are drawn as an even centre line. */
  dash?: StrokeDash;
  /** Set on pieces left by the eraser: that end was cut, so it gets a plain round end instead of the pen's taper. */
  cutStart?: boolean;
  cutEnd?: boolean;
}

export type StrokeDash = "dashed" | "dotted";

export interface TextEl {
  id: ID;
  kind: "text";
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  text: string;
  font: "sans" | "serif" | "mono" | "hand";
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: "left" | "center" | "right";
  bg?: string;
  link?: string;
  t0?: number;
}

export interface ImageEl {
  id: ID;
  kind: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  asset: ID;
  /** Normalised crop rectangle (0..1) of the source image. */
  crop?: { x: number; y: number; w: number; h: number };
  t0?: number;
}

export interface LinkEl {
  id: ID;
  kind: "link";
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  url?: string;
  pageId?: ID;
  label?: string;
}

export type Item = Stroke | TextEl | ImageEl | LinkEl;
export type BoxItem = TextEl | ImageEl | LinkEl;

export type TemplateId =
  | "blank"
  | "ruled"
  | "narrow"
  | "grid"
  | "dotted"
  | "cornell"
  | "music"
  | "todo"
  | "custom";

export type Background =
  | {
      type: "template";
      template: TemplateId;
      paper: string;
      line?: string;
      spacing?: number;
      /** Asset of a custom template image. */
      asset?: ID;
    }
  | { type: "pdf"; asset: ID; page: number; rot: number };

export interface Page {
  id: ID;
  docId: ID;
  w: number;
  h: number;
  bg: Background;
  items: Item[];
  /** Text recognised from handwriting (AI or OCR) — used by search. */
  recognized?: string;
  updated: number;
  /** Integrity checksum of the serialised content. */
  sum?: string;
}

export type Cover =
  | { type: "color"; color: string; pattern: "plain" | "lines" | "dots" | "wave" | "grid" }
  | { type: "image"; asset: ID }
  | { type: "page" };

export interface OutlineEntry {
  id: ID;
  title: string;
  pageId: ID;
  level: number;
}

export interface Doc {
  id: ID;
  title: string;
  folderId: ID | null;
  cover: Cover;
  created: number;
  updated: number;
  opened: number;
  favorite: boolean;
  deletedAt?: number;
  pageIds: ID[];
  bookmarks: ID[];
  outline: OutlineEntry[];
  /** Default background for new pages. */
  defaultBg: Background;
  layout: "vertical" | "horizontal";
  /** Monotonic local revision — bumped on every save. */
  rev: number;
  /** Local revision that was last confirmed in the cloud. */
  syncedRev?: number;
  /** Remote revision token stored in Drive appProperties at the last sync. */
  remoteRev?: string;
  remoteId?: string;
  /** Google account (email, lower-case) that `remoteId` belongs to. A notebook is never synced into a different account by itself. */
  syncAccount?: string;
  /** Set when sync stopped for this notebook and the user has to decide what happens (nothing is deleted or overwritten meanwhile). */
  syncIssue?: SyncIssue;
  /** Kept on this device only: never uploaded to Google Drive (a device setting; not written into .notefira files). */
  localOnly?: boolean;
  /** The user asked to move this device-only notebook's Google Drive copy to the Drive trash (done by sync after checking the local copy). */
  cloudRemoval?: boolean;
  /** Lowest-level conflict marker: set when this doc is a "conflicted copy". */
  conflictOf?: ID;
}

export interface SyncIssue {
  /** missing: the Drive file is gone (deleted on another device or in Drive). other-account: linked to a different Google account.
   *  damaged: the Drive copy failed validation, so it was not applied. */
  kind: "missing" | "other-account" | "damaged";
  at: number;
  /** other-account: that account; damaged: the nfRev of the damaged Drive copy. */
  detail?: string;
  /** The user chose to keep this notebook on this device only. */
  dismissed?: boolean;
}

export interface Folder {
  id: ID;
  name: string;
  parentId: ID | null;
  color: string;
  created: number;
  updated: number;
  deletedAt?: number;
}

export interface Asset {
  id: ID;
  docId: ID | null;
  mime: string;
  size: number;
  blob: Blob;
  created: number;
  remoteId?: string;
  name?: string;
  /** SHA-256 of the bytes (hex): how the attachment is addressed in files and in Google Drive. */
  sha256?: string;
}

export interface TranscriptLine {
  t: number; // ms offset from recording start
  text: string;
}

export interface Recording {
  id: ID;
  docId: ID;
  title: string;
  start: number; // epoch ms
  duration: number; // ms
  asset: ID;
  transcript: TranscriptLine[];
  /** Pauses inside the recording: [epochStart, epochEnd] pairs so ink timing maps to audio time. */
  segments: [number, number][];
}

export interface CardSide {
  text?: string;
  image?: ID; // asset id (PNG snapshot from a lasso selection)
}

export interface Card {
  id: ID;
  front: CardSide;
  back: CardSide;
  docId?: ID;
  pageId?: ID;
  ease: number;
  interval: number; // days
  reps: number;
  lapses: number;
  due: number; // epoch ms
  created: number;
  updated: number;
}

export interface Deck {
  id: ID;
  name: string;
  docId?: ID;
  cards: Card[];
  created: number;
  updated: number;
  deletedAt?: number;
}

export interface Sticker {
  id: ID;
  name: string;
  items: Item[];
  w: number;
  h: number;
  created: number;
  /** PNG preview */
  preview?: string;
}

export interface PenPreset {
  id: ID;
  tool: "pen" | "highlighter";
  pen: PenKind;
  color: string;
  width: number;
}

export type ToolId =
  | "pen"
  | "eraser"
  | "highlighter"
  | "shapes"
  | "lasso"
  | "elements"
  | "image"
  | "text"
  | "laser"
  | "zoombox"
  | "ruler"
  | "hand";

export interface Settings {
  theme: "light" | "dark" | "system";
  /** True once the user has picked a theme themselves (distinguishes a real choice from a stored default). */
  themeExplicit?: boolean;
  fingerDrawing: boolean;
  /** Legacy on/off switch (before 0.1.13); read only to migrate to palmMode. */
  palmRejection: boolean;
  /** Palm rejection mode (see editor/palm.ts). */
  palmMode: "auto" | "stylus" | "balanced" | "strict" | "off";
  writingHand: "auto" | "right" | "left";
  writingPosture: "upright" | "below" | "beside" | "angled";
  palmSensitivity: "low" | "medium" | "high";
  /** A stylus has been used on this device (Automatic mode then keeps fingers for navigation). */
  stylusSeen: boolean;
  pressure: boolean;
  shapeHold: boolean;
  /** Scribble back and forth over ink with a pen to erase it. */
  scribbleErase?: boolean;
  toolbar: ToolId[];
  presets: PenPreset[];
  penColors: string[];
  highlighterColors: string[];
  penWidths: number[];
  highlighterWidths: number[];
  googleClientId: string;
  googleClientSecret: string; // only for desktop "installed app" clients; never bundled
  autoSync: boolean;
  libraryView: "grid" | "list";
  librarySort: "updated" | "created" | "title";
  defaultTemplate: TemplateId;
  defaultPaper: "a4" | "letter" | "a5" | "widescreen" | "square";
  defaultOrientation: "portrait" | "landscape";
  onboarded: boolean;
}

export const DEFAULT_TOOLBAR: ToolId[] = [
  "pen",
  "eraser",
  "highlighter",
  "shapes",
  "lasso",
  "elements",
  "image",
  "text",
  "laser",
  "zoombox",
  "ruler",
];
