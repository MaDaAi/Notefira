import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AskHost, confirmDialog, Dialog, MenuHost, openMenu } from "../../src/ui/common";
import { imageSize } from "../../src/services/transfer";

function Fixture() {
  const [open, setOpen] = useState(false);
  return <><button id="launcher" onClick={() => setOpen(true)}>Open</button><button id="background">Background</button>
    {open && <Dialog title="Accessible dialog" onClose={() => setOpen(false)} footer={<button id="last">Last</button>}><button id="nested" onClick={() => void confirmDialog("Nested confirmation")}>Nested</button></Dialog>}
    <button id="menu-launcher" onClick={(e) => openMenu(e.currentTarget, [{ label: "First", onClick() {} }, { label: "Disabled", disabled: true }, { label: "Second", onClick() {} }])}>Menu</button><MenuHost/><AskHost/></>;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
let assertions = 0;
const check = (condition: unknown, message: string) => { assertions++; if (!condition) throw new Error(message); };
const key = (value: string, shiftKey = false) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }));
const click = async (id: string) => { document.getElementById(id)!.focus(); document.getElementById(id)!.click(); await tick(); };

async function run() {
  flushSync(() => createRoot(document.getElementById("root")!).render(<Fixture/>));
  await click("launcher");
  const dialog = document.querySelector('[role="dialog"]')!;
  check(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent === "Accessible dialog", "dialog needs an accessible title");
  check(dialog.contains(document.activeElement), "focus must enter dialog");
  document.getElementById("last")!.focus(); key("Tab");
  check(document.activeElement === dialog.querySelector("button"), "Tab must wrap forward");
  key("Tab", true); check(document.activeElement?.id === "last", "Shift+Tab must wrap backward");
  document.getElementById("background")!.focus(); check(dialog.contains(document.activeElement), "background focus must stay outside the modal flow");
  await click("nested"); check(document.querySelectorAll('[role="dialog"]').length === 2, "nested dialog opens");
  key("Escape"); await tick(); check(document.querySelectorAll('[role="dialog"]').length === 1, "Escape closes only top dialog");
  check(document.activeElement?.id === "nested", "nested focus restores");
  key("Escape"); await tick(); check(!document.querySelector('[role="dialog"]'), "parent dialog closes");
  check(document.activeElement?.id === "launcher", "launcher focus restores");
  await click("menu-launcher"); check(document.activeElement?.textContent?.includes("First"), "menu receives focus");
  key("ArrowDown"); check(document.activeElement?.textContent?.includes("Second"), "menu arrow skips disabled");
  key("ArrowDown"); check(document.activeElement?.textContent?.includes("First"), "menu arrow wraps");
  key("End"); check(document.activeElement?.textContent?.includes("Second"), "menu End selects last");
  key("Home"); check(document.activeElement?.textContent?.includes("First"), "menu Home selects first");
  key("Escape"); await tick(); check(!document.querySelector('[role="menu"]'), "menu Escape closes");
  check(document.activeElement?.id === "menu-launcher", "menu focus restores");
  const image = await imageSize(await (await fetch("/icons/icon-192.png")).blob());
  check(image.w === 192 && image.h === 192, "valid raster still decodes in the real browser");
  document.getElementById("result")!.textContent = `UI_SECURITY_PASS: ${assertions} browser assertions`;
}
run().catch((e) => { document.getElementById("result")!.textContent = "UI_SECURITY_FAIL: " + e.message; });
