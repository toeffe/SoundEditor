import type { ProjectState } from '../types';
import { audioBufferToWav } from '../export/FFmpegExporter';
import type { AssetLibrary } from '../audio/AssetLibrary';
import { decodeAudioFile } from '../audio/Decoder';
import type { StoredUiFlags } from './ProjectStore';

/** File extension for portable Toeffe projects. */
export const TOFF_EXT = '.toff';
export const TOFF_MIME = 'application/x-toeffe-project';

const MAGIC = new TextEncoder().encode('TOFF');
const VERSION = 1;

interface ToffManifest {
  version: number;
  state: ProjectState;
  ui: StoredUiFlags;
  savedAt: number;
  assets: Array<{
    id: string;
    name: string;
    sampleRate: number;
    numberOfChannels: number;
    byteLength: number;
  }>;
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Build a portable .toff blob (magic + version + JSON manifest + WAV payloads). */
export async function buildToffBlob(
  state: ProjectState,
  library: AssetLibrary,
  ui: StoredUiFlags
): Promise<Blob> {
  const used = new Set(state.clips.map((c) => c.assetId));
  const wavParts: ArrayBuffer[] = [];
  const assetMeta: ToffManifest['assets'] = [];

  for (const asset of library.all()) {
    if (!used.has(asset.id)) continue;
    const wav = audioBufferToWav(asset.buffer);
    assetMeta.push({
      id: asset.id,
      name: asset.name,
      sampleRate: asset.buffer.sampleRate,
      numberOfChannels: asset.buffer.numberOfChannels,
      byteLength: wav.byteLength,
    });
    wavParts.push(wav);
  }

  const manifest: ToffManifest = {
    version: VERSION,
    state: JSON.parse(JSON.stringify(state)) as ProjectState,
    ui,
    savedAt: Date.now(),
    assets: assetMeta,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(manifest));

  // TOFF | u32 version | u32 jsonLen | json | wav0 | wav1 | …
  const headerLen = 4 + 4 + 4;
  const total =
    headerLen + jsonBytes.byteLength + wavParts.reduce((n, p) => n + p.byteLength, 0);
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  bytes.set(MAGIC, 0);
  writeUint32(view, 4, VERSION);
  writeUint32(view, 8, jsonBytes.byteLength);
  bytes.set(jsonBytes, headerLen);

  let offset = headerLen + jsonBytes.byteLength;
  for (const wav of wavParts) {
    bytes.set(new Uint8Array(wav), offset);
    offset += wav.byteLength;
  }

  return new Blob([out], { type: TOFF_MIME });
}

export function suggestToffFilename(state: ProjectState): string {
  const title = state.metadata?.title?.trim();
  const base = (title || 'project')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 64);
  return `${base || 'project'}${TOFF_EXT}`;
}

export function isToffFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(TOFF_EXT) || file.type === TOFF_MIME;
}

/** Parse a .toff file into project state + restore assets into the library. */
export async function parseToffFile(
  file: File,
  library: AssetLibrary
): Promise<{ state: ProjectState; ui: StoredUiFlags }> {
  const buf = await file.arrayBuffer();
  if (buf.byteLength < 12) throw new Error('Not a valid .toff file');

  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== 'TOFF') throw new Error('Not a valid .toff file (bad magic)');

  const version = readUint32(view, 4);
  if (version !== VERSION) {
    throw new Error(`Unsupported .toff version ${version}`);
  }

  const jsonLen = readUint32(view, 8);
  const jsonStart = 12;
  const jsonEnd = jsonStart + jsonLen;
  if (jsonEnd > buf.byteLength) throw new Error('Corrupt .toff file (manifest)');

  const jsonText = new TextDecoder().decode(bytes.subarray(jsonStart, jsonEnd));
  const manifest = JSON.parse(jsonText) as ToffManifest;
  if (!manifest?.state || !Array.isArray(manifest.assets)) {
    throw new Error('Corrupt .toff file (manifest contents)');
  }

  let offset = jsonEnd;
  library.clear();
  for (const meta of manifest.assets) {
    const end = offset + (meta.byteLength || 0);
    if (end > buf.byteLength) throw new Error(`Corrupt .toff file (asset ${meta.id})`);
    const wavSlice = buf.slice(offset, end);
    offset = end;
    const wavFile = new File([wavSlice], meta.name || 'audio.wav', { type: 'audio/wav' });
    const buffer = await decodeAudioFile(wavFile);
    library.restore(meta.id, meta.name, buffer);
  }

  return {
    state: manifest.state,
    ui: manifest.ui ?? {
      snapEnabled: false,
      magneticEnabled: true,
      gridStep: 0.1,
      loopEnabled: false,
    },
  };
}
