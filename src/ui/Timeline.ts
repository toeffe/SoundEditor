import type { Clip, TimeSelection, Track } from '../types';
import { clipDuration } from '../types';
import type { Project } from '../project/Project';
import { clipOverlap, interpolateEnvelope } from '../project/Project';
import { envelopeGainToY, envelopeYToGain } from '../audio/Envelope';
import type { AssetLibrary } from '../audio/AssetLibrary';

type DragType =
  | 'move'
  | 'resize-l'
  | 'resize-r'
  | 'fade-in'
  | 'fade-out'
  | 'env-point'
  | 'seek'
  | 'select';

export const RULER_HEIGHT = 28;
/** Minimum / default lane height. */
export const LANE_HEIGHT = 88;
/** Cap so a few tracks fill the window without a giant empty lane. */
export const MAX_LANE_HEIGHT = 200;
/** Fixed height of the "+ Track" strip (clickable, not viewport-filling). */
export const ADD_STRIP_HEIGHT = 48;
export const TRACK_HEADER_WIDTH = 148;

interface ThemeColors {
  bg: string;
  grid: string;
  gridText: string;
  clip: string;
  clipSelected: string;
  clipBorder: string;
  clipBorderSelected: string;
  waveform: string;
  waveformSelected: string;
  playhead: string;
  envelope: string;
}

function readThemeColors(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--canvas-bg', '#0f172a'),
    grid: v('--canvas-grid', '#1e293b'),
    gridText: v('--canvas-grid-text', '#64748b'),
    clip: v('--canvas-clip', '#0b1220'),
    clipSelected: v('--canvas-clip-selected', '#1e293b'),
    clipBorder: v('--canvas-clip-border', '#334155'),
    clipBorderSelected: v('--signal', '#4ade80'),
    waveform: v('--canvas-waveform', '#22c55e'),
    waveformSelected: v('--canvas-waveform-selected', '#4ade80'),
    playhead: v('--canvas-playhead', '#ef4444'),
    envelope: v('--canvas-envelope', '#f59e0b'),
  };
}

export class Timeline {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  container: HTMLElement;
  private spacer: HTMLElement;
  private headersEl: HTMLElement;

  project: Project | null = null;
  library: AssetLibrary | null = null;

  zoom = 100;
  playhead = 0;
  selectedClipId: string | null = null;
  mode: 'normal' | 'envelope' = 'normal';
  showSpectrogram = false;
  selection: TimeSelection | null = null;

  /** Per-track lane height; grows with available viewport (capped). */
  private laneHeight = LANE_HEIGHT;

  private colors: ThemeColors = readThemeColors();
  private scrollLeft = 0;

  private isDragging = false;
  private dragType: DragType = 'seek';
  private dragClipId: string | null = null;
  private dragPointIdx = -1;
  private dragStartX = 0;
  private dragStartTime = 0;
  private dragClipStart = 0;
  private dragSourceStart = 0;
  private dragSourceEnd = 0;
  private dragTrackId = '';
  private historyBegun = false;

  onSeek: ((time: number) => void) | null = null;
  onSelectChange: ((id: string | null) => void) | null = null;
  onProjectChange: (() => void) | null = null;
  onTrackChange: (() => void) | null = null;
  onAddTrack: (() => void) | null = null;
  onRemoveTrack: ((trackId: string) => void) | null = null;
  /** Drop audio files onto a track (or create a new track when createTrack is true). */
  onImportFiles:
    | ((
        files: File[],
        info: { time: number; trackId: string | null; createTrack: boolean }
      ) => void)
    | null = null;
  /** Fired on right-click with screen coords and hit info. */
  onContextMenu:
    | ((info: {
        clientX: number;
        clientY: number;
        time: number;
        clipId: string | null;
        trackId: string | null;
      }) => void)
    | null = null;

  /** Visual drop target while dragging files: track index, or -1 for "new track" strip. */
  private dropTarget: number | null = null;

  get isSeekDragging(): boolean {
    return this.isDragging && this.dragType === 'seek';
  }

  constructor(row: HTMLElement) {
    this.headersEl = document.createElement('div');
    this.headersEl.id = 'track-headers';
    this.headersEl.className = 'track-headers';

    const wrapper = document.createElement('div');
    wrapper.id = 'timeline-wrapper';
    wrapper.className = 'timeline-scroll';

    this.spacer = document.createElement('div');
    this.spacer.className = 'timeline-spacer';

    this.container = document.createElement('div');
    this.container.className = 'timeline-viewport';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'timeline-canvas';
    this.container.appendChild(this.canvas);
    this.spacer.appendChild(this.container);
    wrapper.appendChild(this.spacer);

    row.appendChild(this.headersEl);
    row.appendChild(wrapper);

    this.ctx = this.canvas.getContext('2d')!;

    wrapper.addEventListener('scroll', () => {
      this.scrollLeft = wrapper.scrollLeft;
      this.draw();
    });
    window.addEventListener('resize', () => {
      this.resize();
      this.draw();
      this.renderHeaders();
    });

    this.canvas.addEventListener('mousedown', this.onDown);
    this.canvas.addEventListener('contextmenu', this.onContext);
    this.canvas.addEventListener('dragover', this.onDragOver);
    this.canvas.addEventListener('dragleave', this.onDragLeave);
    this.canvas.addEventListener('drop', this.onFileDrop);
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
  }

