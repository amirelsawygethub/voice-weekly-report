// Writing coach: checks a processed note against what a good weekly report
// needs and suggests what to add or clarify, so colleagues learn to dictate
// complete, specific notes. Runs on the device.
import { findUnknownTerms } from './editor.js';

const VAGUE = /\b(some|several|things?|stuff|a lot|lots of|various|etc|soon|later|somehow|bigger circle|kind of)\b/i;

export function coach(note, projects) {
  const s = note.sections || {};
  const tips = [];

  if (s.achievements?.length && !s.achievements.some(b => /\d/.test(b))) {
    tips.push({ text: 'Tip: a number, date or percentage makes progress clearer.' });
  }
  const vague = [...(s.achievements || []), ...(s.challenges || []), ...(s.priorities || [])].find(b => VAGUE.test(b));
  if (vague) tips.push({ text: `Tip: this point could be more specific (who, what, how many): "${vague}"` });

  const general = projects.find(p => p.name === 'General');
  if (general && (note.groups || []).some(g => g.projectId === general.id)) {
    tips.push({ text: 'Tip: name the project as you start, for example "On the Edu Nexus project...", so the note is filed correctly.' });
  }

  for (const t of note.aiTips || []) tips.push({ text: t });

  const known = projects.flatMap(p => [p.name, p.code, ...(p.glossary || []), ...(p.aliases || [])]);
  for (const term of findUnknownTerms(note.transcript || '', known)) {
    tips.push({ text: `Is "${term}" spelled correctly? Add it to key terms so it is always written the same way.`, term, action: 'Add to key terms' });
  }
  return tips.slice(0, 5);
}
