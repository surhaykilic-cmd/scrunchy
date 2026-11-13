'use strict';
// Post-meeting pass: re-transcribe the saved audio with Whisper large-v3 on
// the GPU and line the words up with whole-recording speaker turns.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;

// Streams 16 kHz mono float audio to a 16-bit WAV file while recording.
class WavWriter {
  constructor(file) {
    this.fd = fs.openSync(file, 'w');
    this.samples = 0;
    fs.writeSync(this.fd, Buffer.alloc(44));
  }

  write(float32) {
    const buf = Buffer.allocUnsafe(float32.length * 2);
    for (let i = 0; i < float32.length; i++) {
      const v = Math.max(-1, Math.min(1, float32[i]));
      buf.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    fs.writeSync(this.fd, buf);
    this.samples += float32.length;
  }

  close() {
    if (this.fd === null) return;
    const bytes = this.samples * 2;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + bytes, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22); // mono
    h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(SAMPLE_RATE * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(bytes, 40);
    fs.writeSync(this.fd, h, 0, 44, 0);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

// Runs whisper.cpp on one WAV file and returns word-level timings (seconds).
function runWhisper({ files, wav, vocabulary, onProgress }) {
  return new Promise((resolve, reject) => {
    const out = wav.replace(/\.wav$/i, '') + '.whisper';
    const args = [
      '-m', files.whisperModel,
      '-f', wav,
      '-l', 'auto',
      '-oj', '-of', out,
      '-ml', '1', '-sow', // one word per output entry, so speakers can be assigned per word
      '-pp',
    ];
    const terms = String(vocabulary || '').split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
    // Whisper copies the style of its prompt. Without one, casual speech often
    // comes back as lowercase text with no punctuation, which also breaks the
    // sentence-based speaker assignment. (whisper.cpp's own --vad option is not
    // used: with it the prompt is ignored. The engine cuts the silence instead.)
    const prompt = ['Hello, everyone. This is a recording of a meeting, written with full punctuation and capital letters.'];
    if (terms.length) prompt.push(`Glossary: ${terms.join(', ')}.`);
    args.push('--prompt', prompt.join(' '), '--carry-initial-prompt');

    const child = spawn(files.whisperCli, args, { cwd: path.dirname(files.whisperCli), windowsHide: true });
    let log = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      log = (log + text).slice(-4000);
      const m = /progress\s*=\s*(\d+)%/.exec(text);
      if (m && onProgress) onProgress(Number(m[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      const json = out + '.json';
      if (code !== 0 || !fs.existsSync(json)) {
        return reject(new Error(`Whisper failed (exit ${code}): ${log.trim().split('\n').slice(-3).join(' | ')}`));
      }
      try {
        const data = JSON.parse(fs.readFileSync(json, 'utf8'));
        fs.unlinkSync(json);
        const words = [];
        for (const item of data.transcription || []) {
          const text = item.text || '';
          // Drop non-speech markers such as [BLANK_AUDIO] or (music).
          if (!text.trim() || /^\s*[\[(].*[\])]\s*$/.test(text)) continue;
          words.push({ start: item.offsets.from / 1000, end: item.offsets.to / 1000, text });
        }
        resolve(words);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Turns can overlap: a listener's "uh-huh" sits inside the talker's long turn.
// The shortest turn covering a moment is the most specific, so it wins.
// Whisper ran on a copy of the audio with the silences cut out. Put each
// word back on the original timeline. `regions` come from the engine:
// {start, end} in the original and {at} in the shortened copy.
function restoreTimes(words, regions) {
  // A time that lands in the short gap between two kept stretches belongs to
  // the next stretch if it is where a word starts, and to the previous one if
  // it is where a word ends.
  const place = (t, isStart) => {
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const length = r.end - r.start;
      if (t < r.at) return r.start;
      if (t <= r.at + length) return r.start + (t - r.at);
      const next = regions[i + 1];
      if (!next || t < next.at) return isStart && next ? next.start : r.end;
    }
    return regions[regions.length - 1].end;
  };
  return words.map((w) => {
    const start = place(w.start, true);
    return { ...w, start, end: Math.max(start, place(w.end, false)) };
  });
}

function speakerAt(turns, time) {
  let inside = null;
  let best = null;
  let bestGap = Infinity;
  for (const turn of turns) {
    if (time >= turn.start && time <= turn.end) {
      if (!inside || turn.end - turn.start < inside.end - inside.start) inside = turn;
      continue;
    }
    if (inside) continue;
    const gap = time < turn.start ? turn.start - time : time - turn.end;
    if (gap < bestGap) {
      bestGap = gap;
      best = turn.speakerId;
    }
  }
  return inside ? inside.speakerId : best;
}

const endsSentence = (text) => /[.!?]["')\]]?\s*$/.test(text);

// Whisper's word timings run edge to edge, so a pause gets absorbed into the
// word next to it and that word appears to last many seconds. Cut such a word
// back to a plausible length. The pause normally sits before the word, except
// when the word finishes a sentence that was already under way.
function trimStretch(w, i, words) {
  const limit = Math.min(1.5, 0.3 + 0.09 * w.text.trim().length);
  if (w.end - w.start <= limit) return w;
  const prev = words[i - 1];
  const pauseAfter = endsSentence(w.text) && prev && !endsSentence(prev.text);
  return pauseAfter ? { ...w, end: w.start + limit } : { ...w, start: w.end - limit };
}

// Groups words into transcript segments, one speaker each.
// `turns` is [{start, end, speakerId}]; with no turns everything goes to `fallback`.
function buildSegments({ words, turns, fallback, source, offset }) {
  const labelled = words.map(trimStretch).map((w) => ({ ...w, speakerId: speakerAt(turns, (w.start + w.end) / 2) || fallback }));
  // People rarely change mid-sentence, but turn boundaries are only accurate
  // to a word or two. So each sentence goes, whole, to whoever holds most of it.
  let from = 0;
  for (let i = 0; i < labelled.length; i++) {
    const next = labelled[i + 1];
    if (next && !endsSentence(labelled[i].text) && next.start - labelled[i].end <= 1) continue;
    const time = {};
    for (let j = from; j <= i; j++) {
      const w = labelled[j];
      time[w.speakerId] = (time[w.speakerId] || 0) + Math.max(0.05, w.end - w.start);
    }
    const winner = Object.keys(time).sort((a, b) => time[b] - time[a])[0];
    for (let j = from; j <= i; j++) labelled[j].speakerId = winner;
    from = i + 1;
  }

  const segments = [];
  let current = null;
  for (const w of labelled) {
    const sentenceDone = current && endsSentence(current.text);
    const split =
      !current ||
      current.speakerId !== w.speakerId ||
      w.start - current.end > 1.5 ||
      (sentenceDone && current.end - current.start > 20);
    if (split) {
      current = { source, start: w.start, end: w.end, text: w.text, speakerId: w.speakerId };
      segments.push(current);
    } else {
      current.text += w.text;
      current.end = w.end;
    }
  }
  return segments
    .map((s) => ({ ...s, start: s.start + offset, end: s.end + offset, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text);
}

module.exports = { WavWriter, runWhisper, restoreTimes, buildSegments };