  private scroller(): HTMLElement {
    return this.spacer.parentElement!;
  }

  setProject(project: Project, library: AssetLibrary) {
    this.project = project;
    this.library = library;
    this.selectedClipId = project.clips[0]?.id ?? null;
    this.selection = null;
    this.refreshPeaks();
    this.resize();
    this.draw();
    this.renderHeaders();
    project.clearListeners();
    project.onChange(() => {
      this.refreshPeaks();
      this.resize();
      this.draw();
      this.renderHeaders();
      this.onProjectChange?.();
    });
  }

  refreshTheme() {
    this.colors = readThemeColors();
    this.draw();
    this.renderHeaders();
  }

  refreshPeaks() {
    if (!this.project || !this.library) return;
    const ids = new Set(this.project.clips.map((c) => c.assetId));
    for (const id of ids) {
      this.library.computePeaks(id, this.zoom);
    }
  }

  setZoom(z: number) {
    this.zoom = Math.max(10, Math.min(2000, z));
    this.refreshPeaks();
    this.resize();
    this.draw();
  }

  setPlayhead(t: number) {
    const max = Math.max(this.project?.duration ?? 0, t);
    this.playhead = Math.max(0, Math.min(max, t));
    this.draw();
  }

  setMode(mode: 'normal' | 'envelope') {
    this.mode = mode;
    this.draw();
  }

  toggleSpectrogram() {
    this.showSpectrogram = !this.showSpectrogram;
    this.draw();
    return this.showSpectrogram;
  }

  /**
   * Normalized shift-drag time selection, or null if none / too small.
   */
  getTimeSelection(): { start: number; end: number } | null {
    if (!this.selection) return null;
    const start = Math.min(this.selection.start, this.selection.end);
    const end = Math.max(this.selection.start, this.selection.end);
    if (end - start < 0.05) return null;
    return { start, end };
  }

  splitAtPlayhead(): string | null {
    return this.splitAt(this.playhead);
  }

  /** Split the clip under `time` (or the selection) at that timeline position. */
  splitAt(time: number): string | null {
    if (!this.project) return null;
    const clip =
      (this.selectedClipId && this.project.clips.find((c) => c.id === this.selectedClipId)) ||
      this.hitClipAt(time, null);
    if (!clip) return null;
    const id = this.project.splitClip(clip.id, time);
    if (id) this.selectedClipId = id;
    this.onSelectChange?.(this.selectedClipId);
    return id;
  }

  deleteSelected() {
    if (!this.project || !this.selectedClipId) return;
    this.project.removeClip(this.selectedClipId);
    this.selectedClipId = null;
    this.onSelectChange?.(null);
  }

  /**
   * Resolve hit at a pointer event for context menus.
   * Returns timeline time and clip under the cursor (if any).
   */
  hitFromEvent(e: MouseEvent): { time: number; clipId: string | null; trackId: string | null } {
    const { mx, my, time } = this.pointer(e);
    void mx;
    const ti = this.trackIndexAtY(my);
    const track = ti >= 0 ? this.project?.tracks[ti] ?? null : null;
    const clip = this.hitClipAt(time, track?.id ?? null);
    return { time, clipId: clip?.id ?? null, trackId: track?.id ?? null };
  }

  private duration(): number {
    return Math.max(this.project?.duration ?? 0, 1);
  }

  private contentHeight(): number {
    const n = this.project?.tracks.length ?? 0;
    const lanes = Math.max(1, n) * this.laneHeight;
    return RULER_HEIGHT + lanes + ADD_STRIP_HEIGHT;
  }

  private contentWidth(): number {
    return Math.ceil(this.duration() * this.zoom) + 80;
  }

