// Business-writing clean-up applied to every transcript, on the device,
// before bullets are written. It removes speech artefacts, meta-talk and
// casual phrasing without changing the facts the speaker gave.

const CASUAL = [
  [/\bgonna\b/gi, 'going to'],
  [/\bwanna\b/gi, 'want to'],
  [/\bgotta\b/gi, 'have to'],
  [/\bgot done\b/gi, 'completed'],
  [/\bget (it |this |that )?done\b/gi, (m, o) => `complete${o ? ' ' + o.trim() : ''}`],
  [/\bfigure(d)? out\b/gi, (m, d) => (d ? 'determined' : 'determine')],
  [/\btouch(ed)? base with\b/gi, (m, d) => (d ? 'followed up with' : 'follow up with')],
  [/\bcheck(ed)? in with\b/gi, (m, d) => (d ? 'followed up with' : 'follow up with')],
  [/\ba bunch of\b/gi, 'several'],
  [/\ba couple of\b/gi, 'two'],
  [/\basap\b/gi, 'as soon as possible'],
  [/\bthe guys\b/gi, 'the team'],
  [/\bstuff like that\b/gi, ''],
  [/\bokay\b/gi, 'OK']
];

// Common spoken phrasing rewritten in business register.
const PHRASES = [
  [/\b(a|the) (bigger|wider|larger|broader) circle\b/gi, 'the wider team'],
  [/\band now (in|with) the\b/gi, 'and is now with the'],
  [/\bcomments that (i|we) (did|made|have done)\b/gi, 'comments $1 addressed'],
  [/\b(did|made|done) (the |some |my |our )?comments\b/gi, 'addressed $2comments'],
  [/\b(did|made) (a |the )?meeting\b/gi, 'held $2meeting'],
  [/\b(do|make) (a |the )?meeting\b/gi, 'hold $2meeting'],
  [/\bmade (a |the )?presentation\b/gi, 'delivered $1presentation'],
  [/\bmake (a |the )?presentation\b/gi, 'deliver $1presentation'],
  [/\bdiscuss(ed)? about\b/gi, 'discuss$1'],
  [/\bmention(ed)? about\b/gi, 'mention$1'],
  [/\brevert(ed)? back\b/gi, (m, d) => (d ? 'responded' : 'respond')],
  [/\bsend(ing)? it back\b/gi, 'return$1 it'],
  [/\bin the coming days\b/gi, 'shortly'],
  [/\bon the ground\b/gi, 'in the field']
];

// Acronyms that speech recognition writes in lower or title case.
export const ACRONYMS = {
  mofa: 'MoFA', moe: 'MoE', moete: 'MoETE', mohe: 'MoHE', mosa: 'MoSA', mohp: 'MoHP', mopmed: 'MoPMED',
  usaid: 'USAID', unicef: 'UNICEF', undp: 'UNDP', unesco: 'UNESCO', unhcr: 'UNHCR', unfpa: 'UNFPA', wfp: 'WFP', ilo: 'ILO',
  ngo: 'NGO', ngos: 'NGOs', cso: 'CSO', csos: 'CSOs', kpi: 'KPI', kpis: 'KPIs', tor: 'ToR', tors: 'ToRs', tot: 'ToT',
  mou: 'MoU', mous: 'MoUs', rfp: 'RFP', rfq: 'RFQ', pmo: 'PMO', ceo: 'CEO', cfo: 'CFO', hr: 'HR', ai: 'AI', ict: 'ICT',
  ppt: 'PPT', eu: 'EU', egp: 'EGP', usd: 'USD', q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4', faq: 'FAQ', faqs: 'FAQs',
  mel: 'MEL', stem: 'STEM', tvet: 'TVET', edc: 'EDC', auc: 'AUC'
};
const ACRONYM_RE = new RegExp(`\\b(${Object.keys(ACRONYMS).join('|')})\\b`, 'gi');

// Phrases that carry no information in a written report.
const NOISE = [
  /\b(to be honest|honestly|frankly|at the end of the day|you see|let's say|so to speak|if you will|as i said|like i said|as you know|you know what i mean|i would say|i'd say)\b,?\s*/gi,
  /,?\s*\b(or something( like that)?|and stuff( like that)?|and all that|and so on and so forth|and whatnot|or whatever)\b/gi,
  /\b(pretty much|more or less|really|super|quite a bit of|just)\s+(?=\w)/gi,
  /\b(sorry|no wait|scratch that|let me rephrase( that)?|let me correct (that|myself)|what i meant (was|is))\b,?\s*/gi,
  /^\s*(i think|i guess|i believe|i suppose|i feel like)\s+(that\s+)?/gi
];

// Hedges at the start of a later sentence (no look-behind, for older Safari).
const HEDGE_AFTER_STOP = /([.!?]\s+)(i think|i guess|i believe|i suppose|i feel like)\s+(that\s+)?/gi;

const RUN_ON = /([a-z0-9])\s+(?=(?:the (?:main |key |biggest |major |other )?(?:challenges?|issues?|problems?|obstacles?|risks?) (?:is|was|are|were|we faced)|next week,? (?:i|we)|(?:i|we) (?:also )?need (?:some )?(?:support|help)|moving (?:on )?to|on the other project|as for)\b)/gi;

const FILLERS = /\b(um+|uh+|erm+|hmm+|ah+|you know|i mean|basically|actually|kind of|sort of|literally)\b,?\s*/gi;

