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
import { type Clip, type Track } from './types';
import { defaultTrackEffects, normalizeTrackEffects, type TrackEffects } from './audio/TrackEffects';
import { nightcoreAmount } from './audio/FxChain';
import {
  clearSavedProject,
  hasSavedProject,
  loadProject,
  saveProject,
  type StoredUiFlags,
} from './storage/ProjectStore';
import {
  buildToffBlob,
  isToffFile,
  parseToffFile,
  suggestToffFilename,
  TOFF_EXT,
} from './storage/ToffFormat';

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
const activityToggle = document.getElementById('activity-toggle') as HTMLButtonElement;
const activityLog = document.getElementById('activity-log')!;
const activityList = document.getElementById('activity-list')!;
const playBtn = document.getElementById('play-btn')!;
const stopBtn = document.getElementById('stop-btn')!;
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
const masterMeterFill = document.querySelector('#master-meter .meter-fill') as HTMLElement;
const clipInfo = document.getElementById('clip-info')!;
const timeDisplay = document.getElementById('time-display')!;
const filesMenuBtn = document.getElementById('files-menu-btn') as HTMLButtonElement;
const exportPanel = document.getElementById('export-panel') as HTMLDivElement;
const exportBtn = document.getElementById('export-btn')!;
const formatSel = document.getElementById('format') as HTMLSelectElement;
const bitrateSel = document.getElementById('bitrate') as HTMLSelectElement;
const metaTitle = document.getElementById('meta-title') as HTMLInputElement;
const metaArtist = document.getElementById('meta-artist') as HTMLInputElement;
const fxPopover = document.getElementById('fx-popover')!;

function syncLoopToEngine() {
  const sel = timeline.getTimeSelection();
  engine.setLoopRegion(timeline.loopEnabled && sel ? sel : null);
}

function refresh() {
  undoBtn.disabled = !project.canUndo;
  redoBtn.disabled = !project.canRedo;
  editMenuBtn.classList.toggle('active', timeline.mode === 'envelope');

  if (!masterGainGesture) {
    masterGainInput.value = String(Math.round(project.state.masterGain * 100));
    updateMasterReadout();
  }

  const clip = timeline.selectedClipId
    ? project.clips.find((c) => c.id === timeline.selectedClipId)
    : null;

  if (clip) {
    const dur = project.clipDur(clip);
    const asset = library.get(clip.assetId);
    const rate = project.effectiveRate(clip);
    clipInfo.textContent = `${asset?.name ?? 'Clip'} @ ${clip.start.toFixed(2)}s · ${dur.toFixed(2)}s · ${rate.toFixed(2)}×`;
  } else {
    clipInfo.textContent = project.tracks.length
      ? 'No clip selected'
      : 'Add a track or drop audio onto the timeline';
  }
}

function syncMixer() {
  engine.syncTrackGains(project);
  engine.syncTrackFx(project);
  refresh();
}

timeline.onProjectChange = () => {
  refresh();
  scheduleAutosave();
};
timeline.onTrackChange = () => {
  syncMixer();
  scheduleAutosave();
};
timeline.onSelectionChange = () => {
  syncLoopToEngine();
  timeline.draw();
  scheduleAutosave();
};

let liveClipRaf = 0;
let pendingLiveKind: 'envelope' | 'timing' | null = null;
timeline.onClipLiveChange = (kind = 'timing') => {
  if (!engine.isPlaying) return;
  // Timing edits need a full reschedule; envelope can soft-update.
  if (kind === 'timing') pendingLiveKind = 'timing';
  else if (pendingLiveKind !== 'timing') pendingLiveKind = 'envelope';
  if (liveClipRaf) return;
  liveClipRaf = requestAnimationFrame(() => {
    liveClipRaf = 0;
    const k = pendingLiveKind;
    pendingLiveKind = null;
    if (!engine.isPlaying || !k) return;
    if (k === 'envelope') engine.updateClipEnvelopes(project);
    else engine.seek(project, timeline.playhead);
  });
};

