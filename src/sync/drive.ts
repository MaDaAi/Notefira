// Minimal Google Drive v3 REST client used by the sync engine.
// Everything Notefira stores lives in one visible "Notefira" folder and is
// tagged with appProperties so files can be found without parsing names.

export interface RemoteFile {
  id: string;
  name: string;
  modifiedTime?: string;
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
  ensureRoot(): Promise<string>;
  list(folderId: string): Promise<RemoteFile[]>;
  get(id: string): Promise<RemoteFile | null>;
  download(id: string): Promise<Uint8Array>;
  create(folderId: string, name: string, mime: string, appProperties: Record<string, string>, data: Uint8Array | Blob): Promise<RemoteFile>;
  update(id: string, name: string, mime: string, appProperties: Record<string, string>, data: Uint8Array | Blob): Promise<RemoteFile>;
  trash(id: string): Promise<void>;
  listRevisions(id: string): Promise<RemoteRevision[]>;
  downloadRevision(id: string, revId: string): Promise<Uint8Array>;
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
const FIELDS = "id,name,modifiedTime,size,appProperties";
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
        if (e?.name === "AuthRequired" || e?.constructor?.name === "AuthRequired") throw e;
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
        await backoff(attempt);
        continue;
      }
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

  async ensureRoot(): Promise<string> {
    const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='notefiraRoot' and value='1' }");
    const r = await (await this.req("GET", `${API}/files?q=${q}&fields=files(id,name)&spaces=drive`)).json();
    if (r.files?.length) return r.files[0].id;
    const created = await (
      await this.req("POST", `${API}/files?fields=id`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Notefira", mimeType: "application/vnd.google-apps.folder", appProperties: { notefiraRoot: "1" } }),
      })
    ).json();
    return created.id;
  }

  async list(folderId: string): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let pageToken = "";
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    do {
      const r = await (await this.req("GET", `${API}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${FIELDS})${pageToken ? `&pageToken=${pageToken}` : ""}`)).json();
      out.push(...(r.files ?? []));
      pageToken = r.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async get(id: string): Promise<RemoteFile | null> {
    try {
      const f = await (await this.req("GET", `${API}/files/${id}?fields=${FIELDS},trashed`)).json();
      return f.trashed ? null : f;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async download(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req("GET", `${API}/files/${id}?alt=media`)).arrayBuffer());
  }

  private async upload(method: "POST" | "PATCH", id: string | null, meta: Record<string, unknown>, mime: string, data: Uint8Array | Blob): Promise<RemoteFile> {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
    const base = id ? `${UPLOAD}/files/${id}` : `${UPLOAD}/files`;
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
      await this.req("PATCH", `${API}/files/${id}`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
  }

  async listRevisions(id: string): Promise<RemoteRevision[]> {
    const r = await (await this.req("GET", `${API}/files/${id}/revisions?fields=revisions(id,modifiedTime,size)&pageSize=200`)).json();
    return (r.revisions ?? []).reverse();
  }

  async downloadRevision(id: string, revId: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req("GET", `${API}/files/${id}/revisions/${revId}?alt=media`)).arrayBuffer());
  }
}

function backoff(attempt: number) {
  const ms = Math.min(30_000, 600 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
  return new Promise((r) => setTimeout(r, ms));
}
