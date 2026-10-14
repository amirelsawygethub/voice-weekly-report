// Writing coach: checks a processed note against what a good weekly report
// needs and suggests what to add or clarify, so colleagues learn to dictate
// complete, specific notes. Runs on the device.
import { findUnknownTerms } from './editor.js';

const VAGUE = /\b(some|several|things?|stuff|a lot|lots of|various|etc|soon|later|somehow|bigger circle|kind of)\b/i;

export function coach(note, project) {
  const s = note.sections || {};
  const tips = [];

  if (!s.achievements?.length) {
    tips.push({ text: 'No progress was captured. Add a short voice note on what you completed this week.', tag: 'Achievements', action: 'Add progress' });
  } else if (!s.achievements.some(b => /\d/.test(b))) {
    tips.push({ text: 'Add a measurable result, such as a number, a date or a percentage, to show progress clearly.' });
  }
  if (!s.challenges?.length && !s.none?.challenges) {
    tips.push({ text: 'Challenges were not mentioned. If there were none, simply say "No challenges this week."', tag: 'Challenges', action: 'Add challenges' });
  }
  if (!s.priorities?.length) {
    tips.push({ text: 'Priorities for next week were not mentioned. Say "Next week I will..." followed by your top actions.', tag: 'Priorities', action: 'Add priorities' });
  }
  if (!s.support?.length && !s.none?.support) {
    tips.push({ text: 'Say what support you need and from whom, or "No support needed."', tag: 'Support Needed', action: 'Add support' });
  }

  const vague = [...(s.achievements || []), ...(s.challenges || []), ...(s.priorities || [])].find(b => VAGUE.test(b));
  if (vague) tips.push({ text: `Make this point more specific (who, what, how many): "${vague}"` });

  for (const t of note.aiTips || []) tips.push({ text: t });

  const known = [project?.name, project?.code, ...(project?.glossary || [])];
  for (const term of findUnknownTerms(note.transcript || '', known)) {
    tips.push({ text: `Is "${term}" spelled correctly? Add it to the project's key terms so it is always written the same way.`, term, action: 'Add to key terms' });
  }
  return tips.slice(0, 6);
}
