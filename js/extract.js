// Automatic analysis of a voice note: finds which project(s) the speaker
// talks about and splits the note into one group per project, each with
// its own achievements, challenges, priorities and support. Users never
// pick a project or a tag. Runs on the device.
import { summarise, predictTitle, splitSentences, applyGlossary, editDistance } from './summarize.js';
import { polish, NOT_NAMES } from './editor.js';

export const GENERAL = 'General';

const NAME = "[A-Z][\\w&'.-]*(?:\\s+(?:of\\s+|and\\s+|for\\s+|&\\s+)?[A-Z][\\w&'.-]*){0,4}";
const KIND = '(?:project|programme|program|initiative|grant|account|contract|activity)';
const EXPLICIT = [
  // "the project called Edu Nexus", "programme AI Ready Egypt"
  new RegExp(`\\b${KIND}\\s+(?:called\\s+|named\\s+|titled\\s+)?(${NAME})`),
  // "the Digital Classroom project", "on AA project"
  new RegExp(`\\b(${NAME})\\s+${KIND}\\b`),
  // Sentence opening: "For Edu Nexus, ...", "On AA: ...", "Moving to Jusoor, ..."
  new RegExp(`^(?:so,?\\s+|and\\s+|now,?\\s+|also,?\\s+)?(?:on|for|regarding|about|under|with|moving (?:on )?to|turning to|as for)\\s+(?:the\\s+)?(${NAME})\\s*[,:]`)
];

const BAD_NAME = /^(the|this|that|our|my|each|every|another|one|first|second|next|last|new|main|whole|same)$/i;

export function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(the|project|programme|program|initiative)\b/g, '')
    .replace(/[^a-z0-9&]+/g, ' ').trim();
}

function cleanName(raw) {
  const words = raw.trim().split(/\s+/);
  while (words.length && (NOT_NAMES.has(words[0]) || BAD_NAME.test(words[0]))) words.shift();
  while (words.length && (NOT_NAMES.has(words[words.length - 1]) || /^(of|and|for|&)$/i.test(words[words.length - 1]))) words.pop();
  const name = words.join(' ').replace(/[.,;:]+$/, '');
  return name.length > 1 ? name : '';
}

// Finds an existing project for a spoken name, tolerating small mis-hearings.
export function matchKnown(name, known) {
  const n = normName(name);
  if (!n) return null;
  for (const p of known) {
    const aliases = [p.name, p.code, ...(p.aliases || [])].filter(Boolean).map(normName);
    if (aliases.includes(n)) return p;
  }
  for (const p of known) {
    const pn = normName(p.name);
    if (pn.length >= 4 && (pn.includes(n) && n.length >= 4 || n.includes(pn))) return p;
    if (pn.length >= 5 && Math.abs(pn.length - n.length) <= 2 && editDistance(pn, n) <= Math.floor(pn.length / 5)) return p;
  }
  return null;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Pattern for a known name that tolerates spacing and hyphen differences
// ("roll out" vs "Rollout", "Edu-Nexus" vs "Edu Nexus").
function loosePattern(alias) {
  const chars = alias.replace(/[\s-]+/g, '').split('');
  return chars.length >= 4 ? chars.map(escapeRe).join('[\\s-]*') : escapeRe(alias);
}

// Returns the project a sentence switches to, if it names one.
function detectProject(sentence, known) {
  // Known projects first, by name, code or alias, longest first.
  const aliases = known.flatMap(p => [p.name, p.code, ...(p.aliases || [])].filter(Boolean).map(a => ({ a, p })))
    .sort((x, y) => y.a.length - x.a.length);
  for (const { a, p } of aliases) {
    const m = sentence.match(new RegExp(`(?:^|[^\\w])(${loosePattern(a)})(?=$|[^\\w])`, 'i'));
    if (m) return { name: p.name, alias: m[1] };
  }
  // Lower-case the first letter so sentence-initial "Moving to X," matches.
  const s0 = sentence.charAt(0).toLowerCase() + sentence.slice(1);
  for (const re of EXPLICIT) {
    const m = s0.match(re);
    if (m) {
      const name = cleanName(m[1]);
      if (name) {
        const k = matchKnown(name, known);
        return { name: k ? k.name : name, alias: m[1].trim() };
      }
    }
  }
  return null;
}

// Removes the spoken project reference so it does not become a bullet.
function stripMention(sentence, alias) {
  const a = escapeRe(alias);
  const lead = new RegExp(`^(?:(?:so|and|now|also|next|then)[,]?\\s+)?(?:(?:on|for|regarding|about|under|in|with|moving (?:on )?to|turning to|as for|this is (?:about|for)|starting with)\\s+)?(?:the\\s+)?(?:${KIND}\\s+(?:called\\s+|named\\s+)?)?${a}(?:\\s+${KIND})?\\s*[,:.]?\\s*`, 'i');
  let s = sentence.replace(lead, '');
  if (s !== sentence && /^(is|was|are|were|has|have|had|will|remains?|continues?)\b/i.test(s)) s = `The project ${s}`;
  s = s.replace(new RegExp(`\\b(?:the\\s+)?${a}\\s+${KIND}\\b`, 'i'), 'the project');
  return s.trim();
}

/**
 * Analyses a transcript into project groups.
 * @param {string} transcript
 * @param {Array} known       projects learned so far ({ name, code, glossary, aliases })
 * @param {string} fallback   project to use when no project is named
 * @returns {{ title: string, groups: Array<{ name: string, sections: object }> }}
 */
export function analyse(transcript, known, fallback) {
  const terms = known.flatMap(p => [p.name, p.code, ...(p.glossary || [])]).filter(Boolean);
  const text = polish(applyGlossary(transcript || '', terms));
  const chunks = [];
  let current = null;
  for (const sentence of splitSentences(text)) {
    const hit = detectProject(sentence, known);
    let body = sentence;
    if (hit) {
      body = stripMention(sentence, hit.alias);
      if (!current || normName(current.name) !== normName(hit.name)) {
        current = chunks.find(c => c.name && normName(c.name) === normName(hit.name)) || null;
        if (!current) { current = { name: hit.name, sentences: [] }; chunks.push(current); }
      }
    } else if (!current) {
      current = { name: null, sentences: [] };
      chunks.push(current);
    }
    if (body && /\w/.test(body)) current.sentences.push(/[.!?]$/.test(body) ? body : body + '.');
  }

  // Sentences before the first project mention belong to the first named project.
  const named = chunks.filter(c => c.name);
  const unnamed = chunks.filter(c => !c.name);
  if (named.length) {
    for (const u of unnamed) named[0].sentences.unshift(...u.sentences);
  } else if (unnamed.length) {
    unnamed[0].name = fallback || GENERAL;
    named.push(unnamed[0]);
    for (const u of unnamed.slice(1)) named[0].sentences.push(...u.sentences);
  }

  const groups = [];
  for (const c of named) {
    const project = matchKnown(c.name, known);
    const sections = summarise(c.sentences.join(' '), {
      glossary: project?.glossary || [],
      projectTerms: [c.name, project?.code].filter(Boolean)
    });
    const count = sections.achievements.length + sections.challenges.length + sections.priorities.length + sections.support.length;
    if (count) groups.push({ name: c.name, sections });
  }
  const title = groups.length > 1
    ? `${groups.map(g => g.name).join(groups.length > 2 ? ', ' : ' and ')} updates`
    : predictTitle(groups.length ? text : transcript, groups[0]?.sections);
  return { title, groups };
}