async function importFile(
  file: File,
  opts: { atTime?: number; trackId?: string | null; createTrack?: boolean } = {}
) {
  setStatus(`Loading ${file.name}…`);
  let buffer: AudioBuffer;
  try {
    buffer = await decodeAudioFile(file);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't decode "${file.name}" — is it a supported audio file?`);
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
  // New tracks always place the clip at the start of the timeline.
  const atTime = createTrack ? 0 : Math.max(0, opts.atTime ?? timeline.playhead);

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
  if (!message) return;

  const li = document.createElement('li');
  const time = document.createElement('span');
  time.className = 'activity-time';
  const now = new Date();
  time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const text = document.createElement('span');
  text.textContent = message;
  li.append(time, text);
  activityList.prepend(li);

  // Keep the log from growing forever
  while (activityList.children.length > 40) {
    activityList.lastElementChild?.remove();
  }
}

activityToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = activityLog.hasAttribute('hidden');
  activityLog.hidden = !open;
  activityToggle.setAttribute('aria-expanded', String(open));
});

window.addEventListener('pointerdown', (e) => {
  if (activityLog.hidden) return;
  const t = e.target as Node;
  if (activityLog.contains(t) || activityToggle.contains(t)) return;
  activityLog.hidden = true;
  activityToggle.setAttribute('aria-expanded', 'false');
});

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
      .map((c) => sliceClipToRange(c, range.start, range.end, project.trackRate(trackId)))
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
    if (isToffFile(file)) {
      await openToffFile(file);
      return;
    }
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
  timeline.followPlayhead = playing;
  if (playing) timeline.setPlayhead(timeline.playhead);
  else scrubSilenced = false;
}

/** True after we've silenced the engine for an in-progress scrub drag. */
let scrubSilenced = false;

playBtn.addEventListener('click', () => {
  if (project.clips.length === 0) return;
  if (engine.isPlaying) {
    engine.stop();
    setPlayingUI(false);
    timeline.clearMeters();
    if (masterMeterFill) masterMeterFill.style.width = '0%';
    return;
  }
  syncLoopToEngine();
  let from = timeline.playhead >= project.duration ? 0 : timeline.playhead;
  const sel = timeline.getTimeSelection();
  if (timeline.loopEnabled && sel) {
    if (from < sel.start || from >= sel.end) from = sel.start;
  }
  engine.play(project, from);
  setPlayingUI(true);
});

stopBtn.addEventListener('click', () => {
  if (recorder.isRecording) {
    void stopRecording();
  }
  engine.stop();
  setPlayingUI(false);
  timeline.clearMeters();
  if (masterMeterFill) masterMeterFill.style.width = '0%';
  timeline.setPlayhead(0);
  timeDisplay.textContent = fmt(0);
});

let recStartAt = 0;

timeline.onRecordTrack = (trackId) => {
  void toggleRecordOnTrack(trackId);
};

async function toggleRecordOnTrack(trackId: string) {
  if (recorder.isRecording) {
    if (timeline.recordingTrackId === trackId) await stopRecording();
    return;
  }
  project.setArmedTrack(trackId);
  try {
    if (project.tracks.length === 0) project.setSampleRate(44100);
    recStartAt = timeline.playhead;
    await recorder.start(project.sampleRate);
    timeline.setRecordingTrack(trackId);
    setStatus('Recording…');
    refresh();
  } catch (err) {
    console.error(err);
    project.setArmedTrack(null);
    setStatus('Microphone permission denied or unavailable');
  }
}

async function stopRecording() {
  const startAt = recStartAt;
  const trackId = project.armedTrackId;
  const buffer = recorder.stop();
  timeline.setRecordingTrack(null);
  if (!buffer || !trackId) {
    setStatus('Recording cancelled');
    refresh();
    return;
  }
  let buf = buffer;
  if (buf.sampleRate !== project.sampleRate || buf.numberOfChannels === 1) {
    buf = await resampleBuffer(buf, project.sampleRate, 2);
  }
  const asset = library.add(`Recording ${new Date().toLocaleTimeString()}`, buf);
  library.computePeaks(asset.id, timeline.zoom);
  const clip = project.createClip(trackId, asset.id, startAt, 0, buf.duration);
  project.addClip(clip);
  timeline.selectedClipId = clip.id;
  try {
    library.setSpectrogram(asset.id, analyzer.generate(buf));
  } catch {
    /* ignore */
  }
  const track = project.tracks.find((t) => t.id === trackId);
  setStatus(`Recorded ${buf.duration.toFixed(1)}s onto ${track?.name ?? 'track'}`);
  refresh();
}

