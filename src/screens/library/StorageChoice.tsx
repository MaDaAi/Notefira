import { Icon } from "../../ui/icons";

/**
 * Where a new notebook lives: synced to the user's Google Drive (default) or
 * kept on this device only. Shown at the bottom left of the new-notebook and
 * import dialogs when Google sync is available.
 */
export function StorageChoice({ localOnly, onChange }: { localOnly: boolean; onChange: (localOnly: boolean) => void }) {
  return (
    <div className="seg storage-choice" role="radiogroup" aria-label="Where to keep this notebook">
      <button type="button" role="radio" aria-checked={!localOnly} className={!localOnly ? "on" : ""} onClick={() => onChange(false)} title="Saved on this device and synced to your Google Drive">
        <Icon name="cloud" size={14} /> Google Drive
      </button>
      <button type="button" role="radio" aria-checked={localOnly} className={localOnly ? "on" : ""} onClick={() => onChange(true)} title="Saved on this device only; never uploaded">
        <Icon name="cloudOff" size={14} /> This device only
      </button>
    </div>
  );
}
