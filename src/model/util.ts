export function uid(): string {
  const c: Crypto | undefined = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 20);
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).slice(0, 20);
}

/** FNV-1a 32-bit hash — fast integrity checksum for page content (not cryptographic). */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round2(v: number) {
  return Math.round(v * 100) / 100;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return data;
  const cs = new CompressionStream("gzip");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipIfNeeded(data: Uint8Array): Promise<Uint8Array> {
  if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot open compressed files");
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return data;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let t: any;
  const f = (...a: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  f.flush = () => {
    clearTimeout(t);
  };
  return f as T & { flush: () => void };
}

/** Strip characters that are invalid in file names on Windows/macOS/Linux. */
export function safeFileName(name: string): string {
  const n = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120);
  return n || "Untitled";
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
