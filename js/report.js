// Builds the weekly report from processed notes.
import { SECTIONS, similar, stripDashes } from './summarize.js';

export const MAX_PER_SECTION = 5;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function weekBounds(date, weekStart = 0, offset = 0) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() - weekStart + 7) % 7;
  const start = new Date(d);
  start.setDate(d.getDate() - diff + offset * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  const lastWorkday = new Date(start);
  lastWorkday.setDate(start.getDate() + 4);
  return { start, end, lastWorkday };
}

export function formatRange(start, lastDay) {
  const sameMonth = start.getMonth() === lastDay.getMonth();
  const sameYear = start.getFullYear() === lastDay.getFullYear();
  const left = sameMonth ? `${start.getDate()}` : `${start.getDate()} ${MONTHS[start.getMonth()]}${sameYear ? '' : ' ' + start.getFullYear()}`;
  return `${left} to ${lastDay.getDate()} ${MONTHS[lastDay.getMonth()]} ${lastDay.getFullYear()}`;
}

export function formatDate(ts) {
  const d = new Date(ts);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

export function weekKey(start) {
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
}

// Entries are { text, noteId } so each report point can link to its note.
function dedupe(list) {
  const out = [];
  // Later notes win, so corrections replace earlier near-duplicates.
  for (let i = list.length - 1; i >= 0; i--) {
    if (!out.some(b => similar(b.text, list[i].text))) out.unshift(list[i]);
  }
  return out;
}

// notes: decrypted notes with { projectId, createdAt, sections }
export function buildReport({ notes, projects, profile, start, lastWorkday }) {
  const byProject = new Map();
  const sorted = [...notes].sort((a, b) => a.createdAt - b.createdAt);
  for (const n of sorted) {
    if (!n.sections) continue;
    if (!byProject.has(n.projectId)) byProject.set(n.projectId, { achievements: [], challenges: [], priorities: [], support: [], noneSupport: false, noneChallenges: false });
    const agg = byProject.get(n.projectId);
    for (const s of SECTIONS) agg[s.key].push(...(n.sections[s.key] || []).map(text => ({ text, noteId: n.id })));
    if (n.sections.none?.support) agg.noneSupport = true;
    if (n.sections.none?.challenges) agg.noneChallenges = true;
  }

  const order = projects.map(p => p.id);
  const projectBlocks = [...byProject.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([projectId, agg]) => {
      const project = projects.find(p => p.id === projectId) || { name: 'Unassigned project' };
      const sections = SECTIONS.map(s => {
        const all = dedupe(agg[s.key].map(e => ({ ...e, text: stripDashes(e.text) })));
        const kept = all.slice(-MAX_PER_SECTION);
        return { ...s, items: kept.map(e => e.text), sources: kept.map(e => e.noteId), omitted: all.length - kept.length };
      });
      return { project, sections };
    });

  return {
    name: profile.name || '',
    week: formatRange(start, lastWorkday),
    projects: projectBlocks
  };
}

export function projectTitle(p) {
  return p.code ? `${p.name} (${p.code})` : p.name;
}

export function reportToText(report) {
  const lines = ['Weekly Report', `Name: ${report.name}`, `Week: ${report.week}`];
  for (const block of report.projects) {
    lines.push('', `Project: ${projectTitle(block.project)}`);
    for (const s of block.sections.filter(x => x.items.length)) {
      lines.push('', s.label);
      s.items.forEach(i => lines.push(`• ${i}`));
    }
  }
  return stripDashes(lines.join('\n'));
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function reportToHTML(report) {
  let html = `<h2>Weekly Report</h2><div class="meta"><strong>Name:</strong> ${esc(report.name)}<br><strong>Week:</strong> ${esc(report.week)}</div>`;
  for (const block of report.projects) {
    html += `<h3 class="project">Project: ${esc(projectTitle(block.project))}</h3>`;
    // Sections with nothing reported are left out rather than filled with placeholders.
    for (const s of block.sections.filter(x => x.items.length)) {
      html += `<h4>${esc(s.label)}</h4><ul>`;
      html += s.items.map((i, k) => s.sources?.[k]
        ? `<li class="point" data-note="${esc(s.sources[k])}" role="button" tabindex="0" title="Open the note">${esc(i)}</li>`
        : `<li>${esc(i)}</li>`).join('');
      html += '</ul>';
      if (s.omitted) html += `<div class="fine">${s.omitted} earlier point(s) condensed. Delete or re-record notes to adjust.</div>`;
    }
  }
  return html;
}

export { esc };
