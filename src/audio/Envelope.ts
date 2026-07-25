import type { Clip, EnvelopePoint } from '../types';
import { clipDuration } from '../types';
import { interpolateEnvelope } from '../project/Project';

export interface GainPoint {
  time: number;
  gain: number;
}

/** Build absolute gain schedule (clip.gain × envelope × fades) for duration */
export function buildGainSchedule(clip: Clip): GainPoint[] {
  const duration = clipDuration(clip);
  if (duration <= 0) return [{ time: 0, gain: 0 }];

  const pts: GainPoint[] = [];
  const env = [...clip.envelope].sort((a, b) => a.time - b.time);

  const sample = (t: number): number => {
    let g = clip.gain * interpolateEnvelope(env, t, 1);
    if (clip.fadeIn > 0 && t < clip.fadeIn) {
      g *= t / clip.fadeIn;
    }
    if (clip.fadeOut > 0 && t > duration - clip.fadeOut) {
      g *= Math.max(0, (duration - t) / clip.fadeOut);
    }
    return Math.max(0, g);
  };

  const times = new Set<number>([0, duration]);
  if (clip.fadeIn > 0) times.add(clip.fadeIn);
  if (clip.fadeOut > 0) times.add(Math.max(0, duration - clip.fadeOut));
  for (const p of env) {
    if (p.time > 0 && p.time < duration) times.add(p.time);
  }

  for (const t of [...times].sort((a, b) => a - b)) {
    pts.push({ time: t, gain: sample(t) });
  }
  return pts;
}

export function normalizeEnvelope(
  envelope: EnvelopePoint[],
  duration: number,
  defaultGain: number
): EnvelopePoint[] {
  const sorted = [...envelope].sort((a, b) => a.time - b.time);
  const result: EnvelopePoint[] = [];
  if (sorted.length === 0 || sorted[0].time > 0) {
    result.push({
      time: 0,
      gain: sorted.length > 0 ? sorted[0].gain : defaultGain,
    });
  }
  result.push(...sorted);
  const last = result[result.length - 1];
  if (last.time < duration) {
    result.push({ time: duration, gain: last.gain });
  }
  return result;
}

export function envelopeGainToY(gain: number, height: number): number {
  const clamped = Math.max(0, Math.min(2, gain));
  return height - (clamped / 2) * (height - 20) - 10;
}

export function envelopeYToGain(y: number, height: number): number {
  const g = ((height - 10 - y) / (height - 20)) * 2;
  return Math.max(0, Math.min(2, g));
}
