import './style.css';
import { Project, sliceClipToRange } from './project/Project';
import { Engine } from './audio/Engine';
import { decodeAudioFile, resampleBuffer } from './audio/Decoder';
import { renderProject } from './audio/Renderer';
import { Analyzer } from './audio/Analyzer';
import { AssetLibrary } from './audio/AssetLibrary';
import { Recorder } from './audio/Recorder';
import { Timeline } from './ui/Timeline';
import { ContextMenu } from './ui/ContextMenu';
import { exportAudio, getFFmpeg } from './export/FFmpegExporter';
import { clipDuration, type Clip, type Track } from './types';

const project = new Project();
const library = new AssetLibrary();
const engine = new Engine();
const analyzer = new Analyzer();
const recorder = new Recorder();
engine.setLibrary(library);

const timelineRow = document.getElementById('timeline-row')!;
const timeline = new Timeline(timelineRow);
const ctxMenu = new ContextMenu();

const statusEl = document.getElementById('status')!;
const playBtn = document.getElementById('play-btn')!;
const stopBtn = document.getElementById('stop-btn')!;
const recordBtn = document.getElementById('record-btn') as HTMLButtonElement;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
const editMenuBtn = document.getElementById('edit-menu-btn') as HTMLButtonElement;
const splitBtn = document.getElementById('split-btn')!;
const mergeBtn = document.getElementById('merge-btn')!;
const crossfadeBtn = document.getElementById('crossfade-btn')!;
const deleteBtn = document.getElementById('delete-btn')!;
const dupBtn = document.getElementById('dup-btn')!;
const clearBtn = document.getElementById('clear-btn')!;
const envBtn = document.getElementById('env-btn')!;
const specToggle = document.getElementById('spec-toggle')!;
const masterGainInput = document.getElementById('master-gain') as HTMLInputElement;
const masterGainValue = document.getElementById('master-gain-value')!;
const clipRateInput = document.getElementById('clip-rate') as HTMLInputElement;
const clipInfo = document.getElementById('clip-info')!;
const timeDisplay = document.getElementById('time-display')!;
const exportMenuBtn = document.getElementById('export-menu-btn') as HTMLButtonElement;
const exportPanel = document.getElementById('export-panel') as HTMLDivElement;
const exportBtn = document.getElementById('export-btn')!;
const formatSel = document.getElementById('format') as HTMLSelectElement;
const bitrateSel = document.getElementById('bitrate') as HTMLSelectElement;
const metaTitle = document.getElementById('meta-title') as HTMLInputElement;
const metaArtist = document.getElementById('meta-artist') as HTMLInputElement;

function refresh() {
  undoBtn.disabled = !project.canUndo;
  redoBtn.disabled = !project.canRedo;
  recordBtn.classList.toggle('active', recorder.isRecording);
  recordBtn.disabled = !project.armedTrackId && !recorder.isRecording;
  editMenuBtn.classList.toggle('active', timeline.mode === 'envelope');

  if (!masterGainGesture) {
    masterGainInput.value = String(Math.round(project.state.masterGain * 100));
    updateMasterReadout();
  }

  const clip = timeline.selectedClipId
    ? project.clips.find((c) => c.id === timeline.selectedClipId)
    : null;

  if (clip) {
    clipRateInput.disabled = false;
    clipRateInput.value = String(clip.rate);
    const dur = clipDuration(clip);
    const asset = library.get(clip.assetId);
    clipInfo.textContent = `${asset?.name ?? 'Clip'} @ ${clip.start.toFixed(2)}s · ${dur.toFixed(2)}s · ${clip.rate.toFixed(2)}×`;
  } else {
    clipRateInput.disabled = true;
    clipInfo.textContent = project.tracks.length
      ? 'No clip selected'
      : 'Add a track or drop audio onto the timeline';
  }
}

function syncMixer() {
  engine.syncTrackGains(project);
  refresh();
}

timeline.onProjectChange = refresh;
timeline.onTrackChange = syncMixer;

