import * as THREE from 'three';
import { type Params, PHYS, noiseAmplitude } from '../core/params';
import {
  N,
  NZ,
  type Optics,
  type Metrics,
  type ProcessWindow,
  type WaferMap,
  computeOptics,
  develop,
  etch,
  computeMetrics,
  computeSection,
  computeProcessWindow,
  computeWaferMap,
  targetMap,
} from './engine';

export interface ProcessState {
  clean: number;
  coat: number;
  softBake: number;
  exposed: number;
  peb: number;
  developed: number;
  etched: number;
  stripped: number;
}

export function processState(stage: number, progress: number[]): ProcessState {
  const v = (i: number) => (stage > i ? 1 : stage === i ? progress[i] : 0);
  return { clean: v(0), coat: v(1), softBake: v(2), exposed: v(4), peb: v(5), developed: v(6), etched: v(7), stripped: v(8) };
}

function floatTex(data: Float32Array, w: number, h: number) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
function byteTex(data: Uint8Array, w: number, h: number) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const PW_KEYS: (keyof Params)[] = ['source', 'pattern', 'halfPitch', 'thickness', 'tone', 'devTime'];

/**
 * Owns the simulation state and the GPU-facing textures derived from it.
 * Heavy optics only recompute when optical parameters change; development/etch are cheap and
 * re-run per frame while a stage animates.
 */
export class SimController {
  params: Params;
  optics!: Optics;
  target = new Uint8Array(N * N);
  devFinal = new Float32Array(N * N);
  surfFinal = new Float32Array(N * N);
  resistEtchFinal = new Float32Array(N * N);
  metrics!: Metrics;
  pw: ProcessWindow | null = null;
  wafer: WaferMap | null = null;
  version = 0;
  pwVersion = 0;
  private finalVersion = 0;
  private pwTimer: number | null = null;
  private listeners = new Set<() => void>();

  dispResist = new Float32Array(N * N);
  dispSurface = new Float32Array(N * N);
  private tmp = new Float32Array(N * N);
  private latent = new Float32Array(N * N);
  private acid = new Float32Array(N * N);

  fieldData = new Float32Array(N * N * 4);
  auxData = new Float32Array(N * N * 4);
  sectionData = new Float32Array(N * NZ * 4);
  waferData = new Uint8Array(N * N * 4);
  maskData = new Uint8Array(N * N * 4);
  fieldTex: THREE.DataTexture;
  auxTex: THREE.DataTexture;
  sectionTex: THREE.DataTexture;
  waferTex: THREE.DataTexture;
  maskTex: THREE.DataTexture;
  sectionRow = -1;
  private sectionVersion = -1;
  private displayKey = '';
  private auxTone = '';
  private sectionAt = -1e9;

