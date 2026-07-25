import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
// Explicit worker URL so Vite serves the real module (not a broken prebundled path).
import classWorkerURL from '@ffmpeg/ffmpeg/worker?url';

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

/**
 * Loads ffmpeg.wasm from same-origin ESM files in /public/ffmpeg (copied by
 * `npm install` via scripts/copy-ffmpeg-core.mjs). Blob URLs keep the worker
 * import same-origin / offline — no CDN.
 */
export async function getFFmpeg(): Promise<FFmpeg> {
  if (instance) return instance;
  if (loading) return loading;

  loading = (async () => {
    const ffmpeg = new FFmpeg();
    const base = `${window.location.origin}/ffmpeg`;
    try {
      const coreProbe = await fetch(`${base}/ffmpeg-core.js`, { method: 'HEAD' });
      if (!coreProbe.ok) {
        throw new Error(`HTTP ${coreProbe.status} for ${base}/ffmpeg-core.js`);
      }
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      ]);
      await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
    } catch (err) {
      loading = null;
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not load the audio encoder (${detail}). ` +
          'Ensure public/ffmpeg has the ESM ffmpeg-core.js/.wasm (run "npm install"), then restart the dev server.',
        { cause: err }
      );
    }
    instance = ffmpeg;
    return ffmpeg;
  })();

  return loading;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

export function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChan = buffer.numberOfChannels;
  const len = buffer.length * numChan * 2 + 44;
  const ab = new ArrayBuffer(len);
  const view = new DataView(ab);
  const channels: Float32Array[] = [];
  let offset = 0;
  let pos = 0;

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + buffer.length * numChan * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChan, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2 * numChan, true);
  view.setUint16(32, numChan * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, buffer.length * numChan * 2, true);

  for (let i = 0; i < numChan; i++) channels.push(buffer.getChannelData(i));

  offset = 44;
  while (pos < buffer.length) {
    for (let i = 0; i < numChan; i++) {
      let sample = Math.max(-1, Math.min(1, channels[i][pos]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
    pos++;
  }
  return ab;
}

export async function exportAudio(
  buffer: AudioBuffer,
  format: 'mp3' | 'flac' | 'wav' | 'ogg',
  bitrate: number,
  metadata: Record<string, string>
): Promise<Blob> {
  // WAV is written in-process — no ffmpeg.wasm needed.
  if (format === 'wav') {
    return new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' });
  }

  const ffmpeg = await getFFmpeg();

  const wav = audioBufferToWav(buffer);
  await ffmpeg.writeFile('input.wav', new Uint8Array(wav));

  const args = ['-i', 'input.wav'];

  Object.entries(metadata).forEach(([k, v]) => {
    if (v) args.push('-metadata', `${k}=${v}`);
  });

  if (format === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`);
  } else if (format === 'ogg') {
    args.push('-c:a', 'libvorbis', '-q:a', '4');
  } else if (format === 'flac') {
    args.push('-c:a', 'flac');
  } else {
    args.push('-c:a', 'pcm_s16le');
  }

  args.push(`output.${format}`);
  await ffmpeg.exec(args);

  const data = await ffmpeg.readFile(`output.${format}`);
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  return new Blob([bytes.buffer as ArrayBuffer], { type: `audio/${format}` });
}
