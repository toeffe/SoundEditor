import type { Clip, TimeSelection, Track } from '../types';
import { clipDuration, clipPlaybackRate, sourceDuration } from '../types';
import { buildGainSchedule, sampleGainSchedule } from './Envelope';
import { clipOverlap } from '../project/Project';
import type { Project } from '../project/Project';
import type { AssetLibrary } from './AssetLibrary';
import { applyTrackFxParams, buildTrackFxChain, nightcoreAmount } from './FxChain';
import { normalizeTrackEffects } from './TrackEffects';

export interface MeterLevel {
  id: string; // track id or 'master'
  peak: number;
  rms: number;
}

interface TrackChain {
  input: GainNode;
  gain: GainNode;
  bass: BiquadFilterNode;
  eq: BiquadFilterNode[];
  clarity: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  analyser: AnalyserNode;
}

export class Engine {
  private _ctx: AudioContext | null = null;
  private library: AssetLibrary | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private clipSources = new Map<string, AudioBufferSourceNode>();
  private clipGains = new Map<string, GainNode>();
  private nodes: AudioNode[] = [];
  private trackChains = new Map<string, TrackChain>();
  private master: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private startTime = 0;
  private offset = 0;
  private raf = 0;
  private endTime = 0;
  private stopping = false;
  private playing = false;
  private loopRegion: TimeSelection | null = null;
  private activeProject: Project | null = null;
  private meterBuf = new Float32Array(2048);
  /** Bumped to cancel in-flight soft fade / scrub teardown timers. */
  private transportGen = 0;
  private static readonly FADE_OUT = 0.012;
  private static readonly FADE_IN = 0.02;

