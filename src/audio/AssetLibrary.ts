import { uid } from '../uid';

export interface Asset {
  id: string;
  name: string;
  buffer: AudioBuffer;
  peaks: Float32Array | null;
  spectrogram: HTMLCanvasElement | null;
}

/** Runtime media store — buffers are never put in the undo stack. */
export class AssetLibrary {
  private assets = new Map<string, Asset>();

  clear() {
    this.assets.clear();
  }

  has(id: string): boolean {
    return this.assets.has(id);
  }

  get(id: string): Asset | undefined {
    return this.assets.get(id);
  }

  getBuffer(id: string): AudioBuffer | null {
    return this.assets.get(id)?.buffer ?? null;
  }

  add(name: string, buffer: AudioBuffer): Asset {
    const asset: Asset = {
      id: uid('asset'),
      name,
      buffer,
      peaks: null,
      spectrogram: null,
    };
    this.assets.set(asset.id, asset);
    return asset;
  }

  setPeaks(id: string, peaks: Float32Array) {
    const a = this.assets.get(id);
    if (a) a.peaks = peaks;
  }

  setSpectrogram(id: string, canvas: HTMLCanvasElement | null) {
    const a = this.assets.get(id);
    if (a) a.spectrogram = canvas;
  }

  /** Compute min/max peaks for waveform drawing at a given px/sec zoom. */
  computePeaks(id: string, zoom: number) {
    const a = this.assets.get(id);
    if (!a) return;
    const buffer = a.buffer;
    const spp = Math.max(1, Math.ceil(buffer.sampleRate / zoom));
    const len = Math.ceil(buffer.duration * zoom);
    const peaks = new Float32Array(Math.max(2, len * 2));
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      let min = 1;
      let max = -1;
      const s = Math.floor(i * spp);
      const e = Math.min(s + spp, data.length);
      for (let j = s; j < e; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[i * 2] = min;
      peaks[i * 2 + 1] = max;
    }
    a.peaks = peaks;
  }

  removeUnused(usedIds: Set<string>) {
    for (const id of [...this.assets.keys()]) {
      if (!usedIds.has(id)) this.assets.delete(id);
    }
  }
}