engine.onUpdate = (t) => {
  if (timeline.isSeekDragging) return;
  timeline.setPlayhead(t);
  timeDisplay.textContent = fmt(t);
  const levels = engine.getMeterLevels();
  timeline.setMeterLevels(levels);
  const master = levels.find((l) => l.id === 'master');
  if (master && masterMeterFill) {
    masterMeterFill.style.width = `${Math.min(100, master.peak * 100)}%`;
  }
};
engine.onEnded = () => {
  setPlayingUI(false);
  timeline.clearMeters();
  if (masterMeterFill) masterMeterFill.style.width = '0%';
};

let pendingSeek: number | null = null;
let seekRaf = 0;
timeline.onSeek = (t, ended) => {
  timeDisplay.textContent = fmt(t);
  if (!engine.isPlaying) {
    scrubSilenced = false;
    return;
  }
  // While scrub-dragging: mute once and skip per-frame restarts (they cause clicks/noise).
  if (!ended && timeline.isSeekDragging) {
    if (!scrubSilenced) {
      scrubSilenced = true;
      engine.silenceForScrub();
    }
    return;
  }
  scrubSilenced = false;
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
      { id: 'sep-snap', label: '', separator: true },
      {
        id: 'snap',
        label: timeline.snapEnabled ? 'Snap to grid ✓' : 'Snap to grid',
      },
      {
        id: 'magnetic',
        label: timeline.magneticEnabled ? 'Magnetic snap ✓' : 'Magnetic snap',
      },
      {
        id: 'grid-0.1',
        label: timeline.gridStep === 0.1 ? 'Grid step 0.1s ✓' : 'Grid step 0.1s',
        disabled: !timeline.snapEnabled,
      },
      {
        id: 'grid-0.5',
        label: timeline.gridStep === 0.5 ? 'Grid step 0.5s ✓' : 'Grid step 0.5s',
        disabled: !timeline.snapEnabled,
      },
      {
        id: 'grid-1',
        label: timeline.gridStep === 1 ? 'Grid step 1s ✓' : 'Grid step 1s',
        disabled: !timeline.snapEnabled,
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
        case 'snap':
          timeline.setSnapEnabled(!timeline.snapEnabled);
          refresh();
          scheduleAutosave();
          break;
        case 'magnetic':
          timeline.setMagneticEnabled(!timeline.magneticEnabled);
          refresh();
          scheduleAutosave();
          break;
        case 'grid-0.1':
          timeline.setGridStep(0.1);
          refresh();
          scheduleAutosave();
          break;
        case 'grid-0.5':
          timeline.setGridStep(0.5);
          refresh();
          scheduleAutosave();
          break;
        case 'grid-1':
          timeline.setGridStep(1);
          refresh();
          scheduleAutosave();
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
      const dur = project.clipDur(clip);
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
        label: 'Delete track',
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
      {
        id: 'loop',
        label: timeline.loopEnabled ? 'Disable loop' : 'Loop selection',
        shortcut: 'L',
        disabled: !timeline.getTimeSelection(),
      },
      { id: 'play', label: engine.isPlaying ? 'Pause' : 'Play from here', shortcut: 'Space' },
    ],
    (id) => {
      switch (id) {
        case 'split': {
          if (clipId) timeline.selectedClipId = clipId;
          const rightId = timeline.splitAt(time);
          if (rightId) setStatus('Split clip');
          else setStatus('Cannot split here');
          refresh();
          break;
        }
        case 'merge': {
          const target = clipId ?? timeline.selectedClipId;
          if (!target) break;
          timeline.selectedClipId = target;
          if (project.mergeClipWithNext(target)) {
            setStatus('Merged with next clip');
          } else {
            setStatus('Cannot merge — need abutting same-asset clips on one track');
          }
          refresh();
          break;
        }
        case 'crossfade': {
          const target = clipId ?? timeline.selectedClipId;
          if (!target) break;
          timeline.selectedClipId = target;
          if (project.createCrossfade(target, 0.05)) {
            setStatus('Crossfade overlap applied (50ms)');
          } else {
            setStatus('Need a following clip on the same track');
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
        case 'loop':
          toggleLoop();
          break;
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
  applyMasterGain(readStoredMasterGain(), false);
  refresh();
  scheduleAutosave();
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

function updateMasterReadout() {
  masterGainValue.textContent = masterGainInput.value;
}

const MASTER_GAIN_KEY = 'masterGain';

function readStoredMasterGain(): number {
  const raw = localStorage.getItem(MASTER_GAIN_KEY);
  if (raw == null) return 1;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(2, n));
}

function persistMasterGain(gain: number) {
  localStorage.setItem(MASTER_GAIN_KEY, String(Math.max(0, Math.min(2, gain))));
}

function applyMasterGain(gain: number, commit = false) {
  const g = Math.max(0, Math.min(2, gain));
  project.setMasterGain(g, commit);
  engine.setMasterGain(g);
  masterGainInput.value = String(Math.round(g * 100));
  updateMasterReadout();
  persistMasterGain(g);
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
  persistMasterGain(g);
});
masterGainInput.addEventListener('change', () => {
  masterGainGesture = false;
  updateMasterReadout();
  persistMasterGain(parseInt(masterGainInput.value, 10) / 100);
});
applyMasterGain(readStoredMasterGain(), false);

function toggleLoop() {
  const on = !timeline.loopEnabled;
  if (on && !timeline.getTimeSelection()) {
    setStatus('Shift-drag a region on the timeline first, then enable Loop');
    return;
  }
  timeline.setLoopEnabled(on);
  syncLoopToEngine();
  refresh();
  setStatus(on ? 'Loop on' : 'Loop off');
  scheduleAutosave();
}

function currentUiFlags(): StoredUiFlags {
  return {
    snapEnabled: timeline.snapEnabled,
    magneticEnabled: timeline.magneticEnabled,
    gridStep: timeline.gridStep,
    loopEnabled: timeline.loopEnabled,
  };
}

let restoringSession = false;
let autosaveTimer = 0;
let autosaveBusy = false;
let autosaveQueued = false;

function scheduleAutosave() {
  if (restoringSession) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    void flushAutosave();
  }, 1500);
}

async function flushAutosave() {
  if (restoringSession) return;
  if (autosaveBusy) {
    autosaveQueued = true;
    return;
  }
  autosaveBusy = true;
  try {
    await saveProject(project.state, library, currentUiFlags());
  } catch (err) {
    console.error(err);
    setStatus('Autosave failed');
  } finally {
    autosaveBusy = false;
    if (autosaveQueued) {
      autosaveQueued = false;
      scheduleAutosave();
    }
  }
}

function applyLoadedProject(
  loaded: { state: import('./types').ProjectState; ui: StoredUiFlags },
  status: string
) {
  engine.stop();
  setPlayingUI(false);
  timeline.clearMeters();
  if (masterMeterFill) masterMeterFill.style.width = '0%';
  project.loadFresh(
    loaded.state.tracks,
    loaded.state.clips,
    loaded.state.masterGain,
    loaded.state.metadata,
    loaded.state.sampleRate
  );
  timeline.setSnapEnabled(loaded.ui.snapEnabled);
  timeline.setMagneticEnabled(loaded.ui.magneticEnabled);
  timeline.setGridStep(loaded.ui.gridStep);
  timeline.setLoopEnabled(loaded.ui.loopEnabled);
  timeline.setProject(project, library);
  applyMasterGain(readStoredMasterGain(), false);
  syncLoopToEngine();
  refresh();
  setStatus(status);
  scheduleAutosave();
}

async function downloadToffFile() {
  try {
    if (project.clips.length === 0 && project.tracks.length === 0) {
      setStatus('Nothing to save — add a track or audio first');
      return;
    }
    setStatus('Building .toff…');
    const blob = await buildToffBlob(project.state, library, currentUiFlags());
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestToffFilename(project.state);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded ${suggestToffFilename(project.state)}`);
  } catch (err) {
    console.error(err);
    setStatus('Download .toff failed');
  }
}

async function openToffFile(file: File) {
  try {
    setStatus(`Opening ${file.name}…`);
    restoringSession = true;
    const loaded = await parseToffFile(file, library);
    restoringSession = false;
    applyLoadedProject(loaded, `Opened ${file.name}`);
  } catch (err) {
    restoringSession = false;
    console.error(err);
    setStatus(err instanceof Error ? err.message : 'Could not open .toff file');
  }
}

async function clearBrowserSession() {
  if (
    !confirm(
      'Clear the autosaved browser session and empty the current project? Download a .toff first if you need a backup.'
    )
  ) {
    return;
  }
  try {
    engine.stop();
    setPlayingUI(false);
    timeline.clearMeters();
    if (masterMeterFill) masterMeterFill.style.width = '0%';
    restoringSession = true;
    await clearSavedProject();
    project.clear();
    library.clear();
    trackClipboard = null;
    focusedTrackId = null;
    timeline.setLoopEnabled(false);
    timeline.setProject(project, library);
    applyMasterGain(readStoredMasterGain(), false);
    syncLoopToEngine();
    refresh();
    restoringSession = false;
    setStatus('Browser session cleared');
  } catch (err) {
    restoringSession = false;
    console.error(err);
    setStatus('Could not clear browser session');
  }
}

const toffFileInput = document.createElement('input');
toffFileInput.type = 'file';
toffFileInput.accept = `${TOFF_EXT},application/x-toeffe-project`;
toffFileInput.hidden = true;
document.body.appendChild(toffFileInput);
toffFileInput.addEventListener('change', () => {
  const file = toffFileInput.files?.[0];
  toffFileInput.value = '';
  if (file) void openToffFile(file);
});

function pickToffFile() {
  toffFileInput.click();
}

let fxTrackId: string | null = null;
function closeFxPopover() {
  fxPopover.hidden = true;
  fxTrackId = null;
}

function openFxPopover(trackId: string, anchor: HTMLElement) {
  const track = project.state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  if (fxTrackId && fxTrackId !== trackId) {
    project.commitClip(fxTrackId);
  }
  fxTrackId = trackId;
  project.beginEdit();
  const fx = normalizeTrackEffects(track.effects);
  fxPopover.innerHTML = '';
  const title = document.createElement('h4');
  title.textContent = `${track.name} — Effects`;
  fxPopover.appendChild(title);

  const defaults = defaultTrackEffects();

  const addSlider = (
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    defaultValue: number,
    onInput: (v: number) => void
  ) => {
    const row = document.createElement('div');
    row.className = 'fx-row';
    const lab = document.createElement('span');
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.title = 'Double-click to reset';
    input.addEventListener('input', () => onInput(parseFloat(input.value)));
    input.addEventListener('dblclick', (e) => {
      e.preventDefault();
      input.value = String(defaultValue);
      onInput(defaultValue);
    });
    row.append(lab, input);
    fxPopover.appendChild(row);
  };

  const patchFx = (partial: Partial<TrackEffects>) => {
    if (!fxTrackId) return;
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    if (!t) return;
    const prevNc = nightcoreAmount(normalizeTrackEffects(t.effects));
    const next = normalizeTrackEffects({
      ...t.effects,
      ...partial,
      eq: { ...t.effects.eq, ...partial.eq },
      bassBoost: { ...t.effects.bassBoost, ...partial.bassBoost },
      voiceClarity: { ...t.effects.voiceClarity, ...partial.voiceClarity },
      compressor: { ...t.effects.compressor, ...partial.compressor },
      nightcore: { ...t.effects.nightcore, ...partial.nightcore },
    });
    project.mutateTrack(fxTrackId, { effects: next });
    engine.syncTrackFx(project);
    if (!engine.isPlaying || !partial.nightcore) return;
    const nextNc = nightcoreAmount(next);
    if (prevNc === nextNc) return;
    // Enable/disable changes the scheduled buffer window — soft reschedule.
    // Amount tweaks while already on can update playbackRate live (no seek noise).
    if (prevNc === 1 || nextNc === 1) {
      engine.seek(project, timeline.playhead);
    } else {
      engine.setTrackRate(project, fxTrackId);
    }
  };

  addSlider('Low', -12, 12, 0.5, fx.eq.lowGain, defaults.eq.lowGain, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ eq: { ...cur.eq, lowGain: v } });
  });
  addSlider('Mid', -12, 12, 0.5, fx.eq.midGain, defaults.eq.midGain, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ eq: { ...cur.eq, midGain: v } });
  });
  addSlider('High', -12, 12, 0.5, fx.eq.highGain, defaults.eq.highGain, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ eq: { ...cur.eq, highGain: v } });
  });

  const bassRow = document.createElement('div');
  bassRow.className = 'fx-row';
  const bassLab = document.createElement('label');
  const bassCb = document.createElement('input');
  bassCb.type = 'checkbox';
  bassCb.checked = fx.bassBoost.enabled;
  bassCb.addEventListener('change', () => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ bassBoost: { ...cur.bassBoost, enabled: bassCb.checked } });
  });
  bassLab.append(bassCb, document.createTextNode(' Bass boost'));
  bassRow.append(bassLab, document.createElement('span'));
  fxPopover.appendChild(bassRow);

  const bandRow = document.createElement('div');
  bandRow.className = 'fx-row fx-band';
  const bandWrap = document.createElement('div');
  bandWrap.className = 'fx-band-options';
  for (const band of ['80', '140'] as const) {
    const lab = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `bass-band-${fxTrackId}`;
    radio.value = band;
    radio.checked = fx.bassBoost.band === band;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const t = project.state.tracks.find((x) => x.id === fxTrackId);
      const cur = normalizeTrackEffects(t?.effects);
      patchFx({ bassBoost: { ...cur.bassBoost, band } });
    });
    lab.append(radio, document.createTextNode(` ~${band} Hz`));
    bandWrap.appendChild(lab);
  }
  bandRow.append(document.createElement('span'), bandWrap);
  fxPopover.appendChild(bandRow);

  addSlider('Bass', 0, 12, 0.5, fx.bassBoost.gain, defaults.bassBoost.gain, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ bassBoost: { ...cur.bassBoost, gain: v } });
  });

  const clarityRow = document.createElement('div');
  clarityRow.className = 'fx-row';
  const clarityLab = document.createElement('label');
  const clarityCb = document.createElement('input');
  clarityCb.type = 'checkbox';
  clarityCb.checked = fx.voiceClarity.enabled;
  clarityCb.addEventListener('change', () => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ voiceClarity: { ...cur.voiceClarity, enabled: clarityCb.checked } });
  });
  clarityLab.append(clarityCb, document.createTextNode(' Voice clarity'));
  clarityRow.append(clarityLab, document.createElement('span'));
  fxPopover.appendChild(clarityRow);

  addSlider('Clarity', 0, 9, 0.5, fx.voiceClarity.gain, defaults.voiceClarity.gain, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ voiceClarity: { ...cur.voiceClarity, gain: v } });
  });

  const compRow = document.createElement('div');
  compRow.className = 'fx-row';
  const compLab = document.createElement('label');
  const compCb = document.createElement('input');
  compCb.type = 'checkbox';
  compCb.checked = fx.compressor.enabled;
  compCb.addEventListener('change', () => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ compressor: { ...cur.compressor, enabled: compCb.checked } });
  });
  compLab.append(compCb, document.createTextNode(' Comp'));
  compRow.append(compLab, document.createElement('span'));
  fxPopover.appendChild(compRow);

  addSlider('Thresh', -60, 0, 1, fx.compressor.threshold, defaults.compressor.threshold, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ compressor: { ...cur.compressor, threshold: v } });
  });
  addSlider('Ratio', 1, 20, 0.5, fx.compressor.ratio, defaults.compressor.ratio, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ compressor: { ...cur.compressor, ratio: v } });
  });

  const ncRow = document.createElement('div');
  ncRow.className = 'fx-row';
  const ncLab = document.createElement('label');
  const ncCb = document.createElement('input');
  ncCb.type = 'checkbox';
  ncCb.checked = fx.nightcore.enabled;
  ncCb.addEventListener('change', () => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ nightcore: { ...cur.nightcore, enabled: ncCb.checked } });
  });
  ncLab.append(ncCb, document.createTextNode(' Nightcore'));
  ncRow.append(ncLab, document.createElement('span'));
  fxPopover.appendChild(ncRow);

  addSlider('Amount', 1, 1.5, 0.01, fx.nightcore.amount, defaults.nightcore.amount, (v) => {
    const t = project.state.tracks.find((x) => x.id === fxTrackId);
    const cur = normalizeTrackEffects(t?.effects);
    patchFx({ nightcore: { ...cur.nightcore, amount: v } });
  });

  const hint = document.createElement('p');
  hint.className = 'hint';
  fxPopover.appendChild(hint);

  const rect = anchor.getBoundingClientRect();
  fxPopover.hidden = false;
  fxPopover.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`;
  fxPopover.style.top = `${rect.bottom + 6}px`;
}

timeline.onEditTrackFx = (trackId, anchor) => {
  if (fxTrackId === trackId && !fxPopover.hidden) {
    project.commitClip(fxTrackId);
    closeFxPopover();
    return;
  }
  openFxPopover(trackId, anchor);
};

window.addEventListener('pointerdown', (e) => {
  if (fxPopover.hidden) return;
  const t = e.target as Node;
  if (fxPopover.contains(t)) return;
  if (t instanceof Element && t.closest('.track-fx')) return;
  if (fxTrackId) project.commitClip(fxTrackId);
  closeFxPopover();
});

let nudgeGesture = false;
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (nudgeGesture && timeline.selectedClipId) {
      project.commitClip(timeline.selectedClipId);
    }
    nudgeGesture = false;
  }
});

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

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    const step = timeline.nudgeStep(e.altKey);
    if (e.shiftKey && timeline.selectedClipId) {
      const clip = project.clips.find((c) => c.id === timeline.selectedClipId);
      if (clip) {
        if (!nudgeGesture) {
          project.beginEdit();
          nudgeGesture = true;
        }
        const next = timeline.snap(Math.max(0, clip.start + dir * step), clip.id, clip.trackId);
        project.mutateClip(clip.id, { start: next });
        timeline.draw();
        refresh();
      }
    } else {
      const t = timeline.snap(Math.max(0, timeline.playhead + dir * step));
      timeline.setPlayhead(t);
      timeDisplay.textContent = fmt(t);
      if (engine.isPlaying) engine.seek(project, t);
      else timeline.onSeek?.(t);
    }
    return;
  }

  if (e.key === 'Home') {
    e.preventDefault();
    timeline.setPlayhead(0);
    timeDisplay.textContent = fmt(0);
    if (engine.isPlaying) engine.seek(project, 0);
    return;
  }
  if (e.key === 'End') {
    e.preventDefault();
    const t = project.duration;
    timeline.setPlayhead(t);
    timeDisplay.textContent = fmt(t);
    if (engine.isPlaying) engine.seek(project, t);
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
  } else if (e.key === 'l' || e.key === 'L') {
    toggleLoop();
  }
});