  private resize() {
    const wrap = this.scroller();
    const viewW = Math.max(100, wrap.clientWidth);
    const viewH = Math.max(160, wrap.clientHeight || 0);
    const trackCount = Math.max(1, this.project?.tracks.length ?? 0);

    // Stretch lanes into leftover space (capped); keep "+ Track" a fixed strip.
    const roomForLanes = Math.max(LANE_HEIGHT, viewH - RULER_HEIGHT - ADD_STRIP_HEIGHT);
    this.laneHeight = Math.min(
      MAX_LANE_HEIGHT,
      Math.max(LANE_HEIGHT, Math.floor(roomForLanes / trackCount))
    );

    const h = Math.max(this.contentHeight(), viewH);
    const dpr = window.devicePixelRatio || 1;

    this.spacer.style.width = this.contentWidth() + 'px';
    this.spacer.style.height = h + 'px';
    this.container.style.width = viewW + 'px';
    this.container.style.height = h + 'px';

    this.canvas.width = Math.floor(viewW * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = viewW + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private viewWidth(): number {
    return this.canvas.width / (window.devicePixelRatio || 1);
  }

  private trackY(orderIndex: number): number {
    return RULER_HEIGHT + orderIndex * this.laneHeight;
  }

  private trackIndexAtY(y: number): number {
    if (y < RULER_HEIGHT) return -1;
    const n = this.project?.tracks.length ?? 0;
    if (n === 0) return -1;
    const idx = Math.floor((y - RULER_HEIGHT) / this.laneHeight);
    if (idx < 0) return -1;
    if (idx >= n) return -1; // add-strip / below
    return idx;
  }

  /** -1 = new-track strip, >=0 = lane index, null = ruler / invalid */
  private dropTargetAtY(y: number): number | null {
    if (y < RULER_HEIGHT) return null;
    const n = this.project?.tracks.length ?? 0;
    if (n === 0) return -1;
    const idx = Math.floor((y - RULER_HEIGHT) / this.laneHeight);
    if (idx < 0) return null;
    if (idx >= n) return -1;
    return idx;
  }

  draw() {
    const w = this.viewWidth();
    const h = this.contentHeight();
    const ctx = this.ctx;
    const c = this.colors;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.project) {
      ctx.fillStyle = c.gridText;
      ctx.font = '13px sans-serif';
      ctx.fillText('Drop audio to add a track', 16, RULER_HEIGHT + 40);
      return;
    }

    const scroll = this.scrollLeft;
    const t0 = scroll / this.zoom;
    const t1 = (scroll + w) / this.zoom;

    // Ruler
    ctx.fillStyle = withAlpha(c.grid, 0.85);
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.strokeStyle = c.grid;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(w, RULER_HEIGHT - 0.5);
    ctx.stroke();

    ctx.fillStyle = c.gridText;
    ctx.font = '11px sans-serif';
    const step = Math.max(0.25, niceStep(60 / this.zoom));
    const first = Math.floor(t0 / step) * step;
    for (let t = first; t <= t1 + step; t += step) {
      const x = t * this.zoom - scroll;
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (t >= 0) ctx.fillText(fmt(t), x + 4, 16);
    }

    const tracks = this.project.tracks;
    if (tracks.length === 0) {
      const y = RULER_HEIGHT;
      ctx.fillStyle = withAlpha(c.clip, 0.25);
      ctx.fillRect(0, y, w, this.laneHeight);
      ctx.strokeStyle = c.grid;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(4.5, y + 4.5, w - 9, this.laneHeight - 9);
      ctx.setLineDash([]);
      ctx.fillStyle = c.gridText;
      ctx.font = '12px sans-serif';
      ctx.fillText('Drop audio here to create the first track', 16, y + this.laneHeight / 2 + 4);
    } else {
      tracks.forEach((_track, i) => {
        const y = this.trackY(i);
        ctx.fillStyle = i % 2 === 0 ? withAlpha(c.clip, 0.35) : withAlpha(c.bg, 0.5);
        ctx.fillRect(0, y, w, this.laneHeight);
        ctx.strokeStyle = c.grid;
        ctx.strokeRect(0, y + 0.5, w, this.laneHeight - 1);
      });
    }

    for (const clip of this.project.clips) {
      const ti = tracks.findIndex((t) => t.id === clip.trackId);
      if (ti < 0) continue;
      const y = this.trackY(ti);
      this.drawClip(clip, y, this.laneHeight - 4, scroll);
    }

    // Crossfade overlays
    for (let i = 0; i < this.project.clips.length; i++) {
      for (let j = i + 1; j < this.project.clips.length; j++) {
        const a = this.project.clips[i];
        const b = this.project.clips[j];
        const o = clipOverlap(a, b);
        if (!o) continue;
        const ti = tracks.findIndex((t) => t.id === a.trackId);
        if (ti < 0) continue;
        const y = this.trackY(ti);
        const x1 = o.start * this.zoom - scroll;
        const x2 = o.end * this.zoom - scroll;
        ctx.fillStyle = withAlpha(c.envelope, 0.25);
        ctx.fillRect(x1, y + 2, x2 - x1, this.laneHeight - 4);
        ctx.strokeStyle = c.envelope;
        ctx.beginPath();
        ctx.moveTo(x1, y + 2);
        ctx.lineTo(x2, y + this.laneHeight - 2);
        ctx.moveTo(x1, y + this.laneHeight - 2);
        ctx.lineTo(x2, y + 2);
        ctx.stroke();
      }
    }

    // "+ Track" drop strip
    const addY = RULER_HEIGHT + Math.max(1, tracks.length) * this.laneHeight;
    ctx.fillStyle = this.dropTarget === -1 ? withAlpha(c.clipBorderSelected, 0.2) : withAlpha(c.grid, 0.35);
    ctx.fillRect(0, addY, w, ADD_STRIP_HEIGHT);
    ctx.strokeStyle = c.grid;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(4.5, addY + 4.5, w - 9, ADD_STRIP_HEIGHT - 9);
    ctx.setLineDash([]);
    ctx.fillStyle = c.gridText;
    ctx.font = '12px sans-serif';
    ctx.fillText('+ Drop here to add a new track', 14, addY + ADD_STRIP_HEIGHT / 2 + 4);

    // Drop highlight on lane
    if (this.dropTarget !== null && this.dropTarget >= 0) {
      const y = this.trackY(this.dropTarget);
      ctx.fillStyle = withAlpha(c.clipBorderSelected, 0.22);
      ctx.fillRect(0, y, w, this.laneHeight);
      ctx.strokeStyle = c.clipBorderSelected;
      ctx.lineWidth = 2;
      ctx.strokeRect(1, y + 1, w - 2, this.laneHeight - 2);
      ctx.lineWidth = 1;
    } else if (this.dropTarget === -1 && tracks.length === 0) {
      ctx.fillStyle = withAlpha(c.clipBorderSelected, 0.22);
      ctx.fillRect(0, RULER_HEIGHT, w, this.laneHeight);
    }

    if (this.selection) {
      const x1 = this.selection.start * this.zoom - scroll;
      const x2 = this.selection.end * this.zoom - scroll;
      ctx.fillStyle = withAlpha(c.clipBorderSelected, 0.18);
      ctx.fillRect(x1, RULER_HEIGHT, x2 - x1, h - RULER_HEIGHT);
    }

    const px = this.playhead * this.zoom - scroll;
    ctx.strokeStyle = c.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.fillStyle = c.playhead;
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px, 10);
    ctx.closePath();
    ctx.fill();
  }

