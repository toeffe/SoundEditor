import type { BassBoostBand, TrackEffects } from './TrackEffects';

const BASS_Q = 0.85;
const CLARITY_FREQ = 3200;
const CLARITY_Q = 1.1;

export function bassBoostHz(band: BassBoostBand): number {
  return band === '140' ? 140 : 80;
}

function bassBoostGainDb(fx: TrackEffects): number {
  return fx.bassBoost.enabled ? fx.bassBoost.gain : 0;
}

function voiceClarityGainDb(fx: TrackEffects): number {
  return fx.voiceClarity.enabled ? fx.voiceClarity.gain : 0;
}

/** Build bass → EQ → voice clarity → compressor; returns { input, output }. */
export function buildTrackFxChain(
  ctx: BaseAudioContext,
  fx: TrackEffects
): {
  input: GainNode;
  output: AudioNode;
  bass: BiquadFilterNode;
  eq: BiquadFilterNode[];
  clarity: BiquadFilterNode;
  comp: DynamicsCompressorNode;
} {
  const input = ctx.createGain();
  input.gain.value = 1;

  const bass = ctx.createBiquadFilter();
  bass.type = 'peaking';
  bass.frequency.value = bassBoostHz(fx.bassBoost.band);
  bass.Q.value = BASS_Q;
  bass.gain.value = bassBoostGainDb(fx);

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 250;
  low.gain.value = fx.eq.lowGain;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 1;
  mid.gain.value = fx.eq.midGain;

  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 4000;
  high.gain.value = fx.eq.highGain;

  const clarity = ctx.createBiquadFilter();
  clarity.type = 'peaking';
  clarity.frequency.value = CLARITY_FREQ;
  clarity.Q.value = CLARITY_Q;
  clarity.gain.value = voiceClarityGainDb(fx);

  const comp = ctx.createDynamicsCompressor();
  if (fx.compressor.enabled) {
    comp.threshold.value = fx.compressor.threshold;
    comp.ratio.value = fx.compressor.ratio;
    comp.knee.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
  } else {
    // Bypass-ish: very high threshold
    comp.threshold.value = 0;
    comp.ratio.value = 1;
    comp.knee.value = 0;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
  }

  input.connect(bass);
  bass.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(clarity);
  clarity.connect(comp);

  return { input, output: comp, bass, eq: [low, mid, high], clarity, comp };
}

export function applyTrackFxParams(
  bass: BiquadFilterNode,
  eq: BiquadFilterNode[],
  clarity: BiquadFilterNode,
  comp: DynamicsCompressorNode,
  fx: TrackEffects,
  when: number
) {
  const [low, mid, high] = eq;
  bass.frequency.setValueAtTime(bassBoostHz(fx.bassBoost.band), when);
  bass.Q.setValueAtTime(BASS_Q, when);
  bass.gain.setValueAtTime(bassBoostGainDb(fx), when);
  low.gain.setValueAtTime(fx.eq.lowGain, when);
  mid.gain.setValueAtTime(fx.eq.midGain, when);
  high.gain.setValueAtTime(fx.eq.highGain, when);
  clarity.frequency.setValueAtTime(CLARITY_FREQ, when);
  clarity.Q.setValueAtTime(CLARITY_Q, when);
  clarity.gain.setValueAtTime(voiceClarityGainDb(fx), when);
  if (fx.compressor.enabled) {
    comp.threshold.setValueAtTime(fx.compressor.threshold, when);
    comp.ratio.setValueAtTime(fx.compressor.ratio, when);
  } else {
    comp.threshold.setValueAtTime(0, when);
    comp.ratio.setValueAtTime(1, when);
  }
}

export function nightcoreAmount(fx: TrackEffects | undefined): number {
  if (!fx?.nightcore?.enabled) return 1;
  return Math.max(1, Math.min(1.5, fx.nightcore.amount || 1.25));
}
