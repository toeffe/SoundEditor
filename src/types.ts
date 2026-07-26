import type { TrackEffects } from './audio/TrackEffects';
import { defaultTrackEffects } from './audio/TrackEffects';

export type { TrackEffects };
export { defaultTrackEffects };

export interface EnvelopePoint {
  time: number; // seconds relative to clip start (timeline)
  gain: number; // multiplier 0..2
}

export interface Track {
  id: string;
  name: string;
  order: number;
  gain: number;
  /** Playback speed for all clips on this track (pitch follows). */
  rate: number;
  mute: boolean;
  solo: boolean;
  effects: TrackEffects;
}

export interface Clip {
  id: string;
  trackId: string;
  assetId: string;
  start: number; // timeline position (seconds)
  sourceStart: number;
  sourceEnd: number;
  /** Legacy per-clip rate; multiplied with track.rate. Prefer track.rate for new edits. */
  rate: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  envelope: EnvelopePoint[];
}

export interface ProjectState {
  tracks: Track[];
  clips: Clip[];
  masterGain: number;
  metadata: Record<string, string>;
  sampleRate: number;
}

export interface TimeSelection {
  start: number;
  end: number;
}

/** Source media duration (seconds). */
export function sourceDuration(clip: Clip): number {
  return Math.max(0, clip.sourceEnd - clip.sourceStart);
}

/** Combined clip × track playback rate. */
export function clipPlaybackRate(clip: Clip, trackRate = 1): number {
  const cr = clip.rate > 0 ? clip.rate : 1;
  const tr = trackRate > 0 ? trackRate : 1;
  return cr * tr;
}

/** Timeline duration accounting for playback rate. */
export function clipDuration(clip: Clip, trackRate = 1): number {
  return sourceDuration(clip) / clipPlaybackRate(clip, trackRate);
}
