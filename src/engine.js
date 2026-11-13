'use strict';
// Speech engine. Runs in an Electron utility process so model inference never
// blocks the window. It does two jobs:
//   live:  audio -> voice activity detection -> transcription -> speaker matching
//   after: whole-recording speaker turns for the refinement pass ("diarize")
const { modelFiles } = require('./models');

const SAMPLE_RATE = 16000;
// Cosine similarity needed to treat two voice prints as the same person.
// In tests the same voice scored 0.7-0.9 and different voices 0.35-0.6.
// Raise it if different people get merged; lower it if one person is split.
const MATCH_THRESHOLD = 0.6;
// Below this length a voice print is too noisy to create or update a speaker.
const MIN_EMBED_SECONDS = 1.2;
// How much of each person's speech goes into their voice print after a meeting.
const PRINT_SECONDS = 45;

const port = process.parentPort;
const post = (msg) => port.postMessage(msg);

let sherpa = null;
let recognizer = null;
let extractor = null;
let files = null;
let session = null;

function init(modelsDir) {
  if (recognizer) return;
  files = modelFiles(modelsDir);
  sherpa = require('sherpa-onnx-node');
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      modelType: 'nemo_transducer',
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  });
  extractor = new sherpa.SpeakerEmbeddingExtractor({ model: files.speaker, numThreads: 2, debug: 0 });
}

