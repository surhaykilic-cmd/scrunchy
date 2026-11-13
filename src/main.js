'use strict';
const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog, utilityProcess, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { modelFiles, refineFiles } = require('./models');
const { WavWriter, runWhisper, restoreTimes, buildSegments } = require('./refine');
const learn = require('./learning');

const OLLAMA = 'http://127.0.0.1:11434';
const DEFAULT_SETTINGS = { model: 'gemma3:27b', userName: 'You', sharedMic: false, vocabulary: '', micId: '' };
const MAX_CONTEXT_TOKENS = 32768;

let win = null;
let dataDir, meetingsDir, voicesFile, settingsFile, learningFile, modelsDir;

// ---------- storage ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const meetingDir = (id) => path.join(meetingsDir, id);
const meetingFile = (id) => path.join(meetingDir(id), 'meeting.json');
// Raw per-source audio of one recording, kept only until it has been refined.
const partWav = (id, source, part) => path.join(meetingDir(id), `${source}-${part}.wav`);
// A voice print for each transcript line, used when the user corrects who spoke.
const printsFile = (id) => path.join(meetingDir(id), 'prints.json');
const validId = (id) => typeof id === 'string' && /^[a-z0-9]+$/.test(id);

// The meeting being recorded lives in memory so segments are not lost between saves.
let active = null; // { meeting, saveTimer, part, offset, writers }
let refining = false;

function loadMeeting(id) {
  if (!validId(id)) throw new Error('Unknown meeting');
  if (active && active.meeting.id === id) return active.meeting;
  const meeting = readJson(meetingFile(id), null);
  if (!meeting) throw new Error('Unknown meeting');
  return meeting;
}

function saveMeeting(meeting) {
  writeJson(meetingFile(meeting.id), meeting);
}

function forRenderer(meeting) {
  const audioUrls = (meeting.audio || [])
    .map((name) => path.join(meetingDir(meeting.id), name))
    .filter((file) => fs.existsSync(file))
    .map((file) => pathToFileURL(file).href);
  // Voice prints are large and the window never needs them.
  const speakers = {};
  for (const [id, sp] of Object.entries(meeting.speakers || {})) speakers[id] = { name: sp.name };
  return { ...meeting, speakers, audioUrls };
}

function listMeetings() {
  if (!fs.existsSync(meetingsDir)) return [];
  return fs
    .readdirSync(meetingsDir)
    .map((id) => readJson(meetingFile(id), null))
    .filter(Boolean)
    .map((m) => ({ id: m.id, title: m.title, createdAt: m.createdAt, duration: m.duration || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

const loadVoices = () => readJson(voicesFile, []);
const loadLearning = () => ({ ...learn.emptyLearning(), ...readJson(learningFile, {}) });
const saveLearning = (learning) => writeJson(learningFile, learning);
// Names and terms for Whisper and the summary model, typed and learned.
const glossaryText = () => learn.glossary(loadLearning(), loadSettings(), loadVoices()).join('\n');
// A placeholder label, as opposed to a real person's name.
const isPlaceholder = (name) => /^Speaker \d+$/.test(name) || name === 'Unknown';

function countCorrection(meeting, kind) {
  meeting.corrections = { speaker: 0, text: 0, ...(meeting.corrections || {}) };
  meeting.corrections[kind] += 1;
}

// People already in a meeting, in the shape the engine expects. "me" is the
// microphone and is never matched by voice.
const knownSpeakers = (meeting) =>
  Object.entries(meeting.speakers)
    .filter(([id]) => id !== 'me' && id !== 'unknown')
    .map(([id, sp]) => ({ id, name: sp.name, centroid: sp.centroid }));
const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(settingsFile, {}) });

function modelsMissing() {
  return Object.values(modelFiles(modelsDir)).some((file) => !fs.existsSync(file));
}

// ---------- speech engine (utility process) ----------

let engine = null;
let engineReady = false;
let pending = [];

function ensureEngine() {
  if (engine) return;
  engineReady = false;
  engine = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], { serviceName: 'Scrunchy speech engine' });
  engine.on('message', (msg) => {
    if (msg.type === 'segment') return onSegment(msg);
    if (msg.type === 'error') {
      const i = pending.findIndex((p) => p.during === msg.during);
      if (i >= 0) pending.splice(i, 1)[0].reject(new Error(msg.message));
      else if (win) win.webContents.send('rec:error', msg.message);
      return;
    }
    const i = pending.findIndex((p) => p.reply === msg.type);
    if (i >= 0) pending.splice(i, 1)[0].resolve(msg);
  });
  engine.on('exit', () => {
    engine = null;
    engineReady = false;
    for (const p of pending) p.reject(new Error('The speech engine stopped unexpectedly.'));
    pending = [];
  });
}

