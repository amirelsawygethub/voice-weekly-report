// Business-writing clean-up applied to every transcript, on the device,
// before bullets are written. It removes speech artefacts and casual
// phrasing without changing the facts the speaker gave.

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

const FILLERS = /\b(um+|uh+|erm+|hmm+|ah+|you know|i mean|basically|actually|kind of|sort of|literally)\b,?\s*/gi;

export function polish(text) {
  let s = ` ${text} `.replace(FILLERS, ' ').replace(/,(\s*,)+/g, ',');
  // False starts: "we- we", "I- I", "the deliv- the delivery"
  s = s.replace(/\b\w{1,12}-\s+(?=\w)/g, '');
  // Immediate repetitions: "the the", "we we we", "on on the"
  s = s.replace(/\b(\w+)(?:[\s,]+\1\b)+/gi, '$1');
  s = s.replace(/\b(\w+ \w+)(?:,?\s+\1\b)+/gi, '$1');
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(HEDGE_AFTER_STOP, '$1');
  for (const [re, rep] of CASUAL) s = s.replace(re, rep);
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