function createVad(overrides = {}) {
  return new sherpa.Vad(
    {
      sileroVad: {
        model: files.vad,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.5,
        maxSpeechDuration: 20,
        windowSize: 512,
        ...overrides,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    },
    60
  );
}

// ---- voice print maths ----

function normalize(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function dot(a, b) {
  if (a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function centroidOf(cluster) {
  if (cluster.sum) return normalize(cluster.sum);
  return cluster.refs[0] || null;
}

function score(cluster, emb) {
  let best = -1;
  for (const ref of cluster.refs) best = Math.max(best, dot(ref, emb));
  if (cluster.sum) best = Math.max(best, dot(normalize(cluster.sum), emb));
  return best;
}

// Voice print of one or more stretches of audio from the same person.
function embed(...chunks) {
  const stream = extractor.createStream();
  for (const samples of chunks) stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  if (!extractor.isReady(stream)) return null;
  // `false`: Electron forbids external buffers, so ask for a copy.
  return normalize(extractor.compute(stream, false));
}

// ---- known speakers ----

// Everyone we could recognise: people already in this meeting, then voices
// the user has named in earlier meetings.
function knownSpeakers({ voices = [], speakers = [], threshold }) {
  const clusters = [];
  let maxNumber = 0;
  for (const sp of speakers) {
    const m = /^spk-(\d+)$/.exec(sp.id);
    if (m) maxNumber = Math.max(maxNumber, Number(m[1]));
    clusters.push({
      id: sp.id,
      name: sp.name,
      refs: sp.centroid ? [normalize(Float32Array.from(sp.centroid))] : [],
      sum: null,
    });
  }
  for (const voice of voices) {
    const id = `voice:${voice.name}`;
    const refs = voice.embeddings.map((e) => normalize(Float32Array.from(e)));
    const existing = clusters.find((c) => c.id === id);
    if (existing) existing.refs.push(...refs);
    else clusters.push({ id, name: voice.name, refs, sum: null });
  }
  // `threshold` is the cut-off learned from the user's saved voices, if any.
  return { clusters, nextNumber: maxNumber + 1, threshold };
}

function newCluster(book) {
  const n = book.nextNumber++;
  const cluster = { id: `spk-${n}`, name: `Speaker ${n}`, refs: [], sum: null };
  book.clusters.push(cluster);
  return cluster;
}

function bestMatch(book, emb) {
  let best = null;
  let bestScore = book.threshold || MATCH_THRESHOLD;
  for (const cluster of book.clusters) {
    const s = score(cluster, emb);
    if (process.env.SCRUNCHY_DEBUG) console.error(`[speaker] ${cluster.id} ${s.toFixed(2)}`);
    if (s >= bestScore) {
      bestScore = s;
      best = cluster;
    }
  }
  return best;
}

// ---- live session ----

function startSession(msg) {
  session = {
    ...knownSpeakers(msg),
    offset: msg.offset || 0,
    // Unless several people share the microphone, everything on it is the user.
    me: msg.micIsMe ? { id: 'me', name: msg.meName || 'You', refs: [], sum: null } : null,
    lastSpeaker: {},
    vads: { mic: createVad(), system: createVad() },
  };
}

function assignSpeaker(source, samples) {
  if (source === 'mic' && session.me) return session.me;
  const seconds = samples.length / SAMPLE_RATE;
  const emb = seconds >= 0.5 ? embed(samples) : null;
  let cluster = emb ? bestMatch(session, emb) : null;

  if (emb && seconds >= MIN_EMBED_SECONDS) {
    if (!cluster) cluster = newCluster(session);
    // Longer speech gives a more reliable print, so weight by duration.
    if (!cluster.sum) cluster.sum = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) cluster.sum[i] += emb[i] * seconds;
  } else if (!cluster) {
    // Too short to judge: assume whoever last spoke on this source.
    cluster = session.lastSpeaker[source] || newCluster(session);
  }
  session.lastSpeaker[source] = cluster;
  return cluster;
}

function handleSegment(source, seg) {
  const samples = seg.samples;
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  recognizer.decode(stream);
  const text = (recognizer.getResult(stream).text || '').trim();
  if (!text) return;

  const cluster = assignSpeaker(source, samples);
  const centroid = centroidOf(cluster);
  const start = session.offset + Number(seg.start) / SAMPLE_RATE;
  post({
    type: 'segment',
    segment: {
      source,
      start,
      end: start + samples.length / SAMPLE_RATE,
      text,
      speakerId: cluster.id,
    },
    speaker: { id: cluster.id, name: cluster.name, centroid: centroid ? Array.from(centroid) : null },
  });
}

function drain(source) {
  const vad = session.vads[source];
  while (!vad.isEmpty()) {
    const seg = vad.front(false);
    vad.pop();
    handleSegment(source, seg);
  }
}

// ---- after the meeting: a copy of the recording with the silences cut out ----

// Whisper invents text during long silences, so it is given only the parts
// where a voice was detected. Returns where each kept stretch came from
// (start/end in the original) and where it sits in the shortened file (at).
function cutSilence(wav, out) {
  const samples = sherpa.readWave(wav, false).samples;
  // Deliberately more sensitive than the live detector: losing a quiet word
  // is worse than keeping a little background noise.
  const vad = createVad({ threshold: 0.35, minSpeechDuration: 0.15, minSilenceDuration: 0.6, maxSpeechDuration: 30 });
  const found = [];
  const collect = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      vad.pop();
      const start = Number(seg.start) / SAMPLE_RATE;
      found.push({ start, end: start + seg.samples.length / SAMPLE_RATE });
    }
  };
  for (let i = 0; i < samples.length; i += SAMPLE_RATE) {
    vad.acceptWaveform(samples.slice(i, i + SAMPLE_RATE));
    collect();
  }
  vad.flush();
  collect();

  // Pad each stretch so word edges survive, and join stretches that then touch.
  const total = samples.length / SAMPLE_RATE;
  const regions = [];
  for (const r of found.sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, r.start - 0.4);
    const end = Math.min(total, r.end + 0.4);
    const last = regions[regions.length - 1];
    if (last && start - last.end < 0.6) last.end = Math.max(last.end, end);
    else regions.push({ start, end });
  }
  if (!regions.length) return [];

  const gap = Math.round(0.3 * SAMPLE_RATE);
  // A short lead-in: Whisper tends to drop the very first word of a file.
  const lead = Math.round(0.5 * SAMPLE_RATE);
  const length = regions.reduce((n, r) => n + Math.round((r.end - r.start) * SAMPLE_RATE) + gap, lead);
  const compact = new Float32Array(length);
  let offset = lead;
  for (const r of regions) {
    const from = Math.round(r.start * SAMPLE_RATE);
    const piece = samples.subarray(from, from + Math.round((r.end - r.start) * SAMPLE_RATE));
    compact.set(piece, offset);
    r.at = offset / SAMPLE_RATE;
    offset += piece.length + gap;
  }
  sherpa.writeWave(out, { samples: compact, sampleRate: SAMPLE_RATE });
  return regions;
}

// ---- after the meeting: who spoke when, over the whole recording ----