  private drawClip(clip: Clip, y: number, h: number, scroll: number) {
    const ctx = this.ctx;
    const c = this.colors;
    const x = clip.start * this.zoom - scroll;
    const w = clipDuration(clip) * this.zoom;
    const srcX = clip.sourceStart * this.zoom;
    const selected = clip.id === this.selectedClipId;
    const viewW = this.viewWidth();
    if (x + w < 0 || x > viewW) return;

    ctx.fillStyle = selected ? c.clipSelected : c.clip;
    ctx.strokeStyle = selected ? c.clipBorderSelected : c.clipBorder;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.fillRect(x, y + 2, w, h);
    ctx.strokeRect(x + 0.5, y + 2.5, w - 1, h - 1);

    const asset = this.library?.get(clip.assetId);
    if (this.showSpectrogram && asset?.spectrogram) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 3, w - 2, h - 2);
      ctx.clip();
      const srcDur = clip.sourceEnd - clip.sourceStart;
      const fullW = asset.buffer.duration * this.zoom;
      ctx.globalAlpha = 0.75;
      ctx.drawImage(
        asset.spectrogram,
        (clip.sourceStart / asset.buffer.duration) * asset.spectrogram.width,
        0,
        (srcDur / asset.buffer.duration) * asset.spectrogram.width,
        asset.spectrogram.height,
        x,
        y + 2,
        w,
        h
      );
      ctx.restore();
      void fullW;
    } else if (asset?.peaks) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 3, w - 2, h - 2);
      ctx.clip();
      ctx.fillStyle = selected ? c.waveformSelected : c.waveform;
      const cy = y + 2 + h / 2;
      const amp = h / 2 - 6;
      const rate = clip.rate > 0 ? clip.rate : 1;
      const startIdx = Math.floor(srcX);
      for (let i = 0; i < Math.floor(w); i++) {
        // Map timeline pixel → source peak index
        const srcPx = startIdx + Math.floor(i * rate);
        const idx = srcPx * 2;
        if (idx >= asset.peaks.length - 1) break;
        const min = asset.peaks[idx];
        const max = asset.peaks[idx + 1];
        const y1 = cy + min * amp;
        const y2 = cy + max * amp;
        ctx.fillRect(x + i, y1, 1, Math.max(1, y2 - y1));
      }
      ctx.restore();
    }

    const fadeFill = withAlpha(c.gridText, selected ? 0.28 : 0.18);
    const fadeStroke = withAlpha(c.envelope, selected ? 0.95 : 0.55);
    if (clip.fadeIn > 0) {
      const fw = clip.fadeIn * this.zoom;
      ctx.fillStyle = fadeFill;
      ctx.beginPath();
      ctx.moveTo(x, y + 2 + h);
      ctx.lineTo(x, y + 2);
      ctx.lineTo(x + fw, y + 2 + h);
      ctx.fill();
      ctx.strokeStyle = fadeStroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y + 2 + h);
      ctx.lineTo(x + fw, y + 2);
      ctx.stroke();
    }
    if (clip.fadeOut > 0) {
      const fw = clip.fadeOut * this.zoom;
      ctx.fillStyle = fadeFill;
      ctx.beginPath();
      ctx.moveTo(x + w, y + 2 + h);
      ctx.lineTo(x + w, y + 2);
      ctx.lineTo(x + w - fw, y + 2 + h);
      ctx.fill();
      ctx.strokeStyle = fadeStroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + w, y + 2 + h);
      ctx.lineTo(x + w - fw, y + 2);
      ctx.stroke();
    }

    if (selected) {
      this.drawFadeHandle(ctx, x + clip.fadeIn * this.zoom, y + 2, c);
      this.drawFadeHandle(ctx, x + w - clip.fadeOut * this.zoom, y + 2, c);
    }

    if (this.mode === 'envelope' || selected) {
      const env = [...clip.envelope].sort((a, b) => a.time - b.time);
      ctx.strokeStyle = c.envelope;
      ctx.lineWidth = 2;
      ctx.beginPath();
      env.forEach((pt, i) => {
        const px = x + pt.time * this.zoom;
        const py = y + 2 + envelopeGainToY(pt.gain, h);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      if (this.mode === 'envelope') {
        for (const pt of env) {
          const px = x + pt.time * this.zoom;
          const py = y + 2 + envelopeGainToY(pt.gain, h);
          ctx.fillStyle = c.envelope;
          ctx.fillRect(px - 4, py - 4, 8, 8);
        }
      }
    }

    if (selected) {
      ctx.fillStyle = c.gridText;
      ctx.fillRect(x - 3, y + h / 2 - 10, 6, 20);
      ctx.fillRect(x + w - 3, y + h / 2 - 10, 6, 20);
    }

    if (Math.abs(clip.rate - 1) > 1e-3) {
      ctx.fillStyle = c.gridText;
      ctx.font = '10px sans-serif';
      ctx.fillText(`${clip.rate.toFixed(2)}×`, x + 6, y + 14);
    }
  }

  renderHeaders() {
    if (!this.project) {
      this.headersEl.innerHTML = '';
      return;
    }
    const tracks = this.project.tracks;
    this.headersEl.style.paddingTop = RULER_HEIGHT + 'px';
    this.headersEl.innerHTML = '';

    for (const track of tracks) {
      const row = document.createElement('div');
      row.className = 'track-header' + (this.project.armedTrackId === track.id ? ' armed' : '');
      row.style.height = this.laneHeight + 'px';
      row.dataset.trackId = track.id;

      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        this.onImportFiles?.(files, {
          time: this.playhead,
          trackId: track.id,
          createTrack: false,
        });
      });

      const name = document.createElement('div');
      name.className = 'track-header__name';
      name.textContent = track.name;
      name.title = track.name;

      const btns = document.createElement('div');
      btns.className = 'track-header__btns';

      const mute = document.createElement('button');
      mute.type = 'button';
      mute.textContent = 'M';
      mute.className = 'track-chip' + (track.mute ? ' on' : '');
      mute.title = 'Mute';
      mute.addEventListener('click', (e) => {
        e.stopPropagation();
        this.project?.updateTrack(track.id, { mute: !track.mute });
        this.onTrackChange?.();
      });

      const solo = document.createElement('button');
      solo.type = 'button';
      solo.textContent = 'S';
      solo.className = 'track-chip' + (track.solo ? ' on solo' : '');
      solo.title = 'Solo';
      solo.addEventListener('click', (e) => {
        e.stopPropagation();
        this.project?.updateTrack(track.id, { solo: !track.solo });
        this.onTrackChange?.();
      });

      const arm = document.createElement('button');
      arm.type = 'button';
      arm.textContent = '●';
      arm.className = 'track-chip' + (this.project.armedTrackId === track.id ? ' on arm' : '');
      arm.title = 'Arm for record';
      arm.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.project) return;
        const next = this.project.armedTrackId === track.id ? null : track.id;
        this.project.setArmedTrack(next);
        this.onTrackChange?.();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.className = 'track-chip track-chip--danger';
      remove.title = 'Remove track';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onRemoveTrack?.(track.id);
      });

      btns.append(mute, solo, arm, remove);

      const fader = document.createElement('input');
      fader.type = 'range';
      fader.min = '0';
      fader.max = '200';
      fader.value = String(Math.round(track.gain * 100));
      fader.title = 'Track fader';
      fader.className = 'track-fader';
      fader.addEventListener('pointerdown', () => this.project?.beginEdit());
      fader.addEventListener('input', () => {
        const g = parseInt(fader.value, 10) / 100;
        this.project?.mutateTrack(track.id, { gain: g });
        this.onTrackChange?.();
      });
      fader.addEventListener('change', () => {
        this.onProjectChange?.();
      });

      row.append(name, btns, fader);
      this.headersEl.appendChild(row);
    }

    // Spacer matching empty placeholder lane when no tracks
    if (tracks.length === 0) {
      const spacer = document.createElement('div');
      spacer.className = 'track-header track-header--placeholder';
      spacer.style.height = this.laneHeight + 'px';
      spacer.textContent = 'No tracks';
      this.headersEl.appendChild(spacer);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-track-btn';
    addBtn.style.height = ADD_STRIP_HEIGHT + 'px';
    addBtn.textContent = '+ Track';
    addBtn.title = 'Add empty track';
    addBtn.addEventListener('click', () => this.onAddTrack?.());
    addBtn.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      addBtn.classList.add('drag-over');
    });
    addBtn.addEventListener('dragleave', () => addBtn.classList.remove('drag-over'));
    addBtn.addEventListener('drop', (e) => {
      e.preventDefault();
      addBtn.classList.remove('drag-over');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      this.onImportFiles?.(files, {
        time: this.playhead,
        trackId: null,
        createTrack: true,
      });
    });
    this.headersEl.appendChild(addBtn);
  }

  private onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const rect = this.canvas.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const next = this.dropTargetAtY(my);
    if (next !== this.dropTarget) {
      this.dropTarget = next;
      this.draw();
    }
  };

  private onDragLeave = (e: DragEvent) => {
    // Only clear when leaving the canvas entirely
    const related = e.relatedTarget as Node | null;
    if (related && this.canvas.contains(related)) return;
    if (this.dropTarget !== null) {
      this.dropTarget = null;
      this.draw();
    }
  };

  private onFileDrop = (e: DragEvent) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    const target = this.dropTarget;
    this.dropTarget = null;
    this.draw();
    if (!files.length) return;

    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left + this.scrollLeft;
    const time = Math.max(0, mx / this.zoom);
    const my = e.clientY - rect.top;
    const resolved = target ?? this.dropTargetAtY(my);

    if (resolved === null || resolved === -1) {
      this.onImportFiles?.(files, { time, trackId: null, createTrack: true });
      return;
    }
    const track = this.project?.tracks[resolved];
    this.onImportFiles?.(files, {
      time,
      trackId: track?.id ?? null,
      createTrack: !track,
    });
  };

  private hitClipAt(time: number, trackId: string | null): Clip | null {
    if (!this.project) return null;
    const candidates = this.project.clips.filter((c) => {
      if (trackId && c.trackId !== trackId) return false;
      return time >= c.start && time <= c.start + clipDuration(c);
    });
    return candidates[candidates.length - 1] ?? null;
  }

  private pointer(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mxView = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const mx = mxView + this.scrollLeft;
    return { mx, my, mxView, time: mx / this.zoom };
  }

  private hitTest(
    mx: number,
    my: number,
    time: number,
    altKey: boolean
  ): { type: DragType; clip?: Clip; pointIdx?: number } {
    if (!this.project) return { type: 'seek' };

    // Ruler or playhead or Alt → seek
    if (my < RULER_HEIGHT || Math.abs(mx - this.playhead * this.zoom) < 6 || altKey) {
      return { type: 'seek' };
    }

    const ti = this.trackIndexAtY(my);
    if (ti < 0) return { type: 'seek' };
    const track = this.project.tracks[ti];
    const trackId = track?.id ?? null;
    const laneTop = this.trackY(ti);

    if (this.mode === 'envelope' && trackId) {
      for (const clip of this.project.clips.filter((c) => c.trackId === trackId)) {
        const x = clip.start * this.zoom;
        const env = [...clip.envelope].sort((a, b) => a.time - b.time);
        for (let i = 0; i < env.length; i++) {
          const px = x + env[i].time * this.zoom;
          const py = laneTop + 2 + envelopeGainToY(env[i].gain, this.laneHeight - 4);
          if (Math.abs(mx - px) < 8 && Math.abs(my - py) < 8) {
            return { type: 'env-point', clip, pointIdx: i };
          }
        }
        if (time >= clip.start && time <= clip.start + clipDuration(clip)) {
          const local = time - clip.start;
          const g = interpolateEnvelope(clip.envelope, local, 1);
          const ey = laneTop + 2 + envelopeGainToY(g, this.laneHeight - 4);
          if (Math.abs(my - ey) < 10) {
            return { type: 'env-point', clip, pointIdx: -1 };
          }
        }
      }
    }

    const clip = this.hitClipAt(time, trackId);
    if (!clip) return { type: 'seek' };
    const x = clip.start * this.zoom;
    const w = clipDuration(clip) * this.zoom;
    const localX = mx - x;
    const inFadeBand = my <= laneTop + 28;

    // Fade handles sit on the top edge so they don't steal trim/move hits.
    if (inFadeBand) {
      const fadeInX = x + clip.fadeIn * this.zoom;
      const fadeOutX = x + w - clip.fadeOut * this.zoom;
      if (Math.abs(mx - fadeInX) < 10) return { type: 'fade-in', clip };
      if (Math.abs(mx - fadeOutX) < 10) return { type: 'fade-out', clip };
    }

    if (Math.abs(localX) < 8) return { type: 'resize-l', clip };
    if (Math.abs(localX - w) < 8) return { type: 'resize-r', clip };
    return { type: 'move', clip };
  }

  private drawFadeHandle(
    ctx: CanvasRenderingContext2D,
    hx: number,
    hy: number,
    c: ThemeColors
  ) {
    ctx.fillStyle = c.envelope;
    ctx.strokeStyle = c.bg;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + 5, hy + 8);
    ctx.lineTo(hx - 5, hy + 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private beginHistory() {
    if (!this.historyBegun && this.project) {
      this.project.beginEdit();
      this.historyBegun = true;
    }
  }

  private onContext = (e: MouseEvent) => {
    e.preventDefault();
    if (!this.project) return;
    const hit = this.hitFromEvent(e);
    if (hit.clipId) {
      this.selectedClipId = hit.clipId;
      this.onSelectChange?.(hit.clipId);
    }
    this.setPlayhead(hit.time);
    this.onSeek?.(hit.time);
    this.draw();
    this.onContextMenu?.({
      clientX: e.clientX,
      clientY: e.clientY,
      time: hit.time,
      clipId: hit.clipId,
      trackId: hit.trackId,
    });
  };

  private onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (!this.project) return;
    const { mx, my, time } = this.pointer(e);

    if (e.shiftKey) {
      this.isDragging = true;
      this.dragType = 'select';
      this.selection = { start: time, end: time };
      this.selectedClipId = null;
      this.onSelectChange?.(null);
      this.draw();
      return;
    }

    const hit = this.hitTest(mx, my, time, e.altKey);

    if (hit.type === 'seek') {
      this.isDragging = true;
      this.dragType = 'seek';
      this.setPlayhead(time);
      this.onSeek?.(time);
      return;
    }

    if (hit.type === 'env-point' && hit.clip) {
      this.beginHistory();
      let env = [...hit.clip.envelope].sort((a, b) => a.time - b.time);
      let idx = hit.pointIdx ?? -1;
      if (idx < 0) {
        const local = Math.max(0, Math.min(clipDuration(hit.clip), time - hit.clip.start));
        const gain = interpolateEnvelope(env, local, 1);
        env.push({ time: local, gain });
        env.sort((a, b) => a.time - b.time);
        idx = env.findIndex((p) => Math.abs(p.time - local) < 1e-6);
        this.project.mutateClip(hit.clip.id, { envelope: env });
      }
      this.isDragging = true;
      this.dragType = 'env-point';
      this.dragClipId = hit.clip.id;
      this.dragPointIdx = idx;
      this.selectedClipId = hit.clip.id;
      this.onSelectChange?.(hit.clip.id);
      this.draw();
      return;
    }

    if (
      hit.clip &&
      (hit.type === 'move' ||
        hit.type === 'resize-l' ||
        hit.type === 'resize-r' ||
        hit.type === 'fade-in' ||
        hit.type === 'fade-out')
    ) {
      this.beginHistory();
      this.isDragging = true;
      this.dragType = hit.type;
      this.dragClipId = hit.clip.id;
      this.selectedClipId = hit.clip.id;
      this.onSelectChange?.(hit.clip.id);
      this.dragStartX = mx;
      this.dragStartTime = time;
      this.dragClipStart = hit.clip.start;
      this.dragSourceStart = hit.clip.sourceStart;
      this.dragSourceEnd = hit.clip.sourceEnd;
      this.dragTrackId = hit.clip.trackId;
      this.draw();
      return;
    }
  };

  private onMove = (e: MouseEvent) => {
    if (!this.isDragging) {
      this.updateCursor(e);
      return;
    }
    if (!this.project) return;
    const { mx, my, time } = this.pointer(e);

    if (this.dragType === 'select' && this.selection) {
      this.selection.end = time;
      this.draw();
      return;
    }

    if (this.dragType === 'seek') {
      this.setPlayhead(Math.max(0, time));
      this.onSeek?.(this.playhead);
      return;
    }

    const clip = this.project.clips.find((c) => c.id === this.dragClipId);
    if (!clip) return;

    if (this.dragType === 'move') {
      const dx = time - this.dragStartTime;
      const ti = this.trackIndexAtY(my);
      const track = ti >= 0 ? this.project.tracks[ti] : undefined;
      const patch: Partial<Clip> = { start: Math.max(0, this.dragClipStart + dx) };
      if (track && track.id !== clip.trackId) patch.trackId = track.id;
      this.project.mutateClip(clip.id, patch);
      this.draw();
      return;
    }

    if (this.dragType === 'resize-l') {
      const rate = clip.rate > 0 ? clip.rate : 1;
      const local = time - this.dragClipStart;
      const newSourceStart = Math.max(
        0,
        Math.min(this.dragSourceEnd - 0.05, this.dragSourceStart + local * rate)
      );
      const deltaSource = newSourceStart - this.dragSourceStart;
      this.project.mutateClip(clip.id, {
        start: this.dragClipStart + deltaSource / rate,
        sourceStart: newSourceStart,
      });
      this.draw();
      return;
    }

    if (this.dragType === 'resize-r') {
      const rate = clip.rate > 0 ? clip.rate : 1;
      const asset = this.library?.get(clip.assetId);
      const maxEnd = asset?.buffer.duration ?? this.dragSourceEnd;
      const newEnd = Math.max(
        this.dragSourceStart + 0.05,
        Math.min(maxEnd, this.dragSourceEnd + (time - this.dragStartTime) * rate)
      );
      this.project.mutateClip(clip.id, { sourceEnd: newEnd });
      this.draw();
      return;
    }

    if (this.dragType === 'fade-in') {
      const dur = clipDuration(clip);
      const maxIn = Math.max(0, dur - clip.fadeOut);
      const fadeIn = Math.round(Math.max(0, Math.min(maxIn, time - clip.start)) * 1000) / 1000;
      this.project.mutateClip(clip.id, { fadeIn });
      this.onProjectChange?.();
      this.draw();
      return;
    }

    if (this.dragType === 'fade-out') {
      const dur = clipDuration(clip);
      const maxOut = Math.max(0, dur - clip.fadeIn);
      const fadeOut =
        Math.round(Math.max(0, Math.min(maxOut, clip.start + dur - time)) * 1000) / 1000;
      this.project.mutateClip(clip.id, { fadeOut });
      this.onProjectChange?.();
      this.draw();
      return;
    }

    if (this.dragType === 'env-point') {
      const ti = this.project.tracks.findIndex((t) => t.id === clip.trackId);
      const laneTop = this.trackY(ti);
      const env = [...clip.envelope].sort((a, b) => a.time - b.time);
      const idx = this.dragPointIdx;
      if (idx >= 0 && idx < env.length) {
        const local = Math.max(0, Math.min(clipDuration(clip), time - clip.start));
        env[idx] = {
          time: local,
          gain: envelopeYToGain(my - laneTop - 2, this.laneHeight - 4),
        };
        env.sort((a, b) => a.time - b.time);
        this.dragPointIdx = env.findIndex((p) => Math.abs(p.time - local) < 1e-4);
        if (this.dragPointIdx < 0) this.dragPointIdx = idx;
        this.project.mutateClip(clip.id, { envelope: env });
        this.draw();
      }
    }
  };

  private updateCursor(e: MouseEvent) {
    if (!this.project) {
      this.canvas.style.cursor = 'default';
      return;
    }
    const { mx, my, time } = this.pointer(e);
    const hit = this.hitTest(mx, my, time, e.altKey);
    const cursors: Record<DragType, string> = {
      'fade-in': 'ew-resize',
      'fade-out': 'ew-resize',
      'resize-l': 'ew-resize',
      'resize-r': 'ew-resize',
      move: 'grab',
      'env-point': 'ns-resize',
      seek: 'default',
      select: 'crosshair',
    };
    this.canvas.style.cursor = cursors[hit.type] ?? 'default';
  }

  private onUp = () => {
    if (this.dragType === 'select' && this.selection) {
      if (Math.abs(this.selection.end - this.selection.start) < 0.05) {
        this.selection = null;
      }
    }
    if (this.historyBegun && this.project && this.dragClipId) {
      this.project.commitClip(this.dragClipId);
    }
    if (this.isDragging && this.dragType === 'seek') {
      this.onSeek?.(this.playhead);
    }
    this.isDragging = false;
    this.dragType = 'seek';
    this.dragClipId = null;
    this.dragPointIdx = -1;
    this.historyBegun = false;
  };
}

function niceStep(raw: number): number {
  const powers = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  for (const p of powers) {
    if (p >= raw) return p;
  }
  return Math.ceil(raw);
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const frac = Math.floor((s % 1) * 10);
  if (s < 60 && s !== Math.floor(s)) return `${sec}.${frac}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// silence unused — Track type used by consumers importing from this module
export type { Track };
