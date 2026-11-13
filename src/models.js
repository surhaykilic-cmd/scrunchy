'use strict';
// Single source of truth for the models: where they live on disk and where
// the setup script downloads them from.
const fs = require('fs');
const path = require('path');

const SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const ASR_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const SEG_DIR = 'sherpa-onnx-pyannote-segmentation-3-0';

// `file` is saved under ./models. Archives are unpacked into `into` (default:
// ./models itself) and removed; `check` is the path that proves it is installed.
const DOWNLOADS = [
  {
    label: 'Voice activity detector (Silero VAD)',
    url: `${SHERPA}/asr-models/silero_vad.onnx`,
    file: 'silero_vad.onnx',
  },
  {
    label: 'Speaker recognition (WeSpeaker ResNet34)',
    url: `${SHERPA}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx`,
    file: 'speaker.onnx',
  },
  {
    label: 'Live transcription (Parakeet TDT 0.6b v3)',
    url: `${SHERPA}/asr-models/${ASR_DIR}.tar.bz2`,
    file: `${ASR_DIR}.tar.bz2`,
    extract: true,
    check: path.join(ASR_DIR, 'tokens.txt'),
  },
  {
    label: 'Speaker turn detection (pyannote segmentation 3.0)',
    url: `${SHERPA}/speaker-segmentation-models/${SEG_DIR}.tar.bz2`,
    file: `${SEG_DIR}.tar.bz2`,
    extract: true,
    check: path.join(SEG_DIR, 'model.onnx'),
  },
  {
    label: 'Whisper GPU runtime (whisper.cpp, CUDA 12)',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip',
    file: 'whisper-cublas.zip',
    extract: true,
    into: 'whisper',
    check: 'whisper',
  },
  {
    label: 'Final transcription (Whisper large-v3, 3.1 GB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    file: 'ggml-large-v3.bin',
  },
];

// Models for the live draft: recording cannot start without these.
function modelFiles(dir) {
  return {
    vad: path.join(dir, 'silero_vad.onnx'),
    speaker: path.join(dir, 'speaker.onnx'),
    encoder: path.join(dir, ASR_DIR, 'encoder.int8.onnx'),
    decoder: path.join(dir, ASR_DIR, 'decoder.int8.onnx'),
    joiner: path.join(dir, ASR_DIR, 'joiner.int8.onnx'),
    tokens: path.join(dir, ASR_DIR, 'tokens.txt'),
  };
}

function findFile(dir, name, depth = 3) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory() && depth > 0) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

// Models for the post-meeting pass. Returns null when any piece is missing,
// in which case the live draft simply stays as the final transcript.
function refineFiles(dir) {
  const files = {
    whisperCli: findFile(path.join(dir, 'whisper'), 'whisper-cli.exe'),
    whisperModel: path.join(dir, 'ggml-large-v3.bin'),
    segmentation: path.join(dir, SEG_DIR, 'model.onnx'),
    speaker: path.join(dir, 'speaker.onnx'),
  };
  return Object.values(files).every((f) => f && fs.existsSync(f)) ? files : null;
}

module.exports = { DOWNLOADS, modelFiles, refineFiles };