function diarize(msg) {
  const wave = sherpa.readWave(msg.wav, false);
  const samples = wave.samples;
  if (samples.length < SAMPLE_RATE) return { turns: [], speakers: [] };

  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: msg.segmentation }, numThreads: 4, debug: 0 },
    embedding: { model: files.speaker, numThreads: 4, debug: 0 },
    // 0.5 merged two real voices in one conversation into one person; 0.4
    // separated them but also splinters off a few stray fragments, which are
    // folded back into the main speakers below.
    clustering: { numClusters: -1, threshold: 0.4 },
    minDurationOn: 0.2,
    minDurationOff: 0.3,
  });
  const raw = diarizer.process(samples);

  // One voice print per detected person, built from their longest stretches.
  const byPerson = new Map();
  for (const turn of raw) {
    if (!byPerson.has(turn.speaker)) byPerson.set(turn.speaker, []);
    byPerson.get(turn.speaker).push(turn);
  }
  const people = [...byPerson].map(([person, turns]) => {
    const chunks = [];
    let budget = PRINT_SECONDS * SAMPLE_RATE;
    for (const turn of [...turns].sort((a, b) => b.end - b.start - (a.end - a.start))) {
      if (budget <= 0) break;
      const from = Math.max(0, Math.floor(turn.start * SAMPLE_RATE));
      const to = Math.min(samples.length, from + budget, Math.floor(turn.end * SAMPLE_RATE));
      if (to - from < SAMPLE_RATE * 0.4) continue;
      chunks.push(samples.slice(from, to));
      budget -= to - from;
    }
    return {
      person,
      seconds: turns.reduce((sum, t) => sum + (t.end - t.start), 0),
      emb: chunks.length ? embed(...chunks) : null,
    };
  });

  // Someone with only a few seconds in the whole recording is almost always a
  // fragment of a main speaker, so hand them to whichever main voice is closest.
  const total = people.reduce((sum, p) => sum + p.seconds, 0);
  const floor = Math.max(5, total * 0.03);
  let main = people.filter((p) => p.seconds >= floor);
  if (!main.length) main = [...people].sort((a, b) => b.seconds - a.seconds).slice(0, 1);
  const foldInto = new Map();
  for (const p of people) {
    if (main.includes(p)) continue;
    let target = main[0];
    let best = -Infinity;
    for (const m of main) {
      const s = p.emb && m.emb ? dot(p.emb, m.emb) : m.seconds / 1e6;
      if (s > best) {
        best = s;
        target = m;
      }
    }
    foldInto.set(p.person, target.person);
  }

  const book = knownSpeakers(msg);
  const idOf = new Map();
  const used = new Map();
  // Each detected person may match one already-known voice. People found in
  // this pass are never matched to each other: the diarizer has already
  // decided they are different, and similar voices would be merged again.
  const known = [...book.clusters];
  const taken = new Set();
  for (const { person, emb } of main) {
    let cluster = emb ? bestMatch({ clusters: known.filter((c) => !taken.has(c)), threshold: book.threshold }, emb) : null;
    if (cluster) {
      taken.add(cluster);
      // How sure the match was, so very confident ones can add to the voice's samples.
      cluster.matchScore = score(cluster, emb);
    }
    if (!cluster) cluster = newCluster(book);
    if (emb) {
      if (!cluster.sum) cluster.sum = new Float32Array(emb.length);
      for (let i = 0; i < emb.length; i++) cluster.sum[i] += emb[i];
    }
    idOf.set(person, cluster.id);
    used.set(cluster.id, cluster);
  }

  return {
    turns: raw.map((t) => ({ start: t.start, end: t.end, speakerId: idOf.get(foldInto.has(t.speaker) ? foldInto.get(t.speaker) : t.speaker) })),
    speakers: [...used.values()].map((c) => {
      const centroid = centroidOf(c);
      return { id: c.id, name: c.name, centroid: centroid ? Array.from(centroid) : null, matchScore: c.matchScore || null };
    }),
  };
}

// ---- after the meeting: a voice print for each transcript line ----

// Kept with the meeting so that when the user corrects who said a line, the
// right person's saved voice gains a sample without needing the audio again.
function embedSpans(msg) {
  const samples = sherpa.readWave(msg.wav, false).samples;
  const prints = {};
  for (const span of msg.spans) {
    const from = Math.max(0, Math.floor(span.start * SAMPLE_RATE));
    const to = Math.min(samples.length, Math.floor(span.end * SAMPLE_RATE), from + SAMPLE_RATE * 30);
    if (to - from < SAMPLE_RATE) continue;
    const emb = embed(samples.slice(from, to));
    if (emb) prints[span.id] = Array.from(emb, (v) => Math.round(v * 1e4) / 1e4);
  }
  return prints;
}

port.on('message', (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      init(msg.modelsDir);
      post({ type: 'ready' });
    } else if (msg.type === 'start') {
      startSession(msg);
      post({ type: 'started' });
    } else if (msg.type === 'audio') {
      if (!session || !session.vads[msg.source]) return;
      const samples = msg.samples instanceof Float32Array ? msg.samples : Float32Array.from(msg.samples);
      session.vads[msg.source].acceptWaveform(samples);
      drain(msg.source);
    } else if (msg.type === 'stop') {
      if (session) {
        for (const source of Object.keys(session.vads)) {
          session.vads[source].flush();
          drain(source);
        }
      }
      session = null;
      post({ type: 'stopped' });
    } else if (msg.type === 'speech') {
      post({ type: 'speech', regions: cutSilence(msg.wav, msg.out) });
    } else if (msg.type === 'embed') {
      post({ type: 'embedded', prints: embedSpans(msg) });
    } else if (msg.type === 'diarize') {
      post({ type: 'diarized', ...diarize(msg) });
    }
  } catch (err) {
    post({ type: 'error', during: msg.type, message: String((err && err.message) || err) });
  }
});
