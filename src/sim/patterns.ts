import type { PatternId } from '../core/params';
import { PHYS } from '../core/params';

/**
 * Mask layouts. Coordinates are in half-pitch units: the tile is FIELD_HP × FIELD_HP hp.
 * A layout is a predicate `chrome(u, v)` — true where the mask is opaque chrome.
 * Transmission T = 1 − chrome.
 */

export interface MeasureSite {
  /** Centre of the measured feature, hp units. */
  cx: number;
  cy: number;
  /** Which mask region the feature comes from. */
  polarity: 'chrome' | 'clear';
  /** Designed width, hp units. */
  width: number;
}

export interface Layout {
  id: PatternId;
  chrome: (u: number, v: number) => boolean;
  /** Measurement site used for positive / negative tone. */
  site: { positive: MeasureSite; negative: MeasureSite };
  /** Dominant pitch (hp units) — drives the diffraction-order picture. */
  pitch: number;
  /** Two-dimensional diffraction (contacts) shows ±x and ±y orders. */
  twoD: boolean;
  /** Ladder bands: [v0, v1, width] for per-band resolution read-out. */
  bands?: { v0: number; v1: number; w: number }[];
  /** Line index parity for pattern collapse lean direction. */
  lean: (u: number, v: number) => number;
}

const F = PHYS.FIELD_HP;

function frac(x: number) {
  return x - Math.floor(x);
}

const LOGIC_ROWS = [
  '................',
  '.#############..',
  '................',
  '.#.#.#.#....###.',
  '.#.#.#.#....###.',
  '.#.#.#.#....###.',
  '.#.#.#.#........',
  '.#.#.#.#..#####.',
  '.#.#.#.#..#.....',
  '.#.#.#.#..#.....',
  '.#...#.#..#.###.',
  '.#...#.#..#..#..',
  '.#####.#.....#..',
  '.......#.....#..',
  '..######.....#..',
  '................',
];

const LADDER_W = [1.6, 1.3, 1.0, 0.8, 0.65];
const LADDER_BANDS = LADDER_W.map((w, k) => ({ v0: 0.35 + k * 3.2, v1: 0.35 + k * 3.2 + 2.55, w }));

function ladderChrome(u: number, v: number) {
  for (const b of LADDER_BANDS) {
    if (v >= b.v0 && v < b.v1) {
      if (u < 0.5 || u > F - 0.5) return false;
      const x = (u - 0.5) / (2 * b.w);
      return frac(x) < 0.5;
    }
  }
  return false;
}

export const LAYOUTS: Record<PatternId, Layout> = {
  lines: {
    id: 'lines',
    chrome: (u) => {
      const x = frac(u / 2);
      return x >= 0.25 && x < 0.75;
    },
    site: {
      positive: { cx: 9, cy: 8, polarity: 'chrome', width: 1 },
      negative: { cx: 8, cy: 8, polarity: 'clear', width: 1 },
    },
    pitch: 2,
    twoD: false,
    lean: (u) => (Math.floor((u - 0.5) / 2) % 2 === 0 ? 1 : -1),
  },
  contacts: {
    id: 'contacts',
    chrome: (u, v) => {
      const x = frac(u / 2);
      const y = frac(v / 2);
      return !(x >= 0.25 && x < 0.75 && y >= 0.25 && y < 0.75);
    },
    site: {
      positive: { cx: 9, cy: 9, polarity: 'clear', width: 1 },
      negative: { cx: 9, cy: 9, polarity: 'clear', width: 1 },
    },
    pitch: 2,
    twoD: true,
    lean: (u, v) => ((Math.floor(u / 2) + Math.floor(v / 2)) % 2 === 0 ? 1 : -1),
  },
  logic: {
    id: 'logic',
    chrome: (u, v) => {
      const r = Math.floor(v);
      const c = Math.floor(u);
      if (r < 0 || r >= 16 || c < 0 || c >= 16) return false;
      return LOGIC_ROWS[r][c] === '#';
    },
    site: {
      positive: { cx: 3.5, cy: 6.5, polarity: 'chrome', width: 1 },
      negative: { cx: 4.5, cy: 6.5, polarity: 'clear', width: 1 },
    },
    pitch: 2,
    twoD: false,
    lean: (u) => (Math.floor(u / 2) % 2 === 0 ? 1 : -1),
  },
  ladder: {
    id: 'ladder',
    chrome: ladderChrome,
    site: (() => {
      const b = LADDER_BANDS[2];
      const cy = (b.v0 + b.v1) / 2;
      // line centres: 0.5 + w/2 + 2w·i  → pick the one nearest the middle
      const i = Math.round((8 - 0.5 - b.w / 2) / (2 * b.w));
      const cx = 0.5 + b.w / 2 + 2 * b.w * i;
      return {
        positive: { cx, cy, polarity: 'chrome' as const, width: b.w },
        negative: { cx: cx + b.w, cy, polarity: 'clear' as const, width: b.w },
      };
    })(),
    pitch: 2,
    twoD: false,
    bands: LADDER_BANDS,
    lean: (u, v) => {
      for (const b of LADDER_BANDS) if (v >= b.v0 && v < b.v1) return Math.floor((u - 0.5) / (4 * b.w)) % 2 === 0 ? 1 : -1;
      return 0;
    },
  },
};

const maskCache = new Map<string, { mask: Float32Array; lean: Float32Array }>();

/** Rasterise a layout to an N×N transmission map with 3×3 supersampling. */
export function rasterMask(id: PatternId, N: number) {
  const key = `${id}:${N}`;
  const hit = maskCache.get(key);
  if (hit) return hit;
  const L = LAYOUTS[id];
  const mask = new Float32Array(N * N);
  const lean = new Float32Array(N * N);
  const s = F / N;
  const offs = [-1 / 3, 0, 1 / 3];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (const oy of offs)
        for (const ox of offs) {
          const u = (x + 0.5 + ox) * s;
          const v = (y + 0.5 + oy) * s;
          if (!L.chrome(u, v)) acc++;
        }
      mask[y * N + x] = acc / 9;
      lean[y * N + x] = L.lean((x + 0.5) * s, (y + 0.5) * s);
    }
  }
  const out = { mask, lean };
  maskCache.set(key, out);
  return out;
}
