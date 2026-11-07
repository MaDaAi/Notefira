import { describe, expect, it } from "vitest";
import manifestText from "../public/manifest.webmanifest?raw";
import indexHtml from "../index.html?raw";

const manifest = JSON.parse(manifestText);

describe("desktop PWA metadata", () => {
  it("keeps every launch URL relative to the deployment sub-path", () => {
    expect(manifest.id).toBe("./");
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.file_handlers[0].action).toBe("./");
    expect(manifest.shortcuts.map((shortcut: any) => shortcut.url)).toEqual(["./?action=new-notebook", "./?action=import-pdf"]);
  });

  it("uses standalone mode without claiming an unsupported window-controls layout", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.display_override).toEqual(["standalone"]);
  });

  it("ships correctly sized Apple and wide screenshot assets", () => {
    expect(indexHtml).toContain('sizes="180x180" href="./icons/apple-touch-icon-180.png"');
    expect(manifest.screenshots[0].form_factor).toBe("wide");
    expect(manifest.screenshots[0]).toMatchObject({ src: "screenshots/notefira-library-wide.png", sizes: "1920x916", type: "image/png" });
  });
});