async function importFile(
  file: File,
  opts: { atTime?: number; trackId?: string | null; createTrack?: boolean } = {}
) {
  const atTime = Math.max(0, opts.atTime ?? timeline.playhead);
  statusEl.textContent = `Loading ${file.name}…`;
  let buffer: AudioBuffer;
  try {
    buffer = await decodeAudioFile(file);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Couldn't decode "${file.name}" — is it a supported audio file?`;
    return;
  }

  if (project.tracks.length === 0) {
    project.setSampleRate(buffer.sampleRate);
  } else if (buffer.sampleRate !== project.sampleRate) {
    buffer = await resampleBuffer(buffer, project.sampleRate, 2);
  } else if (buffer.numberOfChannels === 1) {
    buffer = await resampleBuffer(buffer, project.sampleRate, 2);
  }

  const asset = library.add(file.name, buffer);
  library.computePeaks(asset.id, timeline.zoom);

  const existing =
    opts.trackId && project.state.tracks.find((t) => t.id === opts.trackId)
      ? opts.trackId
      : null;
  const createTrack = opts.createTrack || !existing;

  let clipId: string;
  if (createTrack) {
    const name = file.name.replace(/\.[^.]+$/, '') || `Track ${project.tracks.length + 1}`;
    const track = project.createTrack(name);
    const clip = project.createClip(track.id, asset.id, atTime, 0, buffer.duration);
    project.addTrackWithClip(track, clip);
    clipId = clip.id;
  } else {
    const clip = project.createClip(existing!, asset.id, atTime, 0, buffer.duration);
    project.addClip(clip);
    clipId = clip.id;
  }

  timeline.setProject(project, library);
  timeline.selectedClipId = clipId;
  refresh();
  setStatus(`Added: ${file.name}`);

  setTimeout(() => {
    try {
      const canvas = analyzer.generate(buffer);
      library.setSpectrogram(asset.id, canvas);
      timeline.draw();
    } catch {
      setStatus('Spectrogram failed for last import');
    }
  }, 30);
}

function setStatus(message = '') {
  statusEl.textContent = message;
}

function addEmptyTrack() {
  const track = project.createTrack(`Track ${project.tracks.length + 1}`);
  project.addTrack(track);
  timeline.setProject(project, library);
  setStatus(`Added empty ${track.name}`);
  refresh();
}

function removeTrackById(trackId: string) {
  const track = project.state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const clipCount = project.clips.filter((c) => c.trackId === trackId).length;
  const msg =
    clipCount > 0
      ? `Remove “${track.name}” and its ${clipCount} clip${clipCount === 1 ? '' : 's'}?`
      : `Remove empty track “${track.name}”?`;
  if (!confirm(msg)) return;

  if (timeline.selectedClipId) {
    const sel = project.clips.find((c) => c.id === timeline.selectedClipId);
    if (sel?.trackId === trackId) {
      timeline.selectedClipId = null;
    }
  }

  project.removeTrack(trackId);
  library.removeUnused(new Set(project.clips.map((c) => c.assetId)));
  if (focusedTrackId === trackId) focusedTrackId = null;
  setStatus(`Removed ${track.name}`);
  refresh();
}

type AppClipboard = {
  track: Track;
  clips: Clip[];
  /** When true, clip.start is relative (0 = left of selection / clip); paste at playhead. */
  relative: boolean;
};
let trackClipboard: AppClipboard | null = null;
/** Last track interacted with (context menu / clip select) for Ctrl+C. */
let focusedTrackId: string | null = null;