  constructor(p: Params) {
    this.params = { ...p };
    this.fieldTex = floatTex(this.fieldData, N, N);
    this.fieldTex.wrapT = THREE.RepeatWrapping;
    this.auxTex = floatTex(this.auxData, N, N);
    this.auxTex.wrapT = THREE.RepeatWrapping;
    this.sectionTex = floatTex(this.sectionData, N, NZ);
    this.waferTex = byteTex(this.waferData, N, N);
    this.maskTex = byteTex(this.maskData, N, N);
    this.recompute(true);
    this.computePW();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  setParams(p: Params) {
    const prev = this.params;
    let changed = false;
    for (const k of Object.keys(p) as (keyof Params)[]) if (p[k] !== prev[k]) changed = true;
    if (!changed) return;
    const pwDirty = PW_KEYS.some((k) => p[k] !== prev[k]);
    this.params = { ...p };
    this.recompute(false);
    if (pwDirty) this.schedulePW();
    else this.recomputeWafer();
    this.emit();
  }

  private recompute(force: boolean) {
    const p = this.params;
    const key = [p.source, p.focus, p.alignX, p.alignY, p.pattern, p.halfPitch, p.thickness].join('|');
    let auxDirty = false;
    if (force || !this.optics || this.optics.key !== key) {
      const prevPattern = this.optics ? this.optics.mask : null;
      this.optics = computeOptics(p, this.optics);
      if (prevPattern !== this.optics.mask) this.fillMask();
      auxDirty = true;
    }
    if (this.auxTone !== p.tone) auxDirty = true;
    this.auxTone = p.tone;
    targetMap(this.optics, p, this.target);
    develop(this.optics, p, 1, this.devFinal);
    etch(this.devFinal, p.etchDepth, this.surfFinal, this.resistEtchFinal);
    this.metrics = computeMetrics(this.optics, p, { resist: this.devFinal, surface: this.surfFinal, resistAfterEtch: this.resistEtchFinal }, this.target);
    // latent image for display (pre- and post-PEB)
    const D = p.dose / PHYS.D_REF;
    const a = noiseAmplitude(this.optics.src, p.dose);
    const n = this.optics.noise;
    for (let i = 0; i < N * N; i++) {
      const g = D * (1 + a * n[i]);
      this.latent[i] = this.optics.topPre[i] * g;
      this.acid[i] = this.optics.slices[0][i] * g;
    }
    // aux holds dose-independent data (aerial, mask, lean, target) — only re-upload when it changes
    if (auxDirty) this.fillAux();
    this.finalVersion++;
    if (this.pw) this.recomputeWafer();
  }

  private fillMask() {
    const m = this.optics.mask;
    for (let i = 0; i < N * N; i++) {
      const v = Math.round(m[i] * 255);
      this.maskData[i * 4] = v;
      this.maskData[i * 4 + 1] = v;
      this.maskData[i * 4 + 2] = v;
      this.maskData[i * 4 + 3] = 255;
    }
    this.maskTex.needsUpdate = true;
  }

  private fillAux() {
    const o = this.optics;
    const d = this.auxData;
    for (let i = 0; i < N * N; i++) {
      d[i * 4] = o.aerial[i];
      d[i * 4 + 1] = o.maskShifted[i];
      d[i * 4 + 2] = o.lean[i];
      d[i * 4 + 3] = this.target[i];
    }
    this.auxTex.needsUpdate = true;
  }

  private schedulePW() {
    if (this.pwTimer !== null) clearTimeout(this.pwTimer);
    this.pwTimer = window.setTimeout(() => {
      this.pwTimer = null;
      this.computePW();
      this.emit();
    }, 90);
  }
  private computePW() {
    this.pw = computeProcessWindow(this.params, ++this.pwVersion);
    this.recomputeWafer();
  }
  private recomputeWafer() {
    if (!this.pw) return;
    this.wafer = computeWaferMap(this.params, this.pw, this.metrics);
  }

  /** Update display textures for the current process state; cheap when nothing changed. */
  updateDisplay(ps: ProcessState, cut: number) {
    const p = this.params;
    const t = this.optics.t;
    const key = [ps.coat, ps.softBake, ps.developed, ps.etched, ps.stripped, this.finalVersion].map((v) => (typeof v === 'number' ? v.toFixed(4) : v)).join('|');
    if (key !== this.displayKey) {
      this.displayKey = key;
      const R = this.dispResist;
      const S = this.dispSurface;
      if (ps.developed <= 0) {
        const th = t * Math.min(1, ps.coat * 1.25) * (1 + 0.12 * (1 - ps.softBake));
        R.fill(th);
        S.fill(PHYS.FILM);
      } else {
        const dev = ps.developed < 1 ? develop(this.optics, p, ps.developed, this.tmp) : this.devFinal;
        if (ps.etched > 0) {
          etch(dev, p.etchDepth * ps.etched, S, R);
        } else {
          R.set(dev);
          S.fill(PHYS.FILM);
        }
        if (ps.stripped > 0) {
          const k = 1 - ps.stripped;
          for (let i = 0; i < R.length; i++) R[i] *= k;
        }
      }
      const f = this.fieldData;
      const w = this.waferData;
      const tt = Math.max(t, 1);
      for (let i = 0; i < N * N; i++) {
        f[i * 4] = R[i];
        f[i * 4 + 1] = S[i];
        f[i * 4 + 2] = this.latent[i];
        f[i * 4 + 3] = this.acid[i];
        w[i * 4] = Math.round(Math.min(1, R[i] / tt) * 255);
        w[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, S[i] / PHYS.FILM)) * 255);
        w[i * 4 + 2] = Math.round(Math.min(1, this.latent[i] * 0.8) * 255);
        w[i * 4 + 3] = Math.round(Math.min(1, this.optics.aerial[i]) * 255);
      }
      this.fieldTex.needsUpdate = true;
      this.waferTex.needsUpdate = true;
    }
    const row = Math.min(N - 1, Math.max(0, Math.floor(cut * N)));
    const now = performance.now();
    // while a slider is being dragged the section refreshes at ~12 Hz; it catches up as soon as input settles
    if ((row !== this.sectionRow || this.sectionVersion !== this.finalVersion) && now - this.sectionAt > 80) {
      this.sectionAt = now;
      this.sectionRow = row;
      this.sectionVersion = this.finalVersion;
      computeSection(this.optics, p, row, this.target, this.sectionData);
      this.sectionTex.needsUpdate = true;
    }
  }
}
