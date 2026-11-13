'use strict';
// What Scrunchy learns from use. None of this retrains a model: it is the
// memory around the models (voices, vocabulary, known mis-hearings, preferred
// notes style) that grows as meetings are recorded and corrected.

const MAX_VOICE_SAMPLES = 40;
const DEFAULT_THRESHOLD = 0.6;

const emptyLearning = () => ({ replacements: [], terms: {}, styleExample: null });

const tokens = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);
const bare = (word) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
// A word that looks like a name or term rather than an ordinary word.
const looksLikeTerm = (text) => /[\p{Lu}\p{N}]/u.test(text);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Which runs of words were swapped for which, between a line before and after
// the user corrected it. Uses a longest-common-subsequence alignment.
function substitutions(before, after) {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > 400 || b.length > 400) return [];
  const same = (i, j) => bare(a[i]) === bare(b[j]) && bare(a[i]) !== '';
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = same(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let from = [];
  let to = [];
  const flush = () => {
    if (from.length && to.length) out.push({ from: from.join(' '), to: to.join(' ') });
    from = [];
    to = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(i, j)) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      to.push(b[j++]);
    } else {
      from.push(a[i++]);
    }
  }
  flush();
  return out;
}

// Remember what the user changed in a transcript line. Short swaps become
// replacements for future transcripts; corrected names and terms join the vocabulary.
function learnFromEdit(learning, before, after) {
  let learned = 0;
  for (const sub of substitutions(before, after)) {
    const from = tokens(sub.from).map(bare).filter(Boolean).join(' ');
    const to = sub.to.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!from || !to || from === to.toLowerCase() || tokens(from).length > 3 || tokens(to).length > 3) continue;
    const known = learning.replacements.find((r) => r.from === from);
    if (known) {
      if (known.to === to) known.count += 1;
      else Object.assign(known, { to, count: 1 });
    } else {
      learning.replacements.push({ from, to, count: 1 });
    }
    if (looksLikeTerm(to)) addTerm(learning, to, 'correction');
    learned += 1;
  }
  return learned;
}

// A swap is applied automatically when it produces a name or term, or when
// the user has made the same fix twice. A one-off fix of an ordinary word
// ("their" to "there") depends on context and is not generalised.
const isActive = (r) => r.count >= 2 || looksLikeTerm(r.to);

function applyReplacements(learning, text) {
  let out = text;
  for (const r of learning.replacements) {
    if (!isActive(r)) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(r.from).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(pattern, r.to);
  }
  return out;
}

function addTerm(learning, term, source, meetingId) {
  const key = term.trim();
  if (key.length < 3 || key.length > 40) return;
  const entry = learning.terms[key] || (learning.terms[key] = { source, meetings: [] });
  if (source === 'correction') entry.source = 'correction';
  if (meetingId && !entry.meetings.includes(meetingId)) entry.meetings.push(meetingId);
}

const STOP = new Set(['The', 'This', 'That', 'They', 'There', 'Then', 'And', 'But', 'For', 'With', 'What', 'When', 'Where', 'Why', 'How', 'Who', 'Yes', 'Not', 'You', 'Our', 'Are', 'Was', 'Will', 'Can', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Meeting', 'Todo', 'Action', 'Notes']);

// Capitalised words in the user's own notes and titles are candidate names
// and terms. A word only counts once it has turned up in two meetings.
function harvestTerms(learning, text, meetingId) {
  for (const line of String(text || '').split('\n')) {
    const words = line.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const word = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const afterSentenceEnd = /[.!?:]$/.test(words[i - 1]);
      if (afterSentenceEnd || !/^\p{Lu}[\p{L}\p{N}]{2,}$/u.test(word) || STOP.has(word)) continue;
      addTerm(learning, word, 'notes', meetingId);
    }
  }
}

// Terms Scrunchy has picked up by itself (not the ones typed into Settings).
function learnedTerms(learning) {
  return Object.entries(learning.terms)
    .filter(([, t]) => t.source === 'correction' || t.meetings.length >= 2)
    .map(([term]) => term);
}

// Everything worth telling Whisper and the summary model to spell correctly.
function glossary(learning, settings, voices) {
  const typed = String(settings.vocabulary || '').split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
  const names = voices.map((v) => v.name);
  const all = [...typed, ...names, ...learnedTerms(learning)];
  const seen = new Set();
  return all.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 80);
}

// ---- voices ----

function addVoiceSample(voices, name, embedding) {
  if (!embedding) return;
  let voice = voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (!voice) voices.push((voice = { name, embeddings: [] }));
  voice.embeddings.push(embedding);
  voice.embeddings = voice.embeddings.slice(-MAX_VOICE_SAMPLES);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

// The "same person or not" cut-off, worked out from the user's own saved
// voices: how alike are two samples of one person, versus two different people?
// Falls back to the default until there is enough to go on.
function calibrate(voices) {
  const same = [];
  const different = [];
  const cap = 12; // samples per voice, to keep this quick
  const sets = voices.map((v) => v.embeddings.slice(-cap));
  for (let v = 0; v < sets.length; v++) {
    for (let i = 0; i < sets[v].length; i++) {
      for (let j = i + 1; j < sets[v].length; j++) same.push(cosine(sets[v][i], sets[v][j]));
      for (let w = v + 1; w < sets.length; w++) {
        for (const other of sets[w]) different.push(cosine(sets[v][i], other));
      }
    }
  }
  if (same.length < 15 || different.length < 15) {
    return { value: DEFAULT_THRESHOLD, auto: false, same: same.length, different: different.length };
  }
  same.sort((a, b) => a - b);
  different.sort((a, b) => a - b);
  const mid = (percentile(same, 0.1) + percentile(different, 0.95)) / 2;
  const value = Math.round(Math.min(0.75, Math.max(0.45, mid)) * 100) / 100;
  return { value, auto: true, same: same.length, different: different.length };
}

module.exports = {
  emptyLearning,
  substitutions,
  learnFromEdit,
  applyReplacements,
  isActive,
  addTerm,
  harvestTerms,
  learnedTerms,
  glossary,
  addVoiceSample,
  calibrate,
};
