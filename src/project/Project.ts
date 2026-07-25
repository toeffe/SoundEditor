import type { Clip, EnvelopePoint, ProjectState, Track } from '../types';
import { clipDuration } from '../types';
import { uid } from '../uid';

export { uid };

function cloneState(state: ProjectState): ProjectState {
  return JSON.parse(JSON.stringify(state)) as ProjectState;
}

function emptyState(sampleRate = 44100): ProjectState {
  return {
    tracks: [],
    clips: [],
    masterGain: 1,
    metadata: {},
    sampleRate,
  };
}

export class Project {
  state: ProjectState;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private maxHistory = 50;
  private listeners: Array<() => void> = [];
  /** Track currently armed for recording (runtime UI; not undoable). */
  armedTrackId: string | null = null;

  constructor() {
    this.state = emptyState();
  }

  get clips(): Clip[] {
    return this.state.clips;
  }

  get tracks(): Track[] {
    return [...this.state.tracks].sort((a, b) => a.order - b.order);
  }

  get duration(): number {
    if (this.state.clips.length === 0) return 0;
    return Math.max(...this.state.clips.map((c) => c.start + clipDuration(c)));
  }

  get sampleRate(): number {
    return this.state.sampleRate || 44100;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  clearListeners() {
    this.listeners = [];
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private pushHistory() {
    this.undoStack.push(JSON.stringify(this.state));
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  private normalizeClip(c: Clip): Clip {
    return {
      ...c,
      trackId: c.trackId,
      assetId: c.assetId,
      rate: c.rate > 0 ? c.rate : 1,
      envelope: (c.envelope ?? []).map((e) => ({ ...e })),
      fadeIn: c.fadeIn ?? 0,
      fadeOut: c.fadeOut ?? 0,
      gain: c.gain ?? 1,
    };
  }

  private load(raw: ProjectState) {
    this.state = {
      tracks: (raw.tracks ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        order: t.order ?? 0,
        gain: t.gain ?? 1,
        mute: !!t.mute,
        solo: !!t.solo,
      })),
      clips: (raw.clips ?? []).map((c) => this.normalizeClip(c)),
      masterGain: raw.masterGain ?? 1,
      metadata: { ...(raw.metadata ?? {}) },
      sampleRate: raw.sampleRate || 44100,
    };
  }

  createTrack(name: string): Track {
    const order =
      this.state.tracks.length === 0
        ? 0
        : Math.max(...this.state.tracks.map((t) => t.order)) + 1;
    return {
      id: uid('track'),
      name,
      order,
      gain: 1,
      mute: false,
      solo: false,
    };
  }

  createClip(
    trackId: string,
    assetId: string,
    start: number,
    sourceStart: number,
    sourceEnd: number,
    rate = 1
  ): Clip {
    const srcDur = sourceEnd - sourceStart;
    const timelineDur = srcDur / (rate > 0 ? rate : 1);
    return {
      id: uid(),
      trackId,
      assetId,
      start,
      sourceStart,
      sourceEnd,
      rate: rate > 0 ? rate : 1,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      envelope: [
        { time: 0, gain: 1 },
        { time: timelineDur, gain: 1 },
      ],
    };
  }

  /** Replace project and clear history */
  loadFresh(
    tracks: Track[],
    clips: Clip[],
    masterGain = 1,
    metadata: Record<string, string> = {},
    sampleRate = 44100
  ) {
    this.state = {
      tracks: [...tracks],
      clips: [...clips].map((c) => this.normalizeClip(c)),
      masterGain,
      metadata,
      sampleRate,
    };
    this.sort();
    this.undoStack = [];
    this.redoStack = [];
    this.armedTrackId = null;
    this.emit();
  }

  clear() {
    this.pushHistory();
    this.state = emptyState(this.state.sampleRate || 44100);
    this.armedTrackId = null;
    this.emit();
  }

  setSampleRate(sr: number) {
    this.state.sampleRate = sr;
  }

  addTrack(track: Track, commit = true) {
    if (commit) this.pushHistory();
    this.state.tracks.push(track);
    if (commit) this.emit();
  }

  updateTrack(id: string, patch: Partial<Track>, commit = true) {
    if (commit) this.pushHistory();
    const idx = this.state.tracks.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this.state.tracks[idx] = { ...this.state.tracks[idx], ...patch };
    if (commit) this.emit();
  }

  /** Live mixer tweaks without flooding undo — call beginEdit once per gesture. */
  mutateTrack(id: string, patch: Partial<Track>) {
    const idx = this.state.tracks.findIndex((t) => t.id === id);
    if (idx === -1) return;
    Object.assign(this.state.tracks[idx], patch);
  }

  removeTrack(id: string) {
    this.pushHistory();
    this.state.tracks = this.state.tracks.filter((t) => t.id !== id);
    this.state.clips = this.state.clips.filter((c) => c.trackId !== id);
    if (this.armedTrackId === id) this.armedTrackId = null;
    this.emit();
  }

  /**
   * Paste a copied track (+ its clips) as a new lane at the bottom.
   * Clips keep the same assetId; ids and trackId are remapped.
   * @param atTime If set, clip.start values are treated as offsets from this time
   *               (used when pasting a marked selection / single clip).
   *               If omitted, clip.start values are kept as absolute timeline times.
   */
  pasteTrack(sourceTrack: Track, sourceClips: Clip[], atTime?: number): string {
    this.pushHistory();
    const order =
      this.state.tracks.length === 0
        ? 0
        : Math.max(...this.state.tracks.map((t) => t.order)) + 1;
    const baseName = sourceTrack.name.replace(/\s*\(copy(?:\s+\d+)?\)\s*$/i, '').trim() || 'Track';
    let name = `${baseName} (copy)`;
    let n = 2;
    while (this.state.tracks.some((t) => t.name === name)) {
      name = `${baseName} (copy ${n++})`;
    }

    const track: Track = {
      id: uid('track'),
      name,
      order,
      gain: sourceTrack.gain,
      mute: sourceTrack.mute,
      solo: false,
    };

    const toPaste = sourceClips.map((c) =>
      this.normalizeClip({
        ...(JSON.parse(JSON.stringify(c)) as Clip),
        id: uid(),
        trackId: track.id,
        start: atTime !== undefined ? Math.max(0, atTime + c.start) : c.start,
      })
    );

    this.state.tracks.push(track);
    this.state.clips.push(...toPaste);
    this.sort();
    this.emit();
    return track.id;
  }

  addClip(clip: Clip) {
    this.pushHistory();
    this.state.clips.push(this.normalizeClip(clip));
    this.sort();
    this.emit();
  }

  /** Add track + clip in one history entry (import / record). */
  addTrackWithClip(track: Track, clip: Clip) {
    this.pushHistory();
    this.state.tracks.push(track);
    this.state.clips.push(this.normalizeClip(clip));
    this.sort();
    this.emit();
  }

  removeClip(id: string) {
    this.pushHistory();
    this.state.clips = this.state.clips.filter((c) => c.id !== id);
    this.emit();
  }

  updateClip(id: string, patch: Partial<Clip>) {
    this.pushHistory();
    const idx = this.state.clips.findIndex((c) => c.id === id);
    if (idx === -1) return;
    this.state.clips[idx] = this.normalizeClip({ ...this.state.clips[idx], ...patch });
    this.sort();
    this.emit();
  }

  mutateClip(id: string, patch: Partial<Clip>) {
    const idx = this.state.clips.findIndex((c) => c.id === id);
    if (idx === -1) return;
    Object.assign(this.state.clips[idx], patch);
  }

  commitClip(_id: string) {
    this.sort();
    this.emit();
  }

  beginEdit() {
    this.pushHistory();
  }

  splitClip(id: string, time: number): string | null {
    const clip = this.state.clips.find((c) => c.id === id);
    if (!clip) return null;
    const dur = clipDuration(clip);
    const local = time - clip.start;
    if (local <= 0.05 || local >= dur - 0.05) return null;

    this.pushHistory();
    const gainAt = interpolateEnvelope(clip.envelope, local, 1);
    const rate = clip.rate > 0 ? clip.rate : 1;
    const localSource = local * rate;

    const leftEnv = clip.envelope
      .filter((p) => p.time <= local)
      .map((p) => ({ ...p }));
    if (!leftEnv.some((p) => Math.abs(p.time - local) < 1e-6)) {
      leftEnv.push({ time: local, gain: gainAt });
    }

    const rightEnv: EnvelopePoint[] = [{ time: 0, gain: gainAt }].concat(
      clip.envelope
        .filter((p) => p.time >= local)
        .map((p) => ({ ...p, time: p.time - local }))
    );

    const left: Clip = {
      ...clip,
      sourceEnd: clip.sourceStart + localSource,
      fadeOut: 0,
      envelope: leftEnv,
    };
    const right: Clip = {
      ...clip,
      id: uid(),
      start: time,
      sourceStart: clip.sourceStart + localSource,
      fadeIn: 0,
      envelope: rightEnv,
    };

    this.state.clips = this.state.clips.filter((c) => c.id !== id);
    this.state.clips.push(left, right);
    this.sort();
    this.emit();
    return right.id;
  }

  /** Whether mergeClipWithNext would succeed for this clip. */
  canMergeClipWithNext(id: string): boolean {
    const clip = this.state.clips.find((c) => c.id === id);
    if (!clip) return false;
    const sameTrack = this.state.clips
      .filter((c) => c.trackId === clip.trackId)
      .sort((a, b) => a.start - b.start);
    const idx = sameTrack.findIndex((c) => c.id === id);
    if (idx < 0 || idx >= sameTrack.length - 1) return false;
    const next = sameTrack[idx + 1];
    if (next.assetId !== clip.assetId) return false;
    if (Math.abs(next.rate - clip.rate) > 1e-6) return false;
    const end = clip.start + clipDuration(clip);
    if (Math.abs(next.start - end) > 0.02) return false;
    if (Math.abs(next.sourceStart - clip.sourceEnd) > 0.02) return false;
    return true;
  }

  hasNextOnTrack(id: string): boolean {
    const clip = this.state.clips.find((c) => c.id === id);
    if (!clip) return false;
    const sameTrack = this.state.clips
      .filter((c) => c.trackId === clip.trackId)
      .sort((a, b) => a.start - b.start);
    const idx = sameTrack.findIndex((c) => c.id === id);
    return idx >= 0 && idx < sameTrack.length - 1;
  }

  /**
   * Merge clip with the next abutting clip on the same track when they share
   * an asset and contiguous source + timeline ranges.
   */
  mergeClipWithNext(id: string): boolean {
    if (!this.canMergeClipWithNext(id)) return false;
    const clip = this.state.clips.find((c) => c.id === id)!;
    const sameTrack = this.state.clips
      .filter((c) => c.trackId === clip.trackId)
      .sort((a, b) => a.start - b.start);
    const idx = sameTrack.findIndex((c) => c.id === id);
    const next = sameTrack[idx + 1];

    this.pushHistory();
    const newDur = clipDuration(clip) + clipDuration(next);
    const mergedEnv = [
      ...clip.envelope.map((p) => ({ ...p })),
      ...next.envelope.map((p) => ({ ...p, time: p.time + clipDuration(clip) })),
    ];
    const merged: Clip = {
      ...clip,
      sourceEnd: next.sourceEnd,
      fadeOut: next.fadeOut,
      envelope: mergedEnv.length
        ? mergedEnv
        : [
            { time: 0, gain: 1 },
            { time: newDur, gain: 1 },
          ],
    };
    this.state.clips = this.state.clips.filter((c) => c.id !== clip.id && c.id !== next.id);
    this.state.clips.push(merged);
    this.sort();
    this.emit();
    return true;
  }

  /** Nudge selected clip and its neighbor to create a small overlap for crossfade. */
  createCrossfade(id: string, overlap = 0.05): boolean {
    const clip = this.state.clips.find((c) => c.id === id);
    if (!clip) return false;
    const sameTrack = this.state.clips
      .filter((c) => c.trackId === clip.trackId)
      .sort((a, b) => a.start - b.start);
    const idx = sameTrack.findIndex((c) => c.id === id);
    if (idx < 0 || idx >= sameTrack.length - 1) return false;
    const next = sameTrack[idx + 1];
    const end = clip.start + clipDuration(clip);
    const gap = next.start - end;
    // Already overlapping enough
    if (gap < -overlap + 1e-6) return true;
    this.pushHistory();
    const need = overlap + Math.max(0, gap);
    const half = need / 2;
    this.state.clips = this.state.clips.map((c) => {
      if (c.id === clip.id) {
        return { ...c, start: Math.max(0, c.start) };
      }
      if (c.id === next.id) {
        return { ...c, start: Math.max(0, next.start - half) };
      }
      return c;
    });
    // Extend first clip slightly into next by moving next earlier and optionally
    // leaving durations; overlap = end - next.start after nudge
    const left = this.state.clips.find((c) => c.id === clip.id)!;
    const right = this.state.clips.find((c) => c.id === next.id)!;
    const leftEnd = left.start + clipDuration(left);
    if (right.start >= leftEnd) {
      right.start = Math.max(0, leftEnd - overlap);
    }
    this.sort();
    this.emit();
    return true;
  }

  duplicateClip(id: string): string | null {
    const clip = this.state.clips.find((c) => c.id === id);
    if (!clip) return null;
    this.pushHistory();
    const dup: Clip = {
      ...cloneState({
        tracks: [],
        clips: [clip],
        masterGain: 1,
        metadata: {},
        sampleRate: this.sampleRate,
      }).clips[0],
      id: uid(),
      start: clip.start + clipDuration(clip),
    };
    this.state.clips.push(dup);
    this.sort();
    this.emit();
    return dup.id;
  }

  setMasterGain(gain: number, commit = true) {
    if (commit) this.pushHistory();
    this.state.masterGain = gain;
    this.emit();
  }

  setMetadata(meta: Record<string, string>, commit = true) {
    if (commit) this.pushHistory();
    this.state.metadata = { ...meta };
    if (commit) this.emit();
  }

  setArmedTrack(id: string | null) {
    this.armedTrackId = id;
    this.emit();
  }

  anySolo(): boolean {
    return this.state.tracks.some((t) => t.solo);
  }

  trackAudible(trackId: string): boolean {
    const t = this.state.tracks.find((x) => x.id === trackId);
    if (!t) return false;
    if (t.mute) return false;
    if (this.anySolo() && !t.solo) return false;
    return true;
  }

  undo() {
    if (!this.canUndo) return;
    this.redoStack.push(JSON.stringify(this.state));
    this.load(JSON.parse(this.undoStack.pop()!) as ProjectState);
    this.emit();
  }

  redo() {
    if (!this.canRedo) return;
    this.undoStack.push(JSON.stringify(this.state));
    this.load(JSON.parse(this.redoStack.pop()!) as ProjectState);
    this.emit();
  }

  private sort() {
    this.state.clips.sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
  }
}

export function interpolateEnvelope(
  envelope: EnvelopePoint[],
  time: number,
  fallback = 1
): number {
  const sorted = [...envelope].sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return fallback;
  if (time <= sorted[0].time) return sorted[0].gain;
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].gain;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (time >= sorted[i].time && time <= sorted[i + 1].time) {
      const span = sorted[i + 1].time - sorted[i].time || 1;
      const t = (time - sorted[i].time) / span;
      return sorted[i].gain + t * (sorted[i + 1].gain - sorted[i].gain);
    }
  }
  return fallback;
}

