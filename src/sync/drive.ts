// Minimal Google Drive v3 REST client used by the sync engine.
// Everything Notefira stores lives in one visible "Notefira Sync" folder and is
// tagged with appProperties so files can be found without parsing names.

export interface RemoteFile {
  id: string;
  name: string;
  modifiedTime?: string;
  createdTime?: string;
  size?: string;
  appProperties?: Record<string, string>;
}

export interface RemoteRevision {
  id: string;
  modifiedTime: string;
  size?: string;
}

/** The operations the sync engine needs — implemented by DriveClient and by an in-memory fake in tests. */
export interface DriveApi {
  /** Every Notefira root folder (tagged appProperties notefiraRoot=1) that is not in the trash. */
  findRoots(): Promise<RemoteFile[]>;
  createFolder(name: string, appProperties: Record<string, string>): Promise<RemoteFile>;
  rename(id: string, name: string): Promise<void>;
  move(id: string, fromFolder: string, toFolder: string): Promise<void>;
  list(folderId: string): Promise<RemoteFile[]>;
  get(id: string): Promise<RemoteFile | null>;
  download(id: string): Promise<Uint8Array>;
  create(folderId: string, name: string, mime: string, appProperties: Record<string, string>, data: Uint8Array | Blob): Promise<RemoteFile>;
  update(id: string, name: string, mime: string, appProperties: Record<string, string>, data: Uint8Array | Blob): Promise<RemoteFile>;
  trash(id: string): Promise<void>;
  listRevisions(id: string): Promise<RemoteRevision[]>;
  downloadRevision(id: string, revId: string): Promise<Uint8Array>;
}

