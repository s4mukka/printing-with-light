import {
  type Params,
  type SourceSpec,
  SOURCES,
  PHYS,
  clamp,
  sigmaOptical,
  sigmaDefocus,
  noiseAmplitude,
  fieldNm,
  depthOfFocus,
  RANGES,
} from '../core/params';
import { LAYOUTS, rasterMask, type MeasureSite } from './patterns';
import { gaussBlur, shiftPeriodic, hash2, mulberry32 } from './blur';

/**
 * Lithography simulation — simplified but physically structured:
 *
 *  mask ──shift(overlay)──▶ ⊗ PSF(λ, NA, defocus(z), PEB) ──▶ I(x, y, z) · absorption(z)
 *       ──× dose × shot-noise──▶ exposure E ──development-rate R(E)──▶ resist relief
 *       ──plasma etch (selectivity)──▶ film relief ──strip──▶ final pattern
 */

export const N = 256;
export const K = 4; // depth slices through the resist
export const NZ = 48; // cross-section depth resolution

export interface Optics {
  key: string;
  field: number;
  px: number;
  t: number;
  src: SourceSpec;
  depths: number[];
  slices: Float32Array[];
  topPre: Float32Array;
  aerial: Float32Array;
  mask: Float32Array;
  maskShifted: Float32Array;
  lean: Float32Array;
  noise: Float32Array;
  sigmaBest: number;
  sigmaMid: number;
  shiftPx: [number, number];
}

export interface Risk {
  id: 'resolution' | 'dose' | 'focus' | 'overlay' | 'collapse' | 'etch' | 'stochastic';
  level: number; // 0 ok … 1 fail
  /** i18n key of the explanation (`rn.*`) and its placeholders. */
  note: string;
  vars?: Record<string, string | number>;
}

export interface Metrics {
  cd: number;
  cdTarget: number;
  cdErr: number; // fraction
  featureKind: 'line' | 'space' | 'hole' | 'pillar';
  ler: number;
  overlay: number;
  overlaySpec: number;
  doseToSize: number;
  contrast: number;
  aspect: number;
  collapse: number;
  punch: number;
  scum: number;
  underEtch: number;
  overEtch: number;
  errorFrac: number;
  /** Image modulation too low to form a pattern at all. */
  unresolved: boolean;
  missing: boolean;
  bridged: boolean;
  dofBand: number;
  risks: Risk[];
  bands?: { w: number; nm: number; ok: boolean; err: number }[];
  /** Positions (nm, along x of the tile) of the measured edges at the site row, for the caliper. */
  edges: [number, number] | null;
  siteRow: number; // pixel row
  /** Aerial-image intensity at the designed edges, and the print threshold on the aerial image at the current dose. */
  edgeI: number;
  thr: number;
}

export interface ProcessWindow {
  doses: number[];
  focuses: number[];
  err: Float32Array; // signed CD error fraction, NaN when the feature does not print; [f * nd + d]
  version: number;
}

export interface WaferMap {
  cols: number;
  rows: number;
  dies: { i: number; j: number; x: number; y: number; pass: boolean; reason: string; exposure: number }[];
  yield: number;
}

export interface FieldSet {
  /** Resist height after development (nm). */
  resist: Float32Array;
  /** Surface height of film/silicon relative to silicon top (nm). */
  surface: Float32Array;
  /** Resist that survives etch (nm). */
  resistAfterEtch: Float32Array;
}

// ───────────────────────── development-rate model ─────────────────────────

const R_MAX = 22; // nm/s
const R_MIN = 0.06; // nm/s (dark erosion)
const E0 = 0.835; // rate midpoint — calibrated so dose-to-size ≈ 30 mJ/cm² at the nominal process
/** Negative resists cross-link at lower exposure; calibrated to the same dose-to-size. */
const E0N = 0.285;
function rate(E: number, positive: boolean) {
  const x = Math.max(E, 0) / (positive ? E0 : E0N);
  const x2 = x * x;
  const x6 = x2 * x2 * x2;
  const f = x6 / (1 + x6);
  return positive ? R_MAX * f + R_MIN : R_MAX * (1 - f) + R_MIN;
}

// ───────────────────────── noise ─────────────────────────

