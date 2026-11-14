import { useEffect, useRef, useState } from "react";
import type { ID, Recording, Stroke } from "../model/types";
import { listRecordings, onChange, deleteRecording, saveRecording, getAsset } from "../storage/repo";
import { recState, startRecording, stopRecording, pauseRecording, resumeRecording, offsetToTime, timeToOffset } from "./recorder";
import { useStore, toast } from "../state/store";
import { Icon } from "../ui/icons";
import { formatDuration } from "../model/util";
import { confirmDialog, promptDialog, openMenu } from "../ui/common";
import { saveFile } from "../platform/native";

export interface AudioPanelApi {
  seekToStroke(s: Stroke): boolean;
}

export function AudioPanel({ docId, onClose, onFade, apiRef }: { docId: ID; onClose: () => void; onFade: (range: { after: number; until: number } | null) => void; apiRef: React.MutableRefObject<AudioPanelApi | null> }) {
  const rs = useStore(recState, (s) => s);
  const [recs, setRecs] = useState<Recording[]>([]);
  const [cur, setCur] = useState<Recording | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [sync, setSync] = useState(true);
  // Off by default: browser speech services (e.g. Chrome, Edge) may send the audio to their servers.
  const [transcribe, setTranscribe] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);

  const load = () => listRecordings(docId).then(setRecs);
  useEffect(() => {
    load();
    return onChange((t) => t === "recordings:" + docId && load());
  }, [docId]);

  useEffect(() => {
    if (!cur) return;
    let u: string | null = null;
    getAsset(cur.asset).then((a) => {
      if (a) {
        u = URL.createObjectURL(a.blob);
        setUrl(u);
      }
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [cur?.id]);

  // replay ink: fade strokes written after the current playback point (within this recording)
  useEffect(() => {
    if (!cur || !sync || (!playing && pos === 0)) {
      onFade(null);
      return;
    }
    const end = cur.segments.length ? cur.segments[cur.segments.length - 1][1] : cur.start + cur.duration;
    onFade({ after: offsetToTime(cur, pos), until: end });
  }, [pos, playing, sync, cur?.id]);
  useEffect(() => () => onFade(null), []);

  apiRef.current = {
    seekToStroke(s: Stroke) {
      for (const r of recs) {
        const off = timeToOffset(r, s.t0);
        if (off != null) {
          if (cur?.id !== r.id) setCur(r);
          setTimeout(() => {
            if (audio.current) {
              audio.current.currentTime = Math.max(0, off / 1000 - 1);
              audio.current.play().catch(() => {});
            }
          }, cur?.id === r.id ? 0 : 300);
          return true;
        }
      }
      return false;
    },
  };

  const record = async () => {
    try {
      if (rs.recording) {
        const r = await stopRecording();
        if (r) {
          setCur(r);
          toast("Recording saved. Tap any ink written during it (read-only mode) to jump there.", "success");
        }
      } else await startRecording(docId, transcribe);
    } catch (e: any) {
      toast(e?.name === "NotAllowedError" ? "Microphone permission was denied." : e?.message ?? String(e), "error");
    }
  };

  const recordingHere = rs.recording && rs.docId === docId;
  return (
    <aside className="side-panel audio-panel">
      <div className="panel-head">
        <Icon name="mic" size={18} />
        <strong className="grow">Audio</strong>
        <button className="icon-btn small" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-body">
        {!rs.recording && <p className="small muted">Before recording, make sure you have permission to record and share the audio. Recordings in a synced notebook are also copied to your Google Drive.</p>}
        <div className="rec-box">
          <button className={"rec-btn" + (recordingHere ? " on" : "")} onClick={record} disabled={rs.recording && !recordingHere} aria-label={recordingHere ? "Stop recording" : "Start recording"}>
            {recordingHere ? <Icon name="stop" size={18} /> : <span className="rec-dot" />}
          </button>
          <div className="grow">
            <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{recordingHere ? formatDuration(rs.activeMs) : "Record"}</div>
            <div className="muted small">{recordingHere ? (rs.paused ? "Paused" : "Recording — your writing is linked to the audio") : "Records audio linked to what you write"}</div>
          </div>
          {recordingHere && (
            <button className="icon-btn" onClick={() => (rs.paused ? resumeRecording() : pauseRecording())} aria-label={rs.paused ? "Resume" : "Pause"}>
              <Icon name={rs.paused ? "play" : "pause"} />
            </button>
          )}
        </div>
        {!rs.recording && (
          <label className="row small muted">
            <input type="checkbox" checked={transcribe && rs.supportsSpeech} disabled={!rs.supportsSpeech} onChange={(e) => setTranscribe(e.target.checked)} />
            Live transcription {rs.supportsSpeech ? "(your browser may send the audio to its speech service, e.g. Google in Chrome)" : "(not supported by this browser)"}
          </label>
        )}
        {recordingHere && (rs.lines.length > 0 || rs.live) && (
          <div className="transcript live">
            {rs.lines.slice(-6).map((l, i) => (
              <p key={i}>{l.text}</p>
            ))}
            {rs.live && <p className="muted">{rs.live}</p>}
          </div>
        )}

        {cur && url && (
          <div className="player">
            <audio
              ref={audio}
              src={url}
              onTimeUpdate={(e) => setPos(e.currentTarget.currentTime * 1000)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onLoadedMetadata={(e) => (e.currentTarget.playbackRate = rate)}
            />
            <div className="row">
              <button className="icon-btn" aria-label="Back 10 seconds" onClick={() => audio.current && (audio.current.currentTime = Math.max(0, audio.current.currentTime - 10))}>
                <span className="small">−10</span>
              </button>
              <button className="icon-btn" aria-label={playing ? "Pause" : "Play"} onClick={() => (playing ? audio.current?.pause() : audio.current?.play())}>
                <Icon name={playing ? "pause" : "play"} />
              </button>
              <button className="icon-btn" aria-label="Forward 10 seconds" onClick={() => audio.current && (audio.current.currentTime += 10)}>
                <span className="small">+10</span>
              </button>
              <input className="grow" type="range" min={0} max={cur.duration} value={Math.min(pos, cur.duration)} onChange={(e) => audio.current && (audio.current.currentTime = Number(e.target.value) / 1000)} aria-label="Position" />
              <span className="small muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatDuration(pos)} / {formatDuration(cur.duration)}
              </span>
            </div>
            <div className="row small">
              <select
                className="input"
                style={{ width: 80 }}
                value={rate}
                onChange={(e) => {
                  setRate(Number(e.target.value));
                  if (audio.current) audio.current.playbackRate = Number(e.target.value);
                }}
                aria-label="Playback speed"
              >
                {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
              <label className="row">
                <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> Replay ink with audio
              </label>
            </div>
            {cur.transcript.length > 0 && (
              <div className="transcript">
                {cur.transcript.map((l, i) => (
                  <button key={i} className={"tline" + (pos >= l.t && (i === cur.transcript.length - 1 || pos < cur.transcript[i + 1].t) ? " on" : "")} onClick={() => audio.current && ((audio.current.currentTime = l.t / 1000), audio.current.play())}>
                    <span className="muted small">{formatDuration(l.t)}</span> {l.text}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="rec-list">
          {recs.map((r) => (
            <div key={r.id} className={"rec-row" + (cur?.id === r.id ? " on" : "")}>
              <button className="grow rec-row-main" onClick={() => setCur(r)}>
                <span className="ellipsis">{r.title}</span>
                <span className="muted small">
                  {formatDuration(r.duration)}
                  {r.transcript.length ? " · transcript" : ""}
                </span>
              </button>
              <button
                className="icon-btn small"
                aria-label="Recording options"
                onClick={(e) =>
                  openMenu(e.currentTarget, [
                    {
                      label: "Rename",
                      icon: "text",
                      onClick: async () => {
                        const t = await promptDialog("Rename recording", r.title);
                        if (t?.trim()) await saveRecording({ ...r, title: t.trim() });
                      },
                    },
                    {
                      label: "Export audio",
                      icon: "download",
                      onClick: async () => {
                        const a = await getAsset(r.asset);
                        if (a) await saveFile(`${r.title.replace(/[\\/:*?"<>|]/g, "_")}.${a.mime.includes("mp4") ? "m4a" : "webm"}`, a.blob, a.mime);
                      },
                    },
                    {
                      label: "Copy transcript",
                      icon: "copy",
                      disabled: !r.transcript.length,
                      onClick: () => navigator.clipboard?.writeText(r.transcript.map((l) => l.text).join("\n")),
                    },
                    {
                      label: "Delete",
                      icon: "trash",
                      danger: true,
                      onClick: async () => {
                        if (await confirmDialog("Delete recording?", r.title, "Delete", true)) {
                          if (cur?.id === r.id) setCur(null);
                          await deleteRecording(r);
                        }
                      },
                    },
                  ])
                }
              >
                <Icon name="more" size={16} />
              </button>
            </div>
          ))}
          {!recs.length && !recordingHere && <p className="muted small">No recordings in this notebook yet.</p>}
        </div>
      </div>
    </aside>
  );
}
