/** Fixed grid steps (seconds). */
export const GRID_STEPS = [0.1, 0.5, 1.0] as const;
export type GridStep = (typeof GRID_STEPS)[number];

export interface SnapContext {
  gridEnabled: boolean;
  gridStep: number;
  magneticEnabled: boolean;
  /** Max distance in seconds to pull to a magnetic edge. */
  magneticThresholdSec: number;
  /** Clip edge times (absolute) to snap to. */
  magneticCandidates: number[];
}

export function snapToGrid(t: number, step: number, enabled: boolean): number {
  if (!enabled || step <= 0) return Math.max(0, t);
  return Math.max(0, Math.round(t / step) * step);
}

export function snapMagnetic(
  t: number,
  candidates: number[],
  thresholdSec: number
): number | null {
  if (thresholdSec <= 0 || candidates.length === 0) return null;
  let best: number | null = null;
  let bestDist = thresholdSec;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/**
 * When grid is on: always quantize to grid.
 * Magnetic can override if an edge is closer than half a grid step (or threshold).
 */
export function snapTime(t: number, ctx: SnapContext): number {
  const raw = Math.max(0, t);
  const mag = ctx.magneticEnabled
    ? snapMagnetic(raw, ctx.magneticCandidates, ctx.magneticThresholdSec)
    : null;

  if (ctx.gridEnabled) {
    const grid = snapToGrid(raw, ctx.gridStep, true);
    if (mag !== null) {
      const half = ctx.gridStep / 2;
      if (Math.abs(mag - raw) <= half || Math.abs(mag - raw) <= ctx.magneticThresholdSec) {
        if (Math.abs(mag - raw) < Math.abs(grid - raw)) return Math.max(0, mag);
      }
    }
    return grid;
  }

  if (mag !== null) return Math.max(0, mag);
  return raw;
}

export function magneticThresholdFromZoom(zoom: number, thresholdPx = 8): number {
  return thresholdPx / Math.max(1, zoom);
}
