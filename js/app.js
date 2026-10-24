import * as db from './db.js';
import { encryptBytes, decryptBytes, encryptJSON, decryptJSON, resetKeyCache } from './crypto.js';
import { Recorder, isSupported, MAX_SECONDS } from './recorder.js';
import { transcribe, blobToPCM, loadModel, onProgress, DEFAULT_MODEL } from './transcriber.js';
import { SECTIONS, summarise, emptySections, predictTitle } from './summarize.js';
import { coach } from './coach.js';
import { analyse, matchKnown, normName, GENERAL } from './extract.js';
import { weekBounds, formatRange, formatDate, weekKey, buildReport, reportToHTML, reportToText, projectTitle, esc } from './report.js';
import { buildICS, googleCalendarLink, isReminderDue } from './reminder.js';
import * as ai from './ai.js';

const APP_VERSION = '1.6.0';
// Bump when the on-device editing rules change, so older notes are re-edited.
const RULES_VERSION = 8;
const AUDIO_RETENTION_DAYS = 90;
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
  installPrompt: null,
  ai: { enabled: false, mode: 'gemini', geminiKey: '', proxyUrl: '', accessCode: '', apiKey: '' }
};

const DEFAULT_SETTINGS = {
  profile: { name: '' },
  weekStart: 0,
  reminderTime: '17:00',
  model: DEFAULT_MODEL,
  onboarded: false,
  installDismissed: false
};

/* ---------- Persistence ---------- */

async function loadState() {
  state.settings = { ...DEFAULT_SETTINGS, ...((await db.get('settings', 'app')) || {}) };
  state.projects = ((await db.getAll('projects')) || []).sort((a, b) => a.createdAt - b.createdAt);
  try {
    const aiRec = await db.get('settings', 'ai');
    if (aiRec) state.ai = { ...state.ai, ...(await decryptJSON(aiRec)) };
  } catch (err) {
    // Surface the problem instead of silently showing an empty connection.
    console.error(err);
    state.aiLoadError = true;
  }
  const raw = (await db.getAll('notes')) || [];
  state.notes = [];
  for (const n of raw) state.notes.push(await decryptNote(n));
  state.notes.sort((a, b) => b.createdAt - a.createdAt);
}

const saveSettings = () => db.put('settings', state.settings, 'app');
// AI editor credentials are encrypted with the device key.
// Saves the AI connection and reads it back, so a write that the browser
// dropped is reported instead of silently lost.
async function saveAi() {
  const snapshot = JSON.stringify(state.ai);
  await db.put('settings', await encryptJSON(state.ai), 'ai');
  const check = await db.get('settings', 'ai');
  if (!check || JSON.stringify(await decryptJSON(check)) !== snapshot) throw new Error('The connection could not be saved on this device.');
  state.aiLoadError = false;
}

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
  if (note.status === 'done' && note.needsReview) return '<span class="pill warn">Needs review</span>';
  if (note.status === 'processing' && !note.audioIds?.length) return '<span class="pill busy">Analysing</span>';
  const [label, cls] = map[note.status] || ['', ''];
  return `<span class="pill ${cls}">${label}</span>`;
}

