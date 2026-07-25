import FFT from 'fft.js';

function heatmap(t: number): { r: number; g: number; b: number } {
  t = Math.max(0, Math.min(1, t));
  if (t < 0.25) {
    const k = t / 0.25;
    return { r: 0, g: 0, b: Math.floor(k * 128) };
  }
  if (t < 0.5) {
    const k = (t - 0.25) / 0.25;
    return { r: 0, g: Math.floor(k * 255), b: 128 + Math.floor(k * 127) };
  }
  if (t < 0.75) {
    const k = (t - 0.5) / 0.25;
    return { r: Math.floor(k * 255), g: 255, b: Math.floor((1 - k) * 255) };
  }
  const k = (t - 0.75) / 0.25;
  return { r: 255, g: Math.floor((1 - k) * 255), b: Math.floor((1 - k) * 128) };
}

export class Analyzer {
  canvas: HTMLCanvasElement | null = null;

  generate(buffer: AudioBuffer, fftSize = 2048): HTMLCanvasElement {
    const data = buffer.getChannelData(0);
    const hop = Math.floor(fftSize / 4);
    const frames = Math.max(1, Math.floor((data.length - fftSize) / hop));
    const fft = new FFT(fftSize);
    const out = fft.createComplexArray();
    const freqs = fftSize / 2;

    const windowFn = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      windowFn[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }

    const canvas = document.createElement('canvas');
    canvas.width = frames;
    canvas.height = freqs;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(frames, freqs);
    const frame = new Float32Array(fftSize);

    for (let i = 0; i < frames; i++) {
      for (let j = 0; j < fftSize; j++) {
        const idx = i * hop + j;
        frame[j] = idx < data.length ? data[idx] * windowFn[j] : 0;
      }
      fft.realTransform(out, frame);

      for (let f = 0; f < freqs; f++) {
        const real = out[f * 2];
        const imag = out[f * 2 + 1];
        const mag = Math.sqrt(real * real + imag * imag);
        const db = 20 * Math.log10(mag + 1e-10);
        const norm = Math.max(0, Math.min(1, (db + 80) / 80));
        const c = heatmap(norm);
        const px = ((freqs - 1 - f) * frames + i) * 4;
        imgData.data[px] = c.r;
        imgData.data[px + 1] = c.g;
        imgData.data[px + 2] = c.b;
        imgData.data[px + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    this.canvas = canvas;
    return canvas;
  }
}

/** @deprecated use Analyzer class */
export function generateSpectrogram(buffer: AudioBuffer, fftSize = 2048, hopSize = 512): ImageData {
  void hopSize;
  const a = new Analyzer();
  const c = a.generate(buffer, fftSize);
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
}
