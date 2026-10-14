// Speech-to-text worker. Runs OpenAI Whisper (ONNX build) locally via
// Transformers.js and WebAssembly. Model files are cached by the browser.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let currentModel = null;
let loading = null;

async function load(model) {
  if (asr && currentModel === model) return asr;
  if (loading && loading.model === model) return loading.promise;
  const promise = pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: p => self.postMessage({ type: 'progress', model, ...p })
  }).then(p => {
    asr = p;
    currentModel = model;
    loading = null;
    return p;
  }, err => {
    loading = null;
    throw err;
  });
  loading = { model, promise };
  return promise;
}

self.onmessage = async ({ data }) => {
  const { type, id, model } = data;
  try {
    if (type === 'load') {
      await load(model);
      self.postMessage({ type: 'ready', id });
    } else if (type === 'transcribe') {
      const run = await load(model);
      const out = await run(data.audio, { chunk_length_s: 30, stride_length_s: 5 });
      self.postMessage({ type: 'result', id, text: out.text || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
  }
};
