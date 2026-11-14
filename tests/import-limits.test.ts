import { afterEach, describe, expect, it, vi } from "vitest";
import { checkFileSize, checkImageBatch, checkImageDimensions, IMPORT_LIMITS, inspectImage } from "../src/services/importLimits";
import { imageSize, importFiles, importImagesAsDoc } from "../src/services/transfer";

function png(w: number, h: number): Blob {
  const b = new Uint8Array(24);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  b.set([73, 72, 68, 82], 12);
  const v = new DataView(b.buffer); v.setUint32(16, w); v.setUint32(20, h);
  return new Blob([b], { type: "image/png" });
}
afterEach(() => vi.unstubAllGlobals());

describe("import budgets", () => {
  it("rejects oversized notebook/backup files before reading them", async () => {
    const arrayBuffer = vi.fn();
    const f = { name: "huge.nfbackup", type: "application/octet-stream", size: IMPORT_LIMITS.fileBytes + 1, arrayBuffer } as unknown as File;
    expect((await importFiles([f], null)).messages[0]).toMatch(/too large/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it("rejects oversized compressed images before reading or decoding", async () => {
    const arrayBuffer = vi.fn();
    await expect(inspectImage({ size: IMPORT_LIMITS.imageBytes + 1, arrayBuffer } as unknown as Blob)).rejects.toThrow(/too large/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it("rejects tiny files advertising excessive decoded pixels before browser decoding", async () => {
    const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
    await expect(imageSize(png(10000, 10000))).rejects.toThrow(/40 megapixels/);
    expect(decode).not.toHaveBeenCalled();
  });
  it("reads PNG, GIF, JPEG and WebP dimensions independently of the file extension", async () => {
    expect(await inspectImage(png(640, 480))).toEqual({ w: 640, h: 480 });
    const gif = new Uint8Array([71,73,70,56,57,97, 100,0, 50,0]);
    expect(await inspectImage(new Blob([gif]))).toEqual({ w: 100, h: 50 });
    const jpg = new Uint8Array([255,216,255,192,0,8,8,0,50,0,100,0]);
    expect(await inspectImage(new Blob([jpg]))).toEqual({ w: 100, h: 50 });
    const webp = new Uint8Array(30); webp.set([82,73,70,70]); webp.set([87,69,66,80,86,80,56,88],8); webp[24]=99; webp[27]=49;
    expect(await inspectImage(new Blob([webp]))).toEqual({ w: 100, h: 50 });
  });
  it("rejects malformed or unsupported images without creating a notebook", async () => {
    await expect(importImagesAsDoc([new File(["not an image"], "fake.png")], null)).rejects.toThrow(/valid PNG/);
  });
  it("enforces individual, dimension and batch budgets", () => {
    expect(() => checkFileSize({ size: -1 })).toThrow();
    expect(() => checkImageDimensions(0, 10)).toThrow();
    expect(() => checkImageDimensions(20000, 10)).toThrow();
    expect(() => checkImageBatch(Array(129).fill({ size: 1 }))).toThrow();
    expect(() => checkImageBatch(Array(5).fill({ size: 64 * 1024 * 1024 }))).toThrow();
    expect(() => checkImageDimensions(4000, 3000)).not.toThrow();
  });
});