function copyTrackById(trackId: string) {
  const track = project.state.tracks.find((t) => t.id === trackId);
  if (!track) return false;

  const range = timeline.getTimeSelection();
  if (range) {
    const sliced = project.clips
      .filter((c) => c.trackId === trackId)
      .map((c) => sliceClipToRange(c, range.start, range.end))
      .filter((c): c is Clip => c !== null);
    if (sliced.length === 0) {
      setStatus('Selection does not overlap any clips on this track');
      return false;
    }
    trackClipboard = { track: { ...track }, clips: sliced, relative: true };
    focusedTrackId = trackId;
    setStatus(
      `Copied selection (${(range.end - range.start).toFixed(2)}s, ${sliced.length} clip${sliced.length === 1 ? '' : 's'}) — Ctrl+V to paste`
    );
    return true;
  }

  if (timeline.selectedClipId) {
    const clip = project.clips.find(
      (c) => c.id === timeline.selectedClipId && c.trackId === trackId
    );
    if (clip) {
      const copy = JSON.parse(JSON.stringify(clip)) as Clip;
      copy.start = 0;
      trackClipboard = { track: { ...track }, clips: [copy], relative: true };
      focusedTrackId = trackId;
      setStatus(`Copied clip — Ctrl+V pastes onto a new track at the playhead`);
      return true;
    }
  }

  const clips = project.clips
    .filter((c) => c.trackId === trackId)
    .map((c) => JSON.parse(JSON.stringify(c)) as Clip);
  trackClipboard = { track: { ...track }, clips, relative: false };
  focusedTrackId = trackId;
  setStatus(
    `Copied “${track.name}” (${clips.length} clip${clips.length === 1 ? '' : 's'}) — Ctrl+V to paste`
  );
  return true;
}

function pasteTrackClipboard() {
  if (!trackClipboard) {
    setStatus('Nothing to paste — copy a track or selection first');
    return false;
  }
  const atTime = trackClipboard.relative ? timeline.playhead : undefined;
  const newId = project.pasteTrack(trackClipboard.track, trackClipboard.clips, atTime);
  focusedTrackId = newId;
  const name = project.state.tracks.find((t) => t.id === newId)?.name ?? 'track';
  setStatus(
    trackClipboard.relative
      ? `Pasted selection onto “${name}” at playhead`
      : `Pasted “${name}”`
  );
  refresh();
  return true;
}

function trackIdForCopy(): string | null {
  if (focusedTrackId && project.state.tracks.some((t) => t.id === focusedTrackId)) {
    return focusedTrackId;
  }
  if (timeline.selectedClipId) {
    return project.clips.find((c) => c.id === timeline.selectedClipId)?.trackId ?? null;
  }
  return project.tracks[project.tracks.length - 1]?.id ?? null;
}

timeline.onAddTrack = addEmptyTrack;
timeline.onRemoveTrack = removeTrackById;
timeline.onSelectChange = (id) => {
  if (id) {
    const clip = project.clips.find((c) => c.id === id);
    if (clip) focusedTrackId = clip.trackId;
  }
  refresh();
};
timeline.onImportFiles = async (files, info) => {
  for (const file of files) {
    await importFile(file, {
      atTime: info.time,
      trackId: info.trackId,
      createTrack: info.createTrack,
    });
  }
};

function setPlayingUI(playing: boolean) {
  playBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
  playBtn.classList.toggle('active', playing);
}

playBtn.addEventListener('click', () => {
  if (project.clips.length === 0) return;
  if (engine.isPlaying) {
    engine.stop();
    setPlayingUI(false);
    return;
  }
  const from = timeline.playhead >= project.duration ? 0 : timeline.playhead;
  engine.play(project, from);
  setPlayingUI(true);
});

stopBtn.addEventListener('click', () => {
  if (recorder.isRecording) {
    void stopRecording();
  }
  engine.stop();
  setPlayingUI(false);
  timeline.setPlayhead(0);
  timeDisplay.textContent = fmt(0);
});

recordBtn.addEventListener('click', async () => {
  if (recorder.isRecording) {
    await stopRecording();
    return;
  }
  if (!project.armedTrackId) {
    if (project.tracks.length === 0) {
      const track = project.createTrack('Track 1');
      project.addTrack(track);
      project.setArmedTrack(track.id);
      timeline.setProject(project, library);
    } else {
      statusEl.textContent = 'Arm a track (●) before recording';
      return;
    }
  }
  try {
    if (project.tracks.length === 0) project.setSampleRate(44100);
    const startAt = timeline.playhead;
    await recorder.start(project.sampleRate);
    (recordBtn as HTMLButtonElement & { _recStart?: number })._recStart = startAt;
    recordBtn.classList.add('active');
    recordBtn.textContent = '⏹ Rec';
    statusEl.textContent = 'Recording…';
    refresh();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Microphone permission denied or unavailable';
  }
});