function firstBullet(note) {
  if (note.status === 'processing' && note.stage === 'editing') return 'Editing into business-formal bullets';
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
  report: 'Weekly Report', settings: 'Settings', guide: 'Note Guidelines', type: 'Type a Note'
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
  $('#btn-back').hidden = !['record', 'note', 'type'].includes(view);
  $('#tabbar').hidden = ['onboarding', 'record', 'type'].includes(view);
  if (view === 'type') $('#title').textContent = opts.mode === 'correct' ? 'Correct Transcript' : opts.mode === 'append' ? 'Add to Note' : 'Type a Note';
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
            <div class="title">${esc(n.status === 'done' && n.title ? n.title : firstBullet(n))}</div>
            <div class="sub">${esc(noteProjects(n))} · ${esc(formatDate(n.createdAt))}</div>
          </div>
          ${statusPill(n)}
        </button>`).join('')
      : '<div class="empty">No notes recorded yet this week.<br>Tap Record to add your first note.</div>';

    const ab = $('#ai-banner');
    ab.hidden = ai.isConfigured(state.ai) || !!state.settings.aiPromptDismissed;
    ab.innerHTML = '<span>Get sharper wording: connect Google Gemini with your Google account (about 1 minute, free).</span><span class="row gap"><button class="btn primary" id="ai-banner-go">Connect</button><button class="btn ghost" id="ai-banner-x" aria-label="Dismiss">Later</button></span>';
    const rb = $('#reminder-banner');
    rb.hidden = !isReminderDue(state.settings.reminderTime, notes.length);
    rb.innerHTML = 'Your weekly report is due today. Please record your notes. <button class="btn primary" data-go="record">Record</button>';
    renderInstallBanner();
  },

  record(opts) {
    $('#rec-hint').textContent = opts.mode === 'followup' ? 'Adding to an existing note'
      : opts.mode === 'rerecord' ? 'This will replace the existing note'
      : `Just speak. Projects and sections are detected automatically. Up to ${MAX_SECONDS / 60} minutes.`;
    resetRecorderUI();
    if (!isSupported()) {
      $('#rec-hint').textContent = 'Voice recording is not supported in this browser. On iPhone, use Safari. On Android, use Chrome.';
      $('#rec-main').disabled = true;
    }
  },

  async note({ id }) {
    const note = state.notes.find(n => n.id === id);
    if (!note) return show('home', {}, { replace: true });
    const done = note.status === 'done' && note.sections;
    $('#note-project').textContent = done ? noteProjects(note) : 'Detecting project';
    $('#note-title').textContent = done ? (note.title || 'Weekly update') : 'Processing note';
    $('#note-date').textContent = note.audioIds?.length
      ? `${formatDate(note.createdAt)} · ${Math.max(1, Math.round((note.duration || 0) / 60))} min recording`
      : `${formatDate(note.createdAt)} · Typed note`;
    $('#note-review').hidden = !(done && note.needsReview);
    $('#note-review-text').textContent = note.transcript || '';
    $('#note-correct-2').hidden = !done;
    $('#note-status').outerHTML = statusPill(note).replace('<span', '<span id="note-status"');

    const box = $('#note-sections');
    box.classList.toggle('card', !!done);
    if (done) {
      const groups = noteGroups(note);
      const multi = groups.length > 1;
      const pointsHtml = groups.map(g => {
        const secs = SECTIONS.filter(s => g.sections[s.key]?.length)
          .map(s => `<div class="sec"><h4>${esc(s.label)}</h4><ul>${g.sections[s.key].map(i => `<li class="point" role="button" tabindex="0" title="Tap to edit">${esc(i)}</li>`).join('')}</ul></div>`).join('');
        return multi ? `<div class="grp"><h3 class="grp-name">${esc(projectTitle(projectById(g.projectId) || { name: 'Unassigned project' }))}</h3>${secs}</div>` : secs;
      }).join('');
      box.innerHTML = pointsHtml ? pointsHtml + '<p class="fine edit-hint">Tap any point to edit this note.</p>' : '<div class="empty">No report content was detected. Please re-record and describe your progress, challenges, priorities and any support needed.</div>';
    } else if (note.status === 'review') {
      box.innerHTML = '<div class="banner warn">Very little speech was detected. Please re-record in a quieter place, closer to the microphone.</div>';
    } else if (note.status === 'error') {
      box.innerHTML = `<div class="banner warn"><span>${esc(note.error || 'Transcription failed.')}</span><button class="btn primary" id="note-retry">Retry</button></div>`;
    } else {
      box.innerHTML = `<div class="card"><p class="muted">${esc(firstBullet(note))}. You can leave this screen; the note will be ready shortly.</p><div class="progress"><div style="width:${state.model.active ? state.model.pct : 15}%"></div></div></div>`;
    }
    $('#note-transcript').textContent = note.transcript || 'Not yet available.';

    const aiOn = ai.isConfigured(state.ai);
    $('#note-editor').innerHTML = !done ? '' : note.editor === 'ai'
      ? '<span class="badge ai">AI edited</span><span>Wording refined by the AI writing assistant.</span>'
      : `<span class="badge">On-device edit</span>${note.aiError ? `<span>${esc(note.aiError)}</span>` : ''}${aiOn ? '' : '<button class="link-btn" id="ai-banner-go">Connect Google Gemini for sharper wording</button>'}`;
    $('#note-ai').hidden = !(done && note.editor !== 'ai' && aiOn);

    const tips = done ? coach(note, state.projects) : [];
    $('#note-coach').hidden = !tips.length;
    $('#note-tips').innerHTML = tips.map(t => `<li><span>${esc(t.text)}</span>${
      t.term ? `<button class="chip" data-addterm="${esc(t.term)}">${esc(t.action)}</button>` : ''}</li>`).join('');

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
    const done = notes.filter(n => n.status === 'done' && !n.needsReview);
    const awaiting = notes.filter(n => n.status === 'done' && n.needsReview);
    const pendingCount = notes.filter(n => ['queued', 'processing'].includes(n.status)).length;
    const issues = notes.filter(n => ['review', 'error'].includes(n.status)).length;
    const meta = await db.get('reports', weekKey(wk.start));

    let status = '';
    if (meta?.submittedAt) status += `<div class="banner info">Submitted on ${esc(formatDate(meta.submittedAt))}.</div>`;
    if (pendingCount) status += `<div class="banner info">${pendingCount} note(s) are still being transcribed on your device. The report will update automatically.</div>`;
    if (issues) status += `<div class="banner warn">${issues} note(s) need attention. Open them from Home to re-record.</div>`;
    if (awaiting.length) status += `<div class="banner warn"><span>${awaiting.length} note(s) are waiting for you to check the transcript. They are added to the report once confirmed.</span><button class="btn primary" data-note="${esc(awaiting[0].id)}">Review</button></div>`;
    $('#rep-status').innerHTML = status;

    const hasContent = done.length > 0;
    ['#rep-share', '#rep-copy', '#rep-download', '#rep-print', '#rep-submit'].forEach(s => { $(s).disabled = !hasContent; });
    $('#rep-submit').textContent = meta?.submittedAt ? 'Submitted' : 'Mark as submitted';
    if (meta?.submittedAt) $('#rep-submit').disabled = true;

    $('#rep-polish').hidden = true;
    if (!hasContent) {
      $('#rep-body').innerHTML = '<div class="empty">No processed notes for this week yet. Record a note and the report will be generated automatically.</div>';
      state.currentReport = null;
      return;
    }
    state.currentReport = buildReport({ notes: expandGroups(done), projects: state.projects, profile: state.settings.profile, start: wk.start, lastWorkday: wk.lastWorkday });
    state.reportSignature = reportSignature(done);
    let polishedNote = '';
    if (meta?.polished) {
      try {
        const polished = await decryptJSON(meta.polished);
        if (polished.signature === state.reportSignature) {
          applyPolish(state.currentReport, polished.byProject);
          polishedNote = '<div class="banner info">Final wording polished by the AI business-writing editor.</div>';
        } else {
          polishedNote = '<div class="banner warn">Notes changed after the AI polish. Polish again to update the final wording.</div>';
        }
      } catch { /* ignore stale data */ }
    }
    $('#rep-status').innerHTML += polishedNote;
    $('#rep-polish').hidden = !ai.isConfigured(state.ai);
    $('#rep-body').innerHTML = reportToHTML(state.currentReport)
      + (polishedNote.includes('polished by') ? '' : '<p class="fine edit-hint">Tap a point to open and edit the note it came from.</p>');
  },

  async settings() {
    const s = state.settings;
    $('#set-name').value = s.profile.name;
    $('#set-weekstart').value = String(s.weekStart);
    $('#set-time').value = s.reminderTime;
    $('#set-model').value = s.model;
    $('#set-gcal').href = googleCalendarLink(s.reminderTime, APP_URL);
    $('#app-version').textContent = APP_VERSION;
    renderProjects();
    renderModelStatus();
    renderAiSettings();
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      if (est) $('#storage-info').textContent = `Storage used: ${(est.usage / 1048576).toFixed(1)} MB${persisted ? ' · protected from automatic clean-up' : ''}`;
    } catch { /* optional */ }
  },

  guide() {},

  async type(opts) {
    const note = opts.noteId ? state.notes.find(n => n.id === opts.noteId) : null;
    const area = $('#type-text');
    const audio = $('#type-audio');
    if (audio.dataset.url) URL.revokeObjectURL(audio.dataset.url);
    audio.removeAttribute('src');
    audio.hidden = true;
    if (opts.mode === 'correct' && note) {
      $('#type-intro').textContent = 'Fix any words the speech recognition got wrong, such as names, numbers or acronyms. Your report is rebuilt from the corrected text.';
      $('#type-label').textContent = 'Transcript';
      area.value = fullTranscript(note);
      $('#type-save').textContent = 'Save corrections';
    } else if (opts.mode === 'append' && note) {
      $('#type-intro').textContent = `Type what you want to add to "${note.title || 'this note'}".`;
      $('#type-label').textContent = 'Addition';
      area.value = '';
      $('#type-save').textContent = 'Add to note';
    } else {
      $('#type-intro').textContent = 'Type your update in plain sentences. There is no need to format it: the project, achievements, challenges, priorities, support and dependencies are picked up automatically.';
      $('#type-label').textContent = 'Your note';
      area.value = '';
      $('#type-save').textContent = 'Save note';
    }
    area.oninput?.();
    // Focus synchronously, while still inside the user's tap: iOS Safari only
    // opens the on-screen keyboard for focus set during the gesture, and a
    // deferred focus can be lost on other browsers too.
    const caret = Number.isInteger(opts.caret) ? Math.min(opts.caret, area.value.length) : area.value.length;
    area.focus({ preventScroll: opts.mode !== 'correct' });
    area.setSelectionRange(caret, caret);

    // Load the recording afterwards so it never delays the keyboard.
    if (opts.mode === 'correct' && note) {
      const last = note.audioIds?.[note.audioIds.length - 1];
      const blob = last ? await loadAudio(last) : null;
      if (blob && state.view === 'type') {
        audio.src = URL.createObjectURL(blob);
        audio.dataset.url = audio.src;
        audio.hidden = false;
      }
    }
  }
};

// Character offset in a transcript paragraph under the pointer, so the editor
// opens with the cursor where the user tapped. Supports both standard
// (caretPositionFromPoint) and WebKit/Blink (caretRangeFromPoint) APIs.
function caretOffsetFromPoint(el, x, y) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { node = pos.offsetNode; offset = pos.offset; }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) { node = range.startContainer; offset = range.startOffset; }
  }
  if (!node || !el.contains(node)) return null;
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

// Position in the transcript of the sentence a bullet came from: the spot
// where most of the bullet's significant words occur together.
function locateInTranscript(point, text) {
  const lower = text.toLowerCase();
  const words = [...new Set(point.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3))];
  let best = { score: 0, index: -1 };
  for (const w of words) {
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) {
      const windowText = lower.slice(Math.max(0, i - 80), i + 160);
      const score = words.filter(x => windowText.includes(x)).length;
      if (score > best.score) best = { score, index: i };
    }
  }
  if (best.index < 0) return null;
  let start = best.index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  while (start < text.length && /\s/.test(text[start])) start++;
  return start;
}

// Clicking (or pressing Enter/Space on) a bullet opens the note's text for
// editing, with the cursor on the sentence that bullet came from.
function openPointEditor(e) {
  const li = e.target.closest('li.point');
  if (!li) return;
  const note = state.notes.find(n => n.id === state.viewOpts.id);
  if (!note || note.status !== 'done') return;
  if (e.type === 'keydown') {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
  }
  if (e.type === 'click' && String(window.getSelection?.() || '').trim()) return;
  show('type', { mode: 'correct', noteId: note.id, caret: locateInTranscript(li.textContent, fullTranscript(note)) });
}

// Clicking (or pressing Enter/Space on) a transcript opens it for correction.
function openTranscriptEditor(e) {
  const note = state.notes.find(n => n.id === state.viewOpts.id);
  if (!note || note.status !== 'done') return;
  if (e.type === 'keydown') {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
  }
  // Let users select text to copy without opening the editor.
  if (e.type === 'click' && String(window.getSelection?.() || '').trim()) return;
  const caret = e.type === 'click' ? caretOffsetFromPoint(e.currentTarget, e.clientX, e.clientY) : null;
  show('type', { mode: 'correct', noteId: note.id, caret });
}

async function saveTyped() {
  const opts = state.viewOpts;
  const text = $('#type-text').value.replace(/[\u2014\u2013]/g, ', ').trim();
  if (text.split(/\s+/).filter(Boolean).length < 4) { toast('Please write a little more (at least a short sentence).'); return; }
  let note = opts.noteId ? state.notes.find(n => n.id === opts.noteId) : null;
  if (opts.mode === 'correct' && note) {
    note.transcriptEdit = { text, segments: (note.segments || []).length };
    note.editor = 'standard';
  } else if (opts.mode === 'append' && note) {
    note.segments = [...(note.segments || []), { audioId: null, text, typed: true }];
  } else {
    note = {
      id: db.uid(), projectId: null, tags: [], groups: [], createdAt: Date.now(), duration: 0,
      audioIds: [], segments: [{ audioId: null, text, typed: true }], transcript: '', sections: null
    };
  }
  // Typed or corrected text has been seen by the user, so no review step is needed.
  note.needsReview = false;
  note.status = 'queued';
  note.error = '';
  note.updatedAt = Date.now();
  await saveNote(note);
  toast(opts.mode === 'correct' ? 'Corrections saved. Rebuilding the note.' : 'Note saved.');
  await show('note', { id: note.id }, { replace: true });
  processQueue();
}

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
    note.transcriptEdit = null;
    note.duration = result.duration;
    note.transcript = '';
    note.sections = null;
  } else {
    note = {
      id: db.uid(), projectId: null, tags: [], groups: [], createdAt: Date.now(), duration: result.duration,
      audioIds: [audioId], segments: [{ audioId, text: null }], transcript: '', sections: null
    };
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
      note.needsReview = true;
      const blob = await loadAudio(seg.audioId);
      if (!blob) { seg.text = ''; continue; }
      const pcm = await blobToPCM(blob);
      seg.text = await transcribe(pcm, state.settings.model);
      await saveNote(note);
    }
    await resummarise(note);
    const words = note.transcript.split(/\s+/).filter(Boolean).length;
    note.status = words < 4 ? 'review' : 'done';
    if (note.status === 'done' && ai.isConfigured(state.ai)) {
      note.status = 'processing';
      note.stage = 'editing';
      refreshIfShowing(note);
      await aiEditNote(note);
      note.status = 'done';
    }
    note.stage = '';
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

// Automatic analysis: detects the project(s) spoken about and extracts the
// four sections for each. Nobody selects a project or a tag.
// The transcript as the user last saw it: their corrected text for the
// segments it covers, plus any segments added after the correction.
function transcriptParts(note) {
  const segs = note.segments || [];
  const edit = note.transcriptEdit;
  const rest = segs.slice(edit ? edit.segments : 0).map(s => (s.text || '').trim());
  return [edit ? edit.text.trim() : '', ...rest].filter(Boolean);
}

function fullTranscript(note) {
  return transcriptParts(note).join('\n\n');
}

async function resummarise(note) {
  note.transcript = fullTranscript(note);
  const fallback = projectById(note.projectId)?.name || (state.projects.length === 1 ? state.projects[0].name : GENERAL);
  // Each recording or typed addition is analysed as its own statement, so an
  // addition does not inherit the section of the previous text's last sentence.
  // An addition that names no project stays with the project last talked about.
  const groups = [];
  let partFallback = fallback;
  for (const part of transcriptParts(note)) {
    const r = analyse(part, state.projects, partFallback);
    for (const g of r.groups) {
      const same = groups.find(x => normName(x.name) === normName(g.name));
      if (same) SECTIONS.forEach(sec => same.sections[sec.key].push(...g.sections[sec.key]));
      else groups.push(g);
    }
    if (r.groups.length) partFallback = r.groups[r.groups.length - 1].name;
  }
  const result = note.transcript ? analyse(note.transcript, state.projects, fallback) : { title: '' };
  // Text the user typed or corrected is trusted for project spelling.
  const trusted = !!note.transcriptEdit || (note.segments || []).every(s => s.typed);
  await setGroups(note, groups, trusted);
  note.title = groups.length > 1
    ? `${groups.map(g => g.name).join(groups.length > 2 ? ', ' : ' and ')} updates`
    : result.title;
  note.editor = 'standard';
  note.aiTips = [];
  note.rulesVersion = RULES_VERSION;
}

// Finds a project by spoken name, or learns it as a new project.
async function resolveProject(name, trusted = false) {
  const known = matchKnown(name, state.projects);
  if (known) {
    // A user-corrected spelling replaces an auto-detected (possibly misheard) name.
    if (trusted && known.auto && normName(known.name) !== normName(name) && name !== GENERAL) {
      known.aliases = [...new Set([...(known.aliases || []), known.name])];
      known.name = name;
      await db.put('projects', known);
    }
    return known;
  }
  const project = { id: db.uid(), name, code: '', glossary: [], createdAt: Date.now(), auto: true };
  await db.put('projects', project);
  state.projects.push(project);
  return project;
}

async function setGroups(note, groups, trusted = false) {
  note.groups = [];
  for (const g of groups) {
    const project = await resolveProject(g.name, trusted);
    const existing = note.groups.find(x => x.projectId === project.id);
    if (existing) SECTIONS.forEach(s => existing.sections[s.key].push(...g.sections[s.key]));
    else note.groups.push({ projectId: project.id, sections: g.sections });
  }
  note.projectId = note.groups[0]?.projectId || note.projectId || null;
  const merged = emptySections();
  for (const g of note.groups) SECTIONS.forEach(s => merged[s.key].push(...(g.sections[s.key] || [])));
  note.sections = merged;
}

function noteGroups(note) {
  return note.groups?.length ? note.groups : (note.sections ? [{ projectId: note.projectId, sections: note.sections }] : []);
}

function noteProjects(note) {
  if (note.status !== 'done') return 'Detecting project';
  return noteGroups(note).map(g => projectName(g.projectId)).join(', ') || 'No project detected';
}

// One report entry per project mentioned in each note.
function expandGroups(notes) {
  return notes.flatMap(n => noteGroups(n).map(g => ({ ...n, projectId: g.projectId, sections: g.sections })));
}

function transcriptForAi(note) {
  return fullTranscript(note);
}

async function addKeyTerm(projectId, term) {
  const project = projectById(projectId);
  if (!project) return;
  project.glossary = [...new Set([...(project.glossary || []), term])];
  await db.put('projects', project);
  for (const note of state.notes.filter(n => noteGroups(n).some(g => g.projectId === projectId) && n.status === 'done' && n.editor !== 'ai')) {
    await resummarise(note);
    await saveNote(note);
  }
  toast(`"${term}" added to key terms. Edit its spelling in Settings if needed.`, 3500);
}

// Second editing layer: Claude rewrites the transcript as business-formal
// bullets. On any failure the standard on-device edit stays in place.
async function aiEditNote(note) {
  try {
    const result = await ai.analyseNote(state.ai, { transcript: transcriptForAi(note), known: state.projects });
    if (result.projects.length) await setGroups(note, result.projects);
    if (result.title) note.title = result.title;
    note.aiTips = result.tips || [];
    note.editor = 'ai';
    note.aiError = '';
  } catch (err) {
    console.error(err);
    note.aiError = ai.friendlyError(err);
  }
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
    const addTerm = e.target.closest('[data-addterm]');
    if (addTerm && state.view === 'note') {
      const note = state.notes.find(n => n.id === state.viewOpts.id);
      if (note) { await addKeyTerm(note.projectId, addTerm.dataset.addterm); RENDER.note({ id: note.id }); }
    }
    const projBtn = e.target.closest('[data-project]');
    if (projBtn) editProject(projectById(projBtn.dataset.project));
    if (e.target.id === 'do-install' && state.installPrompt) {
      state.installPrompt.prompt();
      await state.installPrompt.userChoice.catch(() => {});
      state.installPrompt = null;
      renderInstallBanner();
    }
    if (e.target.id === 'ai-banner-go') {
      state.ai.enabled = true;
      if (!state.ai.mode) state.ai.mode = 'gemini';
      await saveAi().catch(err => console.error(err));
      await show('settings');
      $('#ai-card').scrollIntoView({ block: 'start' });
    }
    if (e.target.id === 'ai-banner-x') {
      state.settings.aiPromptDismissed = true;
      saveSettings();
      $('#ai-banner').hidden = true;
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
    if (!name) { toast('Please enter your name.'); return; }
    state.settings.profile = { name };
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
  $('#note-addtype').onclick = () => show('type', { mode: 'append', noteId: state.viewOpts.id });
  $('#note-correct').onclick = () => show('type', { mode: 'correct', noteId: state.viewOpts.id });
  $('#note-correct-2').onclick = () => show('type', { mode: 'correct', noteId: state.viewOpts.id });
  $('#note-sections').onclick = openPointEditor;
  $('#note-sections').onkeydown = openPointEditor;
  $('#rep-body').onkeydown = e => {
    const li = e.target.closest('li[data-note]');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show('note', { id: li.dataset.note }); }
  };
  for (const sel of ['#note-review-text', '#note-transcript']) {
    $(sel).onclick = openTranscriptEditor;
    $(sel).onkeydown = openTranscriptEditor;
  }
  $('#note-confirm').onclick = async () => {
    const note = state.notes.find(n => n.id === state.viewOpts.id);
    if (!note) return;
    note.needsReview = false;
    note.updatedAt = Date.now();
    await saveNote(note);
    toast('Confirmed. The note is now in your weekly report.');
    RENDER.note({ id: note.id });
  };
  $('#home-type').onclick = () => show('type', { mode: 'new' });
  $('#rec-type').onclick = () => {
    const o = state.viewOpts;
    const target = o.mode === 'followup' ? { mode: 'append', noteId: o.noteId } : { mode: 'new' };
    show('type', target, { replace: true });
  };
  $('#type-text').oninput = () => {
    const n = $('#type-text').value.trim().split(/\s+/).filter(Boolean).length;
    $('#type-count').textContent = `${n} word${n === 1 ? '' : 's'}`;
  };
  $('#type-cancel').onclick = () => history.back();
  $('#type-save').onclick = saveTyped;
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
    const existing = (await db.get('reports', weekKey(wk.start))) || {};
    await db.put('reports', { ...existing, id: weekKey(wk.start), submittedAt: Date.now() });
    toast('Report marked as submitted.');
    RENDER.report();
  };

  // Settings
  const saveProfile = () => {
    state.settings.profile = { name: $('#set-name').value.trim() };
    saveSettings();
  };
  $('#set-name').onchange = saveProfile;
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

  // AI editor
  const readAi = () => {
    state.ai = {
      enabled: $('#ai-enabled').checked,
      mode: $('#ai-mode').value,
      geminiKey: $('#ai-gemini').value.trim(),
      serverUrl: $('#ai-server').value.trim(),
      teamCode: $('#ai-team').value.trim(),
      proxyUrl: $('#ai-proxy').value.trim(),
      accessCode: $('#ai-code').value.trim(),
      apiKey: $('#ai-key').value.trim()
    };
    renderAiSettings();
    return saveAi().then(() => true, err => {
      console.error(err);
      $('#ai-status').textContent = 'Your settings could not be saved on this device. Close and reopen the app, then try again.';
      return false;
    });
  };
  ['#ai-enabled', '#ai-mode', '#ai-gemini', '#ai-server', '#ai-team', '#ai-proxy', '#ai-code', '#ai-key'].forEach(sel => { $(sel).onchange = readAi; });
  const testAi = async () => {
    const saved = await readAi();
    if (!saved) return;
    if (!ai.isConfigured(state.ai)) { $('#ai-status').textContent = 'Turn the editor on and complete the connection details first.'; return; }
    $('#ai-test').disabled = true;
    $('#ai-status').textContent = 'Testing the AI editor...';
    try {
      await ai.testConnection(state.ai);
      $('#ai-status').textContent = 'Connected and saved on this device. New notes will be edited automatically.';
    } catch (err) {
      console.error(err);
      $('#ai-status').textContent = ai.friendlyError(err);
    }
    $('#ai-test').disabled = false;
  };
  $('#ai-test').onclick = testAi;
  // One-tap paste of the key copied from Google AI Studio, then connect.
  $('#gemini-paste').onclick = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) $('#ai-gemini').value = text;
    } catch { /* clipboard blocked: the user can paste into the field */ }
    if (!$('#ai-gemini').value.trim()) {
      $('#ai-gemini').focus();
      $('#ai-status').textContent = 'Paste your key into the field below, then tap Test connection.';
      return;
    }
    $('#ai-enabled').checked = true;
    state.settings.aiPromptDismissed = true;
    saveSettings();
    await testAi();
  };
  $('#note-ai').onclick = async () => {
    const note = state.notes.find(n => n.id === state.viewOpts.id);
    if (!note) return;
    $('#note-ai').disabled = true;
    toast('Editing with the AI editor...');
    await aiEditNote(note);
    note.updatedAt = Date.now();
    await saveNote(note);
    $('#note-ai').disabled = false;
    toast(note.editor === 'ai' ? 'Note edited.' : note.aiError);
    refreshIfShowing(note);
  };
  $('#rep-polish').onclick = polishReport;

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
  const aliases = p.name && p.name !== name ? [...new Set([...(p.aliases || []), p.name])] : (p.aliases || []);
  const updated = {
    ...p, aliases, id: p.id || db.uid(), createdAt: p.createdAt || Date.now(), name,
    code: $('#pj-code').value.trim(),
    glossary: $('#pj-glossary').value.split(',').map(s => s.trim()).filter(Boolean)
  };
  await db.put('projects', updated);
  const i = state.projects.findIndex(x => x.id === updated.id);
  if (i >= 0) state.projects[i] = updated; else state.projects.push(updated);
  // Re-apply terminology to existing notes for this project.
  // Renaming a project to an existing name merges the two.
  const twin = state.projects.find(x => x.id !== updated.id && normName(x.name) === normName(updated.name));
  if (twin) {
    twin.glossary = [...new Set([...(twin.glossary || []), ...updated.glossary])];
    twin.aliases = [...new Set([...(twin.aliases || []), ...(updated.aliases || [])])];
    await db.put('projects', twin);
    for (const note of state.notes) {
      let changed = false;
      for (const g of note.groups || []) if (g.projectId === updated.id) { g.projectId = twin.id; changed = true; }
      if (note.projectId === updated.id) { note.projectId = twin.id; changed = true; }
      if (changed) await saveNote(note);
    }
    await db.del('projects', updated.id);
    state.projects = state.projects.filter(x => x.id !== updated.id);
  }
  const target = twin || updated;
  for (const note of state.notes.filter(n => noteGroups(n).some(g => g.projectId === target.id) && n.status === 'done' && n.editor !== 'ai')) {
    await resummarise(note);
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
  // No stored recipient: the mail app opens and the user picks who to send it to.
  location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
}

/* ---------- AI editor helpers ---------- */

function renderAiSettings() {
  const c = state.ai;
  if (state.aiLoadError) $('#ai-status').textContent = 'Your saved AI connection could not be read on this device. Please connect again.';
  $('#ai-enabled').checked = !!c.enabled;
  $('#ai-mode').value = c.mode || 'gemini';
  $('#ai-gemini').value = c.geminiKey || '';
  $('#ai-server').value = c.serverUrl || '';
  $('#ai-team').value = c.teamCode || '';
  $('#ai-proxy').value = c.proxyUrl || '';
  $('#ai-code').value = c.accessCode || '';
  $('#ai-key').value = c.apiKey || '';
  $('#ai-fields').hidden = !c.enabled;
  document.querySelectorAll('[data-ai]').forEach(el => { el.hidden = el.dataset.ai !== (c.mode || 'gemini'); });
  $('#ai-privacy').textContent = c.mode === 'server'
    ? "Privacy: only transcript text is sent, to your organisation's AI server and on to Google Gemini; audio never leaves this device. No API key is stored on this phone. The team code is stored encrypted on this device."
    : (c.mode || 'gemini') === 'gemini'
    ? 'Privacy: only transcript text is sent to Google; audio never leaves this device. On the free Gemini tier, Google may use submitted text to improve its products and human reviewers may read it, so avoid confidential details or use a paid (billing-enabled) key. Your key is stored encrypted on this device.'
    : 'Privacy: only transcript text is sent to Anthropic; audio never leaves this device. Connection details are stored encrypted on this device.';
}

function reportSignature(notes) {
  return notes.map(n => `${n.id}:${n.updatedAt || n.createdAt}`).sort().join('|');
}

function applyPolish(report, byProject) {
  for (const block of report.projects) {
    const p = byProject[block.project.id];
    if (!p) continue;
    for (const s of block.sections) { s.items = p[s.key] || []; s.sources = []; s.omitted = 0; }
  }
}

async function polishReport() {
  if (!state.currentReport) return;
  const wk = currentWeek(state.reportOffset);
  const notes = notesInWeek(wk).filter(n => n.status === 'done' && !n.needsReview);
  const draft = buildReport({ notes: expandGroups(notes), projects: state.projects, profile: state.settings.profile, start: wk.start, lastWorkday: wk.lastWorkday });
  const blocks = draft.projects.map(b => ({
    project: projectById(b.project.id) || { ...b.project, id: b.project.id || 'unassigned' },
    sections: Object.fromEntries(b.sections.map(s => [s.key, s.items]))
  }));
  $('#rep-polish').disabled = true;
  $('#rep-polish').textContent = 'Polishing...';
  try {
    const byProject = await ai.editWeek(state.ai, blocks);
    const existing = (await db.get('reports', weekKey(wk.start))) || {};
    const polished = await encryptJSON({ signature: reportSignature(notes), byProject });
    await db.put('reports', { ...existing, id: weekKey(wk.start), polished });
    toast('Final wording polished.');
  } catch (err) {
    console.error(err);
    toast(ai.friendlyError(err), 4000);
  }
  $('#rep-polish').disabled = false;
  $('#rep-polish').textContent = 'Polish final wording with AI';
  RENDER.report();
}

/* ---------- Team invite links ---------- */

// An admin shares https://<app>/#join=<code>. The part after # never leaves
// the device, so the team code is not sent to any web server.
async function acceptInvite() {
  const m = location.hash.match(/^#join=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    const json = new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
    const invite = JSON.parse(json);
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(invite.s) || !invite.c) throw new Error('Invalid invite');
    state.ai = { ...state.ai, enabled: true, mode: 'server', serverUrl: invite.s, teamCode: String(invite.c) };
    await saveAi();
    state.settings.aiPromptDismissed = true;
    await saveSettings();
    setTimeout(() => toast("Connected to your team's AI assistant."), 800);
  } catch (err) {
    console.error(err);
    setTimeout(() => toast('This invite link is not valid. Ask your admin for a new one.', 4000), 800);
  }
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
  for (const n of state.notes.filter(n => n.status === 'done' && n.editor === 'ai' && !n.groups?.length && n.sections)) {
    n.groups = [{ projectId: n.projectId, sections: n.sections }];
    await saveNote(n).catch(() => {});
  }
  for (const n of state.notes.filter(n => n.status === 'done' && n.editor !== 'ai' && (n.rulesVersion || 1) < RULES_VERSION)) {
    await resummarise(n);
    await saveNote(n).catch(() => {});
  }
  for (const n of state.notes.filter(n => n.status === 'done' && !n.title && n.transcript)) {
    n.title = predictTitle(n.transcript, n.sections);
    await saveNote(n).catch(() => {});
  }

  await acceptInvite();

  // Ask the browser not to clear this app's data under storage pressure.
  try { if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* optional */ }

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