function setExportOpen(open: boolean) {
  exportPanel.hidden = !open;
  filesMenuBtn.setAttribute('aria-expanded', String(open));
  if (open) filesMenuBtn.setAttribute('aria-haspopup', 'dialog');
  else filesMenuBtn.setAttribute('aria-haspopup', 'menu');
}

filesMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!exportPanel.hidden) {
    setExportOpen(false);
    return;
  }
  const rect = filesMenuBtn.getBoundingClientRect();
  filesMenuBtn.setAttribute('aria-expanded', 'true');
  ctxMenu.show(
    rect.left,
    rect.bottom + 4,
    [
      { id: 'download-toff', label: 'Download Project.toff' },
      { id: 'open-toff', label: 'Open Project.toff' },
      { id: 'sep-files', label: '', separator: true },
      { id: 'export', label: 'Export audio…' },
      { id: 'sep-session', label: '', separator: true },
      { id: 'clear-session', label: 'Clear browser session…' },
    ],
    (id) => {
      switch (id) {
        case 'download-toff':
          void downloadToffFile();
          break;
        case 'open-toff':
          pickToffFile();
          break;
        case 'export':
          setExportOpen(true);
          break;
        case 'clear-session':
          void clearBrowserSession();
          break;
      }
    },
    () => {
      if (exportPanel.hidden) filesMenuBtn.setAttribute('aria-expanded', 'false');
    }
  );
});

window.addEventListener('pointerdown', (e) => {
  if (exportPanel.hidden) return;
  const t = e.target as Node;
  if (!exportPanel.contains(t) && !filesMenuBtn.contains(t)) setExportOpen(false);
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

window.addEventListener('pagehide', () => {
  window.clearTimeout(autosaveTimer);
  void flushAutosave();
});

void (async () => {
  try {
    if (!(await hasSavedProject())) return;
    restoringSession = true;
    const loaded = await loadProject(library);
    restoringSession = false;
    if (!loaded) return;
    const hasContent = loaded.state.tracks.length > 0 || loaded.state.clips.length > 0;
    if (!hasContent) return;
    applyLoadedProject(loaded, 'Restored previous session');
  } catch (err) {
    restoringSession = false;
    console.error(err);
    setStatus('Could not restore previous session');
  }
})();

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}