function engineCall(msg, reply) {
  return new Promise((resolve, reject) => {
    pending.push({ during: msg.type, reply, resolve, reject });
    engine.postMessage(msg);
  });
}

// Without headphones the microphone re-hears the other participants, so the
// same sentence arrives once from the system audio and again from the mic.
const wordsOf = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);

function isEcho(mic, sys) {
  const words = wordsOf(mic.text);
  // Short remarks ("yeah") must overlap in time; longer ones may drift a little.
  const slack = words.length >= 3 ? 15 : 1.5;
  if (mic.start > sys.end + slack || mic.end < sys.start - slack) return false;
  const heard = new Set(wordsOf(sys.text));
  return words.filter((w) => heard.has(w)).length >= words.length * 0.7;
}

let segmentCounter = 0;

function onSegment({ segment, speaker }) {
  if (!active) return;
  const meeting = active.meeting;
  segment.id = `${Date.now().toString(36)}-${++segmentCounter}`;
  let removed = [];
  if (segment.source === 'mic') {
    if (meeting.segments.some((s) => s.source === 'system' && isEcho(segment, s))) return;
  } else {
    removed = meeting.segments.filter((s) => s.source === 'mic' && isEcho(s, segment)).map((s) => s.id);
    if (removed.length) meeting.segments = meeting.segments.filter((s) => !removed.includes(s.id));
  }
  segment.text = learn.applyReplacements(active.learning, segment.text);
  const known = meeting.speakers[speaker.id];
  // The engine only suggests a name; once the user renames someone, theirs wins.
  meeting.speakers[speaker.id] = {
    name: known ? known.name : speaker.name,
    centroid: speaker.centroid || (known && known.centroid) || null,
  };
  meeting.segments.push(segment);
  meeting.segments.sort((a, b) => a.start - b.start);
  clearTimeout(active.saveTimer);
  active.saveTimer = setTimeout(() => saveMeeting(meeting), 3000);
  if (win) {
    win.webContents.send('rec:segment', {
      meetingId: meeting.id,
      segment,
      removed,
      speaker: { id: speaker.id, name: meeting.speakers[speaker.id].name },
    });
  }
}

// ---------- AI notes (Ollama) ----------

const clock = (seconds) => {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

function transcriptText(meeting) {
  const lines = [];
  let last = null;
  for (const seg of meeting.segments) {
    const name = (meeting.speakers[seg.speakerId] || {}).name || 'Unknown';
    if (last && last.name === name) last.text += ' ' + seg.text;
    else lines.push((last = { name, start: seg.start, text: seg.text }));
  }
  return lines.map((l) => `[${clock(l.start)}] ${l.name}: ${l.text}`).join('\n');
}

const SYSTEM_PROMPT = `You write meeting notes from a transcript and the note-taker's own rough notes.

Rules:
- Use only what is in the transcript and the rough notes. Never invent names, numbers, dates or decisions.
- The rough notes show what the note-taker cared about: keep every point they made, and expand each one with detail from the transcript.
- The transcript comes from speech recognition, so fix obvious mis-hearings from context and ignore filler.
- Attribute statements to speakers by name when the name is known. Labels like "Speaker 2" are unknown people; refer to them sparingly.
- Be concise and specific. Write in the language of the meeting.

Output Markdown with exactly these sections, omitting any that would be empty:
## Summary
Two to four sentences.
## Key points
Grouped under short ### topic headings, as bullets.
## Decisions
## Action items
One bullet each, as "**Owner** - task (deadline if stated)". Use "Unassigned" if no owner was named.
## Open questions`;

// Models sometimes write a heading with nothing under it; remove those.
function dropEmptySections(text) {
  const isHeading = (line) => /^#{1,6}\s/.test(line);
  const levelOf = (line) => line.match(/^#+/)[0].length;
  const lines = text.split('\n');
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || (isHeading(lines[j]) && levelOf(lines[j]) <= levelOf(lines[i]))) continue;
    }
    keep.push(lines[i]);
  }
  return keep.join('\n');
}

