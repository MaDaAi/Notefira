// Audio recording synchronised with handwriting. Each stroke stores the wall
// clock time it was written (t0); a recording stores its active segments, so
// audio position <-> writing time can be mapped in both directions.
import { createStore, toast, log } from "../state/store";
import type { ID, Recording, TranscriptLine } from "../model/types";
import { putAsset, saveRecording } from "../storage/repo";
import { uid } from "../model/util";

export const recState = createStore<{ docId: ID | null; recording: boolean; paused: boolean; startedAt: number; activeMs: number; live: string; lines: TranscriptLine[]; supportsSpeech: boolean }>({
  docId: null,
  recording: false,
  paused: false,
  startedAt: 0,
  activeMs: 0,
  live: "",
  lines: [],
  supportsSpeech: typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
});

let media: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let segments: [number, number][] = [];
let segStart = 0;
let speech: any = null;
let tick: any = null;

function activeElapsed() {
  const done = segments.reduce((s, [a, b]) => s + (b - a), 0);
  return done + (recState.get().paused || !segStart ? 0 : Date.now() - segStart);
}

function startSpeech() {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) return;
  try {
    speech = new SR();
    speech.continuous = true;
    speech.interimResults = true;
    speech.lang = navigator.language || "en-US";
    speech.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) recState.set((s) => ({ lines: [...s.lines, { t: Math.max(0, activeElapsed() - 1500), text }] }));
        } else interim += r[0].transcript;
      }
      recState.set({ live: interim });
    };
    speech.onerror = (e: any) => log("warn", "Speech recognition: " + e.error);
    speech.onend = () => {
      // browsers stop continuous recognition periodically; restart while recording
      if (recState.get().recording && !recState.get().paused) {
        try {
          speech.start();
        } catch {
          /* ignore */
        }
      }
    };
    speech.start();
  } catch (e) {
    log("warn", "Speech recognition unavailable: " + e);
  }
}

export async function startRecording(docId: ID, transcribe: boolean) {
  if (recState.get().recording) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Audio recording is not supported here.");
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) ?? "";
  media = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
  chunks = [];
  segments = [];
  media.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  media.start(1000);
  segStart = Date.now();
  recState.set({ docId, recording: true, paused: false, startedAt: segStart, activeMs: 0, live: "", lines: [] });
  if (transcribe) startSpeech();
  tick = setInterval(() => recState.set({ activeMs: activeElapsed() }), 250);
}

export function pauseRecording() {
  if (!media || recState.get().paused) return;
  media.pause();
  segments.push([segStart, Date.now()]);
  segStart = 0;
  try {
    speech?.stop();
  } catch {
    /* ignore */
  }
  recState.set({ paused: true, activeMs: activeElapsed() });
}

export function resumeRecording() {
  if (!media || !recState.get().paused) return;
  media.resume();
  segStart = Date.now();
  recState.set({ paused: false });
  if (speech) {
    try {
      speech.start();
    } catch {
      /* ignore */
    }
  }
}

export async function stopRecording(): Promise<Recording | null> {
  const st = recState.get();
  if (!media || !st.recording || !st.docId) return null;
  if (!st.paused) segments.push([segStart, Date.now()]);
  const m = media;
  const done = new Promise<void>((r) => (m.onstop = () => r()));
  m.stop();
  await done;
  stream?.getTracks().forEach((t) => t.stop());
  try {
    speech?.stop();
  } catch {
    /* ignore */
  }
  speech = null;
  clearInterval(tick);
  const blob = new Blob(chunks, { type: m.mimeType || "audio/webm" });
  media = null;
  stream = null;
  const duration = segments.reduce((s, [a, b]) => s + (b - a), 0);
  const lines = recState.get().lines;
  recState.set({ recording: false, paused: false, live: "", activeMs: 0, docId: null });
  if (!blob.size) {
    toast("Nothing was recorded.", "error");
    return null;
  }
  const asset = await putAsset(blob, st.docId, "recording");
  const rec: Recording = { id: uid(), docId: st.docId, title: `Recording ${new Date(st.startedAt).toLocaleString()}`, start: st.startedAt, duration, asset: asset.id, transcript: lines, segments: [...segments] };
  await saveRecording(rec);
  return rec;
}

/** Map a wall-clock time (when ink was written) to an offset in the recording, or null if outside it. */
export function timeToOffset(rec: Recording, t: number): number | null {
  let acc = 0;
  for (const [a, b] of rec.segments) {
    if (t >= a && t <= b) return acc + (t - a);
    acc += b - a;
  }
  return null;
}

/** Map an audio offset back to wall-clock time. */
export function offsetToTime(rec: Recording, ms: number): number {
  let acc = 0;
  for (const [a, b] of rec.segments) {
    if (ms <= acc + (b - a)) return a + (ms - acc);
    acc += b - a;
  }
  const last = rec.segments[rec.segments.length - 1];
  return last ? last[1] : rec.start + ms;
}