async function stopRecording() {
  const startAt =
    (recordBtn as HTMLButtonElement & { _recStart?: number })._recStart ?? timeline.playhead;
  const buffer = recorder.stop();
  recordBtn.classList.remove('active');
  recordBtn.textContent = '⏺ Record';
  if (!buffer || !project.armedTrackId) {
    statusEl.textContent = 'Recording cancelled';
    refresh();
    return;
  }
  let buf = buffer;
  if (buf.sampleRate !== project.sampleRate || buf.numberOfChannels === 1) {
    buf = await resampleBuffer(buf, project.sampleRate, 2);
  }
  const asset = library.add(`Recording ${new Date().toLocaleTimeString()}`, buf);
  library.computePeaks(asset.id, timeline.zoom);
  const clip = project.createClip(
    project.armedTrackId,
    asset.id,
    startAt,
    0,
    buf.duration
  );
  project.addClip(clip);
  timeline.selectedClipId = clip.id;
  try {
    library.setSpectrogram(asset.id, analyzer.generate(buf));
  } catch {
    /* ignore */
  }
  statusEl.textContent = `Recorded ${buf.duration.toFixed(1)}s onto armed track`;
  refresh();
}

engine.onUpdate = (t) => {
  if (timeline.isSeekDragging) return;
  timeline.setPlayhead(t);
  timeDisplay.textContent = fmt(t);
};
engine.onEnded = () => setPlayingUI(false);

let pendingSeek: number | null = null;
let seekRaf = 0;
timeline.onSeek = (t) => {
  timeDisplay.textContent = fmt(t);
  if (!engine.isPlaying) return;
  pendingSeek = t;
  if (seekRaf) return;
  seekRaf = requestAnimationFrame(() => {
    seekRaf = 0;
    if (pendingSeek === null || !engine.isPlaying) return;
    engine.seek(project, pendingSeek);
    pendingSeek = null;
  });
};

undoBtn.addEventListener('click', () => {
  project.undo();
  timeline.selectedClipId = null;
  refresh();
});
redoBtn.addEventListener('click', () => {
  project.redo();
  timeline.selectedClipId = null;
  refresh();
});

splitBtn.addEventListener('click', () => {
  timeline.splitAtPlayhead();
  refresh();
});
mergeBtn.addEventListener('click', () => {
  if (!timeline.selectedClipId) return;
  if (project.mergeClipWithNext(timeline.selectedClipId)) {
    setStatus('Merged with next clip');
  } else {
    setStatus('Cannot merge — need abutting same-asset clips on one track');
  }
  refresh();
});
crossfadeBtn.addEventListener('click', () => {
  if (!timeline.selectedClipId) return;
  if (project.createCrossfade(timeline.selectedClipId, 0.05)) {
    setStatus('Crossfade overlap applied (50ms)');
  } else {
    setStatus('Select a clip that has a following clip on the same track');
  }
  refresh();
});
deleteBtn.addEventListener('click', () => {
  timeline.deleteSelected();
  refresh();
});
dupBtn.addEventListener('click', () => {
  if (!timeline.selectedClipId) return;
  const id = project.duplicateClip(timeline.selectedClipId);
  if (id) timeline.selectedClipId = id;
  refresh();
});

editMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (editMenuBtn.getAttribute('aria-expanded') === 'true') {
    ctxMenu.hide();
    return;
  }
  const rect = editMenuBtn.getBoundingClientRect();
  const hasClip = !!timeline.selectedClipId;
  editMenuBtn.setAttribute('aria-expanded', 'true');
  ctxMenu.show(
    rect.left,
    rect.bottom + 4,
    [
      { id: 'split', label: 'Split at playhead', shortcut: 'S', disabled: !hasClip },
      {
        id: 'merge',
        label: 'Merge with next',
        disabled: !hasClip || !project.canMergeClipWithNext(timeline.selectedClipId!),
      },
      {
        id: 'crossfade',
        label: 'Crossfade (50ms)',
        disabled: !hasClip || !project.hasNextOnTrack(timeline.selectedClipId!),
      },
      { id: 'sep1', label: '', separator: true },
      { id: 'duplicate', label: 'Duplicate clip', disabled: !hasClip },
      { id: 'delete', label: 'Delete clip', shortcut: 'Del', disabled: !hasClip },
      { id: 'sep2', label: '', separator: true },
      {
        id: 'envelope',
        label: timeline.mode === 'envelope' ? 'Envelope mode ✓' : 'Envelope mode',
        shortcut: 'E',
      },
      {
        id: 'spectrogram',
        label: timeline.showSpectrogram ? 'Waveform view' : 'Spectrogram view',
      },
      { id: 'sep3', label: '', separator: true },
      { id: 'clear', label: 'Clear project…' },
    ],
    (id) => {
      switch (id) {
        case 'split':
          splitBtn.click();
          break;
        case 'merge':
          mergeBtn.click();
          break;
        case 'crossfade':
          crossfadeBtn.click();
          break;
        case 'duplicate':
          dupBtn.click();
          break;
        case 'delete':
          deleteBtn.click();
          break;
        case 'envelope':
          envBtn.click();
          break;
        case 'spectrogram':
          specToggle.click();
          break;
        case 'clear':
          clearBtn.click();
          break;
      }
    },
    () => editMenuBtn.setAttribute('aria-expanded', 'false')
  );
});

