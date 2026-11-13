# Scrunchy

A local meeting recorder for Windows. It records your microphone and the system audio, transcribes the meeting, labels who is speaking, and writes meeting notes — all on your own machine.

## Setup

```bash
npm install
npm run setup        # downloads the speech models and GPU Whisper into ./models (about 4 GB)
ollama pull gemma3:27b
npm start
```

Summaries need [Ollama](https://ollama.com) installed and running. Any Ollama model works; pick it in Settings. The post-meeting pass needs an NVIDIA GPU.

## How it works

| Stage | What runs | Where |
|---|---|---|
| Capture | Mic + system audio loopback; a mixed `audio-N.webm` for playback and a temporary WAV per source | `src/renderer/app.js`, `src/main.js` |
| Live draft | Silero VAD → Parakeet TDT 0.6b v3 (sherpa-onnx, CPU) | `src/engine.js` |
| Final transcript | After you stop: Whisper large-v3 on the GPU (whisper.cpp) re-transcribes each source | `src/refine.js` |
| Speakers | The microphone is you. The call is split by pyannote segmentation + WeSpeaker voice prints over the whole recording, then matched against voices you have named | `src/engine.js` |
| Notes | Transcript + your rough notes → Ollama | `src/main.js` |

Click a speaker's name in the transcript to name them. Their voice print is saved, and later meetings label them automatically. Settings holds your name, a vocabulary list (names and terms to spell correctly), and a switch for when several people share your microphone.

Meetings are stored under `%APPDATA%\scrunchy\data`.

## Learning

Nothing is retrained; the memory around the models grows as you use and correct Scrunchy (`src/learning.js`, stored in `learning.json` and `voices.json`).

| You do | Scrunchy learns |
|---|---|
| Click a speaker name and say who really spoke | That line's voice print becomes a sample of that person's voice |
| Double-click a line and fix the wording | Swapped words become replacements for later transcripts; names and terms join the vocabulary |
| Edit the AI notes | Later notes follow that structure and tone |
| Nothing | Confident voice matches add samples; capitalised words seen in notes across two meetings join the vocabulary |

Once a couple of people each have several samples, the same-person cut-off is calculated from them instead of the built-in default. Each meeting keeps a small compressed mic track and call track, so **Improve again** can rebuild its transcript with everything learned since. Settings shows what has been learned, the corrections-per-hour trend, and a Forget button for each learned replacement.

## Known limits

- Without headphones the microphone also hears the other participants. Repeated lines are filtered out, but headphones give cleaner results.
- Speaker labels are least reliable when people talk over each other.
- If the final pass fails, the live draft is kept and an "Improve transcript" button appears to retry.
