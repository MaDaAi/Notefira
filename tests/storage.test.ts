import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDB, getAll, kvGet, kvSet, setDbName } from "../src/storage/db";
import { createDoc, duplicateDoc, getDoc, loadPages, savePages, verifyPage } from "../src/storage/repo";

describe("offline document persistence", () => {
  beforeAll(() => setDbName(`notefira-test-${Date.now()}`));
  afterAll(() => closeDB());

  it("stores settings and an editable notebook in IndexedDB", async () => {
    await kvSet("test-setting", { enabled: true });
    expect(await kvGet("test-setting", { enabled: false })).toEqual({ enabled: true });

    const doc = await createDoc({ title: "Persisted", pages: 2 });
    expect((await getDoc(doc.id))?.title).toBe("Persisted");
    const loaded = await loadPages(doc);
    expect(loaded.pages.size).toBe(2);
    expect([...loaded.pages.values()].every(verifyPage)).toBe(true);
  });

  it("atomically saves pages and duplicates documents with fresh ids", async () => {
    const doc = await createDoc({ title: "Original" });
    const loaded = await loadPages(doc);
    const page = loaded.pages.get(doc.pageIds[0])!;
    const updated = { ...page, recognized: "searchable handwriting", updated: Date.now() };
    const saved = await savePages(doc, [updated]);
    expect(saved.rev).toBe(doc.rev + 1);

    const copy = await duplicateDoc(doc.id);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(doc.id);
    expect(copy!.pageIds[0]).not.toBe(doc.pageIds[0]);
    expect((await loadPages(copy!)).pages.get(copy!.pageIds[0])?.recognized).toBe("searchable handwriting");
    expect((await getAll("docs")).length).toBeGreaterThanOrEqual(2);
  });
});


describe("secret storage", () => {
  beforeAll(() => setDbName(`notefira-secret-test-${Date.now()}`));
  afterAll(() => closeDB());

  it("never writes secrets to the local database and purges old plaintext copies", async () => {
    const { getSecret, setSecret, purgeLegacyPlaintextSecrets, secretStorageMode } = await import("../src/platform/native");
    expect(await secretStorageMode()).toBe("session-only"); // no OS keychain outside the desktop app
    await setSecret("googleRefresh", "refresh-token-123");
    expect(await getSecret("googleRefresh")).toBe("refresh-token-123"); // usable for this session
    expect(await kvGet("secret:googleRefresh", null)).toBeNull(); // but not persisted

    // a value left behind by an older version is removed
    await kvSet("secret:googleClientSecret", "old-plaintext-secret");
    await purgeLegacyPlaintextSecrets();
    expect(await kvGet("secret:googleClientSecret", null)).toBeNull();

    await setSecret("googleRefresh", "");
    expect(await getSecret("googleRefresh")).toBe("");
  });
});