/** Drive ids are URL-safe; anything else is refused before it reaches a query or URL. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "Unexpected Google Drive file id");
  return id;
}

/** How long Google asked us to wait (Retry-After, in seconds or as a date), capped at 2 minutes. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  const ms = isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  return isFinite(ms) && ms > 0 ? Math.min(ms, 120_000) : null;
}

/** Drive refused because the sign-in lacks the Drive permission (the box was unticked, or access was removed). */
export function isPermissionError(status: number, body: string): boolean {
  return status === 403 && /insufficient|scope|appNotAuthorized|ACCESS_TOKEN_SCOPE/i.test(body) && !/rate|quota/i.test(body);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,modifiedTime,createdTime,size,appProperties";
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB

export class DriveClient implements DriveApi {
  constructor(
    private getToken: () => Promise<string>,
    private onUnauthorized: () => void = () => {},
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async req(method: string, url: string, init: RequestInit = {}, retries = 3): Promise<Response> {
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      let res: Response;
      try {
        const tok = await this.getToken();
        res = await this.fetchImpl(url, { ...init, method, headers: { ...(init.headers as any), Authorization: `Bearer ${tok}` } });
      } catch (e: any) {
        if (e?.name === "AuthRequired") throw e; // sign-in needed: retrying cannot help
        if (attempt++ < retries) {
          await backoff(attempt);
          continue;
        }
        throw new HttpError(0, "Network error: " + (e?.message ?? e));
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.onUnauthorized();
        continue;
      }
      if ((res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota/i.test(await res.clone().text()))) && attempt++ < retries) {
        const wait = retryAfterMs(res.headers.get("Retry-After"));
        await (wait ? new Promise((r) => setTimeout(r, wait)) : backoff(attempt));
        continue;
      }
      if (res.status === 403 && isPermissionError(403, await res.clone().text())) throw new HttpError(403, "PERMISSION");
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const j = await res.json();
          msg = j?.error?.message || msg;
        } catch {
          /* ignore */
        }
        throw new HttpError(res.status, `Google Drive: ${msg} (${res.status})`);
      }
      return res;
    }
  }

  async findRoots(): Promise<RemoteFile[]> {
    const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='notefiraRoot' and value='1' }");
    const r = await (await this.req("GET", `${API}/files?q=${q}&fields=files(${FIELDS})&spaces=drive&pageSize=100`)).json();
    return r.files ?? [];
  }

  async createFolder(name: string, appProperties: Record<string, string>): Promise<RemoteFile> {
    // created in My Drive; retried requests can create a second folder, which the engine merges
    return (
      await this.req("POST", `${API}/files?fields=${FIELDS}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", appProperties }),
      })
    ).json();
  }

  async rename(id: string, name: string): Promise<void> {
    await this.req("PATCH", `${API}/files/${safeId(id)}?fields=id`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  }

  async move(id: string, fromFolder: string, toFolder: string): Promise<void> {
    await this.req("PATCH", `${API}/files/${safeId(id)}?addParents=${safeId(toFolder)}&removeParents=${safeId(fromFolder)}&fields=id`, { headers: { "Content-Type": "application/json" }, body: "{}" });
  }

  async list(folderId: string): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let pageToken = "";
    const q = encodeURIComponent(`'${safeId(folderId)}' in parents and trashed=false`);
    do {
      const r = await (await this.req("GET", `${API}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${FIELDS})${pageToken ? `&pageToken=${pageToken}` : ""}`)).json();
      out.push(...(r.files ?? []));
      pageToken = r.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async get(id: string): Promise<RemoteFile | null> {
    try {
      const f = await (await this.req("GET", `${API}/files/${safeId(id)}?fields=${FIELDS},trashed`)).json();
      return f.trashed ? null : f;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async download(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req("GET", `${API}/files/${safeId(id)}?alt=media`)).arrayBuffer());
  }

  private async upload(method: "POST" | "PATCH", id: string | null, meta: Record<string, unknown>, mime: string, data: Uint8Array | Blob): Promise<RemoteFile> {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
    const base = id ? `${UPLOAD}/files/${safeId(id)}` : `${UPLOAD}/files`;
    if (blob.size <= RESUMABLE_THRESHOLD) {
      const boundary = "nf" + Math.random().toString(36).slice(2);
      const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
      return (await this.req(method, `${base}?uploadType=multipart&fields=${FIELDS}`, { headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body })).json();
    }
    // Resumable upload in chunks: survives flaky connections, resumes from the last confirmed byte.
    const init = await this.req(method, `${base}?uploadType=resumable&fields=${FIELDS}`, {
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(blob.size) },
      body: JSON.stringify(meta),
    });
    const session = init.headers.get("Location");
    if (!session) throw new HttpError(0, "Drive did not return an upload session");
    let offset = 0;
    let failures = 0;
    while (offset < blob.size) {
      const end = Math.min(offset + CHUNK, blob.size);
      let res: Response;
      try {
        res = await this.fetchImpl(session, { method: "PUT", headers: { "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}` }, body: blob.slice(offset, end) });
      } catch {
        if (++failures > 6) throw new HttpError(0, "Upload interrupted");
        await backoff(failures);
        // ask the server how much it received, then continue from there
        const st = await this.fetchImpl(session, { method: "PUT", headers: { "Content-Range": `bytes */${blob.size}` } }).catch(() => null);
        const range = st?.headers.get("Range");
        offset = range ? Number(range.split("-")[1]) + 1 : offset;
        continue;
      }
      if (res.status === 308) {
        const range = res.headers.get("Range");
        offset = range ? Number(range.split("-")[1]) + 1 : end;
        failures = 0;
        continue;
      }
      if (res.ok) return res.json();
      if (res.status >= 500 && ++failures <= 6) {
        await backoff(failures);
        continue;
      }
      throw new HttpError(res.status, `Upload failed (${res.status})`);
    }
    throw new HttpError(0, "Upload ended unexpectedly");
  }

  create(folderId: string, name: string, mime: string, appProperties: Record<string, string>, data: Uint8Array | Blob) {
    return this.upload("POST", null, { name, mimeType: mime, parents: [folderId], appProperties }, mime, data);
  }

  update(id: string, name: string, mime: string, appProperties: Record<string, string>, data: Uint8Array | Blob) {
    return this.upload("PATCH", id, { name, appProperties }, mime, data);
  }

  async trash(id: string) {
    try {
      await this.req("PATCH", `${API}/files/${safeId(id)}`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
  }

  async listRevisions(id: string): Promise<RemoteRevision[]> {
    const r = await (await this.req("GET", `${API}/files/${safeId(id)}/revisions?fields=revisions(id,modifiedTime,size)&pageSize=200`)).json();
    return (r.revisions ?? []).reverse();
  }

  async downloadRevision(id: string, revId: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req("GET", `${API}/files/${safeId(id)}/revisions/${safeId(revId)}?alt=media`)).arrayBuffer());
  }
}

function backoff(attempt: number) {
  const ms = Math.min(30_000, 600 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
  return new Promise((r) => setTimeout(r, ms));
}
