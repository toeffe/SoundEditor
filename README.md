# Audio Editor

**Toeffe's multi-track audio editor** — arrange, mix, record, and export entirely in the browser. No server uploads; audio stays on your machine.

**Live:** [audio.toeffe.uk](https://audio.toeffe.uk)

Built with Vite, TypeScript, Web Audio API, and ffmpeg.wasm.

---

## Features

### Timeline & tracks
- Multi-track lanes — drop audio onto a track or **+ Track**
- Drag clips between lanes; move, trim, split, merge, duplicate
- Scroll-wheel zoom; playhead scrub (ruler / playhead / Alt-click)
- Playhead **follows** the viewport during playback
- Per-track **Delete**, mute, solo, fader, level meter, and **Speed** (0.25–4×, pitch follows)
- Per-track **Rec** — record from the microphone onto that track

### Editing
- **Edit ▾** or right-click: split, merge, crossfade (50 ms overlap), envelope mode, spectrogram, clear
- **Envelope** dots for volume automation (double-click to remove points)
- Overlapping clips on the same track **crossfade** linearly
- Shift-drag a **loop region**; enable loop from the context menu or **L**
- **Snap** to grid (0.1 / 0.5 / 1 s) and **magnetic** snap to clip edges (Edit ▾)
- Keyboard nudges: arrows (playhead), Shift+arrows (clip), Alt+arrows (fine), Home / End

### Effects (per track)
- **FX** button opens EQ (3-band), compressor, and **Nightcore** (rate × pitch)
- Double-click an FX slider to reset it to default

### Mix & meters
- Master gain with horizontal peak meter (level remembered in the browser)
- Per-track peak meters while playing

### Save & export
- **Autosave** to IndexedDB — previous session restores on reload
- **`.toff`** portable projects — **Files ▾ → Download / Open .toff** (or drop a `.toff` on the timeline)
- **Export audio** — WAV, MP3, FLAC, OGG (+ bitrate & optional title/artist)
- **Clear browser session** when you want a clean slate

### UI
- Light / dark theme toggle
- Session **Log** in the footer (activity history)
- Undo / redo

---

## Quick start

You only need this if you want to run or change the app locally. To just use the editor, open **[audio.toeffe.uk](https://audio.toeffe.uk)**.

### 1. Get the code

**Option A — Download ZIP (no Git required)**

1. Open the repo: [github.com/toeffe/SoundEditor](https://github.com/toeffe/SoundEditor)
2. Click the green **Code** button → **Download ZIP**
3. Unzip the file somewhere on your computer
4. Open a terminal in that unzipped folder

**Option B — Clone with Git**

```bash
git clone https://github.com/toeffe/SoundEditor.git
cd SoundEditor
```

### 2. Install & run

Requires [Node.js](https://nodejs.org/) (v20+ recommended).

```bash
npm install   # also copies FFmpeg WASM core into public/ffmpeg
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

### 3. Other commands

```bash
npm run build      # production build → dist/
npm run preview    # serve the build locally
npm test           # Vitest
npm run typecheck  # tsc --noEmit
```

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Space | Play / pause |
| S | Split at playhead |
| E | Envelope mode |
| L | Toggle loop (needs a Shift-drag region) |
| Delete / Backspace | Delete selected clip |
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z | Redo |
| Ctrl/Cmd+C / V | Copy / paste track or selection |
| ← / → | Nudge playhead |
| Shift+← / → | Nudge selected clip |
| Alt+← / → | Fine nudge |
| Home / End | Playhead to start / project end |

---

## `.toff` project files

A `.toff` file is a portable project container:

1. Magic `TOFF` + version header  
2. JSON manifest (tracks, clips, UI flags, asset metadata)  
3. Concatenated WAV blobs for used assets  

Use **Download .toff** for backups or sharing; use **Open .toff** (or drag onto the timeline) to restore. Browser autosave is separate and stays local to that browser.

---

## Project structure

```
src/
  audio/       Decode, engine, renderer, recorder, envelopes, FX, snap, meters
  export/      WAV encode + ffmpeg.wasm (MP3/FLAC/OGG)
  project/     Tracks, clips, undo/redo
  storage/     IndexedDB autosave + .toff read/write
  ui/          Timeline, track headers, context menu
  __tests__/   Vitest unit tests
public/        Favicon, CNAME, ffmpeg core (via postinstall)
.github/       GitHub Pages deploy workflow
```

---

## Tech notes

- **Client-only** — decoding, mixing, recording, and export run in the page
- **Web Audio** for realtime playback, analysers, and offline render
- **ffmpeg.wasm** for compressed export formats (`@ffmpeg/ffmpeg` + `@ffmpeg/core`)
- **IndexedDB** for autosave (not `localStorage` — projects are too large)
- Master volume & theme prefs use **localStorage**

---

## Browser support

Modern Chromium, Firefox, and Safari with Web Audio and WebAssembly. Microphone access is required for recording; a secure context (`https://` or `localhost`) is needed for mic + some APIs.

---

## License

Released under the MIT License. Copyright (c) 2026 toeffe.
