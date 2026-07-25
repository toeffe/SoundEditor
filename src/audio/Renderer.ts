import type { Clip } from '../types';
import { clipDuration, sourceDuration } from '../types';
import { buildGainSchedule } from './Envelope';
import { clipOverlap, type Project } from '../project/Project';
import type { AssetLibrary } from './AssetLibrary';

export async function renderProject(
  project: Project,
  library: AssetLibrary,
  sampleRate: number
): Promise<AudioBuffer> {
  const clips = project.clips;
  const channels = 2;

  if (clips.length === 0) {
    const empty = new OfflineAudioContext(channels, 1, sampleRate);
    return empty.startRendering();
  }

  const duration = Math.max(...clips.map((c) => c.start + clipDuration(c)));
  const frames = Math.max(1, Math.ceil(duration * sampleRate));
  const offline = new OfflineAudioContext(channels, frames, sampleRate);

  const master = offline.createGain();
  master.gain.value = project.state.masterGain;
  master.connect(offline.destination);

  const trackGains = new Map<string, GainNode>();
  for (const track of project.tracks) {
    const g = offline.createGain();
    const audible = project.trackAudible(track.id);
    g.gain.value = audible ? track.gain : 0;
    g.connect(master);
    trackGains.set(track.id, g);
  }

  for (const clip of clips) {
    const buffer = library.getBuffer(clip.assetId);
    const trackGain = trackGains.get(clip.trackId);
    if (!buffer || !trackGain) continue;
    const dur = clipDuration(clip);
    if (dur <= 0) continue;

    const rate = clip.rate > 0 ? clip.rate : 1;
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = offline.createGain();
    const schedule = buildGainSchedule(clip);
    const xf = crossfadeMultiplier(project, clip);

    schedule.forEach((pt, i) => {
      const t = clip.start + pt.time;
      const g = pt.gain * xf(pt.time);
      if (i === 0) gain.gain.setValueAtTime(g, Math.max(0, t));
      else gain.gain.linearRampToValueAtTime(g, Math.max(0, t));
    });

    for (const other of clips) {
      if (other.id === clip.id) continue;
      const o = clipOverlap(clip, other);
      if (!o) continue;
      for (const edge of [o.start, o.end]) {
        const local = edge - clip.start;
        if (local <= 0 || local >= dur) continue;
        const base = schedule.reduce((acc, p, i, arr) => {
          if (p.time <= local) return p.gain;
          if (i > 0 && arr[i - 1].time <= local && p.time >= local) {
            const span = p.time - arr[i - 1].time || 1;
            return (
              arr[i - 1].gain +
              ((local - arr[i - 1].time) / span) * (p.gain - arr[i - 1].gain)
            );
          }
          return acc;
        }, clip.gain);
        gain.gain.linearRampToValueAtTime(base * xf(local), edge);
      }
    }

    src.connect(gain).connect(trackGain);
    src.start(clip.start, clip.sourceStart, sourceDuration(clip));
  }

  return offline.startRendering();
}

function crossfadeMultiplier(project: Project, clip: Clip): (localTime: number) => number {
  const others = project.clips.filter(
    (c) => c.id !== clip.id && c.trackId === clip.trackId
  );
  return (localTime: number) => {
    const abs = clip.start + localTime;
    let m = 1;
    for (const other of others) {
      const o = clipOverlap(clip, other);
      if (!o) continue;
      if (abs < o.start || abs > o.end) continue;
      const u = (abs - o.start) / (o.end - o.start || 1);
      if (clip.start <= other.start) m *= 1 - u;
      else m *= u;
    }
    return Math.max(0, Math.min(1, m));
  };
}
