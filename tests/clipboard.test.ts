import { describe, expect, it } from "vitest";
import { CLIP_MARK, MAX_CLIP_CHARS, MAX_CLIP_ITEMS, parseClipboardItems } from "../src/editor/clipboardFormat";

const link = { id: "link", kind: "link", x: 0, y: 0, w: 40, h: 20, url: "https://example.org" };
const encode = (items: unknown) => CLIP_MARK + JSON.stringify({ items });

describe("untrusted system clipboard", () => {
  it("accepts valid notebook items", () => {
    expect(parseClipboardItems(encode([link]))).toEqual([link]);
  });
  it("rejects executable links and invalid geometry before insertion", () => {
    expect(parseClipboardItems(encode([{ ...link, url: "javascript:alert(1)" }]))).toBeNull();
    expect(parseClipboardItems(encode([{ ...link, x: "bad" }]))).toBeNull();
    expect(parseClipboardItems(encode([{ id: "bad", kind: "stroke", pts: "bad" }]))).toBeNull();
  });
  it("rejects malformed, empty and oversized input", () => {
    for (const text of ["plain text", CLIP_MARK + "{", encode(null), encode([]), encode({ length: 2 }), encode(Array(MAX_CLIP_ITEMS + 1).fill(link)), CLIP_MARK + " ".repeat(MAX_CLIP_CHARS)]) {
      expect(parseClipboardItems(text)).toBeNull();
    }
  });
  it("drops prototype-mutating properties", () => {
    const text = CLIP_MARK + '{"items":[{"id":"x","kind":"link","x":0,"y":0,"w":1,"h":1,"__proto__":{"polluted":true}}]}';
    expect(parseClipboardItems(text)?.[0]).not.toHaveProperty("polluted");
    expect(Object.prototype.hasOwnProperty.call(parseClipboardItems(text)![0], "__proto__")).toBe(false);
  });
});
