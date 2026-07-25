import { describe, it, expect } from 'vitest';
import {
  buildGainSchedule,
  envelopeGainToY,
  envelopeYToGain,
  normalizeEnvelope,
} from '../audio/Envelope';
import type { Clip } from '../types';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    assetId: 'a1',
    start: 0,
    sourceStart: 0,
    sourceEnd: 10,
    rate: 1,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    envelope: [
      { time: 0, gain: 1 },
      { time: 10, gain: 1 },
    ],
    ...overrides,
  };
}

describe('buildGainSchedule', () => {
  it('starts at 0 with fade-in applied', () => {
    const clip = makeClip({ fadeIn: 2 });
    const schedule = buildGainSchedule(clip);
    expect(schedule[0]).toEqual({ time: 0, gain: 0 });
    const atFadeEnd = schedule.find((p) => p.time === 2);
    expect(atFadeEnd?.gain).toBeCloseTo(1);
  });

  it('ends at 0 with fade-out applied', () => {
    const clip = makeClip({ fadeOut: 3 });
    const schedule = buildGainSchedule(clip);
    const last = schedule[schedule.length - 1];
    expect(last.time).toBe(10);
    expect(last.gain).toBeCloseTo(0);
  });

  it('scales by clip.gain and envelope points together', () => {
    const clip = makeClip({
      gain: 0.5,
      envelope: [
        { time: 0, gain: 2 },
        { time: 10, gain: 2 },
      ],
    });
    const schedule = buildGainSchedule(clip);
    for (const pt of schedule) {
      expect(pt.gain).toBeCloseTo(1); // 0.5 * 2
    }
  });

  it('never returns a negative gain', () => {
    const clip = makeClip({ gain: -1 });
    const schedule = buildGainSchedule(clip);
    for (const pt of schedule) {
      expect(pt.gain).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns a single silent point for zero-duration clips', () => {
    const clip = makeClip({ sourceStart: 4, sourceEnd: 4 });
    expect(buildGainSchedule(clip)).toEqual([{ time: 0, gain: 0 }]);
  });
});

describe('normalizeEnvelope', () => {
  it('inserts a leading point at time 0 if missing', () => {
    const result = normalizeEnvelope([{ time: 2, gain: 0.5 }], 10, 1);
    expect(result[0]).toEqual({ time: 0, gain: 0.5 });
  });

  it('appends a trailing point at the clip duration if missing', () => {
    const result = normalizeEnvelope([{ time: 0, gain: 0.5 }], 10, 1);
    expect(result[result.length - 1]).toEqual({ time: 10, gain: 0.5 });
  });
});

describe('envelope Y-axis mapping', () => {
  it('round-trips gain -> y -> gain', () => {
    for (const gain of [0, 0.5, 1, 1.5, 2]) {
      const y = envelopeGainToY(gain, 320);
      expect(envelopeYToGain(y, 320)).toBeCloseTo(gain, 5);
    }
  });

  it('clamps gain to the 0..2 range', () => {
    expect(envelopeYToGain(-1000, 320)).toBe(2);
    expect(envelopeYToGain(1000, 320)).toBe(0);
  });

  it('maps higher gain to a smaller y (higher on screen)', () => {
    const yLow = envelopeGainToY(0, 320);
    const yHigh = envelopeGainToY(2, 320);
    expect(yHigh).toBeLessThan(yLow);
  });
});
