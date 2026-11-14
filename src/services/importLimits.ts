/** Budgets apply before reading files or allocating decoded image pixels. */
export const IMPORT_LIMITS = {
  fileBytes: 1024 * 1024 * 1024,
  imageBytes: 64 * 1024 * 1024,
  imagePixels: 40_000_000,
  imageDimension: 16_384,
  batchFiles: 128,
  batchImageBytes: 256 * 1024 * 1024,
};

export function checkFileSize(file: Pick<Blob, "size">, max = IMPORT_LIMITS.fileBytes): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > max) throw new Error("This file is too large to import safely.");
}

export function checkImageDimensions(w: number, h: number): void {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0 || w > IMPORT_LIMITS.imageDimension || h > IMPORT_LIMITS.imageDimension || w * h > IMPORT_LIMITS.imagePixels) {
    throw new Error("This image is too large to open safely. Resize it to at most 40 megapixels and 16,384 pixels per side.");
  }
}

/** Read raster metadata before invoking the browser decoder. MIME/file names are untrusted. */
export async function inspectImage(file: Blob): Promise<{ w: number; h: number }> {
  checkFileSize(file, IMPORT_LIMITS.imageBytes);
  const b = new Uint8Array(await file.arrayBuffer());
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...b.subarray(start, start + length));
  let w = 0, h = 0;
  if (b.length >= 24 && ascii(0, 8) === "\x89PNG\r\n\x1a\n" && ascii(12, 4) === "IHDR") {
    w = v.getUint32(16); h = v.getUint32(20);
  } else if (b.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
    w = v.getUint16(6, true); h = v.getUint16(8, true);
  } else if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    const u24 = (i: number) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16);
    if (kind === "VP8X") { w = 1 + u24(24); h = 1 + u24(27); }
    if (kind === "VP8 " && ascii(23, 3) === "\x9d\x01\x2a") { w = v.getUint16(26, true) & 0x3fff; h = v.getUint16(28, true) & 0x3fff; }
    if (kind === "VP8L" && b[20] === 0x2f) { w = 1 + (b[21] | ((b[22] & 0x3f) << 8)); h = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0xf) << 10)); }
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (i + 3 < b.length) {
      if (b[i++] !== 0xff) break;
      while (b[i] === 0xff) i++;
      const marker = b[i++];
      if (marker === 0xda || marker === 0xd9 || i + 2 > b.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = v.getUint16(i);
      if (length < 2 || i + length > b.length) break;
      if (sof.has(marker) && length >= 8) { h = v.getUint16(i + 3); w = v.getUint16(i + 5); break; }
      i += length;
    }
  }
  if (!w || !h) throw new Error("Use a valid PNG, JPEG, GIF or WebP image. Convert other image formats before importing.");
  checkImageDimensions(w, h);
  return { w, h };
}

export function checkImageBatch(files: Pick<Blob, "size">[]): void {
  if (!files.length || files.length > IMPORT_LIMITS.batchFiles || files.reduce((n, f) => n + f.size, 0) > IMPORT_LIMITS.batchImageBytes) throw new Error("Import at most 128 images and 256 MB of images at a time.");
  files.forEach((f) => checkFileSize(f, IMPORT_LIMITS.imageBytes));
}
