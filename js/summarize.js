// Converts a voice-note transcript into concise, business-formal bullets
// grouped into the four mandatory weekly report sections. Runs entirely on
// the device with deterministic rules, so no text is sent to any service.
import { polish, stripMeta } from './editor.js';

export const SECTIONS = [
  { key: 'achievements', label: 'Achievements / Progress', tag: 'Achievements', empty: 'No progress reported this week.' },
  { key: 'challenges', label: 'Challenges Faced', tag: 'Challenges', empty: 'None reported this week.' },
  { key: 'priorities', label: 'Priorities for Next Week', tag: 'Priorities', empty: 'To be confirmed.' },
  { key: 'support', label: 'Support Needed', tag: 'Support Needed', empty: 'No support required this week.' }
];

const TAG_TO_KEY = Object.fromEntries(SECTIONS.map(s => [s.tag, s.key]));

// Strong cues mark a deliberate change of topic and persist to the next sentences.
const STRONG = [
  ['support', /\b(i|we) (would )?(need|require|request|am requesting|are requesting)\b.*\b(support|help|assistance|approval|input|guidance)\b|\b(support|help|assistance) (needed|required|requested)\b|\bsupport (with|from|on)\b|\bno (support|help|assistance)\b|\b(don't|do not) need (any )?(support|help|assistance)\b/],
  ['priorities', /\bnext week\b|\bpriorit(y|ies)\b|\bcoming week\b|\bgoing forward\b/],
  ['challenges', /\b(challenges?|obstacles?|blockers?|problems?|issues?|difficult(y|ies)|risks?|concerns?)\b( (i|we) (faced|had|encountered|ran into))? (was|were|is|are|include[sd]?)\b|^(the |one |another |my |our )?(main |key |biggest |major )?(challenges?|obstacles?|blockers?|problems?|issues?|difficult(y|ies)|risks?)\b|\bno (challenges|issues|problems|blockers)\b/],
  ['achievements', /\bthis week,? (i|we)\b|\b(achievements?|accomplishments?|highlights?)\b|\bprogress (this week|so far)\b/]
];

// Weak cues classify a single sentence without changing the running section.
const WEAK = {
  achievements: /\b(completed?|finished|delivered|launched|finali[sz]ed|submitted|achieved|accomplished|managed to|successfully|signed|approved|held|conducted|trained|onboarded|published|closed|resolved)\b/,
  challenges: /\b(delay(ed|s)?|blocked|wait(ing)? (on|for)|pending|postponed|cancel+ed|rescheduled|on hold|stalled|struggl\w*|unable to|could ?n[o']t|failed|shortage|unstable|lack of|behind schedule|overdue|bottleneck|pending approval|risk)\b/,
  priorities: /\b(i|we) (will|'ll|plan to|intend to|am going to|are going to|aim to)\b|\b(i'll|we'll)\b|\bupcoming\b|\bby (monday|tuesday|wednesday|thursday|friday|sunday|saturday|the end of)\b/,
  support: /\b(need|require) (help|support|approval|assistance|guidance)\b|\bhelp from\b/
};

const NONE = {
  support: /\b(no|don't need any|do not need any|nothing needed in terms of)\s+(support|help|assistance)\b|\bno support (is )?(needed|required)\b/,
  challenges: /\bno (major |significant |real )?(challenges|issues|problems|blockers)\b/
};

const FILLERS = /\b(um+|uh+|erm+|hmm+|ah+|you know|i mean|basically|actually|kind of|sort of|literally)\b,?\s*/gi;
const SKIP = /^(that'?s (it|all)|thank you|thanks|okay|ok|right|so|yeah|yes|no|end of (note|report|update)|that is all)\.?$/i;

const NUMBER_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

const ACTION_VERBS = 'complete|run|prepare|finali[sz]e|start|begin|continue|submit|deliver|review|meet|follow up|draft|share|organi[sz]e|schedule|launch|test|train|update|send|hold|conduct|coordinate|present|develop|write|close|resolve|finish|confirm|circulate|engage|visit|onboard|support|plan|monitor|collect|analy[sz]e';

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Restores the exact spelling of project names, codes and glossary terms.
export function applyGlossary(text, terms) {
  let out = text;
  const sorted = [...new Set(terms.filter(Boolean).map(t => t.trim()).filter(t => t.length > 1))].sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    const pattern = escapeRe(term).replace(/\s*&\s*/g, '\\s*(?:&|and)\\s*').replace(/\\-|\s+/g, '[\\s-]*');
    out = out.replace(new RegExp(`(^|[^\\w])${pattern}(?=$|[^\\w])`, 'gi'), (m, pre) => pre + term);
  }
  // Fuzzy pass for single-word names the recogniser misspells (e.g. "Ismaelia").
  const singles = sorted.filter(t => /^[A-Za-z]{6,}$/.test(t));
  if (singles.length) {
    out = out.replace(/\b[A-Za-z]{5,}\b/g, word => {
      const lw = word.toLowerCase();
      for (const term of singles) {
        const lt = term.toLowerCase();
        if (lw !== lt && Math.abs(lw.length - lt.length) <= 2 && lw[0] === lt[0] && editDistance(lw, lt) <= Math.floor(lt.length / 4)) return term;
      }
      return word;
    });
  }
  return out;
}

export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function numbersToDigits(text) {
  const tens = Object.keys(NUMBER_WORDS).join('|');
  const units = Object.keys(UNITS).join('|');
  return text
    .replace(new RegExp(`\\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\\s-](${units})\\b`, 'gi'),
      (m, t, u) => String(NUMBER_WORDS[t.toLowerCase()] + UNITS[u.toLowerCase()]))
    .replace(new RegExp(`\\b(${tens})\\b`, 'gi'), m => String(NUMBER_WORDS[m.toLowerCase()]));
}

export function normalise(text) {
  return numbersToDigits(text)
    .replace(/[—–]/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(FILLERS, '')
    .replace(/\[(.*?)\]|\((?:music|silence|inaudible|blank_audio)\)/gi, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function splitSentences(text) {
  const protectedText = text.replace(/(\d)\.(\d)/g, '$1․$2').replace(/\b(e\.g|i\.e|etc|vs|approx|dept|no)\./gi, m => m.replace('.', '․'));
  const parts = protectedText.match(/[^.!?]+[.!?]*/g) || [];
  return parts.map(p => p.replace(/․/g, '.').trim()).filter(Boolean);
}

const FUTURE_JOIN = /,?\s+(?:that|which|and|so|then)\s+(?=(?:i|we|they)\s+(?:will|'ll|shall|plan to|are going to|am going to|intend to|aim to)\b)|,\s+(?=(?:i|we)\s+(?:will|'ll)\b)/i;

function splitClauses(sentence) {
  return sentence
    .split(/;\s+|,?\s+\b(?:but|however|although|whereas)\b,?\s+/i)
    .flatMap(c => c.split(FUTURE_JOIN))
    .map(s => s.trim())
    .filter(Boolean);
}

function strongCue(lower) {
  for (const [key, re] of STRONG) if (re.test(lower)) return key;
  return null;
}

function weakCue(lower) {
  const hits = Object.entries(WEAK).filter(([, re]) => re.test(lower)).map(([k]) => k);
  return hits.length === 1 ? hits[0] : null;
}

const LEADS = [
  /^(and|so|also|then|but|however|additionally|in addition|moreover|furthermore|well|okay|ok|right|now|as well|firstly|secondly|thirdly|first|second|third|finally|lastly|regarding [^,]+|in terms of [^,]+|on the [^,]+ side)\b,?\s*/i,
  /^(for|on|regarding|about|with|as for|in) (the )?[^,]{2,40},\s*/i,
  /^(the )?project [^,.]{2,50},\s*/i,
  /^(this week|last week|today|yesterday|for this week|for next week|next week|during the week|over the week|this past week|so far|in the coming week|going forward)\b,?\s*/i,
  /^(my |our |the )?(main |key |biggest |major |primary |top )?(achievements?|accomplishments?|progress|highlights?|updates?)( for| this| this week)*( (was|were|is|are|include[sd]?|that))?:?\s*/i,
  /^(the |my |our |one |another )?(main |key |biggest |major |primary |other )?(challenges?|issues?|problems?|obstacles?|blockers?|difficult(y|ies)|risks?|concerns?)( this week| (that )?(i|we) (faced|had|encountered|ran into))?( (was|were|is|are|include[sd]?|remains?))?:?\s*(that\s+)?/i,
  /^(my |our |the )?(main |key |top )?priorit(y|ies)( for next week| next week)?( (is|are|will be|include))?:?\s*(to\s+)?/i,
  /^(the )?support (needed|required|requested)( is| would be)?:?\s*/i,
  /^(i|we) (would )?(also )?(need|require|request|am requesting|are requesting)( some| additional| further)? (support|help|assistance|guidance)( from [^,]+?)?( (with|on|for|in|regarding|to))?\s+/i,
  /^(i|we) (would )?(also )?(need|require|request)\s+/i,
  /^(correction|update|amendment)( for| to| on)? [a-z ]*?:\s*/i
];

const PROGRESSIVE = { working: 'Worked', focusing: 'Focused', preparing: 'Continued preparing', drafting: 'Continued drafting', reviewing: 'Reviewed', developing: 'Continued developing', finalising: 'Finalising', finalizing: 'Finalizing', coordinating: 'Coordinated', following: 'Followed' };

const PRONOUN_LEADS = [
  [/^(i|we) (was|were) (working|focusing|preparing|drafting|reviewing|developing|finalising|finalizing|coordinating|following)\b\s*/i, (m, p, v, ing) => `${PROGRESSIVE[ing.toLowerCase()]} `],
  [/^(was|were) (working|focusing|preparing|drafting|reviewing|developing|coordinating|following)\b\s*/i, (m, v, ing) => `${PROGRESSIVE[ing.toLowerCase()]} `],
  [/^(i|we)( am| are|'m|'re)?( still)? wait(ing)? (for|on)\s+/i, 'Awaiting '],
  [/^(i|we)('ll| will| shall| am going to| are going to|'m going to|'re going to| plan to| intend to| need to| want to| aim to| hope to| expect to| would like to)( also)?\s+/i, ''],
  [/^(i|we) (was|were) able to\s+/i, 'Managed to '],
  [/^(i|we)('ve| have| had)( also)?\s+(?=\w+(ed|en|t)\b)/i, ''],
  [/^(i'm|i am|we're|we are)( currently| still)?\s+/i, ''],
  [/^(i|we)( also)?\s+/i, '']
];

function cleanBullet(raw) {
  let s = raw.trim().replace(/^[,;:\s]+/, '');
  for (let i = 0; i < 4; i++) {
    const before = s;
    for (const re of LEADS) s = s.replace(re, '');
    if (s === before) break;
  }
  for (const [re, rep] of PRONOUN_LEADS) {
    if (re.test(s)) { s = s.replace(re, rep); break; }
  }
  s = s
    .replace(/[—–]/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,;:\s]+$/, '')
    .replace(/[.!]+$/, '')
    .trim();
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[?]$/.test(s)) s += '.';
  return s;
}

function wordCount(s) { return s.split(/\s+/).filter(Boolean).length; }

// Splits long bullets that join two actions, for example "... and finalised the plan".
function splitCompound(bullet) {
  if (wordCount(bullet) <= 8) return [bullet];
  const re = new RegExp(`,?\\s+and\\s+(?=(also\\s+)?(\\w+ed\\b|${ACTION_VERBS}\\b|met\\b|held\\b|ran\\b|began\\b|built\\b|wrote\\b|sent\\b|led\\b|made\\b|got\\b|set up\\b))`, 'i');
  const m = bullet.match(re);
  if (!m) return [bullet];
  const left = bullet.slice(0, m.index);
  const right = bullet.slice(m.index + m[0].length);
  if (wordCount(left) < 3 || wordCount(right) < 3) return [bullet];
  return [cleanBullet(left), ...splitCompound(cleanBullet(right))];
}

const OBJECT_RE = /\b(?:on|finish(?:ed|ing)|draft(?:ed|ing)|prepar(?:ed|ing)|finali[sz](?:ed|ing)|complet(?:ed|ing)|wr(?:ote|iting)|review(?:ed|ing)|shar(?:ed|ing)|submitt(?:ed|ing)|sen(?:t|ding)|develop(?:ed|ing)|updat(?:ed|ing)|revis(?:ed|ing)|start(?:ed|ing)|design(?:ed|ing)) (the|our|a|an) ([\w&-]+(?: [\w&-]+){0,3}?)(?= for\b| to\b| with\b| in\b| by\b| that\b| which\b| and\b|,|\.|;|$)/i;

const DELIVERABLES = 'briefing note|concept note|policy brief|position paper|proposal|report|plan|workshop|training|meeting|survey|budget|presentation|strategy|framework|review|assessment|curriculum|module|event|visit|session|contract|agreement|launch|pilot|study|toolkit|guidelines|handbook|agenda|roadmap|website|platform|campaign|conference|application|submission|evaluation|baseline|document|draft|memo|newsletter|tender';
const TITLE_RE = new RegExp(`\\b((?:[\\w&-]+ ){0,2}?(?:${DELIVERABLES}))((?: (?:for|on|with|to|about) (?:the )?[A-Z][\\w&'-]*(?: (?:of |and |for )?[A-Z][\\w&'-]*)*))?`, 'g');

// Predicts a short title naming the note's main topic.
export function predictTitle(transcript, sections, projectTerms = []) {
  const text = normalise(polish(transcript || ''));
  let best = null;
  for (const m of text.matchAll(TITLE_RE)) {
    let head = m[1];
    for (let i = 0; i < 3; i++) head = head.replace(/^(the|a|an|our|my|this|that|some|on|of|in|for|to|with|held|met|had|did|made|\w+ed|\w+ing) /i, '');
    if (/^(next|last|this) /i.test(head)) continue;
    const score = (m[2] ? 3 : 0) + (/[A-Z]/.test(m[1]) ? 1 : 0) + head.split(' ').length * 0.1;
    if (!best || score > best.score) best = { score, title: (head + (m[2] || '')).trim() };
  }
  let title = best ? best.title : '';
  if (!title) {
    const first = SECTIONS.map(s => (sections && sections[s.key]) || []).flat()[0] || '';
    title = first.replace(/[.!?]$/, '').split(/\s+/).slice(0, 7).join(' ');
  }
  if (!title) return 'Weekly update';
  title = title.replace(/[.,;:]$/, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function isProjectMention(s, projectTerms) {
  const lower = s.toLowerCase().replace(/[.!?]$/, '');
  if (wordCount(lower) > 8) return false;
  if (/^(project|for project|on project|regarding|about|update (on|for))\b/.test(lower)) return true;
  return projectTerms.some(t => t && lower === t.toLowerCase());
}

export function emptySections() {
  return { achievements: [], challenges: [], priorities: [], support: [], none: { support: false, challenges: false } };
}

export function summarise(transcript, { tags = [], glossary = [], projectTerms = [] } = {}) {
  const result = emptySections();
  const text = normalise(polish(applyGlossary(transcript || '', [...glossary, ...projectTerms])));
  if (!text) return result;

  const tagKeys = tags.map(t => TAG_TO_KEY[t]).filter(Boolean);
  const singleTag = tagKeys.length === 1;
  let current = tagKeys[0] || 'achievements';

  let lastObject = '';
  for (const rawSentence of splitSentences(text)) {
    const sentence = stripMeta(rawSentence);
    if (!sentence || wordCount(sentence) < 3 || SKIP.test(sentence) || isProjectMention(sentence, projectTerms)) continue;
    const sentenceLower = sentence.toLowerCase();
    const sentenceStrong = strongCue(sentenceLower);
    if (sentenceStrong) current = sentenceStrong;

    for (const clause of splitClauses(sentence)) {
      const lower = clause.toLowerCase();
      if (NONE.support.test(lower)) { result.none.support = true; continue; }
      if (NONE.challenges.test(lower)) { result.none.challenges = true; continue; }

      let section = strongCue(lower);
      if (section) current = section;
      else section = (!singleTag && weakCue(lower)) || current;

      // Resolve "it" to the work item named earlier: "present it" -> "present the briefing note".
      const obj = clause.match(OBJECT_RE);
      if (obj) lastObject = `the ${obj[2]}`;
      const resolved = lastObject ? clause.replace(new RegExp(`\\b((?:${ACTION_VERBS}|present|discuss|send|share)(?:d|ed)?)( it)\\b`, 'i'), `$1 ${lastObject}`) : clause;
      const bullet = cleanBullet(resolved);
      if (!bullet || wordCount(bullet) < 2 || SKIP.test(bullet)) continue;
      for (const b of splitCompound(bullet)) if (b && wordCount(b) >= 2) result[section].push(b);
    }
  }
  return result;
}

// Word-overlap similarity used to merge near-duplicate bullets across notes.
// Common words are ignored so two different actions on the same item
// ("Finished the design", "Shared the design") are both kept.
const STOP = new Set('in on of to at by an as is it we be or the and for with from that this have has had was were are our their into onto about over under next week will been also than then them they its'.split(' '));
function tokens(s) { return new Set(s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w))); }
export function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return a.toLowerCase() === b.toLowerCase();
  let inter = 0;
  A.forEach(w => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter) >= 0.7;
}

export function stripDashes(s) {
  return s.replace(/\s*[—–]\s*/g, ', ');
}
