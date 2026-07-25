# Audio Editor

A minimal full audio suite in the browser: multi-track arrangement, mixer
(mute/solo/fader), mic recording, clip speed, same-track crossfades, envelopes,
spectrogram, and export to WAV/MP3/FLAC/OGG — all client-side.

## Setup

```bash
npm install   # also copies the FFmpeg WASM core into public/ffmpeg
npm run dev
```

```bash
npm run build
npm run preview
npm test
npm run typecheck
```

## Features

- **Multi-track** — drop files to append tracks; drag clips between lanes
- **Transport** — play, stop, live scrub (ruler / playhead / Alt-click), zoom without canvas crashes
- **Mixer** — per-track mute, solo, fader; master gain
- **Record** — arm a track (●), then Record (R) from the microphone
- **Edit** — split, merge abutting clips, duplicate, delete, clear project
- **Crossfade** — overlapping clips on the same track crossfade linearly; “Crossfade” creates a 50ms overlap
- **Speed** — clip rate 0.25–4× (pitch follows)
- **Envelope / fades / spectrogram** on clips
- **Export** — WAV, MP3, FLAC, OGG with optional metadata

## Limitations (intentional for this pass)

- No project save/load with embedded audio
- No MIDI / plugins / sends
- Speed changes pitch (no pitch-preserving time-stretch yet)
- No punch-in / take comping

## Project structure

```
src/
  audio/       Decode, resample, engine, renderer, recorder, envelopes, FFT, assets
  export/      WAV + FFmpeg encode
  project/     Tracks, clips, undo/redo
  ui/          Viewport timeline + track headers
  __tests__/   Vitest unit tests
```
