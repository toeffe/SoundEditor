import type { TrackEffects } from './TrackEffects';

/** Build EQ → compressor chain; returns { input, output }. */
export function buildTrackFxChain(
  ctx: BaseAudioContext,
  fx: TrackEffects
): { input: GainNode; output: AudioNode; eq: BiquadFilterNode[]; comp: DynamicsCompressorNode } {
  const input = ctx.createGain();
  input.gain.value = 1;

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

  input.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(comp);

  return { input, output: comp, eq: [low, mid, high], comp };
}

export function applyTrackFxParams(
  eq: BiquadFilterNode[],
  comp: DynamicsCompressorNode,
  fx: TrackEffects,
  when: number
) {
  const [low, mid, high] = eq;
  low.gain.setValueAtTime(fx.eq.lowGain, when);
  mid.gain.setValueAtTime(fx.eq.midGain, when);
  high.gain.setValueAtTime(fx.eq.highGain, when);
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