// Notes the user edited by hand show how they like notes to look.
function styleExample(meeting) {
  const example = loadLearning().styleExample;
  if (!example || example.meetingId === meeting.id) return [];
  return [
    '',
    'Below are notes from a different meeting that I edited to my liking. Match their structure, level of detail and tone. Do not reuse any of their content.',
    '<example>',
    example.text,
    '</example>',
  ];
}

async function generateNotes(meeting, onChunk) {
  if (!meeting.segments.length && !(meeting.notes || '').trim()) {
    throw new Error('There is no transcript or notes to summarise yet.');
  }
  const settings = loadSettings();
  let transcript = transcriptText(meeting);
  // Rough budget: ~3.5 characters per token, leaving room for the prompt and the answer.
  const maxChars = (MAX_CONTEXT_TOKENS - 5000) * 3.5;
  let truncated = false;
  if (transcript.length > maxChars) {
    transcript = transcript.slice(0, maxChars);
    truncated = true;
  }
  const user = [
    `Meeting title: ${meeting.title}`,
    `Date: ${new Date(meeting.createdAt).toDateString()}`,
    `The note-taker appears in the transcript as "${settings.userName}".`,
    ...(glossaryText() ? [`Names and terms that may come up: ${glossaryText().replace(/\n/g, ', ')}`] : []),
    ...styleExample(meeting),
    '',
    'My rough notes:',
    (meeting.notes || '').trim() || '(none)',
    '',
    'Transcript:',
    transcript || '(no transcript)',
  ].join('\n');
  const tokens = Math.ceil((SYSTEM_PROMPT.length + user.length) / 3.5) + 3000;
  const numCtx = Math.min(MAX_CONTEXT_TOKENS, Math.max(8192, Math.ceil(tokens / 4096) * 4096));

  let res;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        options: { num_ctx: numCtx, temperature: 0.3 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch {
    throw new Error('Could not reach Ollama. Make sure it is installed and running.');
  }
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).error || body;
    } catch {}
    throw new Error(`Ollama error: ${detail}`);
  }

  let text = truncated
    ? '> Note: this meeting was too long to fit in one pass, so these notes cover only the first part.\n\n'
    : '';
  if (text) onChunk(text);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(`Ollama error: ${data.error}`);
      const piece = (data.message && data.message.content) || '';
      if (piece) {
        text += piece;
        onChunk(piece);
      }
    }
  }
  // Some models put their reasoning inline; keep only the answer.
  return dropEmptySections(text.replace(/<think>[\s\S]*?<\/think>/g, '')).trim();
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('app:status', async () => {
    let ollama = { ok: false, models: [] };
    try {
      const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const data = await res.json();
      ollama = { ok: true, models: (data.models || []).map((m) => m.name) };
    } catch {}
    return { modelsMissing: modelsMissing(), refineAvailable: !!refineFiles(modelsDir), ollama, settings: loadSettings() };
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const next = { ...loadSettings() };
    if (patch && typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
    if (patch && typeof patch.userName === 'string') next.userName = patch.userName.trim().slice(0, 60) || 'You';
    if (patch && typeof patch.vocabulary === 'string') next.vocabulary = patch.vocabulary.slice(0, 4000);
    if (patch && typeof patch.sharedMic === 'boolean') next.sharedMic = patch.sharedMic;
    if (patch && typeof patch.micId === 'string') next.micId = patch.micId.slice(0, 200);
    writeJson(settingsFile, next);
    return next;
  });

  ipcMain.handle('meetings:list', () => listMeetings());
  ipcMain.handle('meetings:get', (_e, id) => forRenderer(loadMeeting(id)));

  ipcMain.handle('meetings:create', () => {
    const now = new Date();
    const meeting = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: `Meeting, ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
      createdAt: now.getTime(),
      duration: 0,
      notes: '',
      aiNotes: '',
      segments: [],
      speakers: {},
      audio: [],
    };
    saveMeeting(meeting);
    return forRenderer(meeting);
  });

  ipcMain.handle('meetings:update', (_e, id, patch) => {
    const meeting = loadMeeting(id);
    for (const key of ['title', 'notes', 'aiNotes']) {
      if (typeof patch[key] === 'string') meeting[key] = patch[key];
    }
    // AI notes the user rewrote by hand become the model for future notes.
    if (patch.edited && typeof patch.aiNotes === 'string' && patch.aiNotes.trim()) {
      meeting.aiNotesEdited = true;
      const learning = loadLearning();
      learning.styleExample = { meetingId: id, text: patch.aiNotes.slice(0, 3000) };
      saveLearning(learning);
    }
    saveMeeting(meeting);
    return true;
  });

  ipcMain.handle('meetings:delete', async (_e, id) => {
    const meeting = loadMeeting(id);
    if (active && active.meeting.id === id) throw new Error('Stop the recording first.');
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `Delete "${meeting.title}"?`,
      detail: 'The recording, transcript and notes will be permanently removed.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    fs.rmSync(meetingDir(id), { recursive: true, force: true });
    return true;
  });

  ipcMain.handle('rec:start', async (_e, id) => {
    if (active) throw new Error('A recording is already running.');
    if (refining) throw new Error('Wait for the last recording to finish processing.');
    if (modelsMissing()) throw new Error('The speech models are not downloaded yet. Run "npm run setup" first.');
    const meeting = loadMeeting(id);
    ensureEngine();
    if (!engineReady) {
      await engineCall({ type: 'init', modelsDir }, 'ready');
      engineReady = true;
    }
    const settings = loadSettings();
    await engineCall(
      {
        type: 'start',
        offset: meeting.duration || 0,
        micIsMe: !settings.sharedMic,
        meName: (meeting.speakers.me || {}).name || settings.userName,
        voices: loadVoices(),
        threshold: learn.calibrate(loadVoices()).value,
        speakers: knownSpeakers(meeting),
      },
      'started'
    );
    const part = (meeting.parts || 0) + 1;
    active = {
      meeting,
      learning: loadLearning(),
      saveTimer: null,
      part,
      offset: meeting.duration || 0,
      // Keep the raw audio of each source so it can be re-transcribed afterwards.
      writers: refineFiles(modelsDir)
        ? { mic: new WavWriter(partWav(id, 'mic', part)), system: new WavWriter(partWav(id, 'system', part)) }
        : null,
    };
    return true;
  });

  ipcMain.on('rec:audio', (_e, source, samples) => {
    if (active && engine && (source === 'mic' || source === 'system')) {
      engine.postMessage({ type: 'audio', source, samples });
      if (active.writers) active.writers[source].write(samples instanceof Float32Array ? samples : Float32Array.from(samples));
    }
  });

  ipcMain.handle('rec:stop', async (_e, id, audio, seconds, tracks) => {
    if (!active || active.meeting.id !== id) throw new Error('This meeting is not being recorded.');
    const meeting = active.meeting;
    try {
      if (engine) await engineCall({ type: 'stop' }, 'stopped');
    } finally {
      clearTimeout(active.saveTimer);
      if (audio && audio.byteLength) {
        const name = `audio-${(meeting.audio || []).length + 1}.webm`;
        fs.writeFileSync(path.join(meetingDir(id), name), Buffer.from(audio));
        meeting.audio = [...(meeting.audio || []), name];
      }
      if (active.writers) {
        active.writers.mic.close();
        active.writers.system.close();
        meeting.parts = active.part;
        meeting.pendingRefine = { part: active.part, offset: active.offset };
      }
      // A small compressed copy of each source is kept for good, so the
      // meeting can be improved again later when Scrunchy has learned more.
      const kept = { part: active.part, offset: active.offset, duration: Number(seconds) || 0 };
      for (const source of ['mic', 'system']) {
        const bytes = tracks && tracks[source];
        if (!bytes || !bytes.byteLength) continue;
        kept[source] = `${source}-${active.part}.webm`;
        fs.writeFileSync(path.join(meetingDir(id), kept[source]), Buffer.from(bytes));
      }
      if (kept.mic || kept.system) meeting.tracks = [...(meeting.tracks || []), kept];
      meeting.duration = (meeting.duration || 0) + (Number(seconds) || 0);
      saveMeeting(meeting);
      active = null;
    }
    return forRenderer(meeting);
  });

  // Older meetings have only the mixed playback audio. The window decodes it
  // and sends it back in pieces, and it is then improved as a single call track.
  // The same route re-runs a newer meeting from its kept per-source tracks.
  ipcMain.handle('refine:audio', (_e, id, name) => {
    const meeting = loadMeeting(id);
    const allowed = [...(meeting.audio || []), ...(meeting.tracks || []).flatMap((t) => [t.mic, t.system])].filter(Boolean);
    const file = name || (allowed.length === 1 ? allowed[0] : null);
    if (!file || !allowed.includes(file)) throw new Error('This meeting has no recording to work from.');
    return fs.readFileSync(path.join(meetingDir(id), file));
  });

  let importing = null;
  ipcMain.handle('refine:import', (_e, id, phase, samples, opts = {}) => {
    if (phase === 'begin') {
      loadMeeting(id);
      if (active || refining) throw new Error('Scrunchy is busy with another recording.');
      const part = Number(opts.part) || 1;
      importing = {
        id,
        job: { part, offset: Number(opts.offset) || 0, ...(opts.until != null ? { until: Number(opts.until) } : {}) },
        writers: { system: new WavWriter(partWav(id, 'system', part)), mic: new WavWriter(partWav(id, 'mic', part)) },
      };
    } else if (importing && importing.id === id && phase === 'data') {
      const source = opts.source === 'mic' ? 'mic' : 'system';
      importing.writers[source].write(samples instanceof Float32Array ? samples : Float32Array.from(samples));
    } else if (importing && importing.id === id && phase === 'end') {
      importing.writers.system.close();
      importing.writers.mic.close();
      const meeting = loadMeeting(id);
      meeting.parts = Math.max(meeting.parts || 0, importing.job.part);
      meeting.pendingRefine = importing.job;
      importing = null;
      saveMeeting(meeting);
    }
    return true;
  });

  // After a recording: replace the live draft with the Whisper transcript and
  // whole-recording speaker turns. On failure the draft is left untouched.
  ipcMain.handle('refine:run', async (event, id) => {
    const files = refineFiles(modelsDir);
    const meeting = loadMeeting(id);
    const job = meeting.pendingRefine;
    if (!files || !job) return forRenderer(meeting);
    if (active || refining) throw new Error('Scrunchy is busy with another recording.');
    refining = true;
    const say = (text) => {
      if (!event.sender.isDestroyed()) event.sender.send('refine:progress', { meetingId: id, text });
    };
    try {
      const settings = loadSettings();
      const wavs = { system: partWav(id, 'system', job.part), mic: partWav(id, 'mic', job.part) };
      const hasAudio = (file) => fs.existsSync(file) && fs.statSync(file).size > 44 + 32000;

      ensureEngine();
      if (!engineReady) {
        await engineCall({ type: 'init', modelsDir }, 'ready');
        engineReady = true;
      }
      const words = { system: [], mic: [] };
      const labels = { system: 'Transcribing the call', mic: 'Transcribing your microphone' };
      for (const source of ['system', 'mic']) {
        if (!hasAudio(wavs[source])) continue;
        say(`${labels[source]}…`);
        // Whisper invents text during silence, so it hears only the spoken parts.
        const spoken = wavs[source].replace(/\.wav$/, '.spoken.wav');
        const speech = await engineCall({ type: 'speech', wav: wavs[source], out: spoken }, 'speech');
        if (!speech.regions.length) continue;
        words[source] = await runWhisper({
          files,
          wav: spoken,
          vocabulary: glossaryText(),
          onProgress: (pct) => say(`${labels[source]} ${pct}%`),
        });
        words[source] = restoreTimes(words[source], speech.regions);
        fs.rmSync(spoken, { force: true });
      }

      if (words.system.length || words.mic.length) {
        say('Working out who spoke…');
        ensureEngine();
        if (!engineReady) {
          await engineCall({ type: 'init', modelsDir }, 'ready');
          engineReady = true;
        }
        // Only people from earlier recordings in this meeting carry over. The
        // live draft's speakers are rough guesses and would mislead the matching.
        // (When an older recording of a longer meeting is re-run, \`until\` marks
        // where it ended, and the recordings after it are kept as well.)
        const earlier = meeting.segments.filter(
          (s) => s.start < job.offset - 0.01 || (job.until != null && s.start >= job.until - 0.01)
        );
        const threshold = learn.calibrate(loadVoices()).value;
        const confident = [];
        const speakers = {};
        for (const seg of earlier) if (meeting.speakers[seg.speakerId]) speakers[seg.speakerId] = meeting.speakers[seg.speakerId];
        if (meeting.speakers.me) speakers.me = meeting.speakers.me;
        const segments = [];
        for (const source of ['system', 'mic']) {
          if (!words[source].length) continue;
          let turns = [];
          let fallback = 'unknown';
          if (source === 'mic' && !settings.sharedMic) {
            fallback = 'me';
            speakers.me = { name: (speakers.me || {}).name || settings.userName, centroid: null };
          } else {
            const result = await engineCall(
              {
                type: 'diarize',
                wav: wavs[source],
                segmentation: files.segmentation,
                voices: loadVoices(),
                threshold,
                speakers: knownSpeakers({ speakers }),
              },
              'diarized'
            );
            turns = result.turns;
            if (turns.length) fallback = turns[0].speakerId;
            for (const sp of result.speakers) {
              speakers[sp.id] = { name: (speakers[sp.id] || {}).name || sp.name, centroid: sp.centroid };
              // A very sure match to a saved voice is itself a new sample of that voice.
              if (sp.id.startsWith('voice:') && sp.centroid && sp.matchScore >= 0.75) confident.push(sp);
            }
          }
          segments.push(...buildSegments({ words: words[source], turns, fallback, source, offset: job.offset }));
        }

        const fromCall = segments.filter((s) => s.source === 'system');
        const fresh = segments.filter((s) => s.source !== 'mic' || !fromCall.some((other) => isEcho(s, other)));
        for (const seg of fresh) seg.id = `${Date.now().toString(36)}-${++segmentCounter}`;

        // Apply what has been learned, and add to it.
        const learning = loadLearning();
        for (const seg of fresh) seg.text = learn.applyReplacements(learning, seg.text);
        learn.harvestTerms(learning, `${meeting.title}\n${meeting.notes || ''}`, id);
        saveLearning(learning);
        if (confident.length) {
          const voices = loadVoices();
          for (const sp of confident) learn.addVoiceSample(voices, sp.id.slice('voice:'.length), sp.centroid);
          writeJson(voicesFile, voices);
        }
        const prints = readJson(printsFile(id), {});
        for (const source of ['system', 'mic']) {
          const spans = fresh
            .filter((s) => s.source === source)
            .map((s) => ({ id: s.id, start: s.start - job.offset, end: s.end - job.offset }));
          if (!spans.length) continue;
          const result = await engineCall({ type: 'embed', wav: wavs[source], spans }, 'embedded');
          Object.assign(prints, result.prints);
        }

        // Other recordings in this meeting keep their segments; this one is replaced.
        meeting.segments = [...earlier, ...fresh].sort((a, b) => a.start - b.start);
        const current = new Set(meeting.segments.map((s) => s.id));
        for (const key of Object.keys(prints)) if (!current.has(key)) delete prints[key];
        writeJson(printsFile(id), prints);
        meeting.speakers = {};
        for (const seg of meeting.segments) {
          meeting.speakers[seg.speakerId] = speakers[seg.speakerId] || { name: 'Unknown', centroid: null };
        }
      }

      delete meeting.pendingRefine;
      meeting.refined = true;
      saveMeeting(meeting);
      for (const file of Object.values(wavs)) fs.rmSync(file, { force: true });
      return forRenderer(meeting);
    } finally {
      refining = false;
    }
  });

  // Naming a speaker also stores their voice print, so later meetings recognise them.
  ipcMain.handle('speakers:rename', (_e, id, speakerId, rawName) => {
    const name = String(rawName || '').trim().slice(0, 60);
    const meeting = loadMeeting(id);
    const speaker = meeting.speakers[speakerId];
    if (!name || !speaker) return forRenderer(meeting);
    speaker.name = name;
    saveMeeting(meeting);
    if (speaker.centroid) {
      const voices = loadVoices();
      learn.addVoiceSample(voices, name, speaker.centroid);
      writeJson(voicesFile, voices);
    }
    return forRenderer(meeting);
  });

  // "This line was actually said by someone else." The lines move to that
  // person, and their voice prints become samples of that person's voice.
  ipcMain.handle('segments:assign', (_e, id, segmentIds, rawName) => {
    const name = String(rawName || '').trim().slice(0, 60);
    const meeting = loadMeeting(id);
    const ids = new Set(segmentIds);
    const lines = meeting.segments.filter((s) => ids.has(s.id));
    if (!name || !lines.length) return forRenderer(meeting);

    const voices = loadVoices();
    const lower = name.toLowerCase();
    let targetId = Object.keys(meeting.speakers).find((sid) => meeting.speakers[sid].name.toLowerCase() === lower);
    if (!targetId) {
      const voice = voices.find((v) => v.name.toLowerCase() === lower);
      if (voice) targetId = `voice:${voice.name}`;
      else {
        const numbers = Object.keys(meeting.speakers).map((sid) => Number((/^spk-(\d+)$/.exec(sid) || [])[1]) || 0);
        targetId = `spk-${Math.max(0, ...numbers) + 1}`;
      }
      meeting.speakers[targetId] = { name: voice ? voice.name : name, centroid: null };
    }
    if (lines.every((s) => s.speakerId === targetId)) return forRenderer(meeting);
    for (const seg of lines) seg.speakerId = targetId;
    for (const sid of Object.keys(meeting.speakers)) {
      if (sid !== 'me' && !meeting.segments.some((s) => s.speakerId === sid)) delete meeting.speakers[sid];
    }

    const target = meeting.speakers[targetId];
    if (targetId !== 'me' && !isPlaceholder(target.name)) {
      const prints = readJson(printsFile(id), {});
      for (const seg of lines) learn.addVoiceSample(voices, target.name, prints[seg.id]);
      writeJson(voicesFile, voices);
    }
    countCorrection(meeting, 'speaker');
    saveMeeting(meeting);
    return forRenderer(meeting);
  });

  // The user fixed the wording of a turn. The turn's lines are merged into
  // one, and the changed words are remembered for future transcripts.
  ipcMain.handle('segments:edit', (_e, id, segmentIds, rawText) => {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    const meeting = loadMeeting(id);
    const ids = new Set(segmentIds);
    const lines = meeting.segments.filter((s) => ids.has(s.id));
    if (!lines.length) return forRenderer(meeting);
    const before = lines.map((s) => s.text).join(' ');
    if (text === before) return forRenderer(meeting);
    if (!text) {
      meeting.segments = meeting.segments.filter((s) => !ids.has(s.id));
    } else {
      lines[0].text = text;
      lines[0].end = lines[lines.length - 1].end;
      const rest = new Set(lines.slice(1).map((s) => s.id));
      meeting.segments = meeting.segments.filter((s) => !rest.has(s.id));
      const learning = loadLearning();
      if (learn.learnFromEdit(learning, before, text)) saveLearning(learning);
    }
    countCorrection(meeting, 'text');
    saveMeeting(meeting);
    return forRenderer(meeting);
  });

  // What Scrunchy has learned so far, for the Settings panel.
  ipcMain.handle('learning:summary', () => {
    const learning = loadLearning();
    const voices = loadVoices();
    const meetings = fs.existsSync(meetingsDir)
      ? fs.readdirSync(meetingsDir).map((mid) => readJson(meetingFile(mid), null)).filter((m) => m && m.refined && m.duration > 0)
      : [];
    meetings.sort((a, b) => b.createdAt - a.createdAt);
    const rate = (list) => {
      const hours = list.reduce((sum, m) => sum + m.duration, 0) / 3600;
      const fixes = list.reduce((sum, m) => sum + ((m.corrections || {}).speaker || 0) + ((m.corrections || {}).text || 0), 0);
      return hours > 0 ? { perHour: fixes / hours, meetings: list.length } : null;
    };
    return {
      names: Object.fromEntries(voices.map((v) => [v.name, v.embeddings.length])),
      threshold: learn.calibrate(voices),
      terms: learn.learnedTerms(learning),
      replacements: learning.replacements.map((r) => ({ ...r, active: learn.isActive(r) })),
      hasStyle: !!learning.styleExample,
      recent: rate(meetings.slice(0, 5)),
      earlier: rate(meetings.slice(5)),
    };
  });

  ipcMain.handle('learning:forget', (_e, kind, key) => {
    const learning = loadLearning();
    if (kind === 'replacement') learning.replacements = learning.replacements.filter((r) => r.from !== key);
    if (kind === 'term') delete learning.terms[key];
    if (kind === 'style') learning.styleExample = null;
    saveLearning(learning);
    return true;
  });

  ipcMain.handle('voices:list', () => loadVoices().map((v) => ({ name: v.name, samples: v.embeddings.length })));
  ipcMain.handle('voices:delete', (_e, name) => {
    writeJson(voicesFile, loadVoices().filter((v) => v.name !== name));
    return true;
  });

  ipcMain.handle('notes:generate', async (event, id) => {
    const meeting = loadMeeting(id);
    const text = await generateNotes(meeting, (piece) => {
      if (!event.sender.isDestroyed()) event.sender.send('notes:chunk', { meetingId: id, piece });
    });
    meeting.aiNotes = text;
    saveMeeting(meeting);
    return text;
  });
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    autoHideMenuBar: true,
    title: 'Scrunchy',
    icon: path.join(__dirname, '..', 'assets', 'scrunchy.ico'),
    // Windows 11 draws blurred glass behind the window; the page tints it dark.
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#4a4a46', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));

  // Development aid: SCRUNCHY_SHOT=<file.png> saves a screenshot and logs page errors.
  const shot = process.env.SCRUNCHY_SHOT;
  if (shot) {
    win.webContents.on('console-message', (e) => console.log(`[page:${e.level}] ${e.message} (${path.basename(e.sourceId || '')}:${e.lineNumber})`));
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
        console.log('screenshot saved');
      }, 1500);
    });
  }
}

// Its own taskbar identity, so Windows shows the Scrunchy icon rather than Electron's.
app.setAppUserModelId('com.surhay.scrunchy');
// The glass behind the window follows the app theme; the design is light.
nativeTheme.themeSource = 'light';

app.whenReady().then(() => {
  dataDir = path.join(app.getPath('userData'), 'data');
  meetingsDir = path.join(dataDir, 'meetings');
  voicesFile = path.join(dataDir, 'voices.json');
  settingsFile = path.join(dataDir, 'settings.json');
  learningFile = path.join(dataDir, 'learning.json');
  modelsDir = path.join(app.getAppPath(), 'models');

  // "Share screen" requests from our own window get the system audio (loopback)
  // without a picker; the video track is discarded by the page.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });

  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  if (active) saveMeeting(active.meeting);
  app.quit();
});
