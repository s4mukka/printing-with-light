import * as THREE from 'three';

/** Additive light-beam volume between two points; radii interpolate along the beam. */
const beamVert = /* glsl */ `
  uniform float uR0;
  uniform float uR1;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    float r = mix(uR0, uR1, position.y);
    vec3 p = vec3(position.x * r, position.y, position.z * r);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vN = normalize(normalMatrix * vec3(normal.x, 0.0, normal.z));
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const beamFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uFlow;
  uniform float uStreaks;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  float noise(float x) { float i = floor(x); float f = fract(x); f = f*f*(3.0-2.0*f); return mix(hash(i), hash(i+1.0), f); }
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float core = pow(facing, 1.6);
    float along = vUv.y;
    float ends = smoothstep(0.0, uFadeIn, along) * smoothstep(1.0, 1.0 - uFadeOut, along);
    float a = vUv.x * 6.2831;
    float s = noise(along * 26.0 + uTime * uFlow + sin(a * 3.0) * 0.6) * 0.65 + noise(along * 7.0 + uTime * uFlow * 0.5 + a) * 0.35;
    float streak = mix(1.0, 0.45 + s * 1.1, uStreaks);
    float v = core * ends * streak * uIntensity;
    gl_FragColor = vec4(uColor * v, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Beam extends THREE.Mesh {
  declare material: THREE.ShaderMaterial;
  private static geo: THREE.CylinderGeometry | null = null;
  constructor(color: THREE.ColorRepresentation, r0 = 0.1, r1 = 0.1) {
    if (!Beam.geo) {
      Beam.geo = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
      Beam.geo.translate(0, 0.5, 0);
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uR0: { value: r0 },
        uR1: { value: r1 },
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: 1 },
        uTime: { value: 0 },
        uFlow: { value: 6 },
        uStreaks: { value: 1 },
        uFadeIn: { value: 0.08 },
        uFadeOut: { value: 0.08 },
      },
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    super(Beam.geo, mat);
    this.frustumCulled = false;
    this.renderOrder = 10;
  }
  private static up = new THREE.Vector3(0, 1, 0);
  private static tmp = new THREE.Vector3();
  /** Beam from `a` (radius r0) to `b` (radius r1). */
  span(a: THREE.Vector3, b: THREE.Vector3, r0?: number, r1?: number) {
    const d = Beam.tmp.subVectors(b, a);
    const len = Math.max(d.length(), 1e-4);
    this.position.copy(a);
    this.quaternion.setFromUnitVectors(Beam.up, d.divideScalar(len));
    this.scale.set(1, len, 1);
    if (r0 !== undefined) this.material.uniforms.uR0.value = r0;
    if (r1 !== undefined) this.material.uniforms.uR1.value = r1;
    return this;
  }
  set intensity(v: number) {
    this.material.uniforms.uIntensity.value = v;
    this.visible = v > 0.002;
  }
  get intensity() {
    return this.material.uniforms.uIntensity.value;
  }
  setColor(c: THREE.ColorRepresentation) {
    (this.material.uniforms.uColor.value as THREE.Color).set(c);
  }
  tick(t: number) {
    this.material.uniforms.uTime.value = t;
  }
}

let spriteTex: THREE.Texture | null = null;
/** Soft round sprite, procedurally drawn. */
export function softSprite() {
  if (spriteTex) return spriteTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  spriteTex = new THREE.CanvasTexture(c);
  spriteTex.colorSpace = THREE.SRGBColorSpace;
  return spriteTex;
}

/** CPU-driven particle system with per-particle life, drawn as additive or normal soft points. */
export class Particles {
  points: THREE.Points;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  alpha: Float32Array;
  count: number;
  private cursor = 0;
  gravity = new THREE.Vector3();
  drag = 0.5;
  lifeSpan = 1.5;
  constructor(count: number, color: THREE.ColorRepresentation, size: number, additive = true, opacity = 1) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.alpha = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: softSprite() }, uColor: { value: new THREE.Color(color) }, uSize: { value: size }, uOpacity: { value: opacity } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        uniform float uSize;
        varying float vA;
        void main() {
          vA = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uSize * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vA;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(uColor, t.a * vA * uOpacity);
          if (gl_FragColor.a < 0.003) discard;
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;
  }
  emit(p: THREE.Vector3, v: THREE.Vector3, life = this.lifeSpan) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.life[i] = life;
  }
  update(dt: number, fade = (l: number) => Math.min(1, l * 2)) {
    const g = this.gravity;
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const j = i * 3;
      this.vel[j] = this.vel[j] * k + g.x * dt;
      this.vel[j + 1] = this.vel[j + 1] * k + g.y * dt;
      this.vel[j + 2] = this.vel[j + 2] * k + g.z * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.alpha[i] = Math.max(0, fade(this.life[i]));
    }
    const geo = this.points.geometry;
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
  }
  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
  }
}

export function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
export function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}
export function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
export function damp(current: number, target: number, lambda: number, dt: number) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}
