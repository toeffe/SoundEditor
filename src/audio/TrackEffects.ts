export type BassBoostBand = '80' | '140';

export interface TrackEffects {
  eq: { lowGain: number; midGain: number; highGain: number }; // dB
  /** Dedicated peaking bass boost (separate from EQ Low shelf). */
  bassBoost: { enabled: boolean; band: BassBoostBand; gain: number }; // gain 0..12 dB
  /** Presence peaking filter for speech/vocal intelligibility (~3.2 kHz). */
  voiceClarity: { enabled: boolean; gain: number }; // gain 0..9 dB
  compressor: { threshold: number; ratio: number; enabled: boolean };
  nightcore: { enabled: boolean; amount: number }; // 1..1.5
}

export function defaultTrackEffects(): TrackEffects {
  return {
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    bassBoost: { enabled: false, band: '80', gain: 6 },
    voiceClarity: { enabled: false, gain: 4 },
    compressor: { threshold: -24, ratio: 4, enabled: false },
    nightcore: { enabled: false, amount: 1.25 },
  };
}

function normalizeBassBand(raw: unknown): BassBoostBand {
  return raw === '140' ? '140' : '80';
}

export function normalizeTrackEffects(raw?: Partial<TrackEffects> | null): TrackEffects {
  const d = defaultTrackEffects();
  if (!raw) return d;
  return {
    eq: {
      lowGain: raw.eq?.lowGain ?? d.eq.lowGain,
      midGain: raw.eq?.midGain ?? d.eq.midGain,
      highGain: raw.eq?.highGain ?? d.eq.highGain,
    },
    bassBoost: {
      enabled: raw.bassBoost?.enabled ?? d.bassBoost.enabled,
      band: normalizeBassBand(raw.bassBoost?.band),
      gain: Math.max(0, Math.min(12, raw.bassBoost?.gain ?? d.bassBoost.gain)),
    },
    voiceClarity: {
      enabled: raw.voiceClarity?.enabled ?? d.voiceClarity.enabled,
      gain: Math.max(0, Math.min(9, raw.voiceClarity?.gain ?? d.voiceClarity.gain)),
    },
    compressor: {
      threshold: raw.compressor?.threshold ?? d.compressor.threshold,
      ratio: raw.compressor?.ratio ?? d.compressor.ratio,
      enabled: raw.compressor?.enabled ?? d.compressor.enabled,
    },
    nightcore: {
      enabled: raw.nightcore?.enabled ?? d.nightcore.enabled,
      amount: Math.max(1, Math.min(1.5, raw.nightcore?.amount ?? d.nightcore.amount)),
    },
  };
}
