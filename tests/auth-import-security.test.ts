import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDB, setDbName } from "../src/storage/db";
import { getToken, initAuth, invalidateToken } from "../src/sync/google";
import { importBackup, pdfToPages } from "../src/services/transfer";
import { encodeJson, validateDeck, validateSticker } from "../src/model/format";

beforeAll(() => setDbName(`security-auth-${Date.now()}`));
afterAll(() => closeDB());
afterEach(() => { invalidateToken(); vi.unstubAllGlobals(); });

describe("restored Google tokens", () => {
  it("accepts a well-formed unexpired tab token", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ value: "synthetic-token", exp: Date.now() + 600_000 }), removeItem: vi.fn() });
    await initAuth();
    expect(await getToken()).toBe("synthetic-token");
  });
  it.each([
    { value: { malicious: true }, exp: Date.now() + 600_000 },
    { value: "token\r\ninjected", exp: Date.now() + 600_000 },
    { value: "token", exp: Date.now() + 86_400_000 },
    { value: "token", exp: 1 },
  ])("discards invalid stored sign-in data: %j", async (stored) => {
    const removeItem = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify(stored), removeItem });
    await initAuth();
    await expect(getToken()).rejects.toThrow("Not signed in");
    expect(removeItem).toHaveBeenCalledWith("notefira-gtoken");
  });
});

describe("PDF insertion", () => {
  it("refuses oversized files before reading their contents", async () => {
    const arrayBuffer = vi.fn();
    await expect(pdfToPages({ size: 1024 ** 3 + 1, arrayBuffer } as unknown as File, "doc")).rejects.toThrow("larger than 1 GB");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it("refuses non-PDF bytes before invoking the PDF engine", async () => {
    await expect(pdfToPages(new File(["not a PDF"], "fake.pdf"), "doc")).rejects.toThrow("not a valid PDF");
  });
});

describe("untrusted backup library records", () => {
  it("rejects study sets without usable cards", () => {
    const deck = { id: "deck", name: "Study", created: 1, updated: 1, cards: [] };
    expect(validateDeck(deck)).toBe(true);
    expect(validateDeck({ ...deck, cards: [{ id: "card" }] })).toBe(false);
    expect(validateDeck({ ...deck, cards: "bad" })).toBe(false);
  });
  it("rejects executable sticker links", () => {
    expect(validateSticker({ id: "sticker", name: "test", created: 1, w: 20, h: 20, items: [{ id: "link", kind: "link", x: 0, y: 0, w: 20, h: 20, url: "javascript:alert(1)" }] })).toBe(false);
  });
  it("rejects malformed library data before restoring any notebooks", async () => {
    await expect(importBackup(await encodeJson({ format: "notefira-backup", docs: [], folders: [], decks: [{ id: "bad" }] }))).rejects.toThrow("invalid library data");
  });
});
