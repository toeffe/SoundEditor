import type { Clip } from '../types';
import { clipDuration, sourceDuration } from '../types';
import { buildGainSchedule } from './Envelope';
import { clipOverlap } from '../project/Project';
import type { Project } from '../project/Project';
import type { AssetLibrary } from './AssetLibrary';

export class Engine {
  private _ctx: AudioContext | null = null;
  private library: AssetLibrary | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private nodes: AudioNode[] = [];
  private trackGains = new Map<string, GainNode>();
  private master: GainNode | null = null;
  private startTime = 0;
  private offset = 0;
  private raf = 0;
  private endTime = 0;
  private stopping = false;
  private playing = false;
  onUpdate: ((time: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  get ctx(): AudioContext {
    if (!this._ctx) this._ctx = new AudioContext();
    return this._ctx;
  }

  setLibrary(library: AssetLibrary) {
    this.library = library;
  }

  play(project: Project, fromTime = 0) {
    if (!this.library) return;
    this.teardown();
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    this.offset = Math.max(0, fromTime);
    this.startTime = this.ctx.currentTime;
    this.endTime = Math.max(this.offset, project.duration);
    this.stopping = false;
    this.playing = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = project.state.masterGain;
    this.master.connect(this.ctx.destination);

    for (const track of project.tracks) {
      const g = this.ctx.createGain();
      g.gain.value = this.trackGainValue(project, track.id);
      g.connect(this.master);
      this.trackGains.set(track.id, g);
      this.nodes.push(g);
    }

    for (const clip of project.clips) {
      this.scheduleClip(project, clip, fromTime);
    }

    const tick = () => {
      if (!this.playing) return;
      const t = this.offset + (this.ctx.currentTime - this.startTime);
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

  private trackGainValue(project: Project, trackId: string): number {
    const track = project.state.tracks.find((t) => t.id === trackId);
    if (!track || !project.trackAudible(trackId)) return 0;
    return track.gain;
  }

  /** Live master gain while playing. */
  setMasterGain(gain: number) {
    if (!this.master) return;
    this.master.gain.setValueAtTime(gain, this.ctx.currentTime);
  }

  /** Refresh track mute/solo/fader while playing. */
  syncTrackGains(project: Project) {
    for (const track of project.tracks) {
      const node = this.trackGains.get(track.id);
      if (!node) continue;
      node.gain.setValueAtTime(this.trackGainValue(project, track.id), this.ctx.currentTime);
    }
  }

  private finish() {
    if (this.stopping) return;
    this.playing = false;
    this.teardown();
    this.onEnded?.();
  }

  private scheduleClip(project: Project, clip: Clip, fromTime: number) {
    if (!this.library || !this.master) return;
    const buffer = this.library.getBuffer(clip.assetId);
    const trackGain = this.trackGains.get(clip.trackId);
    if (!buffer || !trackGain) return;

    const dur = clipDuration(clip);
    const clipEnd = clip.start + dur;
    if (dur <= 0 || clipEnd <= fromTime) return;

    const rate = clip.rate > 0 ? clip.rate : 1;
    const playStart = Math.max(0, clip.start - fromTime);
    const skippedTimeline = Math.max(0, fromTime - clip.start);
    const sourceOffset = clip.sourceStart + skippedTimeline * rate;
    const playDuration = dur - skippedTimeline;
    if (playDuration <= 0) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = this.ctx.createGain();

    const t0 = this.ctx.currentTime + playStart;
    const schedule = buildGainSchedule(clip);
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

    // Extra keyframes at crossfade boundaries
    const overlaps = project.clips
      .filter((c) => c.id !== clip.id)
      .map((c) => clipOverlap(clip, c))
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

    source.connect(gain).connect(trackGain);
    const srcDur = Math.min(sourceDuration(clip) - skippedTimeline * rate, playDuration * rate);
    source.start(t0, sourceOffset, Math.max(0.001, srcDur));
    this.sources.push(source);
    this.nodes.push(gain);
  }

  /** Linear crossfade: outgoing fades 1→0, incoming 0→1 across overlap. */
  private crossfadeMultiplier(project: Project, clip: Clip): (localTime: number) => number {
    const others = project.clips.filter(
      (c) => c.id !== clip.id && c.trackId === clip.trackId
    );
    return (localTime: number) => {
      const abs = clip.start + localTime;
      let m = 1;
      for (const other of others) {
        const o = clipOverlap(clip, other);
        if (!o) continue;
        const u = (abs - o.start) / (o.end - o.start || 1);
        if (abs < o.start || abs > o.end) continue;
        // Earlier-starting clip is outgoing
        if (clip.start <= other.start) {
          m *= 1 - u;
        } else {
          m *= u;
        }
      }
      return Math.max(0, Math.min(1, m));
    };
  }

  seek(project: Project, time: number) {
    if (!this.playing) return;
    this.play(project, time);
  }

  stop() {
    this.stopping = true;
    this.playing = false;
    this.teardown();
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
    if (this.master) {
      this.master.disconnect();
      this.master = null;
    }
    this.sources = [];
    this.nodes = [];
    this.trackGains.clear();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
