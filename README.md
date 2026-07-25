# Audio Editor

A minimal multi-track audio suite in the browser: arrange clips, mix, record,
edit fades/envelopes, and export to WAV/MP3/FLAC/OGG — all client-side (Vite +
Web Audio + ffmpeg.wasm).

Live site: [audio.toeffe.uk](https://audio.toeffe.uk)

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

- **Multi-track** — drop audio onto a lane or **+ Track**; drag clips between lanes; remove tracks
- **Transport** — play, stop, undo/redo, live scrub (ruler / playhead / Alt-click), zoom, master gain
- **Mixer** — per-track mute, solo, fader (separate from clip gain)
- **Record** — arm a track (●), then Record (R) from the microphone
- **Edit** — header **Edit ▾** menu or right-click: split, merge, crossfade, duplicate, delete, envelope, spectrogram, clear
- **Selection / clipboard** — Shift-drag a time range; copy/paste clip, region, or whole track (new track on paste)
- **Fades** — drag fade handles on a selected clip, or use Fade in / Fade out fields
- **Crossfade** — overlapping clips on the same track crossfade linearly; menu action creates a 50ms overlap
- **Speed** — clip rate 0.25–4× (pitch follows)
- **Envelope / spectrogram** on clips
- **Export** — header **Export ▾**: format, bitrate, optional title/artist metadata

## Project structure

```
src/
  audio/       Decode, resample, engine, renderer, recorder, envelopes, FFT, assets
  export/      WAV + FFmpeg encode
  project/     Tracks, clips, undo/redo
  ui/          Viewport timeline, track headers, context menu
  __tests__/   Vitest unit tests
public/        Favicon, CNAME, ffmpeg core (postinstall)
.github/       Pages deploy workflow
```