const noiseCache = new Map<string, Float32Array>();
function noiseField(corrPx: number) {
  const key = `${N}:${Math.round(corrPx * 20)}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const rnd = mulberry32(7);
  const raw = new Float32Array(N * N);
  for (let i = 0; i < raw.length; i++) {
    // Box–Muller
    const u = Math.max(rnd(), 1e-9);
    const v = rnd();
    raw[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const out = new Float32Array(N * N);
  gaussBlur(raw, out, N, corrPx);
  let s2 = 0;
  for (let i = 0; i < out.length; i++) s2 += out[i] * out[i];
  const inv = 1 / Math.sqrt(s2 / out.length);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  noiseCache.set(key, out);
  return out;
}

// ───────────────────────── optics ─────────────────────────

function opticsKey(p: Params) {
  return [p.source, p.focus, p.alignX, p.alignY, p.pattern, p.halfPitch, p.thickness].join('|');
}

export function computeOptics(p: Params, prev?: Optics): Optics {
  const src = SOURCES[p.source];
  const field = fieldNm(p);
  const px = field / N;
  const t = p.thickness;
  const { mask, lean } = rasterMask(p.pattern, N);
  const sx = p.alignX / px;
  const sy = p.alignY / px;
  const maskShifted = prev && prev.maskShifted.length === N * N ? prev.maskShifted : new Float32Array(N * N);
  shiftPeriodic(mask, maskShifted, N, sx, sy);

  const sOpt = sigmaOptical(src);
  const sPeb = PHYS.PEB_SIGMA;
  const depths: number[] = [];
  const slices: Float32Array[] = [];
  for (let k = 0; k < K; k++) {
    const z = (t * k) / (K - 1);
    depths.push(z);
    const dz = p.focus + (z - t / 2);
    const s = Math.sqrt(sOpt * sOpt + sigmaDefocus(src, dz) ** 2 + sPeb * sPeb) / px;
    const buf = prev?.slices[k] ?? new Float32Array(N * N);
    gaussBlur(maskShifted, buf, N, s);
    const A = Math.exp(-src.alpha * z);
    for (let i = 0; i < buf.length; i++) buf[i] *= A;
    slices.push(buf);
  }
  const topPre = prev?.topPre ?? new Float32Array(N * N);
  gaussBlur(maskShifted, topPre, N, Math.sqrt(sOpt * sOpt + sigmaDefocus(src, p.focus - t / 2) ** 2) / px);
  const aerial = prev?.aerial ?? new Float32Array(N * N);
  const sigmaMid = Math.sqrt(sOpt * sOpt + sigmaDefocus(src, p.focus) ** 2);
  gaussBlur(maskShifted, aerial, N, sigmaMid / px);

  // resist noise is spatially correlated over ~8 nm (acid diffusion smooths shot noise)
  const corr = Math.max(1.1, 8 / px);
  return {
    key: opticsKey(p),
    field,
    px,
    t,
    src,
    depths,
    slices,
    topPre,
    aerial,
    mask,
    maskShifted,
    lean,
    noise: noiseField(corr),
    sigmaBest: Math.sqrt(sOpt * sOpt + sPeb * sPeb),
    sigmaMid,
    shiftPx: [sx, sy],
  };
}

// ───────────────────────── development (column model) ─────────────────────────

const SUB = 12;
// interpolation of the K depth slices at each development sub-step (constant for all pixels)
const SUB_K = new Int32Array(SUB);
const SUB_W = new Float32Array(SUB);
for (let s = 0; s < SUB; s++) {
  const f = ((s + 0.5) / SUB) * (K - 1);
  const k = Math.min(K - 2, Math.floor(f));
  SUB_K[s] = k;
  SUB_W[s] = f - k;
}

/** Remaining resist thickness after `time` seconds of development for one column. */
function developColumn(Es: number[], t: number, time: number, positive: boolean) {
  // Es: exposure at the K slice depths
  const dz = t / SUB;
  let z = 0;
  let clock = 0;
  for (let s = 0; s < SUB; s++) {
    const k = SUB_K[s];
    const w = SUB_W[s];
    const E = Es[k] * (1 - w) + Es[k + 1] * w;
    const R = rate(E, positive);
    const dt = dz / R;
    if (clock + dt >= time) {
      z += (time - clock) * R;
      return Math.max(0, t - z);
    }
    clock += dt;
    z += dz;
  }
  return 0;
}


export function develop(o: Optics, p: Params, progress: number, out: Float32Array) {
  const D = p.dose / PHYS.D_REF;
  const a = noiseAmplitude(o.src, p.dose);
  const positive = p.tone === 'positive';
  const time = p.devTime * clamp(progress, 0, 1);
  const t = o.t;
  if (time <= 0) {
    out.fill(t);
    return out;
  }
  const n = o.noise;
  const [S0, S1, S2, S3] = o.slices;
  const dz = t / SUB;
  const inv = 1 / (positive ? E0 : E0N);
  for (let i = 0; i < N * N; i++) {
    const g = D * (1 + a * n[i]);
    const e0 = S0[i] * g;
    const e1 = S1[i] * g;
    const e2 = S2[i] * g;
    const e3 = S3[i] * g;
    let z = 0;
    let clock = 0;
    let h = 0;
    for (let s = 0; s < SUB; s++) {
      const k = SUB_K[s];
      const w = SUB_W[s];
      const E = k === 0 ? e0 + (e1 - e0) * w : k === 1 ? e1 + (e2 - e1) * w : e2 + (e3 - e2) * w;
      const x = E > 0 ? E * inv : 0;
      const x2 = x * x;
      const x6 = x2 * x2 * x2;
      const f = x6 / (1 + x6);
      const R = positive ? R_MAX * f + R_MIN : R_MAX * (1 - f) + R_MIN;
      const dt = dz / R;
      if (clock + dt >= time) {
        z += (time - clock) * R;
        h = t - z;
        if (h < 0) h = 0;
        break;
      }
      clock += dt;
      z += dz;
    }
    out[i] = h;
  }
  return out;
}

/** Lookup of remaining thickness vs. top-of-resist exposure for a depth-uniform image (absorption only). */
function columnLUT(src: SourceSpec, t: number, time: number, positive: boolean, Emax: number, n = 1024) {
  const lut = new Float32Array(n);
  const A = [0, 1, 2, 3].map((k) => Math.exp(-src.alpha * ((t * k) / (K - 1))));
  const c = [0, 0, 0, 0];
  for (let j = 0; j < n; j++) {
    const e = (j / (n - 1)) * Emax;
    c[0] = e * A[0];
    c[1] = e * A[1];
    c[2] = e * A[2];
    c[3] = e * A[3];
    lut[j] = developColumn(c, t, time, positive);
  }
  return lut;
}

export function etch(resist: Float32Array, depth: number, surface: Float32Array, resistAfter: Float32Array) {
  const Sel = PHYS.SELECTIVITY;
  const F = PHYS.FILM;
  const erode = depth / Sel;
  for (let i = 0; i < resist.length; i++) {
    const h = resist[i];
    const etched = Math.max(0, depth - h * Sel);
    surface[i] = F - etched;
    resistAfter[i] = Math.max(0, h - erode);
  }
}

// ───────────────────────── cross-section (2D development front) ─────────────────────────

class MinHeap {
  keys: Float64Array;
  ids: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(cap);
    this.ids = new Int32Array(cap);
  }
  push(k: number, id: number) {
    let i = this.size++;
    if (i >= this.keys.length) {
      const nk = new Float64Array(this.keys.length * 2);
      nk.set(this.keys);
      this.keys = nk;
      const ni = new Int32Array(this.ids.length * 2);
      ni.set(this.ids);
      this.ids = ni;
    }
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p];
      this.ids[i] = this.ids[p];
      i = p;
    }
    this.keys[i] = k;
    this.ids[i] = id;
  }
  pop(): number {
    const top = this.ids[0];
    const k = this.keys[--this.size];
    const id = this.ids[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c];
      this.ids[i] = this.ids[c];
      i = c;
    }
    this.keys[i] = k;
    this.ids[i] = id;
    return top;
  }
  topKey() {
    return this.keys[0];
  }
}

export interface Section {
  row: number;
  /** RGBA float, N × NZ: R = dissolution arrival time / devTime, G = latent (pre-PEB), B = acid (post-PEB), A = design target. */
  data: Float32Array;
}

export function computeSection(o: Optics, p: Params, row: number, target: Uint8Array, out?: Float32Array): Section {
  const data = out ?? new Float32Array(N * NZ * 4);
  const src = o.src;
  const t = o.t;
  const D = p.dose / PHYS.D_REF;
  const a = noiseAmplitude(src, p.dose);
  const positive = p.tone === 'positive';
  const Lam = src.lambda / (2 * PHYS.N_RESIST);
  const m0 = src.swDepth;
  const att = Math.exp((-2 * Math.PI * Math.PI * PHYS.PEB_SW * PHYS.PEB_SW) / (Lam * Lam));
  const Eth = 0.5;
  const E = new Float32Array(N * NZ);
  const speed = new Float32Array(N * NZ);
  const r0 = row * N;
  for (let j = 0; j < NZ; j++) {
    const z = ((j + 0.5) / NZ) * t; // depth from top
    const f = (z / t) * (K - 1);
    const k = Math.min(K - 2, Math.floor(f));
    const w = f - k;
    const phase = (4 * Math.PI * PHYS.N_RESIST * (t - z)) / src.lambda;
    // node at the reflective substrate → intensity minimum at the resist foot (classic footing + scallops)
    const swPre = 1 - m0 * Math.cos(phase);
    const swPost = 1 - m0 * att * Math.cos(phase);
    const absz = Math.exp(-src.alpha * z);
    const Sa = o.slices[k];
    const Sb = o.slices[k + 1];
    for (let x = 0; x < N; x++) {
      const I = Sa[r0 + x] * (1 - w) + Sb[r0 + x] * w;
      const g = D * (1 + a * o.noise[r0 + x]);
      const Ipre = o.topPre[r0 + x] * absz;
      const ePost = I * g * swPost;
      E[j * N + x] = ePost;
      speed[j * N + x] = rate(ePost, positive);
      const di = (j * N + x) * 4;
      data[di + 1] = (Ipre * g * swPre) / (2 * Eth);
      data[di + 2] = ePost / (2 * Eth);
      data[di + 3] = target[r0 + x];
    }
  }
  // Dijkstra arrival time of the developer front from the top surface.
  const dx = o.px;
  const dzs = t / NZ;
  const arrival = new Float64Array(N * NZ).fill(Infinity);
  const heap = new MinHeap(N * 8);
  for (let x = 0; x < N; x++) {
    const tt = dzs / 2 / speed[x];
    arrival[x] = tt;
    heap.push(tt, x);
  }
  const done = new Uint8Array(N * NZ);
  const limit = p.devTime * 4;
  const relax = (nid: number, at: number, s0: number, d: number) => {
    if (done[nid]) return;
    const nt = at + (2 * d) / (s0 + speed[nid]);
    if (nt < arrival[nid]) {
      arrival[nid] = nt;
      heap.push(nt, nid);
    }
  };
  while (heap.size > 0) {
    const id = heap.pop();
    if (done[id]) continue;
    done[id] = 1;
    const at = arrival[id];
    if (at > limit) break;
    const x = id % N;
    const j = (id - x) / N;
    const s0 = speed[id];
    relax(j * N + (x === 0 ? N - 1 : x - 1), at, s0, dx);
    relax(j * N + (x === N - 1 ? 0 : x + 1), at, s0, dx);
    if (j + 1 < NZ) relax(id + N, at, s0, dzs);
    if (j > 0) relax(id - N, at, s0, dzs);
  }
  for (let i = 0; i < N * NZ; i++) data[i * 4] = Math.min(arrival[i] / p.devTime, 8);
  return { row, data };
}

// ───────────────────────── metrics ─────────────────────────

function expectedPresent(site: MeasureSite, positive: boolean) {
  return (site.polarity === 'chrome') === positive;
}

interface RowMeasure {
  cd: number;
  left: number;
  right: number;
}

/** Measure the width of the run containing (cx) along row y where (h > half) === want. Sub-pixel edges. */
function measureRow(h: Float32Array, y: number, cxPx: number, half: number, want: boolean, maxSearch: number, f?: Float32Array, fthr = 0): RowMeasure | null {
  const row = ((y % N) + N) % N;
  const at = (x: number) => h[row * N + (((x % N) + N) % N)];
  const ok = (x: number) => at(x) > half === want;
  let c = Math.round(cxPx);
  if (!ok(c)) {
    let found = false;
    for (let d = 1; d <= maxSearch; d++) {
      if (ok(c + d)) {
        c = c + d;
        found = true;
        break;
      }
      if (ok(c - d)) {
        c = c - d;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  let l = c;
  let r = c;
  let steps = 0;
  while (ok(l - 1) && steps < N) {
    l--;
    steps++;
  }
  steps = 0;
  while (ok(r + 1) && steps < N) {
    r++;
    steps++;
  }
  if (r - l >= N - 2) return { cd: N, left: l, right: r };
  // sub-pixel crossing between (l-1, l) and (r, r+1): prefer the continuous exposure field, whose
  // threshold crossing is smooth even when the developed wall is steeper than a pixel
  const fat = (x: number) => (f ? f[row * N + (((x % N) + N) % N)] : 0);
  const il = (x0: number, x1: number) => {
    if (f) {
      const a = fat(x0) - fthr;
      const b = fat(x1) - fthr;
      if (Math.abs(a - b) > 1e-9) {
        const q = a / (a - b);
        if (q >= 0 && q <= 1) return x0 + q * (x1 - x0);
      }
    }
    const a = at(x0) - half;
    const b = at(x1) - half;
    const q = Math.abs(a - b) < 1e-9 ? 0.5 : a / (a - b);
    return x0 + clamp(q, 0, 1) * (x1 - x0);
  };
  const left = il(l - 1, l);
  const right = il(r, r + 1);
  return { cd: right - left, left, right };
}

export function measureCD(h: Float32Array, o: Optics, p: Params, site: MeasureSite, f?: Float32Array, fthr = 0) {
  const positive = p.tone === 'positive';
  const hp = p.halfPitch;
  const toPx = (hpu: number) => (hpu * hp) / o.px;
  const cx = toPx(site.cx) + o.shiftPx[0] - 0.5;
  const cy = toPx(site.cy) + o.shiftPx[1] - 0.5;
  const want = expectedPresent(site, positive);
  const half = o.t / 2;
  const span = Math.max(2, Math.round(toPx(0.3)));
  const rows: RowMeasure[] = [];
  let misses = 0;
  const maxSearch = Math.round(toPx(0.45));
  for (let dy = -span; dy <= span; dy++) {
    const m = measureRow(h, Math.round(cy) + dy, cx, half, want, maxSearch, f, fthr);
    if (m) rows.push(m);
    else misses++;
  }
  if (rows.length === 0 || misses > rows.length) return { cd: 0, ler: 0, edges: null as [number, number] | null, rowPx: Math.round(cy), missing: true, bridged: false };
  const cds = rows.map((r) => r.cd * o.px);
  const cd = cds.reduce((s, v) => s + v, 0) / cds.length;
  const lefts = rows.map((r) => r.left * o.px);
  const ml = lefts.reduce((s, v) => s + v, 0) / lefts.length;
  const sd = Math.sqrt(lefts.reduce((s, v) => s + (v - ml) ** 2, 0) / lefts.length);
  const mid = rows[Math.floor(rows.length / 2)];
  const bridged = cd > site.width * hp * 1.85 || rows.some((r) => r.cd >= N - 2);
  return {
    cd: bridged ? Math.min(cd, o.field) : cd,
    ler: bridged ? 0 : 3 * sd,
    edges: [mid.left * o.px, mid.right * o.px] as [number, number],
    rowPx: Math.round(cy),
    missing: false,
    bridged,
  };
}

export function targetMap(o: Optics, p: Params, out?: Uint8Array) {
  const t = out ?? new Uint8Array(N * N);
  const positive = p.tone === 'positive';
  for (let i = 0; i < N * N; i++) t[i] = (o.mask[i] < 0.5) === positive ? 1 : 0;
  return t;
}

function featureKind(site: MeasureSite, positive: boolean, pattern: string): Metrics['featureKind'] {
  const present = expectedPresent(site, positive);
  if (pattern === 'contacts') return present ? 'pillar' : 'hole';
  return present ? 'line' : 'space';
}

function smooth(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Width of { x : v(x) > thr } (above) or { v(x) < thr } inside a window, with v linearly interpolated
 * between samples — continuous in dose and focus, never fails (bridged → window, missing → 0).
 */
function linearCoverage(v: Float32Array, n: number, row: number, cx: number, halfWin: number, thr: number, above: boolean) {
  const r = (((row % n) + n) % n) * n;
  const a = cx - halfWin;
  const b = cx + halfWin;
  let acc = 0;
  for (let i = Math.floor(a) - 1; i <= Math.ceil(b); i++) {
    const s0 = Math.max(i, a);
    const s1 = Math.min(i + 1, b);
    if (s1 <= s0) continue;
    const v0 = v[r + (((i % n) + n) % n)];
    const v1 = v[r + ((((i + 1) % n) + n) % n)];
    let part: number;
    if (Math.abs(v1 - v0) < 1e-12) part = v0 > thr ? s1 - s0 : 0;
    else {
      const xc = i + (thr - v0) / (v1 - v0);
      part = v1 > v0 ? Math.max(0, s1 - Math.max(s0, xc)) : Math.max(0, Math.min(s1, xc) - s0);
    }
    acc += above ? part : s1 - s0 - part;
  }
  return acc;
}

/** Top-of-resist exposure at which exactly half the resist thickness survives development. */
export function effectiveThreshold(src: SourceSpec, t: number, devTime: number, positive: boolean) {
  const n = 1024;
  const Emax = 4;
  const lut = columnLUT(src, t, devTime, positive, Emax, n);
  for (let j = 1; j < n; j++) {
    const a = lut[j - 1] - t / 2;
    const b = lut[j] - t / 2;
    if (a === 0) return ((j - 1) / (n - 1)) * Emax;
    if (Math.sign(a) !== Math.sign(b)) return ((j - 1 + a / (a - b)) / (n - 1)) * Emax;
  }
  return NaN;
}

/** Exposure dose at which the site CD equals the target (bisection in log-dose). */
function doseToSize(o: Optics, p: Params, site: MeasureSite, Estar: number) {
  if (!Number.isFinite(Estar)) return NaN;
  const hp = p.halfPitch;
  const target = site.width * hp;
  const positive = p.tone === 'positive';
  const cy = Math.round((site.cy * hp) / o.px + o.shiftPx[1] - 0.5);
  const cx = (site.cx * hp) / o.px + o.shiftPx[0] - 0.5;
  const halfWin = (site.width * hp) / o.px;
  const want = expectedPresent(site, positive);
  const above = positive ? !want : want;
  const S0 = o.slices[0];
  const widthAt = (dose: number) => {
    // exposure D·S0 above E*  <=>  S0 above E*/D
    const thr = (Estar * PHYS.D_REF) / dose;
    let acc = 0;
    for (let dy = -1; dy <= 1; dy++) acc += linearCoverage(S0, N, cy + dy, cx, halfWin, thr, above) * o.px;
    return acc / 3;
  };
  let lo = 3;
  let hi = 300;
  let fl = widthAt(lo) - target;
  const fh = widthAt(hi) - target;
  if (Math.sign(fl) === Math.sign(fh) || fl === 0) return NaN;
  for (let it = 0; it < 22; it++) {
    const mid = Math.sqrt(lo * hi);
    const fm = widthAt(mid) - target;
    if (Math.sign(fm) === Math.sign(fl)) {
      lo = mid;
      fl = fm;
    } else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

let contScratch = new Float32Array(0);

export function computeMetrics(o: Optics, p: Params, fs: FieldSet, target: Uint8Array): Metrics {
  const L = LAYOUTS[p.pattern];
  const positive = p.tone === 'positive';
  const site = positive ? L.site.positive : L.site.negative;
  const hp = p.halfPitch;
  const src = o.src;
  const Estar = effectiveThreshold(src, o.t, p.devTime, positive);
  const D = p.dose / PHYS.D_REF;
  const amp = noiseAmplitude(src, p.dose);
  if (contScratch.length !== N * N) contScratch = new Float32Array(N * N);
  const fField = contScratch;
  for (let i = 0; i < N * N; i++) fField[i] = D * o.slices[0][i] * (1 + amp * o.noise[i]);
  // image contrast at best focus for the dominant pitch (MTF of the Gaussian PSF)
  const pitchNm = L.pitch * hp;
  const mtf = Math.exp((-2 * Math.PI * Math.PI * o.sigmaBest * o.sigmaBest) / (pitchNm * pitchNm));
  const contrast = L.twoD ? Math.pow(mtf, 1.5) : mtf;
  // with (almost) no modulation — at the actual focus — there is no feature to measure, only noise
  const sAct2 = o.sigmaMid * o.sigmaMid + PHYS.PEB_SIGMA * PHYS.PEB_SIGMA;
  const mtfAct = Math.exp((-2 * Math.PI * Math.PI * sAct2) / (pitchNm * pitchNm));
  const unresolved = (L.twoD ? Math.pow(mtfAct, 1.5) : mtfAct) < 0.06;
  const m = measureCD(fs.resist, o, p, site, fField, Estar);
  if (unresolved) {
    m.missing = true;
    m.cd = 0;
    m.ler = 0;
    m.edges = null;
  }
  const cdTarget = site.width * hp;
  const cdErr = m.missing ? -1 : (m.cd - cdTarget) / cdTarget;

  // aspect ratio of the narrowest standing resist feature
  let resistWidth: number;
  const present = expectedPresent(site, positive);
  if (m.missing) resistWidth = present ? 1 : 2 * hp;
  else resistWidth = present ? m.cd : Math.max(1, 2 * hp * site.width * 1 - m.cd);
  if (p.pattern === 'contacts' && !present) resistWidth = Math.max(1, 2 * hp - m.cd);
  const aspect = o.t / Math.max(resistWidth, 1);
  const collapse = unresolved ? 0 : smooth(3.0, 4.4, aspect);

  // scum / punch-through / etch budget / error area
  let tgtN = 0;
  let clearN = 0;
  let scumAcc = 0;
  let punchN = 0;
  let errN = 0;
  const half = o.t / 2;
  const d = p.etchDepth;
  const er = Math.max(1, Math.round((0.3 * hp) / o.px));
  const sx = Math.round(o.shiftPx[0]);
  const sy = Math.round(o.shiftPx[1]);
  const tg = (x: number, y: number) => target[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const printed = fs.resist[i] > half ? 1 : 0;
      // compare against the *design* placement (overlay error shows up as error area)
      if (printed !== target[i]) errN++;
      if (target[i]) {
        tgtN++;
        if (fs.resist[i] * PHYS.SELECTIVITY < d && fs.resist[i] > half * 0.5) punchN++;
      }
      // scum: residue deep inside an opening (checked on the overlay-shifted design)
      const xs = x - sx;
      const ys = y - sy;
      if (!tg(xs, ys) && !tg(xs - er, ys) && !tg(xs + er, ys) && !tg(xs, ys - er) && !tg(xs, ys + er)) {
        clearN++;
        scumAcc += fs.resist[i] / o.t;
      }
    }
  const scumMean = clearN ? scumAcc / clearN : 0;
  const scum = smooth(0.03, 0.12, scumMean);
  const punch = tgtN ? punchN / tgtN : 0;
  const underEtch = smooth(0.06, 0.25, (PHYS.FILM - d) / PHYS.FILM);
  const overEtch = smooth(60, 110, d - PHYS.FILM);

  const overlay = Math.hypot(p.alignX, p.alignY);
  const overlaySpec = 0.25 * hp;
  const dts = unresolved ? NaN : doseToSize(o, p, site, Estar);
  const dof = depthOfFocus(src);
  const rowI = ((Math.round((site.cy * hp) / o.px + o.shiftPx[1] - 0.5) % N) + N) % N;
  const sampleRow = (x: number) => {
    const x0 = Math.floor(x);
    const f = x - x0;
    const a = o.aerial[rowI * N + (((x0 % N) + N) % N)];
    const b = o.aerial[rowI * N + ((((x0 + 1) % N) + N) % N)];
    return a * (1 - f) + b * f;
  };
  const exL = ((site.cx - site.width / 2) * hp) / o.px + o.shiftPx[0] - 0.5;
  const exR = ((site.cx + site.width / 2) * hp) / o.px + o.shiftPx[0] - 0.5;
  const edgeI = (sampleRow(exL) + sampleRow(exR)) / 2;
  const thr = Number.isFinite(dts) ? (edgeI * dts) / p.dose : edgeI;

  const risks: Risk[] = [];
  // unresolved with good best-focus contrast means the blur comes from defocus, not from λ/NA
  const blurFromFocus = unresolved && contrast >= 0.12;
  const resLevel = unresolved && !blurFromFocus ? 1 : smooth(0.4, 0.12, contrast);
  risks.push({
    id: 'resolution',
    level: resLevel,
    note: resLevel > 0.66 ? 'rn.res.bad' : resLevel > 0.33 ? 'rn.res.low' : 'rn.res.ok',
  });
  const doseDev = Number.isFinite(dts) ? p.dose / dts - 1 : 0;
  const failPrint = !unresolved && (m.missing || m.bridged);
  const doseLevel = unresolved ? 0 : Math.max(Number.isFinite(dts) ? smooth(0.06, 0.22, Math.abs(doseDev)) : 0, failPrint ? 1 : 0);
  risks.push({
    id: 'dose',
    level: Math.max(doseLevel, scum),
    note: scum > 0.5 ? 'rn.dose.scum' : doseLevel < 0.33 ? 'rn.dose.ok' : doseDev < 0 ? 'rn.dose.under' : 'rn.dose.over',
  });
  const focusLevel = Math.max(smooth(0.8, 1.9, Math.abs(p.focus) / dof), blurFromFocus ? 1 : 0);
  risks.push({
    id: 'focus',
    level: focusLevel,
    note: focusLevel < 0.33 ? 'rn.focus.ok' : 'rn.focus.bad',
  });
  const ovLevel = smooth(0.6, 1.6, overlay / overlaySpec);
  risks.push({
    id: 'overlay',
    level: ovLevel,
    note: ovLevel < 0.33 ? 'rn.ov.ok' : 'rn.ov.bad',
  });
  risks.push({
    id: 'collapse',
    level: collapse,
    note: collapse < 0.33 ? 'rn.col.ok' : 'rn.col.bad',
    vars: { ar: aspect },
  });
  const etchLevel = Math.max(smooth(0.01, 0.12, punch), underEtch, overEtch * 0.6);
  risks.push({
    id: 'etch',
    level: etchLevel,
    note: punch > 0.02 ? 'rn.etch.punch' : underEtch > 0.3 ? 'rn.etch.under' : overEtch > 0.3 ? 'rn.etch.over' : 'rn.etch.ok',
  });
  const lerRel = m.missing ? 0 : m.ler / Math.max(cdTarget, 1);
  const stoch = smooth(0.12, 0.3, lerRel);
  risks.push({
    id: 'stochastic',
    level: stoch,
    note: stoch < 0.33 ? 'rn.noise.ok' : 'rn.noise.bad',
  });

  let bands: Metrics['bands'];
  if (L.bands) {
    bands = L.bands.map((b) => {
      const y0 = Math.floor((b.v0 * hp) / o.px);
      const y1 = Math.floor((b.v1 * hp) / o.px);
      let e = 0;
      let n = 0;
      for (let y = y0 + 2; y < y1 - 2; y++)
        for (let x = 0; x < N; x++) {
          const i = y * N + x;
          const pr = fs.resist[i] > half ? 1 : 0;
          if (pr !== target[i]) e++;
          n++;
        }
      const err = n ? e / n : 0;
      return { w: b.w, nm: b.w * hp, ok: err < 0.22, err };
    });
  }

  return {
    cd: m.cd,
    cdTarget,
    cdErr,
    featureKind: featureKind(site, positive, p.pattern),
    ler: m.ler,
    overlay,
    overlaySpec,
    doseToSize: dts,
    contrast,
    aspect,
    collapse,
    punch,
    scum,
    underEtch,
    overEtch,
    errorFrac: errN / (N * N),
    unresolved,
    missing: m.missing,
    bridged: m.bridged,
    dofBand: dof,
    risks,
    bands,
    edges: m.edges,
    siteRow: m.rowPx,
    edgeI,
    thr,
  };
}

// ───────────────────────── process window ─────────────────────────

const PW_N = 128;
const PW_ND = 36;
const PW_NF = 29;

export function computeProcessWindow(p: Params, version: number): ProcessWindow {
  const src = SOURCES[p.source];
  const L = LAYOUTS[p.pattern];
  const positive = p.tone === 'positive';
  const site = positive ? L.site.positive : L.site.negative;
  const hp = p.halfPitch;
  const field = fieldNm(p);
  const px = field / PW_N;
  const t = p.thickness;
  const { mask } = rasterMask(p.pattern, N);
  // down-sample the mask (no overlay shift: CD is shift-invariant)
  const f = N / PW_N;
  const m = new Float32Array(PW_N * PW_N);
  for (let y = 0; y < PW_N; y++)
    for (let x = 0; x < PW_N; x++) {
      let acc = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) acc += mask[(y * f + j) * N + x * f + i];
      m[y * PW_N + x] = acc / (f * f);
    }
  const doses: number[] = [];
  const focuses: number[] = [];
  // dose axis centred on the best-focus dose-to-size (estimated below), so the window is legible
  const dtsGuess = pwDoseToSize(p, m, site, px);
  const dLo = Number.isFinite(dtsGuess) ? Math.max(RANGES.dose.min * 0.5, dtsGuess * 0.6) : RANGES.dose.min;
  const dHi = Number.isFinite(dtsGuess) ? Math.min(RANGES.dose.max * 1.6, dtsGuess * 1.5) : RANGES.dose.max;
  for (let d = 0; d < PW_ND; d++) doses.push(dLo + ((dHi - dLo) * d) / (PW_ND - 1));
  for (let q = 0; q < PW_NF; q++) focuses.push(RANGES.focus.min + ((RANGES.focus.max - RANGES.focus.min) * q) / (PW_NF - 1));
  const err = new Float32Array(PW_ND * PW_NF);
  const sOpt = sigmaOptical(src);
  const target = site.width * hp;
  const cy = Math.round((site.cy * hp) / px - 0.5);
  const cx = (site.cx * hp) / px - 0.5;
  const halfWin = (site.width * hp) / px;
  const want = expectedPresent(site, positive);
  const img = new Float32Array(PW_N * PW_N);
  const Estar = effectiveThreshold(src, t, p.devTime, positive);
  const above = positive ? !want : want;
  for (let q = 0; q < PW_NF; q++) {
    const fz = focuses[q];
    const sDef2 = (PHYS.K_DEF * src.NA) ** 2 * (fz * fz + (t * t) / 12);
    const s = Math.sqrt(sOpt * sOpt + sDef2 + PHYS.PEB_SIGMA ** 2) / px;
    gaussBlur(m, img, PW_N, s);
    for (let d = 0; d < PW_ND; d++) {
      const thr = (Estar * PHYS.D_REF) / doses[d];
      let w = 0;
      for (let r = -1; r <= 1; r++) w += linearCoverage(img, PW_N, cy + r, cx, halfWin, thr, above);
      w = (w / 3) * px;
      const e = !Number.isFinite(Estar) || w < target * 0.25 || w > target * 1.9 ? NaN : (w - target) / target;
      err[q * PW_ND + d] = e;
    }
  }
  return { doses, focuses, err, version };
}

function pwDoseToSize(p: Params, m: Float32Array, site: MeasureSite, px: number) {
  const src = SOURCES[p.source];
  const hp = p.halfPitch;
  const t = p.thickness;
  const positive = p.tone === 'positive';
  const s = Math.sqrt(sigmaOptical(src) ** 2 + (PHYS.K_DEF * src.NA) ** 2 * ((t * t) / 12) + PHYS.PEB_SIGMA ** 2) / px;
  const img = new Float32Array(PW_N * PW_N);
  gaussBlur(m, img, PW_N, s);
  const Estar = effectiveThreshold(src, t, p.devTime, positive);
  const cy = Math.round((site.cy * hp) / px - 0.5);
  const cx = (site.cx * hp) / px - 0.5;
  const halfWin = (site.width * hp) / px;
  const want = expectedPresent(site, positive);
  const above = positive ? !want : want;
  const target = site.width * hp;
  if (!Number.isFinite(Estar)) return NaN;
  const width = (dose: number) => linearCoverage(img, PW_N, cy, cx, halfWin, (Estar * PHYS.D_REF) / dose, above) * px - target;
  let lo = 2;
  let hi = 300;
  let fl = width(lo);
  if (Math.sign(fl) === Math.sign(width(hi))) return NaN;
  for (let i = 0; i < 20; i++) {
    const mid = Math.sqrt(lo * hi);
    const fm = width(mid);
    if (Math.sign(fm) === Math.sign(fl)) {
      lo = mid;
      fl = fm;
    } else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

export function lookupPW(pw: ProcessWindow, dose: number, focus: number) {
  const nd = pw.doses.length;
  const nf = pw.focuses.length;
  const fd = clamp(((dose - pw.doses[0]) / (pw.doses[nd - 1] - pw.doses[0])) * (nd - 1), 0, nd - 1.001);
  const ff = clamp(((focus - pw.focuses[0]) / (pw.focuses[nf - 1] - pw.focuses[0])) * (nf - 1), 0, nf - 1.001);
  const d0 = Math.floor(fd);
  const f0 = Math.floor(ff);
  const wd = fd - d0;
  const wf = ff - f0;
  const g = (q: number, d: number) => pw.err[q * nd + d];
  const vals = [g(f0, d0), g(f0, d0 + 1), g(f0 + 1, d0), g(f0 + 1, d0 + 1)];
  if (vals.some((v) => Number.isNaN(v))) {
    // nearest
    const v = g(Math.round(ff), Math.round(fd));
    return v;
  }
  return (vals[0] * (1 - wd) + vals[1] * wd) * (1 - wf) + (vals[2] * (1 - wd) + vals[3] * wd) * wf;
}

// ───────────────────────── wafer map ─────────────────────────

export const DIE = 0.118; // die pitch in wafer-radius units (wafer radius = 1)
export function waferDies() {
  const dies: { i: number; j: number; x: number; y: number }[] = [];
  const n = Math.ceil(1 / DIE) + 1;
  for (let j = -n; j <= n; j++)
    for (let i = -n; i <= n; i++) {
      const x = (i + 0.5) * DIE;
      const y = (j + 0.5) * DIE;
      // die fully inside the edge-exclusion radius
      const cx = Math.abs(x) + DIE / 2;
      const cy = Math.abs(y) + DIE / 2;
      if (cx * cx + cy * cy <= 0.94 * 0.94) dies.push({ i, j, x, y });
    }
  return dies;
}
const DIES = waferDies();

export function computeWaferMap(p: Params, pw: ProcessWindow, mtr: Metrics): WaferMap {
  const hp = p.halfPitch;
  const dies = DIES.map((d) => {
    const r2 = d.x * d.x + d.y * d.y;
    const n1 = hash2(d.i, d.j, 3) - 0.5;
    const n2 = hash2(d.i, d.j, 11) - 0.5;
    const n3 = hash2(d.i, d.j, 17);
    const dose = p.dose * (1 + 0.035 * (r2 - 0.4) + 0.02 * n1);
    const focus = p.focus + 55 * (r2 - 0.35) + 30 * n2;
    const e = lookupPW(pw, dose, focus);
    const ox = p.alignX + 3.5 * d.x - 2.5 * d.y + 2 * n2;
    const oy = p.alignY + 2.5 * d.x + 3.5 * d.y + 2 * n1;
    const ov = Math.hypot(ox, oy);
    let pass = true;
    let reason = '';
    if (Number.isNaN(e)) {
      pass = false;
      reason = 'not printed';
    } else if (Math.abs(e) > 0.1) {
      pass = false;
      reason = e > 0 ? 'CD too large' : 'CD too small';
    }
    if (pass && ov > mtr.overlaySpec * 1.1) {
      pass = false;
      reason = 'overlay';
    }
    const global = Math.max(mtr.collapse, smooth(0.01, 0.1, mtr.punch), mtr.underEtch, mtr.scum, smooth(0.14, 0.32, mtr.ler / Math.max(mtr.cdTarget, 1)));
    if (pass && n3 < global) {
      pass = false;
      reason = mtr.collapse >= global ? 'collapse' : mtr.scum >= global ? 'scum' : mtr.underEtch >= global ? 'under-etch' : mtr.punch > 0.01 ? 'etch punch-through' : 'stochastic defect';
    }
    if (pass && hash2(d.i, d.j, 29) < 0.025) {
      pass = false;
      reason = 'particle';
    }
    return { ...d, pass, reason, exposure: 0 };
  });
  const passN = dies.filter((d) => d.pass).length;
  void hp;
  return { cols: 0, rows: 0, dies, yield: passN / dies.length };
}

export const ALL_DIES = DIES;