/** Overlap [start,end) between two clips on the same track, or null. */
export function clipOverlap(
  a: Clip,
  b: Clip
): { start: number; end: number } | null {
  if (a.trackId !== b.trackId) return null;
  const a0 = a.start;
  const a1 = a.start + clipDuration(a);
  const b0 = b.start;
  const b1 = b.start + clipDuration(b);
  const start = Math.max(a0, b0);
  const end = Math.min(a1, b1);
  if (end - start <= 1e-4) return null;
  return { start, end };
}

/**
 * Trim a clip to a timeline range. Returned clip.start is relative to rangeStart
 * (so 0 means the left edge of the selection). Returns null if no meaningful overlap.
 */
export function sliceClipToRange(
  clip: Clip,
  rangeStart: number,
  rangeEnd: number
): Clip | null {
  const clipStart = clip.start;
  const clipEnd = clip.start + clipDuration(clip);
  const start = Math.max(clipStart, rangeStart);
  const end = Math.min(clipEnd, rangeEnd);
  if (end - start < 0.05) return null;

  const rate = clip.rate > 0 ? clip.rate : 1;
  const localStart = start - clipStart;
  const localEnd = end - clipStart;
  const newDur = localEnd - localStart;

  const env = [...clip.envelope]
    .map((p) => ({ time: p.time - localStart, gain: p.gain }))
    .filter((p) => p.time >= -1e-6 && p.time <= newDur + 1e-6)
    .map((p) => ({ time: Math.max(0, Math.min(newDur, p.time)), gain: p.gain }));

  const gainAtStart = interpolateEnvelope(clip.envelope, localStart, clip.gain);
  const gainAtEnd = interpolateEnvelope(clip.envelope, localEnd, clip.gain);
  if (!env.some((p) => Math.abs(p.time) < 1e-6)) env.unshift({ time: 0, gain: gainAtStart });
  if (!env.some((p) => Math.abs(p.time - newDur) < 1e-6)) env.push({ time: newDur, gain: gainAtEnd });
  env.sort((a, b) => a.time - b.time);

  const cutFromStart = start > clipStart + 1e-4;
  const cutFromEnd = end < clipEnd - 1e-4;

  return {
    ...clip,
    start: start - rangeStart,
    sourceStart: clip.sourceStart + localStart * rate,
    sourceEnd: clip.sourceStart + localEnd * rate,
    fadeIn: cutFromStart ? 0 : Math.min(clip.fadeIn, newDur),
    fadeOut: cutFromEnd ? 0 : Math.min(clip.fadeOut, newDur),
    envelope: env,
  };
}
