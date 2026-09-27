/**
 * Periodic (wrap-around) image operations on square Float32 fields.
 * Gaussian blur uses three box passes for large σ (O(N) per row regardless of radius)
 * and a direct kernel for small σ where box quantisation would be visible.
 */

function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxH(src: Float32Array, dst: Float32Array, N: number, r: number) {
  const inv = 1 / (2 * r + 1);
  const wide = 2 * r + 1 >= N;
  for (let y = 0; y < N; y++) {
    const row = y * N;
    let acc = 0;
    if (wide) for (let k = -r; k <= r; k++) acc += src[row + (((k % N) + N) % N)];
    else for (let k = -r; k <= r; k++) acc += src[row + (k < 0 ? k + N : k)];
    for (let x = 0; x < N; x++) {
      dst[row + x] = acc * inv;
      let a = x + r + 1;
      let b = x - r;
      if (wide) {
        a = ((a % N) + N) % N;
        b = ((b % N) + N) % N;
      } else {
        if (a >= N) a -= N;
        if (b < 0) b += N;
      }
      acc += src[row + a] - src[row + b];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, N: number, r: number) {
  const inv = 1 / (2 * r + 1);
  const wide = 2 * r + 1 >= N;
  const col = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) col[y] = src[y * N + x];
    let acc = 0;
    if (wide) for (let k = -r; k <= r; k++) acc += col[((k % N) + N) % N];
    else for (let k = -r; k <= r; k++) acc += col[k < 0 ? k + N : k];
    for (let y = 0; y < N; y++) {
      dst[y * N + x] = acc * inv;
      let a = y + r + 1;
      let b = y - r;
      if (wide) {
        a = ((a % N) + N) % N;
        b = ((b % N) + N) % N;
      } else {
        if (a >= N) a -= N;
        if (b < 0) b += N;
      }
      acc += col[a] - col[b];
    }
  }
}

const kernelCache = new Map<number, Float32Array>();
function gaussKernel(sigma: number) {
  const key = Math.round(sigma * 1000);
  let k = kernelCache.get(key);
  if (k) return k;
  const r = Math.max(1, Math.ceil(sigma * 3));
  k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  kernelCache.set(key, k);
  return k;
}

function convH(src: Float32Array, dst: Float32Array, N: number, k: Float32Array) {
  const r = (k.length - 1) >> 1;
  for (let y = 0; y < N; y++) {
    const row = y * N;
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xi = x + i;
        if (xi < 0) xi += N;
        else if (xi >= N) xi -= N;
        acc += k[i + r] * src[row + xi];
      }
      dst[row + x] = acc;
    }
  }
}
function convV(src: Float32Array, dst: Float32Array, N: number, k: Float32Array) {
  const r = (k.length - 1) >> 1;
  for (let y = 0; y < N; y++) {
    for (let i = -r; i <= r; i++) {
      let yi = y + i;
      if (yi < 0) yi += N;
      else if (yi >= N) yi -= N;
      const w = k[i + r];
      const ro = yi * N;
      const wo = y * N;
      if (i === -r) for (let x = 0; x < N; x++) dst[wo + x] = w * src[ro + x];
      else for (let x = 0; x < N; x++) dst[wo + x] += w * src[ro + x];
    }
  }
}

const scratch = new Map<number, [Float32Array, Float32Array]>();

/** out = src ⊗ G(σ) with periodic boundaries. σ in pixels. */
export function gaussBlur(src: Float32Array, out: Float32Array, N: number, sigma: number) {
  let sc = scratch.get(N);
  if (!sc) {
    sc = [new Float32Array(N * N), new Float32Array(N * N)];
    scratch.set(N, sc);
  }
  const [scratchA, scratchB] = sc;
  if (sigma < 0.25) {
    out.set(src);
    return out;
  }
  // Very wide blur: the field is essentially uniform.
  if (sigma > N * 0.9) {
    let m = 0;
    for (let i = 0; i < src.length; i++) m += src[i];
    out.fill(m / src.length);
    return out;
  }
  if (sigma < 2.2) {
    const k = gaussKernel(sigma);
    convH(src, scratchA, N, k);
    convV(scratchA, out, N, k);
    return out;
  }
  const boxes = boxesForGauss(sigma, 3);
  // src → B → A, A → B → A, A → B → out  (boxH reads cur / writes B, boxV reads B / writes dst)
  let cur: Float32Array = src;
  for (let i = 0; i < 3; i++) {
    const r = (boxes[i] - 1) >> 1;
    boxH(cur, scratchB, N, r);
    const dst = i === 2 ? out : scratchA;
    boxV(scratchB, dst, N, r);
    cur = dst;
  }
  return out;
}

/** Bilinear periodic shift: out(x, y) = src(x − sx, y − sy), shifts in pixels. */
export function shiftPeriodic(src: Float32Array, out: Float32Array, N: number, sx: number, sy: number) {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  for (let y = 0; y < N; y++) {
    const y0 = (((y - iy) % N) + N) % N;
    const y1 = (y0 - 1 + N) % N;
    for (let x = 0; x < N; x++) {
      const x0 = (((x - ix) % N) + N) % N;
      const x1 = (x0 - 1 + N) % N;
      const a = src[y0 * N + x0] * (1 - fx) + src[y0 * N + x1] * fx;
      const b = src[y1 * N + x0] * (1 - fx) + src[y1 * N + x1] * fx;
      out[y * N + x] = a * (1 - fy) + b * fy;
    }
  }
  return out;
}

/** Down-sample by an integer factor (box average). */
export function downsample(src: Float32Array, N: number, f: number) {
  const M = N / f;
  const out = new Float32Array(M * M);
  const inv = 1 / (f * f);
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++) {
      let acc = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) acc += src[(y * f + j) * N + x * f + i];
      out[y * M + x] = acc * inv;
    }
  return out;
}

/** Deterministic hash-based PRNG. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(i: number, j: number, seed = 1) {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
