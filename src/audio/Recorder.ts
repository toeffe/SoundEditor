/**
 * Capture microphone PCM into an AudioBuffer at the project sample rate.
 */
export class Recorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private recording = false;
  private channels = 1;
  private sampleRate = 44100;

  get isRecording(): boolean {
    return this.recording;
  }

  async start(sampleRate: number): Promise<void> {
    if (this.recording) return;
    this.sampleRate = sampleRate;
    this.chunks = [];

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.ctx = new AudioContext({ sampleRate });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.channels = Math.min(2, this.source.channelCount || 1);
    // ScriptProcessor is deprecated but widely available; size 4096 is fine for capture.
    this.processor = this.ctx.createScriptProcessor(4096, this.channels, this.channels);
    this.processor.onaudioprocess = (e) => {
      if (!this.recording) return;
      const input = e.inputBuffer;
      const copy = new Float32Array(input.length * this.channels);
      for (let ch = 0; ch < this.channels; ch++) {
        const data = input.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          copy[i * this.channels + ch] = data[i];
        }
      }
      this.chunks.push(copy);
    };

    this.source.connect(this.processor);
    // Keep processor alive (silent)
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(this.ctx.destination);
    this.recording = true;
  }

  stop(): AudioBuffer | null {
    this.recording = false;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }

    const ctx = this.ctx;
    this.ctx = null;
    if (!ctx || this.chunks.length === 0) {
      void ctx?.close();
      return null;
    }

    const frameCount = this.chunks.reduce((n, c) => n + c.length / this.channels, 0);
    const buffer = ctx.createBuffer(this.channels, Math.max(1, frameCount), this.sampleRate);
    let offset = 0;
    for (const chunk of this.chunks) {
      const frames = chunk.length / this.channels;
      for (let ch = 0; ch < this.channels; ch++) {
        const dest = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          dest[offset + i] = chunk[i * this.channels + ch];
        }
      }
      offset += frames;
    }
    this.chunks = [];
    void ctx.close();
    return buffer;
  }
}