timeline.onContextMenu = ({ clientX, clientY, time, clipId, trackId }) => {
  if (trackId) focusedTrackId = trackId;
  const hasClip = !!clipId;
  const hasTrack = !!trackId;
  const canSplit =
    hasClip &&
    (() => {
      const clip = project.clips.find((c) => c.id === clipId);
      if (!clip) return false;
      const local = time - clip.start;
      const dur = clipDuration(clip);
      return local > 0.05 && local < dur - 0.05;
    })();

  ctxMenu.show(
    clientX,
    clientY,
    [
      { id: 'split', label: 'Split here', shortcut: 'S', disabled: !canSplit },
      {
        id: 'merge',
        label: 'Merge with next',
        disabled: !hasClip || !project.canMergeClipWithNext(clipId!),
      },
      {
        id: 'crossfade',
        label: 'Crossfade (50ms)',
        disabled: !hasClip || !project.hasNextOnTrack(clipId!),
      },
      { id: 'sep1', label: '', separator: true },
      { id: 'duplicate', label: 'Duplicate clip', disabled: !hasClip },
      { id: 'delete', label: 'Delete clip', shortcut: 'Del', disabled: !hasClip },
      { id: 'sep-track', label: '', separator: true },
      {
        id: 'copy-track',
        label: timeline.getTimeSelection()
          ? 'Copy selection'
          : timeline.selectedClipId
            ? 'Copy clip'
            : 'Copy track',
        shortcut: 'Ctrl+C',
        disabled: !hasTrack,
      },
      {
        id: 'paste-track',
        label: 'Paste as new track',
        shortcut: 'Ctrl+V',
        disabled: !trackClipboard,
      },
      {
        id: 'remove-track',
        label: 'Remove track',
        disabled: !hasTrack,
      },
      { id: 'sep2', label: '', separator: true },
      {
        id: 'envelope',
        label: timeline.mode === 'envelope' ? 'Exit envelope mode' : 'Envelope mode',
        shortcut: 'E',
      },
      {
        id: 'spectrogram',
        label: timeline.showSpectrogram ? 'Show waveform' : 'Show spectrogram',
      },
      { id: 'sep3', label: '', separator: true },
      { id: 'play', label: engine.isPlaying ? 'Pause' : 'Play from here', shortcut: 'Space' },
    ],
    (id) => {
      switch (id) {
        case 'split': {
          if (clipId) timeline.selectedClipId = clipId;
          const rightId = timeline.splitAt(time);
          if (rightId) statusEl.textContent = 'Split clip';
          else statusEl.textContent = 'Cannot split here';
          refresh();
          break;
        }
        case 'merge': {
          const target = clipId ?? timeline.selectedClipId;
          if (!target) break;
          timeline.selectedClipId = target;
          if (project.mergeClipWithNext(target)) {
            statusEl.textContent = 'Merged with next clip';
          } else {
            statusEl.textContent = 'Cannot merge — need abutting same-asset clips on one track';
          }
          refresh();
          break;
        }
        case 'crossfade': {
          const target = clipId ?? timeline.selectedClipId;
          if (!target) break;
          timeline.selectedClipId = target;
          if (project.createCrossfade(target, 0.05)) {
            statusEl.textContent = 'Crossfade overlap applied (50ms)';
          } else {
            statusEl.textContent = 'Need a following clip on the same track';
          }
          refresh();
          break;
        }
        case 'duplicate': {
          const target = clipId ?? timeline.selectedClipId;
          if (!target) break;
          const newId = project.duplicateClip(target);
          if (newId) timeline.selectedClipId = newId;
          refresh();
          break;
        }
        case 'delete': {
          const target = clipId ?? timeline.selectedClipId;
          if (!target) break;
          timeline.selectedClipId = target;
          timeline.deleteSelected();
          refresh();
          break;
        }
        case 'copy-track': {
          if (trackId) copyTrackById(trackId);
          break;
        }
        case 'paste-track': {
          pasteTrackClipboard();
          break;
        }
        case 'remove-track': {
          if (trackId) removeTrackById(trackId);
          break;
        }
        case 'envelope': {
          const next = timeline.mode === 'envelope' ? 'normal' : 'envelope';
          timeline.setMode(next);
          envBtn.classList.toggle('active', next === 'envelope');
          envBtn.textContent = next === 'envelope' ? 'Envelope ✓' : 'Envelope';
          break;
        }
        case 'spectrogram': {
          const on = timeline.toggleSpectrogram();
          specToggle.classList.toggle('active', on);
          specToggle.textContent = on ? 'Waveform' : 'Spectrogram';
          break;
        }
        case 'play':
          if (engine.isPlaying) {
            engine.stop();
            setPlayingUI(false);
          } else if (project.clips.length > 0) {
            timeline.setPlayhead(time);
            engine.play(project, time);
            setPlayingUI(true);
          }
          break;
      }
    }
  );
};
clearBtn.addEventListener('click', () => {
  if (!confirm('Clear all tracks and clips?')) return;
  engine.stop();
  setPlayingUI(false);
  project.clear();
  library.clear();
  trackClipboard = null;
  focusedTrackId = null;
  timeline.setProject(project, library);
  refresh();
});

envBtn.addEventListener('click', () => {
  const next = timeline.mode === 'envelope' ? 'normal' : 'envelope';
  timeline.setMode(next);
  envBtn.classList.toggle('active', next === 'envelope');
  envBtn.textContent = next === 'envelope' ? 'Envelope ✓' : 'Envelope';
});

specToggle.addEventListener('click', () => {
  const on = timeline.toggleSpectrogram();
  specToggle.classList.toggle('active', on);
  specToggle.textContent = on ? 'Waveform' : 'Spectrogram';
});

let rateGesture = false;
function applySelectedClipRate(commit: boolean) {
  if (!timeline.selectedClipId) return;
  const raw = parseFloat(clipRateInput.value);
  if (!Number.isFinite(raw)) return;
  const rate = Math.max(0.25, Math.min(4, raw));

  if (commit) {
    if (!rateGesture) project.beginEdit();
    project.mutateClip(timeline.selectedClipId, { rate });
    project.commitClip(timeline.selectedClipId);
    rateGesture = false;
  } else {
    if (!rateGesture) {
      project.beginEdit();
      rateGesture = true;
    }
    project.mutateClip(timeline.selectedClipId, { rate });
  }

  clipRateInput.value = String(rate);
  const clip = project.clips.find((c) => c.id === timeline.selectedClipId);
  if (clip) {
    const asset = library.get(clip.assetId);
    const dur = clipDuration(clip);
    clipInfo.textContent = `${asset?.name ?? 'Clip'} @ ${clip.start.toFixed(2)}s · ${dur.toFixed(2)}s · ${rate.toFixed(2)}×`;
  }
  timeline.draw();
  if (engine.isPlaying) {
    engine.seek(project, timeline.playhead);
  }
}

