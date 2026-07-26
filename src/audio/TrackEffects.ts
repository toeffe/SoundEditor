export interface TrackEffects {
  eq: { lowGain: number; midGain: number; highGain: number }; // dB
  compressor: { threshold: number; ratio: number; enabled: boolean };
  nightcore: { enabled: boolean; amount: number }; // 1..1.5
}

export function defaultTrackEffects(): TrackEffects {
  return {
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    compressor: { threshold: -24, ratio: 4, enabled: false },
    nightcore: { enabled: false, amount: 1.25 },
  };
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
