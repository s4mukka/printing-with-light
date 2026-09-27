import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.9 },
    uGrain: { value: 0.035 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uCircle: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; uniform vec2 uRes; uniform float uCircle;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float aspect = uRes.x / uRes.y;
      vec2 cc = vec2(c.x * aspect, c.y);
      float r = length(cc);
      // gentle lateral chromatic aberration toward the edges
      vec2 dir = c * 0.0022 * (0.4 + r * 2.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + dir).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - dir).b;
      float vig = smoothstep(1.05, 0.25, r * mix(1.0, 1.35, uCircle));
      col *= mix(1.0, vig, uVignette);
      float g = hash(vUv * uRes + fract(uTime * 13.7)) - 0.5;
      col += g * uGrain * (0.6 + 0.4 * (1.0 - dot(col, vec3(0.333))));
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** A canvas + renderer + post stack. Scenes are handed in per frame so views can swap. */
export class Viewport {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  renderPass: RenderPass;
  bloom: UnrealBloomPass;
  grade: ShaderPass;
  env: THREE.Texture;
  width = 1;
  height = 1;
  floatLinear: boolean;
  dpr: number;
  maxDpr: number;
  minDpr = 0.85;
  private slow = 0;
  private fast = 0;

  constructor(
    public canvas: HTMLCanvasElement,
    opts: { maxDpr: number; bloom: number; circle?: boolean; shadows?: boolean; samples?: number },
  ) {
    this.maxDpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr);
    this.dpr = this.maxDpr;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    r.setPixelRatio(this.dpr);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = opts.shadows !== false;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = r;
    this.floatLinear = r.extensions.has('OES_texture_float_linear');
    const pm = new THREE.PMREMGenerator(r);
    this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: opts.samples ?? 4 });
    this.composer = new EffectComposer(r, rt);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), opts.bloom, 0.62, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uCircle.value = opts.circle ? 1 : 0;
    this.grade.uniforms.uVignette.value = opts.circle ? 1 : 0.85;
    this.composer.addPass(this.grade);
  }

  /** Adaptive resolution: feed the measured frame interval; steps DPR down when the GPU can't keep up. */
  adapt(frameMs: number) {
    if (frameMs > 24) {
      this.slow++;
      this.fast = 0;
    } else if (frameMs < 14) {
      this.fast++;
      this.slow = 0;
    } else {
      this.slow = Math.max(0, this.slow - 1);
      this.fast = Math.max(0, this.fast - 1);
    }
    let next = this.dpr;
    if (this.slow > 20) next = Math.max(this.minDpr, this.dpr - 0.15);
    else if (this.fast > 120) next = Math.min(this.maxDpr, this.dpr + 0.1);
    if (next !== this.dpr) {
      this.dpr = next;
      this.slow = this.fast = 0;
      this.renderer.setPixelRatio(next);
      this.composer.setPixelRatio(next);
      const w = this.width;
      const h = this.height;
      this.width = this.height = 0;
      this.setSize(w, h);
    }
  }

  setSize(w: number, h: number) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.grade.uniforms.uRes.value.set(w * pr, h * pr);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number, envIntensity: number) {
    scene.environment = this.env;
    scene.environmentIntensity = envIntensity;
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.grade.uniforms.uTime.value = time;
    this.composer.render();
  }
}
