import * as THREE from 'three';
import { OrbitRig, shot } from '../OrbitRig';
import { N, NZ } from '../../sim/engine';
import { PHYS, SOURCES, fieldNm } from '../../core/params';
import { t, tOpt, nf } from '../../i18n';
import type { Annotation, FrameContext } from '../types';
import { Particles, damp, smoothstep, softSprite } from '../fx';
import type { MicroCam } from '../../core/store';

const W = 4; // block width in world units

/** Shared uniforms of every specimen material. */
function makeUniforms() {
  return {
    uField: { value: null as THREE.Texture | null },
    uAux: { value: null as THREE.Texture | null },
    uSection: { value: null as THREE.Texture | null },
    uS: { value: 0.003 }, // world units per nm
    uFilm: { value: PHYS.FILM },
    uThick: { value: 110 },
    uSi: { value: 130 },
    uCut: { value: 0.5 },
    uCollapse: { value: 0 },
    uLatent: { value: 0 },
    uPeb: { value: 0 },
    uXs: { value: 0 },
    uDevT: { value: 1 },
    uOverlay: { value: 0 },
    uAerial: { value: 0 },
    uTarget: { value: 0 },
    uCoatFront: { value: 2 },
    uTime: { value: 0 },
    uThr: { value: 0.5 },
    uFlash: { value: 0 },
    uUV: { value: new THREE.Color('#c77dff') },
    uStrip: { value: 0 },
  };
}
type U = ReturnType<typeof makeUniforms>;

const uniformsGLSL = /* glsl */ `
  uniform sampler2D uField; uniform sampler2D uAux; uniform sampler2D uSection;
  uniform float uS, uFilm, uThick, uSi, uCut, uCollapse, uLatent, uPeb, uXs, uDevT, uOverlay, uAerial, uTarget, uCoatFront, uTime, uThr, uFlash, uStrip;
  uniform vec3 uUV;
`;
const commonGLSL = uniformsGLSL + /* glsl */ `
  vec3 magma(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 a = vec3(0.02, 0.01, 0.08), b = vec3(0.38, 0.09, 0.52), c = vec3(0.86, 0.29, 0.34), d = vec3(0.99, 0.72, 0.36), e = vec3(1.0, 0.98, 0.84);
    if (t < 0.25) return mix(a, b, t / 0.25);
    if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
    return mix(d, e, (t - 0.75) / 0.25);
  }
  float lineAA(float v, float at) { float w = fwidth(v) * 1.2; return 1.0 - smoothstep(0.0, w, abs(v - at)); }
`;

