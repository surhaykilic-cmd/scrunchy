'use strict';

const $ = (id) => document.getElementById(id);
// `api` is the bridge to the main process, exposed globally by preload.js.

const state = {
  list: [],
  meeting: null,
  tab: 'mine',
  recording: false,
  generating: false,
  renaming: false,
  transcriptDirty: false,
  aiDraft: '',
  aiError: '',
  refining: false,
  aiEditing: false,
  status: null,
};

let capture = null; // live audio capture while recording
let notesTimer = null;

// ---------- helpers ----------

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const cleanError = (err) =>
  String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function showBanner(parts) {
  const banner = $('banner');
  banner.replaceChildren(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p)));
  banner.hidden = parts.length === 0;
}

// ---------- markdown (small, DOM-only renderer) ----------

function inline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      parent.append(el('strong', '', part.slice(2, -2)));
    } else {
      parent.append(document.createTextNode(part.replace(/`/g, '')));
    }
  }
}

function renderMarkdown(target, source) {
  target.replaceChildren();
  let list = null;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== tag) target.append((list = el(tag.toLowerCase())));
      const item = el('li');
      inline(item, (bullet || numbered)[1].replace(/^\[[ xX]\]\s*/, ''));
      list.append(item);
      continue;
    }
    list = null;
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    let node;
    if (heading) node = el(heading[1].length <= 2 ? 'h2' : 'h3');
    else if (line.startsWith('>')) node = el('blockquote');
    else node = el('p');
    inline(node, heading ? heading[2] : line.replace(/^>\s*/, ''));
    target.append(node);
  }
}

// ---------- sidebar ----------

async function loadList() {
  state.list = await api.listMeetings();
  const ul = $('meeting-list');
  ul.replaceChildren();
  if (!state.list.length) ul.append(el('li', 'none', 'No meetings yet'));
  for (const m of state.list) {
    const li = el('li', state.meeting && state.meeting.id === m.id ? 'active' : '');
    li.append(el('div', 'name', m.title || 'Untitled'));
    const when = new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    li.append(el('div', 'when', m.duration ? `${when} · ${clock(m.duration)}` : when));
    li.addEventListener('click', () => openMeeting(m.id));
    ul.append(li);
  }
}

async function flushNotes() {
  if (!notesTimer || !state.meeting) return;
  clearTimeout(notesTimer);
  notesTimer = null;
  await api.updateMeeting(state.meeting.id, { notes: $('notes').value });
}

async function openMeeting(id) {
  if (state.recording || state.generating || state.refining) return; // finish the current meeting first
  await flushNotes();
  state.meeting = await api.getMeeting(id);
  state.aiDraft = '';
  state.aiError = '';
  state.aiEditing = false;
  setTab(state.meeting.aiNotes ? 'ai' : 'mine');
  renderMeeting();
  loadList();
}

// ---------- meeting view ----------

function renderMeeting() {
  const m = state.meeting;
  $('empty').hidden = !!m;
  $('meeting').hidden = !m;
  if (!m) return;
  $('title').value = m.title;
  $('notes').value = m.notes || '';
  renderMeta();
  renderPlayers();
  renderAiNotes();
  renderTranscript();
  renderButtons();
}

function renderMeta() {
  const m = state.meeting;
  const when = new Date(m.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('meta').textContent = m.duration ? `${when} · ${clock(m.duration)} recorded` : when;
}

function renderPlayers() {
  const players = $('players');
  players.replaceChildren();
  for (const url of state.meeting.audioUrls || []) {
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    players.append(audio);
  }
}

function renderButtons() {
  const m = state.meeting;
  const record = $('record');
  record.classList.toggle('recording', state.recording);
  if (!record.dataset.busy && !state.refining) {
    $('record-label').textContent = state.recording ? 'Stop recording' : m.duration ? 'Resume recording' : 'Start recording';
  }
  $('levels').hidden = !state.recording;
  if (!state.recording) $('timer').textContent = '';
  const busy = state.recording || state.generating || state.refining;
  $('delete').disabled = busy;
  $('new-meeting').disabled = busy;
  // Offered when an earlier improvement pass did not finish.
  $('refine').hidden = !(canRefine(m) && state.status && state.status.refineAvailable) || busy;
  $('refine').textContent = m.refined && !m.pendingRefine ? 'Improve again' : 'Improve transcript';
  $('edit-ai').hidden = !(state.tab === 'ai' && m.aiNotes) || state.generating;
  $('edit-ai').textContent = state.aiEditing ? 'Save' : 'Edit';
  const generate = $('generate');
  generate.disabled = busy || state.aiEditing;
  generate.textContent = state.generating ? 'Generating…' : m.aiNotes ? 'Regenerate notes' : 'Generate notes';
}

function setTab(tab) {
  state.tab = tab;
  $('tab-mine').classList.toggle('active', tab === 'mine');
  $('tab-ai').classList.toggle('active', tab === 'ai');
  $('notes').hidden = tab !== 'mine';
  $('ai-notes').hidden = tab !== 'ai' || state.aiEditing;
  $('ai-edit').hidden = tab !== 'ai' || !state.aiEditing;
  if (state.meeting) renderButtons();
}

// Edit the AI notes as plain Markdown. A saved edit also becomes the example
// that future notes are modelled on.
async function toggleAiEdit() {
  const m = state.meeting;
  if (!state.aiEditing) {
    state.aiEditing = true;
    $('ai-edit').value = m.aiNotes;
  } else {
    const text = $('ai-edit').value.trim();
    state.aiEditing = false;
    if (text && text !== m.aiNotes) {
      m.aiNotes = text;
      await api.updateMeeting(m.id, { aiNotes: text, edited: true });
    }
    renderAiNotes();
  }
  setTab('ai');
  if (state.aiEditing) $('ai-edit').focus();
}

function renderAiNotes() {
  const box = $('ai-notes');
  const text = state.generating ? state.aiDraft : state.meeting.aiNotes;
  if (state.aiError) {
    box.replaceChildren(el('p', 'error', state.aiError));
  } else if (text) {
    renderMarkdown(box, text);
  } else {
    box.replaceChildren(
      el(
        'p',
        'placeholder',
        state.generating
          ? 'Reading the transcript…'
          : 'After the meeting, choose Generate notes to turn the transcript and your rough notes into a summary.'
      )
    );
  }
}

function renderTranscript() {
  if (state.renaming) {
    state.transcriptDirty = true;
    return;
  }
  const box = $('transcript');
  const m = state.meeting;
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  if (!m.segments.length) {
    box.append(el('p', 'placeholder', state.recording ? 'Listening…' : 'The transcript appears here while you record.'));
    return;
  }
  const order = Object.keys(m.speakers);
  // Corrections wait until the transcript is final: the live draft is replaced.
  const editable = !state.recording && !state.refining;
  let turn = null;
  for (const seg of m.segments) {
    if (turn && turn.speakerId === seg.speakerId) {
      turn.text.textContent += ' ' + seg.text;
      turn.ids.push(seg.id);
      continue;
    }
    const wrap = el('div', seg.source === 'mic' ? 'turn mic' : 'turn');
    const head = el('div', 'turn-head');
    const name = (m.speakers[seg.speakerId] || {}).name || 'Unknown';
    const hue = Math.max(0, order.indexOf(seg.speakerId)) % 6;
    const speaker = el('button', `speaker hue-${hue}`, name);
    const text = el('p', 'turn-text', seg.text);
    const thisTurn = { speakerId: seg.speakerId, text, ids: [seg.id] };
    if (editable) {
      speaker.title = 'Change who said this, or rename them';
      speaker.addEventListener('click', () => openSpeakerMenu(speaker, thisTurn, name));
      text.title = 'Double-click to correct the wording';
      text.addEventListener('dblclick', () => beginEdit(text, thisTurn));
    }
    head.append(speaker, el('span', 'turn-time', clock(seg.start)));
    wrap.append(head, text);
    box.append(wrap);
    turn = thisTurn;
  }
  if (stick) box.scrollTop = box.scrollHeight;
}

function closeSpeakerMenu() {
  const menu = document.querySelector('.speaker-menu');
  if (menu) menu.remove();
}

// Clicking a name asks who really said this turn. Picking someone moves the
// turn to them and teaches Scrunchy their voice; renaming changes the name
// everywhere in the meeting.
async function openSpeakerMenu(button, turn, current) {
  if (state.renaming) return;
  if (document.querySelector('.speaker-menu')) return closeSpeakerMenu();
  const m = state.meeting;
  const menu = el('div', 'speaker-menu tile');
  menu.append(el('div', 'menu-label', 'Who said this?'));

  const names = new Set(Object.values(m.speakers).map((s) => s.name));
  for (const voice of await api.listVoices()) names.add(voice.name);
  names.delete(current);
  const assign = async (name) => {
    closeSpeakerMenu();
    try {
      state.meeting = { ...(await api.assignLines(m.id, turn.ids, name)), notes: $('notes').value };
    } catch (err) {
      showBanner([cleanError(err)]);
    }
    renderTranscript();
  };
  for (const name of names) {
    const option = el('button', 'menu-item', name);
    option.addEventListener('click', () => assign(name));
    menu.append(option);
  }
  const other = el('input', 'menu-input');
  other.placeholder = 'Someone else…';
  other.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && other.value.trim()) assign(other.value.trim());
    if (e.key === 'Escape') closeSpeakerMenu();
  });
  menu.append(other);

  const rename = el('button', 'menu-item quiet', `Rename ${current} everywhere`);
  rename.addEventListener('click', () => {
    closeSpeakerMenu();
    beginRename(button, turn.speakerId, current);
  });
  menu.append(rename);

  button.closest('.turn-head').append(menu);
  setTimeout(() => document.addEventListener('click', function away(e) {
    if (menu.contains(e.target)) return;
    document.removeEventListener('click', away);
    closeSpeakerMenu();
  }), 0);
}

// Double-clicking a turn makes its wording editable. Enter saves; Escape cancels.
function beginEdit(text, turn) {
  if (state.renaming) return;
  state.renaming = true;
  const before = text.textContent;
  text.contentEditable = 'plaintext-only';
  text.classList.add('editing');
  text.focus();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const after = text.textContent.replace(/\s+/g, ' ').trim();
    if (save && after !== before) {
      try {
        state.meeting = { ...(await api.editLines(state.meeting.id, turn.ids, after)), notes: $('notes').value };
      } catch (err) {
        showBanner([cleanError(err)]);
      }
    }
    state.renaming = false;
    renderTranscript();
  };
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
    if (e.key === 'Escape') finish(false);
  });
  text.addEventListener('blur', () => finish(true));
}

function beginRename(button, speakerId, current) {
  if (state.renaming) return;
  state.renaming = true;
  const input = el('input', 'speaker-input');
  input.value = /^Speaker \d+$/.test(current) ? '' : current;
  input.placeholder = 'Who is this?';
  button.replaceWith(input);
  input.focus();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (save && name && name !== current) {
      try {
        const updated = await api.renameSpeaker(state.meeting.id, speakerId, name);
        state.meeting.speakers = updated.speakers;
      } catch (err) {
        showBanner([cleanError(err)]);
      }
    }
    state.renaming = false;
    state.transcriptDirty = false;
    renderTranscript();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
}

// ---------- recording ----------

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// The saved microphone if it is still plugged in; otherwise the one Windows
// uses for calls, which is a better guess for meetings than the general default.
async function pickMic() {
  const wanted = state.status.settings.micId;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  if (wanted && inputs.some((d) => d.deviceId === wanted)) return { exact: wanted };
  return inputs.some((d) => d.deviceId === 'communications') ? { exact: 'communications' } : undefined;
}

async function openCapture() {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const streams = [];
  try {
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: await pickMic(), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streams.push(mic);

    // System audio (what the other people say) comes through a display capture
    // with loopback audio; the video track is not needed.
    let system = null;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streams.push(display);
      for (const track of display.getVideoTracks()) {
        track.stop();
        display.removeTrack(track);
      }
      if (display.getAudioTracks().length) system = display;
    } catch (err) {
      console.warn('System audio unavailable:', err);
    }

    const mix = ctx.createMediaStreamDestination();
    const silent = ctx.createGain();
    silent.gain.value = 0;
    silent.connect(ctx.destination);

    // A muted or switched-off microphone still "works" but sends exact zeros.
    let silentChunks = 0;
    const micName = (mic.getAudioTracks()[0].label || 'The microphone').replace(/^(Default|Communications) - /, '');

    const tap = (stream, source) => {
      const input = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'pcm', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      worklet.port.onmessage = (e) => {
        const level = rms(e.data);
        $(`level-${source}`).style.width = Math.min(100, level * 500) + '%';
        if (source === 'mic') {
          if (level > 0) {
            // Sound arrived (for example the mic was unmuted): withdraw the warning.
            if (silentChunks >= 50) showBanner([]);
            silentChunks = 0;
          } else if (++silentChunks === 50) {
            showBanner([`${micName} is sending no sound. It may be muted or switched off; you can choose another microphone in Settings.`]);
          }
        }
        api.sendAudio(source, e.data);
      };
      input.connect(worklet);
      worklet.connect(silent); // keeps the worklet running without playing anything
      input.connect(mix);
      // A separate compressed copy of this source, kept so the meeting can be
      // improved again later.
      const own = ctx.createMediaStreamDestination();
      input.connect(own);
      recorders[source] = startRecorder(own.stream, 32000);
    };
    const startRecorder = (stream, bitrate) => {
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: bitrate });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      return { recorder, chunks };
    };
    const recorders = {};
    tap(mic, 'mic');
    if (system) tap(system, 'system');
    recorders.mix = startRecorder(mix.stream, 48000);
    for (const r of Object.values(recorders)) r.recorder.start(1000);
    return { ctx, streams, recorders, hasSystem: !!system, startedAt: Date.now(), timer: null };
  } catch (err) {
    for (const s of streams) s.getTracks().forEach((t) => t.stop());
    ctx.close();
    throw err;
  }
}

async function closeCapture(cap) {
  clearInterval(cap.timer);
  const finish = ({ recorder, chunks }) =>
    new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }).arrayBuffer());
      recorder.stop();
    });
  const out = {};
  for (const [name, r] of Object.entries(cap.recorders)) out[name] = await finish(r);
  for (const s of cap.streams) s.getTracks().forEach((t) => t.stop());
  await cap.ctx.close();
  return out;
}

async function startRecording() {
  const m = state.meeting;
  const record = $('record');
  record.dataset.busy = '1';
  record.disabled = true;
  $('record-label').textContent = 'Loading models…';
  try {
    await api.startRecording(m.id);
    try {
      capture = await openCapture();
    } catch (err) {
      await api.stopRecording(m.id, null, 0);
      throw new Error(`Could not open the microphone: ${cleanError(err)}`);
    }
    state.recording = true;
    const base = m.duration || 0;
    const tick = () => ($('timer').textContent = clock(base + (Date.now() - capture.startedAt) / 1000));
    capture.timer = setInterval(tick, 500);
    tick();
    showBanner(
      capture.hasSystem ? [] : ['System audio could not be captured, so only your microphone is being recorded.']
    );
  } catch (err) {
    showBanner([cleanError(err)]);
  } finally {
    delete record.dataset.busy;
    record.disabled = false;
    renderButtons();
    renderTranscript();
  }
}

async function stopRecording() {
  const m = state.meeting;
  const record = $('record');
  record.dataset.busy = '1';
  record.disabled = true;
  $('record-label').textContent = 'Finishing…';
  try {
    await flushNotes();
    const seconds = (Date.now() - capture.startedAt) / 1000;
    const audio = await closeCapture(capture);
    capture = null;
    state.meeting = await api.stopRecording(m.id, audio.mix, seconds, { mic: audio.mic, system: audio.system });
  } catch (err) {
    showBanner([cleanError(err)]);
  } finally {
    state.recording = false;
    delete record.dataset.busy;
    record.disabled = false;
    renderMeta();
    renderPlayers();
    renderTranscript();
    renderButtons();
    loadList();
  }
  if (state.meeting.pendingRefine && state.status && state.status.refineAvailable) runRefine();
}

// A recording waiting to be improved, or an older meeting that never was.
// Also any meeting whose separate tracks were kept: those can be improved
// again whenever Scrunchy has learned more.
const hasTracks = (m) => (m.tracks || []).length > 0;
const canRefine = (m) =>
  m.pendingRefine || hasTracks(m) || (!m.refined && (m.audioUrls || []).length === 1 && m.segments.length > 0);

// A saved recording decoded to 16 kHz mono, the format the models take.
async function decodeAudio(meetingId, name) {
  const bytes = await api.meetingAudio(meetingId, name);
  const ctx = new AudioContext({ sampleRate: 16000 });
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } finally {
    ctx.close();
  }
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }
  return mono;
}

async function sendAudio(meetingId, mono, source) {
  const step = 16000 * 30;
  for (let i = 0; i < mono.length; i += step) {
    await api.importAudio(meetingId, 'data', mono.slice(i, i + step), { source });
  }
}

// Meetings from before the improvement pass kept only the mixed playback
// audio, so everything in them is treated as the call.
async function importOldAudio(m) {
  const mono = await decodeAudio(m.id);
  await api.importAudio(m.id, 'begin');
  await sendAudio(m.id, mono, 'system');
  await api.importAudio(m.id, 'end');
}

// One recording of a meeting, restored from its kept mic and call tracks.
async function importTracks(m, track) {
  await api.importAudio(m.id, 'begin', null, {
    part: track.part,
    offset: track.offset,
    until: track.offset + track.duration,
  });
  for (const source of ['mic', 'system']) {
    if (track[source]) await sendAudio(m.id, await decodeAudio(m.id, track[source]), source);
  }
  await api.importAudio(m.id, 'end');
}

// After a recording, the live draft is replaced by a slower, more accurate
// transcript with speakers worked out over the whole recording.
async function runRefine() {
  const m = state.meeting;
  if (!m || state.refining || state.recording) return;
  const again = !m.pendingRefine && m.refined;
  const fixes = ((m.corrections || {}).speaker || 0) + ((m.corrections || {}).text || 0);
  if (
    again &&
    fixes &&
    !confirm('Improving again rebuilds this transcript from the recording. What Scrunchy learned from your corrections is kept and applied, but the corrected lines themselves are replaced. Continue?')
  ) {
    return;
  }
  state.refining = true;
  $('record').disabled = true;
  $('record-label').textContent = 'Improving transcript…';
  renderButtons();
  renderTranscript();
  try {
    let updated;
    if (m.pendingRefine) {
      updated = await api.refine(m.id);
    } else if (hasTracks(m)) {
      for (const track of m.tracks) {
        $('record-label').textContent = 'Reading the recording…';
        await importTracks(m, track);
        updated = await api.refine(m.id);
      }
    } else {
      $('record-label').textContent = 'Reading the recording…';
      await importOldAudio(m);
      updated = await api.refine(m.id);
    }
    if (state.meeting && state.meeting.id === updated.id) {
      updated.notes = $('notes').value;
      state.meeting = updated;
    }
  } catch (err) {
    showBanner([`The transcript could not be improved, so the live draft was kept. ${cleanError(err)}`]);
  } finally {
    state.refining = false;
    $('record').disabled = false;
    renderTranscript();
    renderButtons();
  }
}

// ---------- AI notes ----------

async function generateNotes() {
  const m = state.meeting;
  await flushNotes();
  state.generating = true;
  state.aiDraft = '';
  state.aiError = '';
  setTab('ai');
  renderAiNotes();
  renderButtons();
  try {
    m.aiNotes = await api.generateNotes(m.id);
  } catch (err) {
    state.aiError = cleanError(err);
  } finally {
    state.generating = false;
    renderAiNotes();
    renderButtons();
  }
}

// ---------- settings ----------

async function refreshStatus() {
  const status = await api.status();
  state.status = status;
  if (status.modelsMissing) {
    showBanner(['The speech models are not downloaded yet. Run ', el('code', '', 'npm run setup'), ' in the project folder, then restart Scrunchy.']);
  }
  return status;
}

async function openSettings() {
  const status = await refreshStatus();
  const { ollama, settings } = status;
  $('ollama-status').textContent = ollama.ok
    ? ollama.models.length
      ? 'Ollama is running. Pick the model that writes your notes.'
      : `Ollama is running but has no models. Run: ollama pull ${settings.model}`
    : `Ollama is not running. Install it from ollama.com, then run: ollama pull ${settings.model}`;
  const select = $('model-select');
  select.replaceChildren();
  const names = ollama.models.includes(settings.model) ? ollama.models : [settings.model, ...ollama.models];
  for (const name of names) {
    const option = el('option', '', ollama.models.includes(name) ? name : `${name} (not installed)`);
    option.value = name;
    option.selected = name === settings.model;
    select.append(option);
  }
  const micSelect = $('mic-select');
  micSelect.replaceChildren();
  const auto = el('option', '', 'Automatic (the microphone Windows uses for calls)');
  auto.value = '';
  micSelect.append(auto);
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
  );
  for (const device of inputs) {
    const option = el('option', '', device.label || 'Microphone');
    option.value = device.deviceId;
    option.selected = device.deviceId === settings.micId;
    micSelect.append(option);
  }
  $('user-name').value = settings.userName;
  $('shared-mic').checked = settings.sharedMic;
  $('vocabulary').value = settings.vocabulary;
  await renderVoices();
  await renderLearning();
  $('settings').showModal();
}

// A plain account of what has been learned, with a way to undo a bad lesson.
async function renderLearning() {
  const info = await api.learningSummary();
  const facts = $('learning-facts');
  facts.replaceChildren();
  const add = (text) => facts.append(el('li', '', text));

  const t = info.threshold;
  add(
    t.auto
      ? `Voice matching is tuned to your saved voices (cut-off ${t.value}).`
      : 'Voice matching uses the standard cut-off. It tunes itself once a couple of people each have several saved samples.'
  );
  if (info.terms.length) add(`Learned names and terms: ${info.terms.join(', ')}.`);
  else add('No names or terms learned yet beyond your vocabulary list.');
  add(info.hasStyle ? 'New notes follow the style of the notes you last edited.' : 'Edit some AI notes and new ones will follow that style.');
  const rate = (r) => r.perHour.toFixed(1);
  if (info.recent && info.earlier) {
    add(`Corrections per hour of meeting: ${rate(info.recent)} in your last ${info.recent.meetings} meetings, ${rate(info.earlier)} before that.`);
  } else if (info.recent) {
    add(`Corrections per hour of meeting so far: ${rate(info.recent)}, over ${info.recent.meetings} meeting${info.recent.meetings === 1 ? '' : 's'}. A trend needs more than five.`);
  }

  const list = $('replacement-list');
  list.replaceChildren();
  for (const r of info.replacements) {
    const li = el('li');
    const forget = el('button', 'pill quiet', 'Forget');
    forget.addEventListener('click', async () => {
      await api.learningForget('replacement', r.from);
      renderLearning();
    });
    const note = r.active ? '' : ' (applied after one more identical fix)';
    li.append(el('span', '', `"${r.from}" becomes "${r.to}"${note}`), forget);
    list.append(li);
  }
}

async function renderVoices() {
  const ul = $('voice-list');
  ul.replaceChildren();
  const voices = await api.listVoices();
  if (!voices.length) ul.append(el('li', 'hint', 'No voices saved yet.'));
  for (const voice of voices) {
    const li = el('li');
    const remove = el('button', 'pill quiet', 'Forget');
    remove.addEventListener('click', async () => {
      await api.deleteVoice(voice.name);
      renderVoices();
    });
    li.append(el('span', '', `${voice.name} · ${voice.samples} sample${voice.samples === 1 ? '' : 's'}`), remove);
    ul.append(li);
  }
}

// ---------- wiring ----------

$('new-meeting').addEventListener('click', async () => {
  if (state.recording || state.generating || state.refining) return;
  const meeting = await api.createMeeting();
  await openMeeting(meeting.id);
  $('notes').focus();
});

$('record').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));

$('delete').addEventListener('click', async () => {
  if (!state.meeting || state.recording) return;
  clearTimeout(notesTimer);
  notesTimer = null;
  if (await api.deleteMeeting(state.meeting.id)) {
    state.meeting = null;
    renderMeeting();
    loadList();
  }
});

$('title').addEventListener('change', async () => {
  const title = $('title').value.trim() || 'Untitled';
  state.meeting.title = title;
  await api.updateMeeting(state.meeting.id, { title });
  loadList();
});
$('title').addEventListener('keydown', (e) => e.key === 'Enter' && $('title').blur());

$('notes').addEventListener('input', () => {
  state.meeting.notes = $('notes').value;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(flushNotes, 500);
});

$('tab-mine').addEventListener('click', () => setTab('mine'));
$('tab-ai').addEventListener('click', () => setTab('ai'));
$('generate').addEventListener('click', generateNotes);
$('edit-ai').addEventListener('click', toggleAiEdit);

$('copy').addEventListener('click', async () => {
  const text = state.tab === 'ai' ? (state.aiEditing ? $('ai-edit').value : state.meeting.aiNotes) : $('notes').value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200);
});

$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => $('settings').close());
const saveSetting = async (patch) => {
  state.status.settings = await api.setSettings(patch);
};
$('model-select').addEventListener('change', () => saveSetting({ model: $('model-select').value }));
$('mic-select').addEventListener('change', () => saveSetting({ micId: $('mic-select').value }));
$('user-name').addEventListener('change', () => saveSetting({ userName: $('user-name').value }));
$('shared-mic').addEventListener('change', () => saveSetting({ sharedMic: $('shared-mic').checked }));
$('vocabulary').addEventListener('change', () => saveSetting({ vocabulary: $('vocabulary').value }));
$('refine').addEventListener('click', runRefine);

api.onRefineProgress(({ meetingId, text }) => {
  if (state.refining && state.meeting && state.meeting.id === meetingId) $('record-label').textContent = text;
});

api.onSegment(({ meetingId, segment, speaker, removed }) => {
  const m = state.meeting;
  if (!m || m.id !== meetingId) return;
  // Mic lines that turned out to be an echo of the system audio.
  if (removed.length) m.segments = m.segments.filter((s) => !removed.includes(s.id));
  m.speakers[speaker.id] = { name: speaker.name };
  m.segments.push(segment);
  m.segments.sort((a, b) => a.start - b.start);
  renderTranscript();
});

api.onRecordingError((message) => showBanner([`Transcription problem: ${message}`]));

let aiFrame = 0;
api.onNotesChunk(({ meetingId, piece }) => {
  if (!state.generating || !state.meeting || state.meeting.id !== meetingId) return;
  state.aiDraft += piece;
  if (!aiFrame) {
    aiFrame = requestAnimationFrame(() => {
      aiFrame = 0;
      renderAiNotes();
    });
  }
});

(async () => {
  await refreshStatus();
  await loadList();
  if (state.list.length) await openMeeting(state.list[0].id);
  else renderMeeting();
})();
