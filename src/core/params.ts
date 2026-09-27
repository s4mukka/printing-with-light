/**
 * Process parameters, light sources and physical constants.
 *
 * All lengths are in nanometres (wafer scale), doses in mJ/cm², times in seconds.
 * The model is deliberately simplified but keeps the real scaling laws:
 *   resolution ∝ λ / NA, depth of focus ∝ λ / NA², photon shot noise ∝ 1/√(dose·λ).
 */

export type SourceId = 'g' | 'i' | 'krf' | 'arf' | 'arfi' | 'euv';
export type PatternId = 'lines' | 'contacts' | 'logic' | 'ladder';
export type Tone = 'positive' | 'negative';

export interface SourceSpec {
  id: SourceId;
  label: string;
  short: string;
  lambda: number; // nm
  NA: number;
  kind: 'lamp' | 'laser' | 'euv';
  /** Display colour for the beam. DUV / EUV are invisible — false colour. */
  color: string;
  visible: boolean;
  /** Resist absorption coefficient (1/nm) — EUV resists absorb strongly. */
  alpha: number;
  /** Standing-wave modulation depth before PEB (substrate reflectivity). */
  swDepth: number;
  immersion: boolean;
}

export const SOURCES: Record<SourceId, SourceSpec> = {
  g: { id: 'g', label: 'g-line', short: '436', lambda: 436, NA: 0.45, kind: 'lamp', color: '#6f7dff', visible: true, alpha: 0.0006, swDepth: 0.34, immersion: false },
  i: { id: 'i', label: 'i-line', short: '365', lambda: 365, NA: 0.62, kind: 'lamp', color: '#9270ff', visible: true, alpha: 0.0008, swDepth: 0.32, immersion: false },
  krf: { id: 'krf', label: 'KrF', short: '248', lambda: 248, NA: 0.8, kind: 'laser', color: '#b36cff', visible: false, alpha: 0.001, swDepth: 0.26, immersion: false },
  arf: { id: 'arf', label: 'ArF', short: '193', lambda: 193, NA: 0.93, kind: 'laser', color: '#cf6dff', visible: false, alpha: 0.0014, swDepth: 0.22, immersion: false },
  arfi: { id: 'arfi', label: 'ArF immersion', short: '193i', lambda: 193, NA: 1.35, kind: 'laser', color: '#e27cf4', visible: false, alpha: 0.0014, swDepth: 0.2, immersion: true },
  euv: { id: 'euv', label: 'EUV', short: '13.5', lambda: 13.5, NA: 0.33, kind: 'euv', color: '#78eaff', visible: false, alpha: 0.0045, swDepth: 0.0, immersion: false },
};

export const SOURCE_ORDER: SourceId[] = ['g', 'i', 'krf', 'arf', 'arfi', 'euv'];

export const PATTERN_ORDER: PatternId[] = ['lines', 'contacts', 'logic', 'ladder'];

export interface Params {
  source: SourceId;
  dose: number; // mJ/cm²
  focus: number; // nm (best-focus offset relative to resist mid-plane)
  alignX: number; // nm
  alignY: number; // nm
  pattern: PatternId;
  halfPitch: number; // nm — target feature size
  thickness: number; // nm — photoresist
  tone: Tone;
  devTime: number; // s
  etchDepth: number; // nm
}

export const NOMINAL: Params = {
  source: 'arfi',
  dose: 30,
  focus: 0,
  alignX: 0,
  alignY: 0,
  pattern: 'lines',
  halfPitch: 80,
  thickness: 110,
  tone: 'positive',
  devTime: 60,
  etchDepth: 130,
};

export const RANGES = {
  dose: { min: 8, max: 70, step: 0.5 },
  focus: { min: -400, max: 400, step: 5 },
  align: { min: -60, max: 60, step: 1 },
  halfPitch: { min: 20, max: 400 },
  thickness: { min: 40, max: 400, step: 5 },
  devTime: { min: 10, max: 120, step: 1 },
  etchDepth: { min: 0, max: 220, step: 1 },
} as const;

/** Physical constants of the simplified model. */
export const PHYS = {
  /** Gaussian approximation of the partially-coherent PSF: σ = K_PSF·λ/NA. */
  K_PSF: 0.23,
  /** Defocus blur: σ_def = K_DEF·NA·|Δz|. Gives DOF ≈ 0.8·λ/NA². */
  K_DEF: 0.2,
  /** Acid diffusion length during post-exposure bake (nm). */
  PEB_SIGMA: 10,
  /** Effective vertical smoothing of standing waves during PEB (diffusion + bottom anti-reflective coating), nm. */
  PEB_SW: 17,
  /** Reference dose: E = (dose/D_REF)·I·absorption. */
  D_REF: 30,
  /** Development threshold at the reference time. */
  E_TH: 0.5,
  DEV_REF: 60,
  DEV_EXP: 0.28,
  /** Dark erosion of unexposed positive resist (nm/s). */
  DARK_RATE: 0.06,
  /** Resist refractive index (standing-wave period = λ/2n). */
  N_RESIST: 1.7,
  /** Target film (SiO₂) thickness under the resist, nm. */
  FILM: 120,
  /** Etch selectivity film:resist. */
  SELECTIVITY: 4,
  /** Photon shot noise amplitude at ArF, 30 mJ/cm². */
  NOISE_REF: 0.035,
  /** Field of view: tile = FIELD_HP half-pitches wide. */
  FIELD_HP: 16,
  /** Mask reduction ratio. */
  REDUCTION: 4,
};

export function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

export function sigmaOptical(src: SourceSpec) {
  return (PHYS.K_PSF * src.lambda) / src.NA;
}
export function sigmaDefocus(src: SourceSpec, dz: number) {
  return PHYS.K_DEF * src.NA * Math.abs(dz);
}
/** Approximate usable depth of focus (±nm) — where defocus adds ~20% blur. */
export function depthOfFocus(src: SourceSpec) {
  const s = Math.sqrt(sigmaOptical(src) ** 2 + PHYS.PEB_SIGMA ** 2);
  return (0.66 * s) / (PHYS.K_DEF * src.NA);
}
/** Rayleigh-style half-pitch limit with partial coherence σ = 0.5. */
export function resolutionLimit(src: SourceSpec) {
  return src.lambda / (3 * src.NA);
}
/** Threshold exposure as a function of development time. */
export function devThreshold(tone: Tone, t: number) {
  const r = PHYS.DEV_REF / Math.max(t, 1);
  return tone === 'positive' ? PHYS.E_TH * Math.pow(r, PHYS.DEV_EXP) : PHYS.E_TH / Math.pow(r, PHYS.DEV_EXP);
}
/** Spin-coat relation: thickness ∝ 1/√rpm (Meyerhofer). */
export function spinRpm(thicknessNm: number) {
  return Math.round((3000 * (110 / thicknessNm) ** 2) / 10) * 10;
}
export function noiseAmplitude(src: SourceSpec, dose: number) {
  return PHYS.NOISE_REF * Math.sqrt((193 / src.lambda) * (PHYS.D_REF / Math.max(dose, 1)));
}
export function fieldNm(p: Params) {
  return p.halfPitch * PHYS.FIELD_HP;
}
