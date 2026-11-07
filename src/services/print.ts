import type { ID, Page } from "../model/types";
import { renderPageToCanvasAsync, canvasToBlob } from "../engine/render";

const PRINT_RULES = [
  "@page { margin: 0; }",
  "html, body { margin: 0; padding: 0; background: #fff; }",
  "img { display: block; width: 100%; height: auto; page-break-after: always; break-after: page; }",
  "img:last-child { page-break-after: auto; break-after: auto; }",
];

/** Print pages by rendering them at print resolution into a hidden frame. */
export async function printPages(title: string, pages: Page[], onProgress?: (d: number, t: number) => void): Promise<void> {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const fdoc = frame.contentDocument!;
  fdoc.open();
  fdoc.write(`<!doctype html><html><head><title>${title.replace(/[<>&]/g, "")}</title></head><body></body></html>`);
  fdoc.close();
  // Rules are added through the CSS object model rather than an inline <style> block,
  // which the Content Security Policy (inherited by this frame) does not allow.
  const Sheet = (frame.contentWindow as any)?.CSSStyleSheet as typeof CSSStyleSheet | undefined;
  if (Sheet && "adoptedStyleSheets" in fdoc) {
    const sheet = new Sheet();
    PRINT_RULES.forEach((rule, i) => sheet.insertRule(rule, i));
    fdoc.adoptedStyleSheets = [sheet];
  } else {
    const style = fdoc.createElement("style");
    fdoc.head.appendChild(style);
    PRINT_RULES.forEach((rule, i) => style.sheet?.insertRule(rule, i));
  }
  const urls: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i, pages.length);
    const p = pages[i];
    const c = await renderPageToCanvasAsync(p, Math.min(2400, Math.round(p.w * (200 / 72))), { showLinks: false });
    const url = URL.createObjectURL(await canvasToBlob(c, "image/jpeg", 0.92));
    c.width = c.height = 0;
    urls.push(url);
    const img = fdoc.createElement("img");
    img.src = url;
    img.style.aspectRatio = `${p.w} / ${p.h}`;
    fdoc.body.appendChild(img);
  }
  onProgress?.(pages.length, pages.length);
  await Promise.all([...fdoc.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  setTimeout(() => {
    urls.forEach((u) => URL.revokeObjectURL(u));
    frame.remove();
  }, 60_000);
}

export type { ID };