clipRateInput.addEventListener('pointerdown', () => {
  if (!timeline.selectedClipId) return;
  project.beginEdit();
  rateGesture = true;
});
clipRateInput.addEventListener('input', () => applySelectedClipRate(false));
clipRateInput.addEventListener('change', () => applySelectedClipRate(true));

function updateMasterReadout() {
  masterGainValue.textContent = masterGainInput.value;
}

let masterGainGesture = false;
masterGainInput.addEventListener('pointerdown', () => {
  project.beginEdit();
  masterGainGesture = true;
});
masterGainInput.addEventListener('input', () => {
  updateMasterReadout();
  const g = parseInt(masterGainInput.value, 10) / 100;
  if (!masterGainGesture) {
    project.setMasterGain(g, true);
    masterGainGesture = true;
  } else {
    project.setMasterGain(g, false);
  }
  engine.setMasterGain(g);
});
masterGainInput.addEventListener('change', () => {
  masterGainGesture = false;
  updateMasterReadout();
});
updateMasterReadout();

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

  if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    const id = trackIdForCopy();
    if (id) copyTrackById(id);
    else setStatus('Select a clip or right-click a track to copy');
    return;
  }
  if ((e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    pasteTrackClipboard();
    return;
  }

  if (e.key === ' ') {
    e.preventDefault();
    playBtn.click();
  } else if (e.key === 's' || e.key === 'S') {
    splitBtn.click();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteBtn.click();
  } else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) redoBtn.click();
    else undoBtn.click();
  } else if ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    redoBtn.click();
  } else if (e.key === 'e' || e.key === 'E') {
    envBtn.click();
  } else if (e.key === 'r' || e.key === 'R') {
    recordBtn.click();
  }
});

function setExportOpen(open: boolean) {
  exportPanel.hidden = !open;
  exportMenuBtn.setAttribute('aria-expanded', String(open));
}

exportMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setExportOpen(exportPanel.hasAttribute('hidden'));
});

window.addEventListener('pointerdown', (e) => {
  if (exportPanel.hidden) return;
  const t = e.target as Node;
  if (!exportPanel.contains(t) && !exportMenuBtn.contains(t)) setExportOpen(false);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !exportPanel.hidden) setExportOpen(false);
});

exportBtn.addEventListener('click', async () => {
  if (project.clips.length === 0) return;
  const label = exportBtn.textContent;
  exportBtn.textContent = 'Rendering…';
  exportBtn.setAttribute('disabled', 'true');

  try {
    project.setMetadata({ title: metaTitle.value, artist: metaArtist.value }, false);
    const rendered = await renderProject(project, library, project.sampleRate);
    const format = formatSel.value as 'mp3' | 'flac' | 'wav' | 'ogg';
    exportBtn.textContent = 'Encoding…';
    const blob = await exportAudio(rendered, format, parseInt(bitrateSel.value, 10), {
      title: metaTitle.value,
      artist: metaArtist.value,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `export.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : 'Export failed. Check console for details.';
    alert(msg);
  } finally {
    exportBtn.textContent = label;
    exportBtn.removeAttribute('disabled');
  }
});

document.body.addEventListener(
  'click',
  () => {
    getFFmpeg().catch(() => {});
  },
  { once: true }
);

const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;
const themeToggleLabel = document.getElementById('theme-toggle-label')!;

function applyTheme(theme: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.setAttribute('aria-pressed', String(theme === 'light'));
  themeToggleLabel.textContent = theme === 'light' ? 'Day' : 'Night';
  timeline.refreshTheme();
}

const initialTheme =
  (document.documentElement.getAttribute('data-theme') as 'dark' | 'light' | null) ?? 'dark';
applyTheme(initialTheme);

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

timeline.setProject(project, library);
refresh();

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}
