import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ViewportController } from "./viewport";
import type { DocSession } from "./session";
import type { ID, TextEl } from "../model/types";
import { FONT_FAMILIES, textHeight } from "../engine/render";
import { ColorGrid, Popover, promptDialog } from "../ui/common";
import { Icon } from "../ui/icons";

export function TextEditor({ vp, session, edit, onDone, tick }: { vp: ViewportController; session: DocSession; edit: { pageId: ID; id: ID }; onDone: () => void; tick: number }) {
  const page = session.page(edit.pageId);
  const el = page?.items.find((i) => i.id === edit.id) as TextEl | undefined;
  const [text, setText] = useState(el?.text ?? "");
  const [pop, setPop] = useState<{ a: DOMRect; k: "color" | "bg" } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    vp.setEditing(edit);
    setTimeout(() => ta.current?.focus(), 20);
    return () => vp.setEditing(null);
  }, [edit.id]);

  useLayoutEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
  }, [text, tick, el?.size, el?.w]);

  if (!el || !page) return null;
  const z = vp.zoom;
  const pos = vp.pageToScreen(edit.pageId, el.x, el.y);

  const patch = (p: Partial<TextEl>, label = "Format text") => {
    const cur = session.page(edit.pageId)?.items.find((i) => i.id === edit.id) as TextEl | undefined;
    if (!cur) return;
    const next = { ...cur, ...p, text };
    next.h = textHeight(next);
    session.replaceItems(edit.pageId, new Map([[cur.id, [next]]]), label);
  };

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const cur = session.page(edit.pageId)?.items.find((i) => i.id === edit.id) as TextEl | undefined;
    if (cur) {
      if (!text.trim()) session.removeItems(edit.pageId, new Set([cur.id]), "Delete text");
      else if (text !== cur.text) {
        const next = { ...cur, text };
        next.h = textHeight(next);
        session.replaceItems(edit.pageId, new Map([[cur.id, [next]]]), "Type");
      }
    }
    onDone();
  };

  return (
    <>
      <div className="text-format" style={{ left: Math.max(8, pos.x), top: Math.max(8, pos.y - 48) }} onPointerDown={(e) => e.preventDefault()}>
        <select value={el.font} onChange={(e) => patch({ font: e.target.value as TextEl["font"] })} aria-label="Font">
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
          <option value="hand">Hand</option>
        </select>
        <select value={el.size} onChange={(e) => patch({ size: Number(e.target.value) })} aria-label="Font size">
          {[8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className={el.bold ? "on" : ""} onClick={() => patch({ bold: !el.bold })} aria-label="Bold">
          <b>B</b>
        </button>
        <button className={el.italic ? "on" : ""} onClick={() => patch({ italic: !el.italic })} aria-label="Italic">
          <i>I</i>
        </button>
        <button className={el.underline ? "on" : ""} onClick={() => patch({ underline: !el.underline })} aria-label="Underline">
          <u>U</u>
        </button>
        <button onClick={(e) => setPop({ a: e.currentTarget.getBoundingClientRect(), k: "color" })} aria-label="Text colour">
          <span className="color-dot" style={{ background: el.color, width: 16, height: 16 }} />
        </button>
        <button onClick={(e) => setPop({ a: e.currentTarget.getBoundingClientRect(), k: "bg" })} aria-label="Background colour" title="Background">
          <span className="color-dot" style={{ background: el.bg || "transparent", width: 16, height: 16, outline: "1px dashed var(--c-line)" }} />
        </button>
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} className={el.align === a ? "on" : ""} onClick={() => patch({ align: a })} aria-label={`Align ${a}`}>
            {a === "left" ? "⇤" : a === "center" ? "↔" : "⇥"}
          </button>
        ))}
        <button
          className={el.link ? "on" : ""}
          onClick={async () => {
            const url = await promptDialog("Link this text to a web address", el.link ?? "https://", "Save", "Leave empty to remove the link.");
            if (url == null) return;
            const v = url.trim();
            if (v && !/^(https?:\/\/|mailto:)/i.test(v)) return;
            patch({ link: v || undefined }, "Link");
          }}
          aria-label="Hyperlink"
        >
          <Icon name="link" size={16} />
        </button>
        <button onClick={commit} aria-label="Done">
          <Icon name="check" size={16} />
        </button>
      </div>
      <textarea
        ref={ta}
        className="text-edit"
        value={text}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          if ((e.relatedTarget as HTMLElement | null)?.closest?.(".text-format,.menu")) return;
          commit();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) commit();
        }}
        style={{
          left: pos.x,
          top: pos.y,
          width: el.w * z,
          minHeight: el.size * 1.6 * z,
          font: `${el.italic ? "italic " : ""}${el.bold ? 700 : 400} ${el.size * z}px/${1.3} ${FONT_FAMILIES[el.font]}`,
          color: el.color,
          textAlign: el.align,
          textDecoration: el.underline ? "underline" : "none",
          background: el.bg || "rgba(255,255,255,0.6)",
          padding: `${4 * z}px`,
          transform: el.rot ? `rotate(${el.rot}rad)` : undefined,
        }}
      />
      {pop && (
        <Popover anchor={pop.a} onClose={() => setPop(null)}>
          <ColorGrid
            value={pop.k === "color" ? el.color : el.bg ?? "#ffffff"}
            onChange={(c) => {
              patch(pop.k === "color" ? { color: c } : { bg: c });
              setPop(null);
            }}
          />
          {pop.k === "bg" && (
            <button
              className="btn small"
              style={{ marginTop: 8 }}
              onClick={() => {
                patch({ bg: undefined });
                setPop(null);
              }}
            >
              No background
            </button>
          )}
        </Popover>
      )}
    </>
  );
}
