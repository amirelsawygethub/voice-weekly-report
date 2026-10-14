import * as db from './db.js';
import { encryptBytes, decryptBytes, encryptJSON, decryptJSON, resetKeyCache } from './crypto.js';
import { Recorder, isSupported, MAX_SECONDS } from './recorder.js';
import { transcribe, blobToPCM, loadModel, onProgress, DEFAULT_MODEL } from './transcriber.js';
import { SECTIONS, summarise, emptySections } from './summarize.js';
import { weekBounds, formatRange, formatDate, weekKey, buildReport, reportToHTML, reportToText, projectTitle, esc } from './report.js';
import { buildICS, googleCalendarLink, isReminderDue } from './reminder.js';

const APP_VERSION = '1.0.0';
const AUDIO_RETENTION_DAYS = 90;
const TAGS = SECTIONS.map(s => s.tag);
const APP_URL = new URL('./', location.href).href;

const $ = sel => document.querySelector(sel);
const state = {
  settings: null,
  projects: [],
  notes: [],
  view: null,
  viewOpts: {},
  reportOffset: 0,
  recorder: null,
  levels: [],
  processing: false,
  processAgain: false,
  model: { pct: 0, active: false, ready: false, error: '' },
  installPrompt: null
};

const DEFAULT_SETTINGS = {
  profile: { name: '', recipient: '' },
  weekStart: 0,
  reminderTime: '17:00',
  model: DEFAULT_MODEL,
  lastProjectId: null,
  onboarded: false,
  installDismissed: false
};

/* ---------- Persistence ---------- */

async function loadState() {
  state.settings = { ...DEFAULT_SETTINGS, ...((await db.get('settings', 'app')) || {}) };
  state.projects = ((await db.getAll('projects')) || []).sort((a, b) => a.createdAt - b.createdAt);
  const raw = (await db.getAll('notes')) || [];
  state.notes = [];
  for (const n of raw) state.notes.push(await decryptNote(n));
  state.notes.sort((a, b) => b.createdAt - a.createdAt);
}

const saveSettings = () => db.put('settings', state.settings, 'app');

async function decryptNote(record) {
  let payload = { segments: [], transcript: '', sections: null };
  try { if (record.enc) payload = await decryptJSON(record.enc); } catch { record.status = 'error'; record.error = 'Could not decrypt this note.'; }
  const { enc, ...meta } = record;
  return { ...meta, ...payload };
}

async function saveNote(note) {
  const { segments, transcript, sections, ...meta } = note;
  const enc = await encryptJSON({ segments, transcript, sections });
  await db.put('notes', { ...meta, enc });
  const i = state.notes.findIndex(n => n.id === note.id);
  if (i >= 0) state.notes[i] = note; else state.notes.unshift(note);
}

async function saveAudio(blob) {
  const id = db.uid();
  const { iv, data } = await encryptBytes(await blob.arrayBuffer());
  await db.put('audio', { id, iv, data, type: blob.type, createdAt: Date.now() });
  return id;
}

async function loadAudio(id) {
  const rec = await db.get('audio', id);
  if (!rec) return null;
  const bytes = await decryptBytes(rec);
  return new Blob([bytes], { type: rec.type });
}

async function deleteNote(note) {
  for (const id of note.audioIds || []) await db.del('audio', id);
  await db.del('notes', note.id);
  state.notes = state.notes.filter(n => n.id !== note.id);
}

async function enforceRetention() {
  const cutoff = Date.now() - AUDIO_RETENTION_DAYS * 86400000;
  const audio = (await db.getAll('audio')) || [];
  const expired = new Set(audio.filter(a => a.createdAt < cutoff).map(a => a.id));
  if (!expired.size) return;
  for (const id of expired) await db.del('audio', id);
  for (const note of state.notes) {
    if ((note.audioIds || []).some(id => expired.has(id))) {
      note.audioIds = note.audioIds.filter(id => !expired.has(id));
      await saveNote(note);
    }
  }
}

