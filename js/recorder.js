// Microphone capture with MediaRecorder. Picks a container format each
// platform supports: WebM/Opus on Android and desktop, MP4/AAC on iOS.
export const MAX_SECONDS = 300;

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const options = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return options.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
}

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}

export class Recorder {
  constructor({ onTick, onLevel, onAutoStop } = {}) {
    this.onTick = onTick || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onAutoStop = onAutoStop || (() => {});
    this.state = 'idle';
    this.elapsed = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    const mimeType = pickMime();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 48000 } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(1000);
    this.state = 'recording';
    this.elapsed = 0;
    this.lastTick = performance.now();
    this._startMeter();
    this._timer = setInterval(() => this._tick(), 250);
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }

  _tick() {
    const now = performance.now();
    if (this.state === 'recording') this.elapsed += (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.onTick(this.elapsed);
    if (this.elapsed >= MAX_SECONDS && this.state === 'recording') this.onAutoStop();
  }

  _startMeter() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.ctx.resume?.();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const data = new Uint8Array(this.analyser.fftSize);
      const loop = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        this.onLevel(this.state === 'recording' ? Math.min(1, Math.sqrt(sum / data.length) * 4) : 0);
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* level meter is cosmetic */ }
  }

  pause() {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    this.recorder.resume();
    this.lastTick = performance.now();
    this.state = 'recording';
  }

  stop() {
    return new Promise(resolve => {
      if (!this.recorder || this.state === 'idle') return resolve(null);
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || this.chunks[0]?.type || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        const duration = Math.round(this.elapsed);
        this._cleanup();
        resolve({ blob, duration });
      };
      this.recorder.stop();
    });
  }

  cancel() {
    if (this.recorder && this.state !== 'idle') {
      this.recorder.onstop = null;
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    this._cleanup();
  }

  _cleanup() {
    clearInterval(this._timer);
    cancelAnimationFrame(this.raf);
    this.analyser = null;
    this.ctx?.close().catch(() => {});
    this.stream?.getTracks().forEach(t => t.stop());
    this.wakeLock?.release?.().catch(() => {});
    this.state = 'idle';
  }
}