// Meta-talk: openings and sign-offs about the note itself rather than the work.
const META_LEADS = [
  /^(ok(ay)?|so|right|alright|well|hello|hi|hey|good (morning|afternoon|evening)( everyone| all)?)\b[,.!]?\s*/i,
  /^(this is|it's|it is) (my|our|the|a|an)?\s*[\w\s]{0,30}?(update|voice note|note|report|recording)( for [\w\s&-]{0,40}?)?(?=[,.:]|$)[,.:]?\s*/i,
  /^(here (are|is)|these are|below are|following are|the following are) (some|a few|the|my|our)?\s*(of )?(the |my |our )?(comments?|updates?|notes?|points|things|highlights|items|tasks)( (that )?(i|we) (did|have|had|made|addressed|worked on|have done|completed))?( (today|this week|so far))?[,.:]?\s*/i,
  /^(i|we) (want|would like|'d like|wanted|need) to (share|give|update|mention|talk about|report|go through)( you| on| about)?( (some|a few|my|the|our))?( (updates?|points|things|progress))?( (for|on) [\w\s&-]{0,30}?)?( (today|this week))?[,.:]?\s*/i,
  /^(let me|i('ll| will)) (start|begin|go through)( (with|by))?( (the|my))?( (updates?|progress))?[,.:]?\s*/i,
  /^(so )?(today|this week),? (i|we) (did|have done|worked on) the following[,.:]?\s*/i,
  /^(testing|test)( testing| one two)*[,.]?\s*/i
];
const META_ONLY = /^((that's|that is|this is) (it|all|everything)( for (now|today|this week))?[,.]?\s*)?((thank you|thanks)( (very|so) much)?[,.]?\s*)?((bye|goodbye|over)[,.]?)?$/i;

export function stripMeta(sentence) {
  let s = sentence.trim();
  if (!s || META_ONLY.test(s)) return '';
  for (let i = 0; i < 3; i++) {
    const before = s;
    for (const re of META_LEADS) s = s.replace(re, '');
    if (s === before) break;
  }
  return s.replace(/^[,.:;\s]+/, '');
}

export function fixAcronyms(text) {
  return text.replace(ACRONYM_RE, m => ACRONYMS[m.toLowerCase()] || m);
}

export function polish(text) {
  let s = ` ${text} `.replace(FILLERS, ' ').replace(/,(\s*,)+/g, ',');
  // False starts: "we- we", "I- I", "the deliv- the delivery"
  s = s.replace(/\b\w{1,12}-\s+(?=\w)/g, '');
  // Immediate repetitions: "the the", "we we we", "on on the"
  s = s.replace(/\b(\w+)(?:[\s,]+\1\b)+/gi, '$1');
  s = s.replace(/\b(\w+ \w+)(?:,?\s+\1\b)+/gi, '$1');
  // Speech recognition often runs sentences together; restore a break before
  // phrases that start a new report point ("...with EDC the main challenge is...").
  s = s.replace(RUN_ON, '$1. ');
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(HEDGE_AFTER_STOP, '$1');
  for (const [re, rep] of CASUAL) s = s.replace(re, rep);
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  s = fixAcronyms(s);
  return s
    .replace(/\b(with|for|on|to|about|of|from|and|the|a|an)\s*,\s*/gi, '$1 ')
    .replace(/^[\s,]+/, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,.!?])\1+/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/(^|[.!?]\s+)([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
}

// Proper names in the transcript that are not yet in the project's key terms.
// These are the words most likely to be mis-heard, so the app asks the
// speaker to confirm them once.
export const NOT_NAMES = new Set(('I The A An This That These Those We Our My It Its Next Last Also And But So Then Now Today ' +
  'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September ' +
  'October November December OK Here There What When Where Which Who How Achievements Challenges Priorities Support ' +
  'Project Team Ministry Office Department Week Weekly Correction Update').split(' '));

export function findUnknownTerms(text, known) {
  const knownLower = new Set(known.filter(Boolean).map(k => k.toLowerCase()));
  const acr = new Set(Object.values(ACRONYMS).map(a => a.toLowerCase()));
  const found = new Map();
  for (const sentence of text.split(/[.!?]+\s*/)) {
    const words = sentence.trim().split(/\s+/);
    let run = [];
    const flush = () => {
      while (run.length && NOT_NAMES.has(run[0])) run.shift();
      while (run.length && NOT_NAMES.has(run[run.length - 1])) run.pop();
      const term = run.join(' ');
      const lower = term.toLowerCase();
      if (term.length > 2 && !knownLower.has(lower) && !acr.has(lower) && ![...knownLower].some(k => k.includes(lower))) {
        found.set(lower, term);
      }
      run = [];
    };
    words.forEach((raw, i) => {
      const w = raw.replace(/[^\w&'-]/g, '');
      const capital = /^[A-Z][A-Za-z&'-]*$/.test(w) && !(i === 0 && NOT_NAMES.has(w)) && w !== 'I';
      if (capital && i > 0) run.push(w);
      else if (capital && i === 0 && !NOT_NAMES.has(w) && words.length > 1 && /^[A-Z]/.test(words[1] || '')) run.push(w);
      else flush();
      if (/[,;:]$/.test(raw)) flush();
    });
    flush();
  }
  return [...found.values()].slice(0, 3);
}