  onUpdate: ((time: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  get ctx(): AudioContext {
    if (!this._ctx) this._ctx = new AudioContext();
    return this._ctx;
  }

  setLibrary(library: AssetLibrary) {
    this.library = library;
  }

  setLoopRegion(region: TimeSelection | null) {
    this.loopRegion = region
      ? {
          start: Math.min(region.start, region.end),
          end: Math.max(region.start, region.end),
        }
      : null;
  }

  play(project: Project, fromTime = 0, opts?: { fadeIn?: boolean }) {
    if (!this.library) return;
    this.teardown();
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    this.activeProject = project;
    let start = Math.max(0, fromTime);
    if (this.loopRegion && this.loopRegion.end - this.loopRegion.start > 0.05) {
      if (start < this.loopRegion.start || start >= this.loopRegion.end) {
        start = this.loopRegion.start;
      }
    }

    this.offset = start;
    this.startTime = this.ctx.currentTime;
    this.endTime = Math.max(this.offset, project.duration);
    this.stopping = false;
    this.playing = true;

    this.master = this.ctx.createGain();
    const targetGain = project.state.masterGain;
    if (opts?.fadeIn) {
      this.master.gain.setValueAtTime(0, this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(
        targetGain,
        this.ctx.currentTime + Engine.FADE_IN
      );
    } else {
      this.master.gain.value = targetGain;
    }

    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterAnalyser.smoothingTimeConstant = 0.3;
    this.master.connect(this.masterAnalyser);
    this.master.connect(this.ctx.destination);

    for (const track of project.tracks) {
      this.buildTrackChain(project, track);
    }

    for (const clip of project.clips) {
      this.scheduleClip(project, clip, start);
    }

    const tick = () => {
      if (!this.playing) return;
      const t = this.offset + (this.ctx.currentTime - this.startTime);

      if (
        this.loopRegion &&
        this.loopRegion.end - this.loopRegion.start > 0.05 &&
        t >= this.loopRegion.end
      ) {
        this.onUpdate?.(this.loopRegion.end);
        this.play(project, this.loopRegion.start, { fadeIn: true });
        return;
      }

      if (t >= this.endTime) {
        this.onUpdate?.(this.endTime);
        this.finish();
        return;
      }
      this.onUpdate?.(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private buildTrackChain(project: Project, track: Track) {
    const fx = normalizeTrackEffects(track.effects);
    const { input, output, bass, eq, clarity, comp } = buildTrackFxChain(this.ctx, fx);
    const gain = this.ctx.createGain();
    gain.gain.value = this.trackGainValue(project, track.id);
    output.connect(gain);

    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    gain.connect(analyser);
    gain.connect(this.master!);

    this.trackChains.set(track.id, { input, gain, bass, eq, clarity, comp, analyser });
    this.nodes.push(input, bass, ...eq, clarity, comp, gain, analyser);
  }

  private trackGainValue(project: Project, trackId: string): number {
    const track = project.state.tracks.find((t) => t.id === trackId);
    if (!track || !project.trackAudible(trackId)) return 0;
    return track.gain;
  }

  setMasterGain(gain: number) {
    if (!this.master) return;
    const now = this.ctx.currentTime;
    try {
      this.master.gain.cancelAndHoldAtTime(now);
    } catch {
      this.master.gain.cancelScheduledValues(now);
    }
    this.master.gain.linearRampToValueAtTime(gain, now + 0.01);
  }

  syncTrackGains(project: Project) {
    for (const track of project.tracks) {
      const chain = this.trackChains.get(track.id);
      if (!chain) continue;
      chain.gain.gain.setValueAtTime(this.trackGainValue(project, track.id), this.ctx.currentTime);
    }
  }

  syncTrackFx(project: Project) {
    const when = this.ctx.currentTime;
    for (const track of project.tracks) {
      const chain = this.trackChains.get(track.id);
      if (!chain) continue;
      applyTrackFxParams(
        chain.bass,
        chain.eq,
        chain.clarity,
        chain.comp,
        normalizeTrackEffects(track.effects),
        when
      );
    }
  }

  getMeterLevels(): MeterLevel[] {
    const levels: MeterLevel[] = [];
    for (const [id, chain] of this.trackChains) {
      levels.push({ id, ...this.readAnalyser(chain.analyser) });
    }
    if (this.masterAnalyser) {
      levels.push({ id: 'master', ...this.readAnalyser(this.masterAnalyser) });
    }
    return levels;
  }

  private readAnalyser(analyser: AnalyserNode): { peak: number; rms: number } {
    const n = analyser.fftSize;
    if (this.meterBuf.length < n) this.meterBuf = new Float32Array(n);
    analyser.getFloatTimeDomainData(this.meterBuf.subarray(0, n));
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = this.meterBuf[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / n) };
  }

  private finish() {
    if (this.stopping) return;
    this.transportGen++;
    this.playing = false;
    this.teardown();
    this.onEnded?.();
  }

  private scheduleClip(project: Project, clip: Clip, fromTime: number) {
    if (!this.library || !this.master) return;
    const buffer = this.library.getBuffer(clip.assetId);
    const chain = this.trackChains.get(clip.trackId);
    if (!buffer || !chain) return;

    const track = project.state.tracks.find((t) => t.id === clip.trackId);
    const nc = nightcoreAmount(normalizeTrackEffects(track?.effects));
    const trackRate = track && track.rate > 0 ? track.rate : 1;
    const baseRate = clipPlaybackRate(clip, trackRate);
    const rate = baseRate * nc;

    const dur = clipDuration(clip, trackRate);
    const clipEnd = clip.start + dur;
    if (dur <= 0 || clipEnd <= fromTime) return;

    const playStart = Math.max(0, clip.start - fromTime);
    const skippedTimeline = Math.max(0, fromTime - clip.start);
    // Source offset uses effective rate (timeline→source), nightcore speeds the playback of that window
    const sourceOffset = clip.sourceStart + skippedTimeline * baseRate;
    const playDuration = dur - skippedTimeline;
    if (playDuration <= 0) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = this.ctx.createGain();

    const t0 = this.ctx.currentTime + playStart;
    const schedule = buildGainSchedule(clip, trackRate);
    const xf = this.crossfadeMultiplier(project, clip);

    let seeded = false;
    for (const pt of schedule) {
      if (pt.time < skippedTimeline) continue;
      const abs = t0 + (pt.time - skippedTimeline);
      const g = pt.gain * xf(pt.time);
      if (!seeded) {
        const prev = schedule.filter((p) => p.time <= skippedTimeline).pop();
        const entryBase = prev
          ? prev.gain +
            ((skippedTimeline - prev.time) / ((pt.time - prev.time) || 1)) * (pt.gain - prev.gain)
          : pt.gain;
        gain.gain.setValueAtTime(entryBase * xf(skippedTimeline), t0);
        if (pt.time > skippedTimeline) gain.gain.linearRampToValueAtTime(g, abs);
        seeded = true;
      } else {
        gain.gain.linearRampToValueAtTime(g, abs);
      }
    }
    if (!seeded) gain.gain.setValueAtTime(clip.gain * xf(skippedTimeline), t0);

    const tr = trackRate;
    const overlaps = project.clips
      .filter((c) => c.id !== clip.id)
      .map((c) => clipOverlap(clip, c, tr))
      .filter((o): o is { start: number; end: number } => !!o);
    for (const o of overlaps) {
      for (const edge of [o.start, o.end]) {
        const local = edge - clip.start;
        if (local <= skippedTimeline || local >= dur) continue;
        const abs = t0 + (local - skippedTimeline);
        const base = schedule.reduce((acc, p, i, arr) => {
          if (p.time <= local) return p.gain;
          if (i > 0 && arr[i - 1].time <= local && p.time >= local) {
            const span = p.time - arr[i - 1].time || 1;
            return arr[i - 1].gain + ((local - arr[i - 1].time) / span) * (p.gain - arr[i - 1].gain);
          }
          return acc;
        }, clip.gain);
        gain.gain.linearRampToValueAtTime(base * xf(local), abs);
      }
    }

    source.connect(gain).connect(chain.input);
    // With nightcore, buffer is consumed faster; keep timeline playDuration
    const srcDur = Math.min(
      sourceDuration(clip) - skippedTimeline * baseRate,
      playDuration * rate
    );
    source.start(t0, sourceOffset, Math.max(0.001, srcDur));
    this.sources.push(source);
    this.clipSources.set(clip.id, source);
    this.clipGains.set(clip.id, gain);
    this.nodes.push(gain);
  }

  /**
   * Live-update clip volume envelopes without restarting buffer sources.
   * Uses a short ramp so automation changes don't click as hard as a full seek.
   */
  updateClipEnvelopes(project: Project) {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const timelineNow = this.offset + (now - this.startTime);
    const smooth = 0.015;

    for (const clip of project.clips) {
      const gainNode = this.clipGains.get(clip.id);
      if (!gainNode) continue;

      const dur = clipDuration(clip, project.trackRate(clip.trackId));
      if (dur <= 0 || clip.start + dur <= this.offset) continue;

      const schedule = buildGainSchedule(clip, project.trackRate(clip.trackId));
      const xf = this.crossfadeMultiplier(project, clip);
      const localNow = timelineNow - clip.start;
      const audioAt = (local: number) => this.startTime + (clip.start + local - this.offset);

      try {
        gainNode.gain.cancelAndHoldAtTime(now);
      } catch {
        gainNode.gain.cancelScheduledValues(now);
      }

      if (localNow < 0) {
        // Clip has not started yet — rebuild upcoming automation from the start.
        const startAt = Math.max(now, audioAt(0));
        const g0 = sampleGainSchedule(schedule, 0) * xf(0);
        gainNode.gain.setValueAtTime(g0, startAt);
        for (const pt of schedule) {
          if (pt.time <= 0) continue;
          gainNode.gain.linearRampToValueAtTime(pt.gain * xf(pt.time), audioAt(pt.time));
        }
        this.scheduleOverlapEdges(project, clip, schedule, xf, 0, audioAt, gainNode);
        continue;
      }

      if (localNow > dur) continue;

      const target = sampleGainSchedule(schedule, localNow) * xf(localNow);
      const holdUntil = now + smooth;
      gainNode.gain.linearRampToValueAtTime(target, holdUntil);

      for (const pt of schedule) {
        if (pt.time <= localNow) continue;
        const abs = audioAt(pt.time);
        if (abs <= holdUntil) continue;
        gainNode.gain.linearRampToValueAtTime(pt.gain * xf(pt.time), abs);
      }
      this.scheduleOverlapEdges(project, clip, schedule, xf, localNow, audioAt, gainNode, holdUntil);
    }
  }

  private scheduleOverlapEdges(
    project: Project,
    clip: Clip,
    schedule: ReturnType<typeof buildGainSchedule>,
    xf: (localTime: number) => number,
    skippedTimeline: number,
    audioAt: (local: number) => number,
    gain: GainNode,
    notBefore = 0
  ) {
    const dur = clipDuration(clip, project.trackRate(clip.trackId));
    const overlaps = project.clips
      .filter((c) => c.id !== clip.id)
      .map((c) => clipOverlap(clip, c, project.trackRate(clip.trackId)))
      .filter((o): o is { start: number; end: number } => !!o);
    for (const o of overlaps) {
      for (const edge of [o.start, o.end]) {
        const local = edge - clip.start;
        if (local <= skippedTimeline || local >= dur) continue;
        const abs = audioAt(local);
        if (abs <= notBefore) continue;
        const base = sampleGainSchedule(schedule, local);
        gain.gain.linearRampToValueAtTime(base * xf(local), abs);
      }
    }
  }

  private crossfadeMultiplier(project: Project, clip: Clip): (localTime: number) => number {
    const others = project.clips.filter(
      (c) => c.id !== clip.id && c.trackId === clip.trackId
    );
    return (localTime: number) => {
      const abs = clip.start + localTime;
      let m = 1;
      for (const other of others) {
        const o = clipOverlap(clip, other, project.trackRate(clip.trackId));
        if (!o) continue;
        const u = (abs - o.start) / (o.end - o.start || 1);
        if (abs < o.start || abs > o.end) continue;
        if (clip.start <= other.start) m *= 1 - u;
        else m *= u;
      }
      return Math.max(0, Math.min(1, m));
    };
  }

  setTrackRate(project: Project, trackId: string) {
    if (!this.playing) return;
    const track = project.state.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const nc = nightcoreAmount(normalizeTrackEffects(track.effects));
    const trackRate = track.rate > 0 ? track.rate : 1;
    for (const clip of project.clips) {
      if (clip.trackId !== trackId) continue;
      const source = this.clipSources.get(clip.id);
      if (!source) continue;
      const r = clipPlaybackRate(clip, trackRate) * nc;
      source.playbackRate.setValueAtTime(r, this.ctx.currentTime);
    }
  }

  /**
   * Fade output out and tear down the graph while keeping transport "playing".
   * Used while the user scrub-drags so we don't hard-restart sources every frame.
   */
  silenceForScrub() {
    if (!this.playing) return;
    const token = ++this.transportGen;
    this.fadeMasterTo(0, Engine.FADE_OUT);
    window.setTimeout(() => {
      if (token !== this.transportGen || !this.playing) return;
      this.teardown();
    }, Engine.FADE_OUT * 1000 + 2);
  }

  seek(project: Project, time: number) {
    if (!this.playing) return;
    const token = ++this.transportGen;
    const master = this.master;
    const needsFade = !!master && master.gain.value > 0.001;

    const restart = () => {
      if (token !== this.transportGen || !this.playing) return;
      this.play(project, time, { fadeIn: true });
    };

    if (needsFade) {
      this.fadeMasterTo(0, Engine.FADE_OUT);
      window.setTimeout(restart, Engine.FADE_OUT * 1000 + 2);
    } else {
      restart();
    }
  }

  stop() {
    this.transportGen++;
    this.stopping = true;
    this.playing = false;
    this.teardown();
  }

  private fadeMasterTo(value: number, seconds: number) {
    if (!this.master) return;
    const now = this.ctx.currentTime;
    try {
      this.master.gain.cancelAndHoldAtTime(now);
    } catch {
      this.master.gain.cancelScheduledValues(now);
    }
    this.master.gain.linearRampToValueAtTime(Math.max(0, value), now + seconds);
  }

  private teardown() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
      s.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
    if (this.masterAnalyser) {
      this.masterAnalyser.disconnect();
      this.masterAnalyser = null;
    }
    if (this.master) {
      this.master.disconnect();
      this.master = null;
    }
    this.sources = [];
    this.clipSources.clear();
    this.clipGains.clear();
    this.nodes = [];
    this.trackChains.clear();
    this.activeProject = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