/* ---------- Helpers ---------- */

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function dialog({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  const dlg = $('#dlg');
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = body;
  $('#dlg-ok').textContent = ok;
  $('#dlg-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
  $('#dlg-cancel').textContent = cancel;
  $('#dlg-cancel').hidden = !cancel;
  const form = dlg.querySelector('form');
  return new Promise(resolve => {
    const finish = value => {
      form.onsubmit = null;
      dlg.oncancel = null;
      $('#dlg-cancel').onclick = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    form.onsubmit = e => { e.preventDefault(); finish(true); };
    $('#dlg-cancel').onclick = () => finish(false);
    dlg.oncancel = e => { e.preventDefault(); finish(false); };
    dlg.showModal();
  });
}

const projectById = id => state.projects.find(p => p.id === id);
const projectName = id => projectById(id)?.name || 'Unassigned project';

function currentWeek(offset = 0) {
  return weekBounds(new Date(), Number(state.settings.weekStart), offset);
}

function notesInWeek({ start, end }) {
  return state.notes.filter(n => n.createdAt >= start.getTime() && n.createdAt < end.getTime());
}

function statusPill(note) {
  const map = {
    queued: ['Waiting', 'busy'],
    processing: ['Transcribing', 'busy'],
    done: ['Ready', 'ok'],
    review: ['Please re-record', 'err'],
    error: ['Error', 'err']
  };
  const [label, cls] = map[note.status] || ['', ''];
  return `<span class="pill ${cls}">${label}</span>`;
}

function firstBullet(note) {
  if (note.status === 'processing' && state.model.active) return `Preparing speech model ${state.model.pct}%`;
  if (note.status !== 'done' || !note.sections) return note.error || 'Processing on your device';
  for (const s of SECTIONS) if (note.sections[s.key]?.length) return note.sections[s.key][0];
  return 'No report content detected';
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- Navigation ---------- */

const TITLES = {
  onboarding: 'Welcome', home: 'Weekly Report', record: 'Record Note', note: 'Note',
  report: 'Weekly Report', settings: 'Settings', guide: 'Voice Note Guidelines'
};
const TAB_VIEWS = ['home', 'report', 'guide', 'settings'];

async function show(view, opts = {}, { push = true, replace = false } = {}) {
  if (state.view === 'record' && view !== 'record' && state.recorder && state.recorder.state !== 'idle') {
    const discard = await dialog({ title: 'Discard recording?', body: '<p>Your current recording has not been saved.</p>', ok: 'Discard', danger: true });
    if (!discard) { history.pushState({ view: 'record', opts: state.viewOpts }, ''); return; }
    state.recorder.cancel();
  }
  state.view = view;
  state.viewOpts = opts;
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
  $('#title').textContent = TITLES[view];
  $('#btn-back').hidden = !['record', 'note'].includes(view);
  $('#tabbar').hidden = ['onboarding', 'record'].includes(view);
  $('#btn-help').hidden = view === 'onboarding' || view === 'guide';
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === view));
  if (replace) history.replaceState({ view, opts }, '');
  else if (push) history.pushState({ view, opts }, '');
  window.scrollTo(0, 0);
  await RENDER[view]?.(opts);
}

window.addEventListener('popstate', e => {
  const s = e.state;
  if (s && s.view) show(s.view, s.opts || {}, { push: false });
  else if (state.settings?.onboarded) show('home', {}, { replace: true });
});

/* ---------- Views ---------- */

const RENDER = {
  onboarding() {},

  home() {
    const wk = currentWeek();
    const notes = notesInWeek(wk);
    $('#home-week').textContent = formatRange(wk.start, wk.lastWorkday);
    $('#home-count').textContent = notes.length;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let days = '';
    for (let i = 0; i < 5; i++) {
      const d = new Date(wk.start); d.setDate(wk.start.getDate() + i);
      const has = notes.some(n => new Date(n.createdAt).toDateString() === d.toDateString());
      const isToday = d.getTime() === today.getTime();
      days += `<div class="day${has ? ' has' : ''}${isToday ? ' today' : ''}"><b></b>${d.toLocaleDateString('en-GB', { weekday: 'short' })}</div>`;
    }
    $('#home-days').innerHTML = days;

    $('#home-notes').innerHTML = notes.length
      ? notes.map(n => `
        <button class="item" data-note="${esc(n.id)}">
          <div class="grow">
            <div class="title">${esc(projectName(n.projectId))}</div>
            <div class="sub">${esc(formatDate(n.createdAt))} · ${esc(firstBullet(n))}</div>
          </div>
          ${statusPill(n)}
        </button>`).join('')
      : '<div class="empty">No notes recorded yet this week.<br>Tap Record to add your first note.</div>';

    const rb = $('#reminder-banner');
    rb.hidden = !isReminderDue(state.settings.reminderTime, notes.length);
    rb.innerHTML = 'Your weekly report is due today. Please record your notes. <button class="btn primary" data-go="record">Record</button>';
    renderInstallBanner();
  },

  record(opts) {
    const sel = $('#rec-project');
    sel.innerHTML = state.projects.map(p => `<option value="${esc(p.id)}">${esc(projectTitle(p))}</option>`).join('');
    const parent = opts.noteId ? state.notes.find(n => n.id === opts.noteId) : null;
    sel.value = parent?.projectId || state.settings.lastProjectId || state.projects[0]?.id || '';
    sel.disabled = !!parent;
    const preset = new Set(parent ? parent.tags : (opts.tags || []));
    $('#rec-tags').innerHTML = TAGS.map(t => `<button type="button" class="chip" aria-pressed="${preset.has(t)}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
    $('#rec-tags').closest('.field').hidden = !!parent;
    $('#rec-hint').textContent = opts.mode === 'followup' ? 'Adding to an existing note' : opts.mode === 'rerecord' ? 'This will replace the existing note' : `Maximum ${MAX_SECONDS / 60} minutes per note`;
    resetRecorderUI();
    if (!isSupported()) {
      $('#rec-hint').textContent = 'Voice recording is not supported in this browser. On iPhone, use Safari. On Android, use Chrome.';
      $('#rec-main').disabled = true;
    }
  },

  async note({ id }) {
    const note = state.notes.find(n => n.id === id);
    if (!note) return show('home', {}, { replace: true });
    $('#note-project').textContent = projectName(note.projectId);
    $('#note-date').textContent = `${formatDate(note.createdAt)} · ${Math.max(1, Math.round((note.duration || 0) / 60))} min${note.tags?.length ? ' · ' + note.tags.join(', ') : ''}`;
    $('#note-status').outerHTML = statusPill(note).replace('<span', '<span id="note-status"');

    const box = $('#note-sections');
    if (note.status === 'done' && note.sections) {
      box.innerHTML = SECTIONS.map(s => {
        const items = note.sections[s.key] || [];
        const none = (s.key === 'support' && note.sections.none?.support) || (s.key === 'challenges' && note.sections.none?.challenges);
        if (!items.length && !none) return '';
        return `<div class="card sec-card"><h4>${esc(s.label)}</h4><ul>${items.length ? items.map(i => `<li>${esc(i)}</li>`).join('') : `<li>${esc(s.empty)}</li>`}</ul></div>`;
      }).join('') || '<div class="empty">No report content was detected. Please re-record using the four prompts in the Guide.</div>';
    } else if (note.status === 'review') {
      box.innerHTML = '<div class="banner warn">Very little speech was detected. Please re-record in a quieter place, closer to the microphone.</div>';
    } else if (note.status === 'error') {
      box.innerHTML = `<div class="banner warn"><span>${esc(note.error || 'Transcription failed.')}</span><button class="btn primary" id="note-retry">Retry</button></div>`;
    } else {
      box.innerHTML = `<div class="card"><p class="muted">${esc(firstBullet(note))}. You can leave this screen; the note will be ready shortly.</p><div class="progress"><div style="width:${state.model.active ? state.model.pct : 15}%"></div></div></div>`;
    }
    $('#note-transcript').textContent = note.transcript || 'Not yet available.';

    const audio = $('#note-audio');
    if (audio.dataset.url) URL.revokeObjectURL(audio.dataset.url);
    audio.removeAttribute('src');
    audio.hidden = true;
    if (note.audioIds?.length) {
      const blobs = [];
      for (const aid of note.audioIds) { const b = await loadAudio(aid); if (b) blobs.push(b); }
      if (blobs.length && state.view === 'note') {
        const url = URL.createObjectURL(blobs.length === 1 ? blobs[0] : blobs[blobs.length - 1]);
        audio.src = url;
        audio.dataset.url = url;
        audio.hidden = false;
      }
    }
  },

  async report() {
    const wk = currentWeek(state.reportOffset);
    const notes = notesInWeek(wk);
    $('#rep-week').textContent = formatRange(wk.start, wk.lastWorkday);
    $('#rep-next').disabled = state.reportOffset >= 0;
    const done = notes.filter(n => n.status === 'done');
    const pendingCount = notes.filter(n => ['queued', 'processing'].includes(n.status)).length;
    const issues = notes.filter(n => ['review', 'error'].includes(n.status)).length;
    const meta = await db.get('reports', weekKey(wk.start));

    let status = '';
    if (meta?.submittedAt) status += `<div class="banner info">Submitted on ${esc(formatDate(meta.submittedAt))}.</div>`;
    if (pendingCount) status += `<div class="banner info">${pendingCount} note(s) are still being transcribed on your device. The report will update automatically.</div>`;
    if (issues) status += `<div class="banner warn">${issues} note(s) need attention. Open them from Home to re-record.</div>`;
    $('#rep-status').innerHTML = status;

    const hasContent = done.length > 0;
    ['#rep-share', '#rep-copy', '#rep-download', '#rep-print', '#rep-submit'].forEach(s => { $(s).disabled = !hasContent; });
    $('#rep-submit').textContent = meta?.submittedAt ? 'Submitted' : 'Mark as submitted';
    if (meta?.submittedAt) $('#rep-submit').disabled = true;

    if (!hasContent) {
      $('#rep-body').innerHTML = '<div class="empty">No processed notes for this week yet. Record a note and the report will be generated automatically.</div>';
      state.currentReport = null;
      return;
    }
    state.currentReport = buildReport({ notes: done, projects: state.projects, profile: state.settings.profile, start: wk.start, lastWorkday: wk.lastWorkday });
    $('#rep-body').innerHTML = reportToHTML(state.currentReport);
  },

  async settings() {
    const s = state.settings;
    $('#set-name').value = s.profile.name;
    $('#set-recipient').value = s.profile.recipient || '';
    $('#set-weekstart').value = String(s.weekStart);
    $('#set-time').value = s.reminderTime;
    $('#set-model').value = s.model;
    $('#set-gcal').href = googleCalendarLink(s.reminderTime, APP_URL);
    $('#app-version').textContent = APP_VERSION;
    renderProjects();
    renderModelStatus();
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      if (est) $('#storage-info').textContent = `Storage used: ${(est.usage / 1048576).toFixed(1)} MB${persisted ? ' · protected from automatic clean-up' : ''}`;
    } catch { /* optional */ }
  },

  guide() {}
};

function renderProjects() {
  $('#set-projects').innerHTML = state.projects.map(p => `
    <button class="item" data-project="${esc(p.id)}">
      <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${esc(p.code || 'No code')}${p.glossary?.length ? ' · ' + esc(p.glossary.join(', ')) : ''}</div></div>
      <span class="pill">Edit</span>
    </button>`).join('') || '<div class="empty">No projects yet.</div>';
}

function renderModelStatus() {
  const m = state.model;
  $('#model-progress').hidden = !m.active;
  $('#model-progress div').style.width = `${m.pct}%`;
  $('#model-status').textContent = m.error ? `Download failed: ${m.error}` : m.active ? `Downloading speech model: ${m.pct}%` : m.ready ? 'Speech model ready. Transcription works offline.' : 'The model downloads automatically with your first note. Use Wi-Fi if possible.';
  $('#set-model-load').disabled = m.active || m.ready;
}

function renderInstallBanner() {
  const banner = $('#install-banner');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone || state.settings.installDismissed) { banner.hidden = true; return; }
  if (state.installPrompt) {
    banner.innerHTML = '<span>Install the app for one-tap access and offline use.</span><button class="btn primary" id="do-install">Install</button>';
    banner.hidden = false;
  } else if (ios) {
    banner.innerHTML = '<span>To install: tap the Share button, then <strong>Add to Home Screen</strong>. This keeps your notes safe from automatic clean-up.</span><button class="btn ghost" id="dismiss-install">Dismiss</button>';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

/* ---------- Recording ---------- */

function resetRecorderUI() {
  state.levels = [];
  $('#rec-timer').textContent = '0:00';
  $('#rec-main').classList.remove('recording');
  $('#rec-main').setAttribute('aria-label', 'Start recording');
  $('#rec-main-icon').innerHTML = '<circle cx="12" cy="12" r="7" class="fill"/>';
  $('#rec-main').disabled = false;
  $('#rec-pause').hidden = true;
  $('#rec-cancel').hidden = true;
  drawWave();
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function drawWave() {
  const c = $('#rec-wave');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 300, h = c.clientHeight || 80;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bars = Math.floor(w / 5);
  const data = state.levels.slice(-bars);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--navy').trim() || '#1F3A5F';
  for (let i = 0; i < bars; i++) {
    const v = data[i - (bars - data.length)] ?? 0;
    const bh = Math.max(2, v * h * 0.9);
    ctx.fillRect(i * 5, (h - bh) / 2, 3, bh);
  }
}

async function startRecording() {
  if (!state.projects.length) { toast('Please add a project in Settings first.'); return; }
  const rec = new Recorder({
    onTick: sec => { $('#rec-timer').textContent = fmtTime(sec); },
    onLevel: lvl => { state.levels.push(lvl); if (state.levels.length > 600) state.levels.shift(); drawWave(); },
    onAutoStop: () => { toast('Maximum length reached. Saving your note.'); finishRecording(); }
  });
  try {
    await rec.start();
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    await dialog({
      title: denied ? 'Microphone access needed' : 'Microphone unavailable',
      body: denied
        ? '<p>Please allow microphone access for this app. On iPhone: Settings, Safari, Microphone. On Android: tap the lock icon in the address bar, then Permissions.</p>'
        : `<p>${esc(err?.message || 'The microphone could not be started.')}</p>`,
      cancel: ''
    });
    return;
  }
  state.recorder = rec;
  $('#rec-main').classList.add('recording');
  $('#rec-main').setAttribute('aria-label', 'Stop and save');
  $('#rec-main-icon').innerHTML = '<rect x="7" y="7" width="10" height="10" rx="2" class="fill"/>';
  $('#rec-pause').hidden = false;
  $('#rec-cancel').hidden = false;
}

async function finishRecording() {
  const rec = state.recorder;
  if (!rec || rec.state === 'idle') return;
  $('#rec-main').disabled = true;
  const result = await rec.stop();
  state.recorder = null;
  if (!result || result.duration < 2 || result.blob.size < 1000) {
    toast('Recording too short. Please try again.');
    resetRecorderUI();
    return;
  }
  const opts = state.viewOpts;
  const audioId = await saveAudio(result.blob);
  let note;
  if (opts.mode === 'followup' || opts.mode === 'rerecord') {
    note = state.notes.find(n => n.id === opts.noteId);
  }
  if (note && opts.mode === 'followup') {
    note.audioIds = [...(note.audioIds || []), audioId];
    note.segments = [...(note.segments || []), { audioId, text: null }];
    note.duration = (note.duration || 0) + result.duration;
  } else if (note && opts.mode === 'rerecord') {
    for (const id of note.audioIds || []) await db.del('audio', id);
    note.audioIds = [audioId];
    note.segments = [{ audioId, text: null }];
    note.duration = result.duration;
    note.transcript = '';
    note.sections = null;
  } else {
    const projectId = $('#rec-project').value;
    const tags = [...document.querySelectorAll('#rec-tags .chip[aria-pressed="true"]')].map(c => c.dataset.tag);
    note = {
      id: db.uid(), projectId, tags, createdAt: Date.now(), duration: result.duration,
      audioIds: [audioId], segments: [{ audioId, text: null }], transcript: '', sections: null
    };
    state.settings.lastProjectId = projectId;
    saveSettings();
  }
  note.status = 'queued';
  note.error = '';
  note.updatedAt = Date.now();
  await saveNote(note);
  toast('Saved securely. Transcribing on your device.');
  await show('note', { id: note.id }, { replace: true });
  processQueue();
}

/* ---------- Processing queue ---------- */

async function processQueue() {
  if (state.processing) { state.processAgain = true; return; }
  state.processing = true;
  try {
    do {
      state.processAgain = false;
      const queue = state.notes.filter(n => n.status === 'queued' || n.status === 'processing').sort((a, b) => a.createdAt - b.createdAt);
      for (const note of queue) await processNote(note);
    } while (state.processAgain);
  } finally {
    state.processing = false;
  }
}

async function processNote(note) {
  note.status = 'processing';
  refreshIfShowing(note);
  try {
    for (const seg of note.segments || []) {
      if (seg.text !== null && seg.text !== undefined) continue;
      const blob = await loadAudio(seg.audioId);
      if (!blob) { seg.text = ''; continue; }
      const pcm = await blobToPCM(blob);
      seg.text = await transcribe(pcm, state.settings.model);
      await saveNote(note);
    }
    resummarise(note);
    const words = note.transcript.split(/\s+/).filter(Boolean).length;
    note.status = words < 4 ? 'review' : 'done';
  } catch (err) {
    console.error(err);
    note.status = 'error';
    note.error = navigator.onLine === false && !state.model.ready
      ? 'The speech model needs an internet connection to download the first time. Connect and tap Retry.'
      : `Transcription failed: ${err.message || err}`;
  }
  note.updatedAt = Date.now();
  await saveNote(note);
  refreshIfShowing(note);
}

function resummarise(note) {
  const project = projectById(note.projectId) || {};
  note.transcript = (note.segments || []).map(s => s.text || '').join(' ').trim();
  note.sections = note.transcript
    ? summarise(note.transcript, { tags: note.tags || [], glossary: project.glossary || [], projectTerms: [project.name, project.code].filter(Boolean) })
    : emptySections();
}

function refreshIfShowing(note) {
  if (state.view === 'note' && state.viewOpts.id === note.id) RENDER.note({ id: note.id });
  if (state.view === 'home') RENDER.home();
  if (state.view === 'report') RENDER.report();
}

onProgress(p => {
  if (!onProgress.files) onProgress.files = new Map();
  const files = onProgress.files;
  if (p.status === 'initiate' || p.status === 'download') { state.model.active = true; files.set(p.file, files.get(p.file) || 0); }
  if (p.status === 'progress' && p.file) { state.model.active = true; files.set(p.file, p.progress || 0); }
  if (p.status === 'done' && p.file) files.set(p.file, 100);
  if (p.status === 'ready') { state.model.active = false; state.model.ready = true; files.clear(); }
  const vals = [...files.values()];
  state.model.pct = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : state.model.pct;
  if (state.view === 'settings') renderModelStatus();
  if (state.view === 'note' || state.view === 'home') {
    clearTimeout(onProgress.t);
    onProgress.t = setTimeout(() => { if (state.view === 'home') RENDER.home(); else RENDER.note(state.viewOpts); }, 400);
  }
});

/* ---------- Event wiring ---------- */

function wire() {
  $('#btn-back').onclick = () => history.back();
  $('#btn-help').onclick = () => show('guide');

  document.querySelectorAll('.tab[data-tab]').forEach(t => {
    t.onclick = () => {
      const tab = t.dataset.tab;
      if (tab === 'report') state.reportOffset = 0;
      show(tab, tab === 'record' ? { mode: 'new' } : {});
    };
  });

  document.body.addEventListener('click', async e => {
    const go = e.target.closest('[data-go]');
    if (go) show(go.dataset.go, { mode: 'new' });
    const noteBtn = e.target.closest('[data-note]');
    if (noteBtn) show('note', { id: noteBtn.dataset.note });
    const projBtn = e.target.closest('[data-project]');
    if (projBtn) editProject(projectById(projBtn.dataset.project));
    if (e.target.id === 'do-install' && state.installPrompt) {
      state.installPrompt.prompt();
      await state.installPrompt.userChoice.catch(() => {});
      state.installPrompt = null;
      renderInstallBanner();
    }
    if (e.target.id === 'dismiss-install') {
      state.settings.installDismissed = true;
      saveSettings();
      renderInstallBanner();
    }
    if (e.target.id === 'note-retry') {
      const note = state.notes.find(n => n.id === state.viewOpts.id);
      if (note) { note.status = 'queued'; note.error = ''; await saveNote(note); RENDER.note({ id: note.id }); processQueue(); }
    }
  });

  // Onboarding
  $('#ob-continue').onclick = async () => {
    const name = $('#ob-name').value.trim();
    const projectNameValue = $('#ob-project').value.trim();
    if (!name || !projectNameValue) { toast('Please enter your name and first project.'); return; }
    state.settings.profile = { name, recipient: $('#ob-recipient').value.trim() };
    const project = { id: db.uid(), name: projectNameValue, code: $('#ob-code').value.trim(), glossary: [], createdAt: Date.now() };
    await db.put('projects', project);
    state.projects.push(project);
    state.settings.lastProjectId = project.id;
    state.settings.onboarded = true;
    await saveSettings();
    try { await navigator.storage?.persist?.(); } catch { /* optional */ }
    show('home', {}, { replace: true });
    setTimeout(offerReminder, 600);
  };

  // Home
  $('#home-record').onclick = () => show('record', { mode: 'new' });
  $('#home-report').onclick = () => { state.reportOffset = 0; show('report'); };

  // Record
  $('#rec-tags').onclick = e => {
    const chip = e.target.closest('.chip');
    if (chip) chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
  };
  $('#rec-main').onclick = () => {
    if (!state.recorder || state.recorder.state === 'idle') startRecording();
    else finishRecording();
  };
  $('#rec-pause').onclick = () => {
    const r = state.recorder;
    if (!r) return;
    if (r.state === 'recording') { r.pause(); $('#rec-pause').setAttribute('aria-label', 'Resume'); $('#rec-pause').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" class="fill"/></svg>'; }
    else { r.resume(); $('#rec-pause').setAttribute('aria-label', 'Pause'); $('#rec-pause').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>'; }
  };
  $('#rec-cancel').onclick = () => {
    state.recorder?.cancel();
    state.recorder = null;
    resetRecorderUI();
    toast('Recording discarded.');
  };

  // Note
  $('#note-followup').onclick = () => show('record', { mode: 'followup', noteId: state.viewOpts.id });
  $('#note-rerecord').onclick = () => show('record', { mode: 'rerecord', noteId: state.viewOpts.id });
  $('#note-delete').onclick = async () => {
    const note = state.notes.find(n => n.id === state.viewOpts.id);
    if (!note) return;
    if (!(await dialog({ title: 'Delete this note?', body: '<p>The recording and its transcript will be removed from this device.</p>', ok: 'Delete', danger: true }))) return;
    await deleteNote(note);
    toast('Note deleted.');
    show('home', {}, { replace: true });
  };

  // Report
  $('#rep-prev').onclick = () => { state.reportOffset--; RENDER.report(); };
  $('#rep-next').onclick = () => { if (state.reportOffset < 0) { state.reportOffset++; RENDER.report(); } };
  $('#rep-share').onclick = shareReport;
  $('#rep-copy').onclick = async () => {
    if (!state.currentReport) return;
    try { await navigator.clipboard.writeText(reportToText(state.currentReport)); toast('Report copied.'); }
    catch { toast('Copy is not available. Use Share instead.'); }
  };
  $('#rep-download').onclick = () => {
    if (!state.currentReport) return;
    const wk = currentWeek(state.reportOffset);
    download(`Weekly-Report-${weekKey(wk.start)}.txt`, reportToText(state.currentReport), 'text/plain;charset=utf-8');
  };
  $('#rep-print').onclick = () => window.print();
  $('#rep-correct').onclick = () => show('record', { mode: 'new' });
  $('#rep-submit').onclick = async () => {
    const wk = currentWeek(state.reportOffset);
    await db.put('reports', { id: weekKey(wk.start), submittedAt: Date.now() });
    toast('Report marked as submitted.');
    RENDER.report();
  };

  // Settings
  const saveProfile = () => {
    state.settings.profile = { name: $('#set-name').value.trim(), recipient: $('#set-recipient').value.trim() };
    saveSettings();
  };
  $('#set-name').onchange = saveProfile;
  $('#set-recipient').onchange = saveProfile;
  $('#set-weekstart').onchange = e => { state.settings.weekStart = Number(e.target.value); saveSettings(); };
  $('#set-time').onchange = e => {
    state.settings.reminderTime = e.target.value || '17:00';
    saveSettings();
    $('#set-gcal').href = googleCalendarLink(state.settings.reminderTime, APP_URL);
    toast('Reminder time updated. Add it to your calendar again to apply.');
  };
  $('#set-ics').onclick = () => download('weekly-report-reminder.ics', buildICS(state.settings.reminderTime, APP_URL), 'text/calendar;charset=utf-8');
  $('#set-model').onchange = e => {
    state.settings.model = e.target.value;
    state.model.ready = false;
    saveSettings();
    renderModelStatus();
  };
  $('#set-model-load').onclick = prepareModel;
  $('#set-add-project').onclick = () => editProject(null);
  $('#set-wipe').onclick = async () => {
    if (!(await dialog({ title: 'Delete all data?', body: '<p>All notes, recordings, projects and settings on this device will be permanently removed. This cannot be undone.</p>', ok: 'Delete everything', danger: true }))) return;
    await db.wipeAll();
    resetKeyCache();
    location.replace(APP_URL);
  };

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    state.installPrompt = e;
    if (state.view === 'home') renderInstallBanner();
  });
  window.addEventListener('resize', () => { if (state.view === 'record') drawWave(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.view === 'home') RENDER.home();
  });
}

async function prepareModel() {
  state.model.error = '';
  state.model.active = true;
  renderModelStatus();
  try {
    await loadModel(state.settings.model);
    state.model.ready = true;
    toast('Speech model ready.');
  } catch (err) {
    state.model.error = err.message || String(err);
  }
  state.model.active = false;
  renderModelStatus();
}

async function editProject(project) {
  const p = project || { name: '', code: '', glossary: [] };
  state.editingProject = project;
  const ok = await dialog({
    title: project ? 'Edit project' : 'Add project',
    body: `
      <label class="field">Project name <input id="pj-name" value="${esc(p.name)}" required></label>
      <label class="field">Project code (optional) <input id="pj-code" value="${esc(p.code || '')}"></label>
      <label class="field">Key terms and names (optional, comma separated)
        <input id="pj-glossary" value="${esc((p.glossary || []).join(', '))}" placeholder="e.g. Ismailiya, EDC, M&amp;E"></label>
      <p class="fine">Key terms are always spelled exactly as entered in your reports.</p>
      ${project ? '<button type="button" class="btn danger block" id="pj-delete">Delete project</button>' : ''}`,
    ok: 'Save'
  });
  if (!ok) return;
  const name = $('#pj-name').value.trim();
  if (!name) { toast('Project name is required.'); return; }
  const updated = {
    ...p, id: p.id || db.uid(), createdAt: p.createdAt || Date.now(), name,
    code: $('#pj-code').value.trim(),
    glossary: $('#pj-glossary').value.split(',').map(s => s.trim()).filter(Boolean)
  };
  await db.put('projects', updated);
  const i = state.projects.findIndex(x => x.id === updated.id);
  if (i >= 0) state.projects[i] = updated; else state.projects.push(updated);
  // Re-apply terminology to existing notes for this project.
  for (const note of state.notes.filter(n => n.projectId === updated.id && n.status === 'done')) {
    resummarise(note);
    await saveNote(note);
  }
  renderProjects();
  toast('Project saved.');
}

document.addEventListener('click', async e => {
  if (e.target.id !== 'pj-delete') return;
  const project = state.editingProject;
  $('#dlg-cancel').click();
  if (!project) return;
  if (state.projects.length === 1) { toast('At least one project is required.'); return; }
  if (!(await dialog({ title: `Delete ${project.name}?`, body: '<p>Existing notes will be kept and shown as an unassigned project.</p>', ok: 'Delete', danger: true }))) return;
  await db.del('projects', project.id);
  state.projects = state.projects.filter(p => p.id !== project.id);
  renderProjects();
});

async function offerReminder() {
  const ok = await dialog({
    title: 'Set your Thursday reminder',
    body: `<p>Add a weekly calendar alert every Thursday at ${esc(state.settings.reminderTime)} so you never miss your report. You can change the time in Settings.</p>`,
    ok: 'Add to calendar', cancel: 'Later'
  });
  if (ok) download('weekly-report-reminder.ics', buildICS(state.settings.reminderTime, APP_URL), 'text/calendar;charset=utf-8');
}

async function shareReport() {
  if (!state.currentReport) return;
  const text = reportToText(state.currentReport);
  const title = `Weekly Report: ${state.currentReport.name}, ${state.currentReport.week}`;
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const to = state.settings.profile.recipient || '';
  location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
}

/* ---------- Boot ---------- */

async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  wire();
  await loadState();
  await enforceRetention().catch(() => {});
  // Notes interrupted mid-processing (app closed) are resumed.
  state.notes.filter(n => n.status === 'processing').forEach(n => { n.status = 'queued'; });

  if (!state.settings.onboarded) {
    show('onboarding', {}, { replace: true });
    return;
  }
  const action = new URLSearchParams(location.search).get('action');
  history.replaceState({ view: 'home', opts: {} }, '', './');
  if (action === 'record') await show('record', { mode: 'new' });
  else if (action === 'report') await show('report');
  else await show('home', {}, { replace: true });
  processQueue();
}

boot().catch(err => {
  console.error(err);
  document.getElementById('app').innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="muted">${esc(err.message || String(err))}</p><p class="fine">Please make sure you are using Safari on iPhone or Chrome on Android, and that private browsing is off.</p></div>`;
});
