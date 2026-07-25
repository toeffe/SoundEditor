import { describe, it, expect } from 'vitest';
import { Project, interpolateEnvelope, sliceClipToRange } from '../project/Project';
import { clipDuration } from '../types';

function freshProject(duration = 10) {
  const project = new Project();
  const track = project.createTrack('Track 1');
  const clip = project.createClip(track.id, 'asset-1', 0, 0, duration);
  project.loadFresh([track], [clip], 1, {}, 44100);
  return { project, clipId: clip.id, trackId: track.id };
}

describe('Project', () => {
  it('creates a clip spanning the given source range', () => {
    const { project } = freshProject(5);
    expect(project.clips).toHaveLength(1);
    expect(clipDuration(project.clips[0])).toBe(5);
    expect(project.duration).toBe(5);
    expect(project.tracks).toHaveLength(1);
  });

  it('supports undo/redo for updateClip', () => {
    const { project, clipId } = freshProject();
    project.updateClip(clipId, { gain: 0.5 });
    expect(project.clips[0].gain).toBe(0.5);

    expect(project.canUndo).toBe(true);
    project.undo();
    expect(project.clips[0].gain).toBe(1);
    expect(project.canRedo).toBe(true);

    project.redo();
    expect(project.clips[0].gain).toBe(0.5);
  });

  it('clears the redo stack after a new edit', () => {
    const { project, clipId } = freshProject();
    project.updateClip(clipId, { gain: 0.5 });
    project.undo();
    expect(project.canRedo).toBe(true);

    project.updateClip(clipId, { gain: 0.75 });
    expect(project.canRedo).toBe(false);
  });

  it('caps undo history at maxHistory (50) entries', () => {
    const { project, clipId } = freshProject();
    for (let i = 0; i < 60; i++) {
      project.updateClip(clipId, { gain: 1 + i * 0.001 });
    }
    let undoCount = 0;
    while (project.canUndo) {
      project.undo();
      undoCount++;
    }
    expect(undoCount).toBe(50);
  });

  it('splits a clip into two clips at the given time, preserving total duration', () => {
    const { project, clipId, trackId } = freshProject(10);
    const rightId = project.splitClip(clipId, 4);
    expect(rightId).not.toBeNull();
    expect(project.clips).toHaveLength(2);

    const [left, right] = project.clips;
    expect(clipDuration(left)).toBeCloseTo(4);
    expect(clipDuration(right)).toBeCloseTo(6);
    expect(right.start).toBeCloseTo(4);
    expect(right.id).toBe(rightId);
    expect(left.trackId).toBe(trackId);
    expect(right.trackId).toBe(trackId);
    expect(left.assetId).toBe('asset-1');
    expect(right.assetId).toBe('asset-1');
  });

  it('refuses to split too close to a clip edge', () => {
    const { project, clipId } = freshProject(1);
    expect(project.splitClip(clipId, 0.01)).toBeNull();
    expect(project.splitClip(clipId, 0.99)).toBeNull();
    expect(project.clips).toHaveLength(1);
  });

  it('duplicates a clip immediately after the original', () => {
    const { project, clipId } = freshProject(3);
    const dupId = project.duplicateClip(clipId);
    expect(dupId).not.toBeNull();
    expect(project.clips).toHaveLength(2);
    const dup = project.clips.find((c) => c.id === dupId)!;
    expect(dup.start).toBeCloseTo(3);
  });

  it('keeps clips sorted by start time after edits', () => {
    const project = new Project();
    const track = project.createTrack('T');
    const a = project.createClip(track.id, 'a', 5, 0, 2);
    const b = project.createClip(track.id, 'a', 0, 0, 2);
    project.loadFresh([track], [a, b]);
    expect(project.clips[0].id).toBe(b.id);
    expect(project.clips[1].id).toBe(a.id);
  });

  it('removes a clip via removeClip', () => {
    const { project, clipId } = freshProject();
    project.removeClip(clipId);
    expect(project.clips).toHaveLength(0);
  });

  it('merges abutting same-asset clips on one track', () => {
    const { project, clipId, trackId } = freshProject(4);
    const rightId = project.splitClip(clipId, 2)!;
    expect(project.mergeClipWithNext(project.clips.find((c) => c.start === 0)!.id)).toBe(true);
    expect(project.clips).toHaveLength(1);
    expect(clipDuration(project.clips[0])).toBeCloseTo(4);
    expect(project.clips[0].trackId).toBe(trackId);
    void rightId;
  });

  it('scales timeline duration by rate', () => {
    const { project, clipId } = freshProject(4);
    project.updateClip(clipId, { rate: 2 });
    expect(clipDuration(project.clips[0])).toBeCloseTo(2);
    expect(project.duration).toBeCloseTo(2);
  });

  it('pastes a track with remapped clip ids onto a new lane', () => {
    const { project, clipId, trackId } = freshProject(4);
    const track = project.state.tracks.find((t) => t.id === trackId)!;
    const clips = project.clips.filter((c) => c.trackId === trackId);
    const newId = project.pasteTrack(track, clips);
    expect(newId).not.toBe(trackId);
    expect(project.tracks).toHaveLength(2);
    expect(project.clips).toHaveLength(2);
    const pasted = project.clips.filter((c) => c.trackId === newId);
    expect(pasted).toHaveLength(1);
    expect(pasted[0].id).not.toBe(clipId);
    expect(pasted[0].assetId).toBe('asset-1');
    expect(project.state.tracks.find((t) => t.id === newId)?.name).toContain('(copy)');
  });

  it('pastes relative clips at a given time offset', () => {
    const { project, trackId } = freshProject(4);
    const track = project.state.tracks.find((t) => t.id === trackId)!;
    const slice = {
      ...project.clips[0],
      start: 0,
      sourceStart: 1,
      sourceEnd: 3,
      envelope: [
        { time: 0, gain: 1 },
        { time: 2, gain: 1 },
      ],
    };
    const newId = project.pasteTrack(track, [slice], 5);
    const pasted = project.clips.find((c) => c.trackId === newId)!;
    expect(pasted.start).toBeCloseTo(5);
    expect(clipDuration(pasted)).toBeCloseTo(2);
  });

  it('slices a clip to a time range with relative start', () => {
    const { project, clipId } = freshProject(10);
    const clip = project.clips.find((c) => c.id === clipId)!;
    const sliced = sliceClipToRange(clip, 2, 5);
    expect(sliced).not.toBeNull();
    expect(sliced!.start).toBeCloseTo(0);
    expect(clipDuration(sliced!)).toBeCloseTo(3);
    expect(sliced!.sourceStart).toBeCloseTo(2);
    expect(sliced!.sourceEnd).toBeCloseTo(5);
  });

  it('track mute/solo affect audibility', () => {
    const project = new Project();
    const t1 = project.createTrack('A');
    const t2 = project.createTrack('B');
    project.loadFresh([t1, t2], []);
    expect(project.trackAudible(t1.id)).toBe(true);
    project.updateTrack(t1.id, { mute: true });
    expect(project.trackAudible(t1.id)).toBe(false);
    project.updateTrack(t1.id, { mute: false, solo: true });
    expect(project.trackAudible(t1.id)).toBe(true);
    expect(project.trackAudible(t2.id)).toBe(false);
  });
});

describe('interpolateEnvelope', () => {
  it('returns the fallback for an empty envelope', () => {
    expect(interpolateEnvelope([], 1, 0.7)).toBe(0.7);
  });

  it('clamps to the first/last point outside the range', () => {
    const env = [
      { time: 1, gain: 0.2 },
      { time: 3, gain: 0.8 },
    ];
    expect(interpolateEnvelope(env, 0, 1)).toBe(0.2);
    expect(interpolateEnvelope(env, 5, 1)).toBe(0.8);
  });

  it('linearly interpolates between two points', () => {
    const env = [
      { time: 0, gain: 0 },
      { time: 2, gain: 1 },
    ];
    expect(interpolateEnvelope(env, 1, 0)).toBeCloseTo(0.5);
  });
});
