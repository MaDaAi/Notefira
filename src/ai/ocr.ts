// Offline-capable OCR with Tesseract.js (Apache-2.0). The OCR engine and the
// English language data are downloaded on first use (≈ 15 MB) and then cached
// by the browser; afterwards OCR works offline.
import type { TextRun } from "../storage/repo";

let workerPromise: Promise<any> | null = null;

async function worker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      return createWorker("eng");
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

export interface OcrResult {
  text: string;
  runs: TextRun[];
  confidence: number;
}

/** OCR an image/canvas. `scale` converts image pixels back to page points for the returned word boxes. */
export async function ocrCanvas(canvas: HTMLCanvasElement, scale = 1, offsetX = 0, offsetY = 0): Promise<OcrResult> {
  const w = await worker();
  const { data } = await w.recognize(canvas);
  const runs: TextRun[] = [];
  for (const word of (data.words ?? []) as any[]) {
    const b = word.bbox;
    if (!b || !word.text?.trim()) continue;
    runs.push({ s: word.text, x: offsetX + b.x0 / scale, y: offsetY + b.y0 / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale });
  }
  return { text: (data.text ?? "").trim(), runs, confidence: data.confidence ?? 0 };
}

export async function terminateOcr() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  await w?.terminate();
}
