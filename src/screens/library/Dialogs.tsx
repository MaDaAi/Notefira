import { useState } from "react";
import { Dialog } from "../../ui/common";
import type { Cover, Doc, Folder, ID } from "../../model/types";
import { CoverPicker } from "./NewNotebook";
import { CoverArt } from "./Cover";
import * as repo from "../../storage/repo";
import { Icon } from "../../ui/icons";
import { toast } from "../../state/store";

export function ChangeCoverDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [cover, setCover] = useState<Cover>(doc.cover);
  return (
    <Dialog
      title="Change cover"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const cur = await repo.getDoc(doc.id);
              if (cur) await repo.saveDoc({ ...cur, cover });
              onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="row" style={{ alignItems: "flex-start", gap: 20 }}>
        <div style={{ width: 120, flex: "none" }}>{cover.type === "page" ? <div className="cover cover-firstpage">First page</div> : <CoverArt cover={cover} title={doc.title} />}</div>
        <CoverPicker value={cover} onChange={setCover} />
      </div>
    </Dialog>
  );
}

export function MoveDialog({ items, folders, onClose }: { items: { docs: ID[]; folders: ID[] }; folders: Folder[]; onClose: () => void }) {
  const [target, setTarget] = useState<ID | null>(null);
  const blocked = (fid: ID) => items.folders.some((m) => repo.isDescendant(folders, m, fid));
  const tree = (parent: ID | null, depth: number): JSX.Element[] =>
    folders
      .filter((f) => f.parentId === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((f) => [
        <button key={f.id} className={"nav-item" + (target === f.id ? " on" : "")} style={{ paddingLeft: 12 + depth * 16 }} disabled={blocked(f.id)} onClick={() => setTarget(f.id)}>
          <span style={{ color: f.color, display: "inline-flex" }}>
            <Icon name="folder" size={18} filled />
          </span>
          <span className="grow">{f.name}</span>
        </button>,
        ...tree(f.id, depth + 1),
      ]);
  const move = async () => {
    try {
      for (const id of items.docs) {
        const d = await repo.getDoc(id);
        if (d) await repo.saveDoc({ ...d, folderId: target });
      }
      for (const id of items.folders) await repo.moveFolder(id, target);
      onClose();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <Dialog
      title="Move to…"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={async () => {
              const f = await repo.createFolder("New folder", target);
              setTarget(f.id);
              folders.push(f);
            }}
          >
            New folder
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={move}>
            Move here
          </button>
        </>
      }
    >
      <div className="move-tree">
        <button className={"nav-item" + (target === null ? " on" : "")} onClick={() => setTarget(null)}>
          <Icon name="book" size={18} />
          <span className="grow">Documents (top level)</span>
        </button>
        {tree(null, 1)}
      </div>
    </Dialog>
  );
}