function heightMaterial(U: U, kind: 'resist' | 'substrate') {
  const mat = new THREE.MeshPhysicalMaterial(
    kind === 'resist'
      ? { color: 0xd68a30, roughness: 0.46, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.45, envMapIntensity: 0.45 }
      : { color: 0xffffff, roughness: 0.3, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.15, envMapIntensity: 0.6 },
  );
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${uniformsGLSL}\nvarying vec2 vF; varying float vH; varying float vSurf; varying float vWY;
        float H(vec2 q) { vec4 f = texture(uField, q); return ${kind === 'resist' ? '(f.g + f.r)' : 'f.g'} * uS; }`)
      .replace(
        '#include <beginnormal_vertex>',
        `vec2 dd = vec2(1.6 / ${N}.0, 0.0);
         float hx = (H(uv + dd.xy) - H(uv - dd.xy)) / (2.0 * ${W}.0 * dd.x);
         float hz = (H(uv + dd.yx) - H(uv - dd.yx)) / (-2.0 * ${W}.0 * dd.x);
         vec3 objectNormal = normalize(vec3(-hx, 1.0, -hz));`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec4 fv = texture(uField, uv);
         vec3 transformed = position;
         float hh = ${kind === 'resist' ? 'fv.r' : '0.0'};
         transformed.y = (fv.g + hh) * uS;
         ${kind === 'resist' ? 'transformed.x += texture(uAux, uv).b * uCollapse * hh * uS * 0.62;' : ''}
         vF = uv; vH = hh; vSurf = fv.g; vWY = transformed.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${commonGLSL}\nvarying vec2 vF; varying float vH; varying float vSurf; varying float vWY;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         if (vF.y < uCut) discard;
         ${kind === 'resist' ? 'if (vH < 0.6) discard; if (vF.x > uCoatFront + 0.02 * sin(vF.y * 23.0 + uTime)) discard;' : ''}
         vec4 fs = texture(uField, vF);
         vec4 ax = texture(uAux, vF);
         ${
           kind === 'substrate'
             ? `float si = 1.0 - smoothstep(-0.5, 1.5, vSurf);
                diffuseColor.rgb = mix(pow(vec3(0.26, 0.43, 0.63), vec3(2.2)), pow(vec3(0.3, 0.31, 0.34), vec3(2.2)), si);`
             : ''
         }
         // design target outline & error tint
         float tg = ax.a;
         float edge = lineAA(tg, 0.5);
         float printed = step(uThick * 0.5, fs.r);
         float designed = step(0.5, tg);
         ${
           kind === 'resist'
             ? `float err = uOverlay * printed * (1.0 - designed);`
             : `float err = uOverlay * (1.0 - printed) * designed * step(uFilm * 0.5, vSurf + 0.001) * step(0.5, uXs);`
         }
         // data views: flatten the material so the information reads
         diffuseColor.rgb *= mix(1.0, 0.5, uOverlay);
         diffuseColor.rgb = mix(diffuseColor.rgb, ${kind === 'resist' ? 'vec3(0.62, 0.42, 1.0)' : 'vec3(1.0, 0.33, 0.27)'}, err * 0.9);
         float dash = step(0.5, fract((vF.x + vF.y) * 48.0));
         float outline = edge * max(uOverlay, uTarget * dash);
         // aerial image map
         if (uAerial > 0.5) {
           diffuseColor.rgb = pow(magma(ax.r * 0.95), vec3(2.2)) * 0.8;
         }
         float thrLine = uAerial * lineAA(ax.r, uThr);
         `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         ${
           kind === 'resist'
             ? `float lat = mix(fs.b, fs.a, uPeb);
                totalEmissiveRadiance += uUV * uLatent * pow(clamp(lat, 0.0, 1.6), 2.0) * 0.55;
                totalEmissiveRadiance += uUV * uFlash * clamp(ax.r, 0.0, 1.0) * 1.4;`
             : `totalEmissiveRadiance += uUV * uFlash * clamp(ax.r, 0.0, 1.0) * 0.8;`
         }
         totalEmissiveRadiance += vec3(0.85, 0.95, 1.0) * outline * mix(0.9, 0.55, uOverlay);
         totalEmissiveRadiance += ${kind === 'resist' ? 'vec3(0.35, 0.2, 0.9)' : 'vec3(0.9, 0.2, 0.15)'} * err * 0.35;
         totalEmissiveRadiance += vec3(1.0) * thrLine * 0.7;
         if (uAerial > 0.5) totalEmissiveRadiance += diffuseColor.rgb * 0.18;
         `,
      );
  };
  mat.customProgramCacheKey = () => 'height-' + kind + '-v4';
  return mat;
}

/** Vertical face (sides and cross-section cut) that paints the material stack from textures. */
function faceMaterial(U: U, isCut: boolean) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uA: { value: new THREE.Vector2() }, uB: { value: new THREE.Vector2() }, uY0: { value: -0.5 }, uY1: { value: 1 }, uNormal: { value: new THREE.Vector3(0, 0, 1) } },
    vertexShader: /* glsl */ `
      uniform vec2 uA; uniform vec2 uB; uniform float uY0; uniform float uY1;
      varying vec2 vUvp; varying float vY; varying vec3 vWorld;
      void main() {
        float t = position.x + 0.5;
        vec2 uvp = mix(uA, uB, t);
        vec3 wp = vec3(uvp.x * ${W}.0 - ${W / 2}.0, mix(uY0, uY1, position.y + 0.5), ${W / 2}.0 - uvp.y * ${W}.0);
        vUvp = uvp; vY = wp.y; vWorld = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${commonGLSL}
      uniform vec3 uNormal;
      varying vec2 vUvp; varying float vY; varying vec3 vWorld;
      void main() {
        vec4 f = texture2D(uField, vUvp);
        float y = vY / uS; // nm
        float s = f.g; float h = f.r;
        float top = s + h;
        float resist = step(y, top) * step(s, y);
        ${
          isCut
            ? `
        float dep = (uFilm + uThick - y) / max(uThick, 1.0);
        vec4 xs = texture2D(uSection, vec2(vUvp.x, clamp(dep, 0.0, 1.0)));
        float xsPresent = step(uDevT, xs.r) * step(uFilm, y) * step(y, uFilm + uThick);
        resist = mix(resist, xsPresent * step(y, top + 0.5), uXs);
        if (vUvp.x > uCoatFront + 0.02 * sin(vUvp.y * 23.0 + uTime)) resist = 0.0;
        `
            : `if (vUvp.x > uCoatFront + 0.02 * sin(vUvp.y * 23.0 + uTime)) resist = 0.0;`
        }
        float si = step(y, min(s, 0.0));
        float film = step(y, s) * (1.0 - si);
        if (resist + film + si < 0.5) discard;
        vec3 cSi = pow(vec3(0.24, 0.25, 0.28), vec3(2.2));
        vec3 cFilm = pow(vec3(0.25, 0.42, 0.62), vec3(2.2));
        vec3 cRes = pow(vec3(0.86, 0.55, 0.22), vec3(2.2));
        vec3 col = si > 0.5 ? cSi : (film > 0.5 ? cFilm : cRes);
        // subtle depth shading and silicon lattice texture
        col *= 0.82 + 0.18 * smoothstep(-uSi, uFilm + uThick, y);
        col *= 1.0 - si * 0.06 * step(0.5, fract((vWorld.x * 60.0 + vWorld.y * 60.0)));
        // interfaces as hairlines
        float iface = max(lineAA(y, 0.0) * step(0.0, s), lineAA(y, s) * (1.0 - step(y, 0.0) * 0.0));
        col = mix(col, col * 0.45, iface * 0.8);
        float lit = 0.62 + 0.38 * max(dot(uNormal, normalize(vec3(-0.4, 0.6, 0.7))), 0.0);
        col *= lit;
        ${
          isCut
            ? `
        // light inside the resist (latent image, standing waves) and acid after PEB
        float lat = mix(xs.g, xs.b, uPeb);
        float inRes = resist * (1.0 - step(0.5, uXs));
        // display curve: exposed resist glows violet → white; standing-wave fringes stay legible
        float lv = smoothstep(0.12, 1.05, lat);
        vec3 glow = mix(uUV, vec3(1.0, 0.92, 1.0), smoothstep(0.55, 1.0, lv));
        col = mix(col, col * 0.55 + glow * lv * 1.35, inRes * uLatent * 0.85);
        col += uUV * inRes * uFlash * clamp(lat, 0.0, 1.4) * 0.8;
        // designed profile, dashed
        float tgt = xs.a;
        float ex = lineAA(tgt, 0.5) * step(uFilm, y) * step(y, uFilm + uThick);
        float topL = lineAA(y, uFilm + uThick) * step(0.5, tgt);
        float dsh = step(0.5, fract(y * 0.08 + vWorld.x * 6.0));
        col = mix(col, vec3(0.92, 0.97, 1.0), (ex + topL) * dsh * max(uOverlay, uTarget) * 0.9);
        `
            : ''
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });
  return mat;
}

export class MicroScene {
  scene = new THREE.Scene();
  rig = new OrbitRig(24);
  U = makeUniforms();
  block = new THREE.Group();
  resist: THREE.Mesh;
  substrate: THREE.Mesh;
  faces: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; kind: 'cut' | 'left' | 'right' | 'back' }[] = [];
  base: THREE.Mesh;
  ghost: THREE.Mesh;
  ghostMat: THREE.ShaderMaterial;
  slices: THREE.Mesh[] = [];
  sliceMat: THREE.ShaderMaterial;
  specks: THREE.InstancedMesh;
  vapor: Particles;
  ions: Particles;
  plasma: THREE.Mesh;
  plasmaMat: THREE.MeshBasicMaterial;
  liquid: THREE.Mesh;
  liquidMat: THREE.MeshPhysicalMaterial;
  caliper = new THREE.Group();
  caliperMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
  scaleBar: THREE.Line;
  annotations: Annotation[] = [];
  anchors: Record<string, THREE.Object3D> = {};
  private camMode: MicroCam | '' = '';
  private camKey = '';

  private lastStage = -1;
  private liquidA = 0;
  private plasmaA = 0;
  private latentA = 0;
  private collapseA = 0;
  scaleNm = 500;
  private stackFits = true;
  caliperInfo = { visible: false, text: '' };

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color('#060709');
    s.fog = new THREE.Fog('#060709', 18, 42);
    const hemi = new THREE.HemisphereLight(0x3d4452, 0x08080a, 0.55);
    const key = new THREE.DirectionalLight(0xfff3e4, 1.9);
    key.position.set(-5, 9, 7);
    const rim = new THREE.DirectionalLight(0x8fb0ff, 1.8);
    rim.position.set(6, 3, -8);
    const fill = new THREE.DirectionalLight(0xffb866, 0.6);
    fill.position.set(6, 2, 6);
    s.add(hemi, key, rim, fill);

    const grid = new THREE.PlaneGeometry(W, W, N - 1, N - 1);
    grid.rotateX(-Math.PI / 2);
    this.substrate = new THREE.Mesh(grid, heightMaterial(this.U, 'substrate'));
    this.resist = new THREE.Mesh(grid, heightMaterial(this.U, 'resist'));
    this.substrate.frustumCulled = false;
    this.resist.frustumCulled = false;
    this.block.add(this.substrate, this.resist);
    const faceGeo = new THREE.PlaneGeometry(1, 1, N, 1);
    for (const kind of ['cut', 'left', 'right', 'back'] as const) {
      const mat = faceMaterial(this.U, kind === 'cut');
      const mesh = new THREE.Mesh(faceGeo, mat);
      mesh.frustumCulled = false;
      this.faces.push({ mesh, mat, kind });
      this.block.add(mesh);
    }
    this.base = new THREE.Mesh(new THREE.BoxGeometry(W + 0.16, 0.08, W + 0.16), new THREE.MeshStandardMaterial({ color: 0x131417, roughness: 0.4, metalness: 0.7 }));
    this.block.add(this.base);
    const shadowTex = softSprite();
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 2.6, W * 2.6), new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, opacity: 0.85, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    (this.base.userData as { shadow: THREE.Mesh }).shadow = shadow;
    this.block.add(shadow);
    s.add(this.block);

    // ghost of the mask image (alignment & exposure)
    this.ghostMat = new THREE.ShaderMaterial({
      uniforms: { uAux: this.U.uAux, uA: { value: 0 }, uUV: this.U.uUV, uFlash: this.U.uFlash },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAux; uniform float uA; uniform vec3 uUV; uniform float uFlash; varying vec2 vUv;
        void main(){
          float t = texture2D(uAux, vUv).g;
          float chrome = 1.0 - smoothstep(0.35, 0.65, t);
          float e = abs(dFdx(t)) + abs(dFdy(t));
          vec3 c = mix(uUV * (0.25 + uFlash * 1.5), vec3(0.09, 0.1, 0.12), chrome);
          float a = mix(0.05 + uFlash * 0.25, 0.86, chrome) * uA;
          c += vec3(0.8, 0.85, 1.0) * clamp(e * 3.0, 0.0, 1.0) * 0.6;
          gl_FragColor = vec4(c, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ghost = new THREE.Mesh(new THREE.PlaneGeometry(W, W), this.ghostMat);
    this.ghost.rotation.x = -Math.PI / 2;
    // the plane's uv.y runs +z → -z after rotation, matching the field convention
    s.add(this.ghost);
    this.sliceMat = new THREE.ShaderMaterial({
      uniforms: { uAux: this.U.uAux, uK: { value: 0 }, uI: { value: 0 }, uUV: this.U.uUV, uTime: this.U.uTime },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAux; uniform float uK; uniform float uI; uniform vec3 uUV; uniform float uTime; varying vec2 vUv;
        void main(){
          vec4 a = texture2D(uAux, vUv);
          float v = mix(a.g, a.r, uK);
          float pulse = 0.6 + 0.4 * sin(uK * 12.0 - uTime * 7.0);
          gl_FragColor = vec4(uUV * v * uI * pulse * 0.22, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    for (let k = 0; k < 7; k++) {
      const m = this.sliceMat.clone();
      m.uniforms.uAux = this.U.uAux;
      m.uniforms.uUV = this.U.uUV;
      m.uniforms.uTime = this.U.uTime;
      m.uniforms.uK.value = k / 6;
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(W, W), m);
      pl.rotation.x = -Math.PI / 2;
      pl.renderOrder = 20 + k;
      this.slices.push(pl);
      s.add(pl);
    }

    // particles on the surface before cleaning
    this.specks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x3a342c, roughness: 0.9 }), 26);
    s.add(this.specks);
    this.vapor = new Particles(300, '#efe4d2', 0.35, false, 0.12);
    this.vapor.gravity.set(0, 0.4, 0);
    this.vapor.drag = 1;
    s.add(this.vapor.points);
    this.ions = new Particles(500, '#e7a6ff', 0.06, true, 0.9);
    this.ions.drag = 0;
    s.add(this.ions.points);
    this.plasmaMat = new THREE.MeshBasicMaterial({ map: softSprite(), color: 0xc36bff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.plasma = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.8, 2.2), this.plasmaMat);
    s.add(this.plasma);
    this.liquidMat = new THREE.MeshPhysicalMaterial({ color: 0x9fd2ff, roughness: 0.02, metalness: 0, transparent: true, opacity: 0, clearcoat: 1, envMapIntensity: 1.5, depthWrite: false });
    this.liquid = new THREE.Mesh(new THREE.BoxGeometry(W, 1, W), this.liquidMat);
    s.add(this.liquid);

    // CD caliper & scale bar
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]);
    const main = new THREE.Line(lg, this.caliperMat);
    const tick = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.5, 0)]);
    const t0 = new THREE.Line(tick, this.caliperMat);
    const t1 = new THREE.Line(tick, this.caliperMat);
    this.caliper.add(main, t0, t1);
    Object.assign(this.caliper.userData, { main, t0, t1 });
    this.caliper.renderOrder = 50;
    s.add(this.caliper);
    const sbGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]);
    this.scaleBar = new THREE.Line(sbGeo, new THREE.LineBasicMaterial({ color: 0xcfcac0, transparent: true, opacity: 0.8 }));
    s.add(this.scaleBar);

    for (const id of ['resist', 'film', 'si', 'cd', 'scale', 'mask', 'target', 'plasma'] as const) {
      const o = new THREE.Object3D();
      this.anchors[id] = o;
      s.add(o);
    }
    this.annotations = [
      { id: 'resist', title: 'Photoresist', obj: this.anchors.resist, visible: false, side: 'right' },
      { id: 'film', title: 'SiO₂ film', sub: '120 nm', obj: this.anchors.film, visible: false, side: 'right' },
      { id: 'si', title: 'Silicon', obj: this.anchors.si, visible: false, side: 'right' },
      { id: 'cd', title: '', obj: this.anchors.cd, visible: false, side: 'right', accent: true },
      { id: 'scale', title: '', obj: this.anchors.scale, visible: false, side: 'right' },
      { id: 'mask', title: 'Mask image', sub: 'projected, shrunk 4×', obj: this.anchors.mask, visible: false, side: 'left' },
      { id: 'target', title: 'Where it must land', sub: 'previous layer', obj: this.anchors.target, visible: false, side: 'left' },
      { id: 'plasma', title: 'Ions', sub: 'straight down, anisotropic', obj: this.anchors.plasma, visible: false, side: 'left' },
    ];

    this.rig.minR = 4;
    this.rig.maxR = 40;
    this.rig.minPhi = 0.02;
    this.rig.maxPhi = 1.5;
    this.rig.shot(shot(0, 0.2, 0, 9, 32, 58), 0);
  }

  setCamera(mode: MicroCam, yTop: number, yBase: number, cut: number, duration = 1.4) {
    const zCut = W / 2 - cut * W;
    const depth = W * (1 - cut);
    const zc = zCut - depth / 2;
    const h = yTop - yBase;
    const size = Math.max(W * 0.9, depth, h * 1.3);
    const yc = yBase + h * 0.55;
    if (mode === '3d') this.rig.shot(shot(0, yc, zc, size * 4.5, 24, 57), duration);
    else if (mode === 'section') this.rig.shot(shot(0, yc, zCut, Math.max(W, h * 1.6) * 2.95, 8, 82), duration);
    else this.rig.shot(shot(0, yTop, 0, W * 4.3, 0, 1.2), duration);
    this.camMode = mode;
    this.camKey = `${mode}|${yTop.toFixed(2)}|${yBase.toFixed(2)}|${cut.toFixed(2)}`;
  }

  update(ctx: FrameContext) {
    const { dt, time, state, ps, sim } = ctx;
    const p = sim.params;
    const U = this.U;
    const field = fieldNm(p);
    const S = W / field;
    const src = SOURCES[p.source];
    const stage = state.stage;
    U.uField.value = sim.fieldTex;
    U.uAux.value = sim.auxTex;
    U.uSection.value = sim.sectionTex;
    U.uS.value = S;
    U.uThick.value = p.thickness;
    const SI = Math.max(0.1 * field, 110, p.etchDepth - PHYS.FILM + 40);
    U.uSi.value = SI;
    // from straight above the cut plane is invisible — show the whole field
    U.uCut.value = state.microCam === 'top' ? 0 : state.cut;
    U.uTime.value = time;
    (U.uUV.value as THREE.Color).set(src.color);
    // collapse: tall thin lines lean over after development (capillary forces while drying)
    const collapseTarget = ps.developed >= 1 ? sim.metrics.collapse : ps.developed * sim.metrics.collapse;
    this.collapseA = damp(this.collapseA, collapseTarget * (1 - ps.stripped), 3, dt);
    U.uCollapse.value = this.collapseA;
    this.latentA = damp(this.latentA, ps.exposed > 0 && ps.developed <= 0 ? Math.min(1, ps.exposed * 3) : 0, 4, dt);
    U.uLatent.value = this.latentA;
    U.uPeb.value = ps.peb;
    U.uXs.value = ps.developed > 0 ? 1 : 0;
    U.uDevT.value = ps.developed > 0 ? ps.developed : 0;
    U.uOverlay.value = state.microLayer === 'overlay' ? 1 : 0;
    U.uAerial.value = state.microLayer === 'aerial' ? 1 : 0;
    const data = state.microLayer !== 'none';
    for (const mesh of [this.resist, this.substrate]) {
      const mm = mesh.material as THREE.MeshPhysicalMaterial;
      mm.clearcoat = data ? 0.001 : mesh === this.resist ? 0.25 : 0.8;
      mm.roughness = data ? 0.85 : mesh === this.resist ? 0.46 : 0.3;
      mm.envMapIntensity = data ? 0.15 : mesh === this.resist ? 0.45 : 0.6;
    }
    U.uTarget.value = stage === 3 || (ps.developed >= 1 && state.microLayer === 'none') ? 1 : 0;
    U.uCoatFront.value = stage > 1 ? 2 : stage === 1 ? THREE.MathUtils.lerp(-0.05, 1.1, smoothstep(0.1, 0.75, ps.coat)) : -1;
    U.uStrip.value = ps.stripped;
    // effective print threshold on the aerial image (for the contour line)
    U.uThr.value = THREE.MathUtils.clamp(sim.metrics.thr, 0.02, 0.98);
    const exposing = stage === 4 && state.playing === 4 && state.progress[4] > 0 && state.progress[4] < 1;
    U.uFlash.value = damp(U.uFlash.value, exposing ? 0.9 + 0.1 * Math.sin(time * 30) : 0, 8, dt);

    // geometry of the block
    const yTop = (PHYS.FILM + p.thickness) * S;
    const yBase = -SI * S;
    const cut = state.cut;
    for (const f of this.faces) {
      const u = f.mat.uniforms;
      u.uY0.value = yBase;
      u.uY1.value = yTop * 1.02 + 0.01;
      if (f.kind === 'cut') {
        u.uA.value.set(0, cut);
        u.uB.value.set(1, cut);
        u.uNormal.value.set(0, 0, 1);
      } else if (f.kind === 'left') {
        u.uA.value.set(0, cut);
        u.uB.value.set(0, 1);
        u.uNormal.value.set(-1, 0, 0);
      } else if (f.kind === 'right') {
        u.uA.value.set(1, cut);
        u.uB.value.set(1, 1);
        u.uNormal.value.set(1, 0, 0);
      } else {
        u.uA.value.set(0, 1);
        u.uB.value.set(1, 1);
        u.uNormal.value.set(0, 0, -1);
      }
    }
    const zCut = W / 2 - cut * W;
    const depthZ = W * (1 - cut);
    this.base.position.set(0, yBase - 0.04, zCut - depthZ / 2);
    this.base.scale.set(1, 1, (depthZ + 0.16) / (W + 0.16));
    const shadow = (this.base.userData as { shadow: THREE.Mesh }).shadow;
    shadow.position.set(0, yBase - 0.079, zCut - depthZ / 2);

    // camera framing follows the specimen size & cut
    const wantKey = `${state.microCam}|${yTop.toFixed(2)}|${yBase.toFixed(2)}|${cut.toFixed(2)}`;
    if (wantKey !== this.camKey && !this.rig.interacting) {
      this.setCamera(state.microCam, yTop, yBase, cut, this.camMode === '' ? 0 : this.camMode !== state.microCam ? 1.4 : 0.9);

    }
    if (this.lastStage !== stage) this.lastStage = stage;
    this.rig.targetClamp = new THREE.Box3(new THREE.Vector3(-3, yBase - 1, -3), new THREE.Vector3(3, yTop + 2, 3));

    // ghost mask & light slices
    const ghostOn = stage === 3 || stage === 4 ? 1 : 0;
    const ga = damp(this.ghostMat.uniforms.uA.value, ghostOn, 4, dt);
    this.ghostMat.uniforms.uA.value = ga;
    this.ghost.visible = ga > 0.01;
    const gy = yTop + Math.max(1.2, (yTop - yBase) * 0.9);
    this.ghost.position.set(0, gy, 0);
    const beamI = stage === 4 ? (exposing ? 1 : 0.35) : 0;
    this.slices.forEach((pl, k) => {
      const m = pl.material as THREE.ShaderMaterial;
      const target = beamI;
      m.uniforms.uI.value = damp(m.uniforms.uI.value, target, 4, dt);
      pl.visible = m.uniforms.uI.value > 0.01;
      pl.position.y = THREE.MathUtils.lerp(gy - 0.04, yTop + 0.02, k / 6);
    });

    // particles before cleaning
    const clean = ps.clean;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < this.specks.count; i++) {
      const hx = Math.sin(i * 12.9898) * 43758.5453;
      const hz = Math.sin(i * 78.233) * 12543.1234;
      const x = (hx - Math.floor(hx) - 0.5) * W * 0.9;
      const z = (hz - Math.floor(hz) - 0.5) * W * 0.9;
      const r = (0.05 + 0.1 * (hx - Math.floor(hx))) * (1 - clean);
      const lift = clean * clean * (2 + (i % 5));
      q.setFromEuler(new THREE.Euler(i, i * 2, 0));
      m4.compose(new THREE.Vector3(x + clean * (i % 2 ? 1 : -1) * 1.5, PHYS.FILM * S + r * 0.7 + lift, z), q, new THREE.Vector3(r, r * 0.8, r));
      this.specks.setMatrixAt(i, m4);
    }
    this.specks.instanceMatrix.needsUpdate = true;
    this.specks.visible = clean < 0.999;

    // vapour during bakes
    const baking = (stage === 2 || stage === 5) && state.playing === stage && state.progress[stage] > 0 && state.progress[stage] < 1;
    if (baking && Math.random() < 0.8) {
      this.vapor.emit(new THREE.Vector3((Math.random() - 0.5) * W, yTop + 0.02, (Math.random() - 0.5) * W * (1 - cut) - W * cut * 0.5 + W * 0.0), new THREE.Vector3((Math.random() - 0.5) * 0.1, 0.4 + Math.random() * 0.3, (Math.random() - 0.5) * 0.1), 2.2);
    }
    (this.vapor.points.material as THREE.ShaderMaterial).uniforms.uColor.value.set(stage === 5 ? '#ffd9b0' : '#efe4d2');
    this.vapor.update(dt, (l) => Math.min(1, l) * Math.min(1, (2.2 - l) * 3));

    // developer liquid
    const devRunning = stage === 6 && state.progress[6] > 0 && state.progress[6] < 1;
    this.liquidA = damp(this.liquidA, devRunning ? 1 : 0, 4, dt);
    this.liquid.visible = this.liquidA > 0.01;
    this.liquidMat.opacity = this.liquidA * 0.14;
    const lh = Math.max(0.25, (yTop - PHYS.FILM * S) * 1.6);
    this.liquid.scale.set(1, lh, 1 - cut);
    this.liquid.position.set(0, PHYS.FILM * S + lh / 2, zCut - depthZ / 2);

    // plasma etch
    const etching = stage === 7 && state.progress[7] > 0 && state.progress[7] < 1;
    this.plasmaA = damp(this.plasmaA, etching ? 1 : 0, 4, dt);
    this.plasmaMat.opacity = this.plasmaA * (0.45 + 0.1 * Math.sin(time * 27));
    this.plasma.visible = this.plasmaA > 0.01;
    this.plasma.position.set(0, yTop + 1.4, zCut - depthZ / 2 - 0.4);
    this.plasma.lookAt(this.rig.camera.position.x, this.plasma.position.y, this.rig.camera.position.z);
    if (etching) {
      for (let k = 0; k < 7; k++)
        this.ions.emit(new THREE.Vector3((Math.random() - 0.5) * W, yTop + 1.6, zCut - Math.random() * depthZ), new THREE.Vector3(0, -3.2, 0), (yTop + 1.6 - yBase * 0) / 3.2);
    }
    this.ions.update(dt, (l) => Math.min(1, l * 4));

    // anchors for labels on the cut face
    // put the stack labels on whichever end of the cut face sits left on screen, text pointing outward
    const film = PHYS.FILM * S;
    const pL = new THREE.Vector3(-W / 2, film, zCut).project(this.rig.camera);
    const pR = new THREE.Vector3(W / 2, film, zCut).project(this.rig.camera);
    const vw = ctx.view;
    const toPx = (v: THREE.Vector3) => (v.x * 0.5 + 0.5) * vw.w;
    const leftFirst = pL.x < pR.x;
    const scrLeft = toPx(leftFirst ? pL : pR);
    const scrRight = toPx(leftFirst ? pR : pL);
    // text needs ~170 px; prefer the left end, fall back to the right end, hide if neither fits
    const fitsLeft = scrLeft - 190 > vw.l;
    const fitsRight = scrRight + 190 < vw.r;
    const useLeft = fitsLeft || !fitsRight;
    this.stackFits = fitsLeft || fitsRight;
    const endSign = (useLeft ? leftFirst : !leftFirst) ? -1 : 1;
    const xr = endSign * (W / 2 + 0.02);
    for (const a of this.annotations) if (a.id === 'resist' || a.id === 'film' || a.id === 'si') a.side = useLeft ? 'left' : 'right';
    this.anchors.resist.position.set(xr, film + p.thickness * S * 0.55, zCut);
    this.anchors.film.position.set(xr, film * 0.5, zCut);
    this.anchors.si.position.set(xr, yBase * 0.5, zCut);
    this.anchors.mask.position.set(-W / 2, gy, W / 2);
    this.anchors.target.position.set(-W / 2, yTop, W / 2 - 0.4);
    this.anchors.plasma.position.set(-W / 2 + 0.3, yTop + 1.0, zCut - 0.3);

    // scale bar along the front-bottom edge
    const nice = [50, 100, 200, 250, 500, 1000, 2000];
    const want = field * 0.3;
    this.scaleNm = nice.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    const sbLen = this.scaleNm * S;
    this.scaleBar.position.set(-W / 2, yBase - 0.12, zCut + 0.12);
    this.scaleBar.scale.set(sbLen, 1, 1);
    this.anchors.scale.position.set(-W / 2 + sbLen, yBase - 0.12, zCut + 0.12);

    // CD caliper at the metrology site — visible on the cut face when the cut passes through it
    const m = sim.metrics;
    const siteV = m.siteRow / N;
    const onCut = Math.abs(siteV - cut) < 1.5 / N + 0.004;
    const showCd = ps.developed >= 1 && m.edges !== null && !m.missing && !m.bridged && onCut;
    this.caliper.visible = showCd;
    this.caliperInfo.visible = showCd;
    if (showCd && m.edges) {
      const [l, r] = m.edges;
      const hDisp = ps.etched > 0 ? p.thickness * 0.5 : p.thickness * 0.5;
      const yC = film + hDisp * S + (ps.stripped > 0.5 ? -film * 0.5 - hDisp * S : 0);
      const x0 = l * S - W / 2;
      const x1 = r * S - W / 2;
      const ud = this.caliper.userData as Record<string, THREE.Object3D>;
      this.caliper.position.set(x0, yC, zCut + 0.012);
      ud.main.scale.set(x1 - x0, 1, 1);
      ud.t0.position.set(0, 0, 0);
      ud.t1.position.set(x1 - x0, 0, 0);
      const th = Math.max(0.08, p.thickness * S * 0.45);
      ud.t0.scale.set(1, th, 1);
      ud.t1.scale.set(1, th, 1);
      this.anchors.cd.position.set((x0 + x1) / 2, yC + th * 0.6, zCut + 0.012);
    }

    // label visibility
    const faceVisible = state.microCam !== 'top';
    for (const a of this.annotations) {
      let v = false;
      a.title = tOpt(`ann.${a.id}`);
      a.sub = tOpt(`ann.${a.id}.sub`) || undefined;
      switch (a.id) {
        case 'resist':
          v = faceVisible && this.stackFits && ps.coat > 0.8 && ps.stripped < 0.5;
          a.sub = t(`ann.resist.${p.tone}`, { t: nf(p.thickness, 0) });
          break;
        case 'film':
          v = faceVisible && this.stackFits;
          break;
        case 'si':
          v = faceVisible && this.stackFits;
          break;
        case 'cd':
          v = showCd;
          a.title = `CD ${nf(m.cd, 1)} nm`;
          a.sub = t('ann.cd.sub', { t: nf(m.cdTarget, 0), kind: t(`kind.${m.featureKind}`) });
          break;
        case 'scale':
          v = true;
          a.title = this.scaleNm >= 1000 ? `${nf(this.scaleNm / 1000, 0)} µm` : `${nf(this.scaleNm, 0)} nm`;
          break;
        case 'mask':
          v = ga > 0.5;
          break;
        case 'target':
          v = stage === 3;
          break;
        case 'plasma':
          v = this.plasmaA > 0.5;
          break;
      }
      a.visible = v && ctx.big;
    }
    void NZ;
  }
}
