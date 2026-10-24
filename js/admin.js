// Team admin page: edit the AI prompts stored on the team server, test them,
// and create the invite link for colleagues. Admin credentials are stored
// encrypted on this device, like the rest of the app's data.
import * as db from './db.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { serverRequest } from './ai.js';
import { SECTIONS } from './summarize.js';
import { esc } from './report.js';

const $ = sel => document.querySelector(sel);
const APP_URL = new URL('./', location.href).href;
let creds = null;      // { url, token, name }
let config = null;     // last config from the server

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function call(action, extra = {}) {
  return serverRequest(creds.url, { action, adminToken: creds.token, ...extra });
}

async function saveCreds() {
  await db.put('settings', await encryptJSON(creds), 'admin');
}

function inviteLink(url, teamCode) {
  const json = JSON.stringify({ s: url, c: teamCode });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${APP_URL}#join=${b64}`;
}

function counts() {
  $('#adm-note-count').textContent = `${$('#adm-note').value.length} / 8000 characters`;
  $('#adm-week-count').textContent = `${$('#adm-week').value.length} / 8000 characters`;
}

function render() {
  const c = config;
  const when = c.updatedAt ? new Date(c.updatedAt).toLocaleString('en-GB') : 'never (using defaults)';
  $('#adm-status').innerHTML = [
    `<li>Gemini key on server: ${c.hasGeminiKey ? 'set' : '<strong>missing</strong>. Add GEMINI_API_KEY in the script properties.'}</li>`,
    `<li>Models: ${esc(c.models)}</li>`,
    `<li>Prompts last changed: ${esc(when)}${c.updatedBy ? ` by ${esc(c.updatedBy)}` : ''}</li>`
  ].join('');
  $('#adm-note').value = c.notePrompt;
  $('#adm-week').value = c.weekPrompt;
  $('#adm-invite').value = c.teamCode ? inviteLink(creds.url, c.teamCode) : 'Set TEAM_CODE on the server first (run setupTokens).';
  $('#adm-restore').disabled = !c.hasPrevious;
  $('#adm-name').value = creds.name || '';
  counts();
}

async function connect() {
  $('#adm-connect').disabled = true;
  $('#adm-login-status').textContent = 'Connecting...';
  try {
    config = await call('adminGetConfig');
    await saveCreds();
    $('#admin-login').hidden = true;
    $('#admin-main').hidden = false;
    render();
  } catch (err) {
    console.error(err);
    $('#adm-login-status').textContent = err.status === 401 ? 'The admin token was not accepted.' : err.message;
  }
  $('#adm-connect').disabled = false;
}

function renderTest(out) {
  let html = `<h4>Title</h4><p>${esc(out.title || '')}</p>`;
  for (const p of out.projects || []) {
    html += `<h3 class="project">Project: ${esc(p.project_name)}</h3>`;
    for (const s of SECTIONS) {
      const items = p[s.key] || [];
      if (items.length) html += `<h4>${esc(s.label)}</h4><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    }
  }
  if (out.tips?.length) html += `<h4>Tips</h4><ul>${out.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
  $('#adm-test-result').innerHTML = html;
}

function wire() {
  $('#adm-connect').onclick = () => {
    const url = $('#adm-url').value.trim();
    const token = $('#adm-token').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) || !token) {
      $('#adm-login-status').textContent = 'Enter the Apps Script web app URL (https://script.google.com/...) and the admin token.';
      return;
    }
    creds = { url, token, name: creds?.name || '' };
    connect();
  };
  $('#adm-signout').onclick = async () => {
    await db.del('settings', 'admin');
    location.reload();
  };
  $('#adm-note').oninput = counts;
  $('#adm-week').oninput = counts;
  $('#adm-note-default').onclick = () => { $('#adm-note').value = config.defaultNotePrompt; counts(); toast('Default restored in the editor. Save to apply it.'); };
  $('#adm-week-default').onclick = () => { $('#adm-week').value = config.defaultWeekPrompt; counts(); toast('Default restored in the editor. Save to apply it.'); };
  $('#adm-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#adm-invite').value); toast('Invite link copied.'); }
    catch { $('#adm-invite').select(); toast('Select the link and copy it.'); }
  };
  $('#adm-share').onclick = async () => {
    const url = $('#adm-invite').value;
    if (navigator.share) {
      try { await navigator.share({ title: 'Voice Weekly Report', text: 'Open this link on your phone to connect the Voice Weekly Report app to our team AI assistant:', url }); } catch { /* cancelled */ }
    } else {
      $('#adm-copy').click();
    }
  };
  $('#adm-test').onclick = async () => {
    $('#adm-test').disabled = true;
    $('#adm-test-result').textContent = 'Running...';
    try {
      const content = `Known projects:\n- none yet\n\n<transcript>\n${$('#adm-sample').value}\n</transcript>`;
      renderTest(await call('adminTest', { notePrompt: $('#adm-note').value, content }));
    } catch (err) {
      console.error(err);
      $('#adm-test-result').textContent = err.message;
    }
    $('#adm-test').disabled = false;
  };
  $('#adm-save').onclick = async () => {
    $('#adm-save').disabled = true;
    $('#adm-save-status').textContent = 'Saving...';
    creds.name = $('#adm-name').value.trim();
    try {
      config = await call('adminSetPrompts', { notePrompt: $('#adm-note').value, weekPrompt: $('#adm-week').value, updatedBy: creds.name });
      await saveCreds();
      render();
      $('#adm-save-status').textContent = 'Saved. Everyone using the team server gets the new prompts on their next note.';
    } catch (err) {
      console.error(err);
      $('#adm-save-status').textContent = err.message;
    }
    $('#adm-save').disabled = false;
  };
  $('#adm-restore').onclick = async () => {
    if (!confirm('Restore the previous prompts for everyone?')) return;
    try {
      config = await call('adminRestorePrevious');
      render();
      toast('Previous prompts restored.');
    } catch (err) {
      toast(err.message, 4000);
    }
  };
}

async function boot() {
  wire();
  try {
    const rec = await db.get('settings', 'admin');
    if (rec) creds = await decryptJSON(rec);
  } catch (err) {
    console.error(err);
  }
  if (creds?.url && creds?.token) {
    $('#adm-url').value = creds.url;
    connect();
  }
}

boot();
