// Runs Whisper speech recognition on the device inside a Web Worker.
// Audio is never uploaded; only the model files are downloaded (once).

export const DEFAULT_MODEL = 'Xenova/whisper-tiny.en';

let worker;
let seq = 0;
const pending = new Map();
const progressListeners = new Set();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        progressListeners.forEach(fn => fn(data));
        return;
      }
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.type === 'error') job.reject(new Error(data.message));
      else job.resolve(data);
    };
    worker.onerror = e => {
      pending.forEach(job => job.reject(new Error(e.message || 'Transcription worker failed')));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function send(msg, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

export function onProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

export function loadModel(model) {
  return send({ type: 'load', model });
}

export async function transcribe(pcm, model) {
  const res = await send({ type: 'transcribe', model, audio: pcm }, [pcm.buffer]);
  return (res.text || '').trim();
}

// Decode any recorded container (WebM, MP4) into 16 kHz mono PCM for Whisper.
export async function blobToPCM(blob) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } finally {
    ctx.close().catch(() => {});
  }
  const rate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * rate));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OAC(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}
