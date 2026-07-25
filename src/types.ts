export interface EnvelopePoint {
  time: number; // seconds relative to clip start (timeline)
  gain: number; // multiplier 0..2
}

export interface Track {
  id: string;
  name: string;
  order: number;
  gain: number;
  mute: boolean;
  solo: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  assetId: string;
  start: number; // timeline position (seconds)
  sourceStart: number;
  sourceEnd: number;
  rate: number; // playback speed; timeline dur = sourceDur / rate
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

/** Timeline duration accounting for playback rate. */
export function clipDuration(clip: Clip): number {
  const rate = clip.rate > 0 ? clip.rate : 1;
  return sourceDuration(clip) / rate;
}
