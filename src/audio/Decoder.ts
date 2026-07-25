export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const ab = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(ab);
  } finally {
    void ctx.close();
  }
}

/** Resample buffer to targetRate / targetChannels (mono→stereo duplicates). */
export async function resampleBuffer(
  buffer: AudioBuffer,
  targetRate: number,
  targetChannels = 2
): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetRate && buffer.numberOfChannels === targetChannels) {
    return buffer;
  }
  const duration = buffer.duration;
  const frames = Math.max(1, Math.ceil(duration * targetRate));
  const offline = new OfflineAudioContext(targetChannels, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  if (buffer.numberOfChannels === 1 && targetChannels === 2) {
    const splitter = offline.createChannelSplitter(1);
    const merger = offline.createChannelMerger(2);
    src.connect(splitter);
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 0, 1);
    merger.connect(offline.destination);
  } else {
    src.connect(offline.destination);
  }
  src.start(0);
  return offline.startRendering();
}

export async function extractRegion(
  buffer: AudioBuffer,
  start: number,
  end: number
): Promise<AudioBuffer> {
  const duration = end - start;
  const frames = Math.floor(duration * buffer.sampleRate);
  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    frames,
    buffer.sampleRate
  );
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0, start, duration);
  return offline.startRendering();
}
