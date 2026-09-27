import * as THREE from 'three';
import { M, roundedBox, lensGeometry, cutawayCylinder } from './materials';
import { Beam, softSprite } from '../fx';
import type { SourceSpec, Params } from '../../core/params';
import { LAYOUTS } from '../../sim/patterns';

export const SCANNER_X = 1.7;
export const WAFER_TOP_SCANNER = 1.412;
const PUPIL_Y = 3.05;
const PUPIL_R = 0.5;
const RETICLE_Y = 4.78;
const SIGMA = 0.5;

interface Order {
  beamIn: Beam;
  beamOut: Beam;
  beamOut2: Beam;
  fx: number;
  fz: number;
  weight: number;
  pass: number;
  blockPt: THREE.Vector3 | null;
  splash: THREE.Sprite;
}

/** The exposure tool: source → illuminator → reticle → projection optics → wafer stage. */
export class Scanner {
  group = new THREE.Group();
  stage = new THREE.Group();
  waferSocket = new THREE.Object3D();
  lamp = new THREE.Group();
  laser = new THREE.Group();
  euv = new THREE.Group();
  illum = new THREE.Group();
  condenser: THREE.Mesh;
  reticle = new THREE.Group();
  reticleMat: THREE.MeshPhysicalMaterial;
  reticleUniforms = { uMask: { value: null as THREE.Texture | null }, uRepeat: { value: 7 }, uGlow: { value: 0 }, uAlign: { value: 0 } };
  lensGroup = new THREE.Group();
  lenses: { mesh: THREE.Object3D; y: number }[] = [];
  barrel: THREE.Group;
  barrelMats: THREE.Material[] = [];
  water: THREE.Mesh;
  pupilRing: THREE.Mesh;
  anchors: Record<string, THREE.Object3D> = {};
  // beams
  srcBeam: Beam;
  srcBeam2: Beam;
  illumBeam: Beam;
  orders: Order[] = [];
  focusGlow: THREE.Sprite;
  alignBeams: Beam[] = [];
  bulb: THREE.Mesh;
  laserWindow: THREE.Mesh;
  plasma: THREE.Sprite;
  droplets: THREE.InstancedMesh;
  lensGlass: THREE.MeshPhysicalMaterial;
  lensCap!: THREE.MeshPhysicalMaterial;
  lensMirror: THREE.MeshPhysicalMaterial;
  private src: SourceSpec | null = null;
  private exploded = 0;
  private baseY = new Map<THREE.Object3D, number>();
  sourceBlend = { lamp: 1, laser: 0, euv: 0 };

  constructor() {
    const g = this.group;
    g.position.x = SCANNER_X;
    const panel = M.panel();
    const dark = M.dark();
    const steel = M.steel();

    // ── base & stage
    const base = new THREE.Mesh(roundedBox(3.1, 0.3, 2.6, 0.12), M.stone());
    base.position.y = 0.9;
    base.receiveShadow = true;
    base.castShadow = true;
    g.add(base);
    for (const z of [-0.95, 0.95]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.03, 0.08), steel);
      rail.position.set(0, 1.215, z);
      g.add(rail);
    }
    const stageBody = new THREE.Mesh(roundedBox(2.05, 0.15, 2.05, 0.08), M.ceramic());
    stageBody.castShadow = true;
    stageBody.receiveShadow = true;
    stageBody.position.y = 1.21;
    this.stage.add(stageBody);
    const chuck = new THREE.Mesh(new THREE.CylinderGeometry(0.93, 0.93, 0.04, 96), M.darker());
    chuck.position.y = 1.38;
    chuck.receiveShadow = true;
    this.stage.add(chuck);
    this.waferSocket.position.y = 1.4;
    this.stage.add(this.waferSocket);
    g.add(this.stage);

    // ── metrology frame: two back pillars and a bridge carrying the lens
    for (const x of [-1.25, 1.25]) {
      const p = new THREE.Mesh(roundedBox(0.34, 5.6, 0.34, 0.06), panel);
      p.position.set(x, 1.2, -1.05);
      p.castShadow = true;
      g.add(p);
    }
    const bridge = new THREE.Mesh(roundedBox(2.84, 0.22, 0.5, 0.06), panel);
    bridge.position.set(0, 4.4, -0.95);
    bridge.castShadow = true;
    g.add(bridge);
    const bridge2 = new THREE.Mesh(roundedBox(2.84, 0.18, 0.5, 0.06), panel);
    bridge2.position.set(0, 2.2, -0.95);
    g.add(bridge2);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.6), panel);
    arm.position.set(0, 4.47, -0.55);
    g.add(arm);

    // ── projection lens barrel (cut away)
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.4, metalness: 0.8 });
    const shellOuter = M.panel();
    const shellInner = new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.6, metalness: 0.4 });
    this.barrel = cutawayCylinder(0.72, 2.35, shellOuter, shellInner, edgeMat, Math.PI * 0.62, 0.06);
    this.barrel.position.y = 1.95 + 2.35 / 2;
    this.barrelMats = [shellOuter, shellInner, edgeMat];
    g.add(this.barrel);
    for (const y of [1.95, 4.3, 3.2]) {
      const fl = cutawayCylinder(0.76, 0.06, steel, shellInner, edgeMat, Math.PI * 0.62, 0.1);
      fl.position.y = y;
      g.add(fl);
    }
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.17, 0.43, 64, 1, true), M.panel());
    nose.position.y = 1.52 + 0.43 / 2;
    nose.castShadow = true;
    g.add(nose);
    const noseRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.012, 12, 64), steel);
    noseRing.rotation.x = Math.PI / 2;
    noseRing.position.y = 1.52;
    g.add(noseRing);

    this.lensGlass = M.glass();
    this.lensMirror = M.mirror();
    const lensSpec: [number, number, number, number, number][] = [
      // y, R, sagTop, sagBottom, edge
      [4.08, 0.56, 0.06, 0.04, 0.05],
      [3.72, 0.61, 0.09, 0.07, 0.05],
      [3.38, 0.59, -0.03, 0.08, 0.06],
      [2.78, 0.61, 0.08, -0.02, 0.05],
      [2.44, 0.57, 0.07, 0.07, 0.05],
      [2.12, 0.52, 0.05, 0.02, 0.05],
      [1.74, 0.32, 0.05, 0.0, 0.04],
    ];
    this.lensCap = new THREE.MeshPhysicalMaterial({ color: 0xcfe6ff, metalness: 0, roughness: 0.22, transparent: true, opacity: 0.55, clearcoat: 1, envMapIntensity: 1.2, side: THREE.DoubleSide, depthWrite: false });
    for (const [y, R, st, sb, e] of lensSpec) {
      const mesh = cutLens(R, st, sb, e, this.lensGlass, this.lensCap);
      mesh.position.y = y;
      this.lensGroup.add(mesh);
      this.lenses.push({ mesh, y });
    }
    g.add(this.lensGroup);
    // aperture stop (pupil)
    this.pupilRing = new THREE.Mesh(new THREE.RingGeometry(PUPIL_R, 0.66, 96), new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
    this.pupilRing.rotation.x = -Math.PI / 2;
    this.pupilRing.position.y = PUPIL_Y;
    g.add(this.pupilRing);
    const pupilEdge = new THREE.Mesh(new THREE.TorusGeometry(PUPIL_R, 0.006, 8, 128), M.glow('#b9a6ff', 1.2));
    pupilEdge.rotation.x = Math.PI / 2;
    pupilEdge.position.y = PUPIL_Y + 0.002;
    g.add(pupilEdge);
    this.anchors.pupil = pupilEdge;

    // immersion water
    this.water = new THREE.Mesh(
      new THREE.CylinderGeometry(0.21, 0.26, 0.108, 64),
      new THREE.MeshPhysicalMaterial({ color: 0x9fd4ff, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.45, clearcoat: 1, envMapIntensity: 1.5, depthWrite: false }),
    );
    this.water.position.y = WAFER_TOP_SCANNER + 0.054;
    g.add(this.water);
    this.anchors.water = this.water;

    // ── reticle stage
    for (const z of [-0.62, 0.62]) {
      const rail = new THREE.Mesh(roundedBox(2.4, 0.1, 0.14, 0.03), dark);
      rail.position.set(0, RETICLE_Y - 0.1, z);
      rail.castShadow = true;
      this.reticle.add(rail);
    }
    const carriage = new THREE.Group();
    for (const [x, z, w, d] of [
      [0, 0.52, 1.3, 0.12],
      [0, -0.52, 1.3, 0.12],
      [0.6, 0, 0.1, 0.94],
      [-0.6, 0, 0.1, 0.94],
    ]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), M.ceramic());
      b.position.set(x, RETICLE_Y - 0.01, z);
      carriage.add(b);
    }
    this.reticleMat = this.makeReticleMaterial();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.03, 1.04), this.reticleMat);
    plate.position.y = RETICLE_Y;
    carriage.add(plate);
    const pellicle = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.9), M.window());
    pellicle.position.y = RETICLE_Y - 0.045;
    carriage.add(pellicle);
    this.reticle.add(carriage);
    this.anchors.reticle = plate;
    (this.reticle.userData as { carriage: THREE.Group }).carriage = carriage;
    g.add(this.reticle);

    // ── condenser + illuminator
    this.condenser = new THREE.Mesh(lensGeometry(0.46, 0.07, 0.07, 0.05), this.lensGlass);
    this.condenser.position.y = 5.13;
    g.add(this.condenser);
    const ih = new THREE.Mesh(roundedBox(1.5, 0.9, 1.35, 0.12), panel);
    ih.castShadow = true;
    ih.position.y = 5.32;
    this.illum.add(ih);
    const slot = new THREE.Mesh(roundedBox(1.0, 0.36, 0.02, 0.04), M.darker());
    slot.position.set(0, 5.6, 0.68);
    this.illum.add(slot);
    // fly's-eye homogeniser visible through the slot
    const lenslet = new THREE.SphereGeometry(0.035, 12, 8);
    const fe = new THREE.InstancedMesh(lenslet, M.glow('#b9a6ff', 0.6), 11 * 3);
    let k = 0;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 11; i++)
      for (let j = 0; j < 3; j++) {
        m4.makeTranslation(-0.42 + i * 0.084, 5.66 - j * 0.1 + 0.01, 0.695);
        fe.setMatrixAt(k++, m4);
      }
    this.illum.add(fe);
    (this.illum.userData as { fe: THREE.InstancedMesh }).fe = fe;
    const iBottom = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 64), dark);
    iBottom.position.y = 5.3;
    this.illum.add(iBottom);
    g.add(this.illum);
    this.anchors.illum = ih;

    // ── sources
    // mercury lamp
    const lampHouse = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.56, 0.8, 64), panel);
    lampHouse.position.y = 6.62;
    lampHouse.castShadow = true;
    this.lamp.add(lampHouse);
    for (let i = 0; i < 6; i++) {
      const fin = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.025, 48), steel);
      fin.position.y = 7.08 + i * 0.055;
      this.lamp.add(fin);
    }
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), panel);
    cap.position.y = 7.4;
    this.lamp.add(cap);
    const reflector = new THREE.Mesh(new THREE.SphereGeometry(0.4, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.42), M.chrome());
    (reflector.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    reflector.rotation.x = 0;
    reflector.scale.set(1, 1.2, 1);
    reflector.position.y = 6.45;
    this.lamp.add(reflector);
    this.bulb = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.bulb.position.y = 6.7;
    this.lamp.add(this.bulb);
    const lampWin = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.3, 48, 1, true), M.window());
    lampWin.position.y = 6.2;
    this.lamp.add(lampWin);
    g.add(this.lamp);
    this.anchors.lamp = lampHouse;

    // excimer laser (behind the column, beam folded down by a periscope mirror)
    const lb = new THREE.Mesh(roundedBox(0.74, 0.62, 2.6, 0.1), panel);
    lb.position.set(0, 6.36, -2.55);
    lb.castShadow = true;
    this.laser.add(lb);
    this.laserWindow = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 2.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.laserWindow.position.set(0.375, 6.67, -2.55);
    this.laser.add(this.laserWindow);
    for (let i = 0; i < 9; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.02, 0.1), steel);
      fin.position.set(0, 7.0, -3.6 + i * 0.25);
      this.laser.add(fin);
    }
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.5, 32), M.window());
    tube.rotation.x = Math.PI / 2;
    tube.position.set(0, 6.67, -0.75);
    this.laser.add(tube);
    const periscope = new THREE.Mesh(roundedBox(0.44, 0.5, 0.44, 0.06), panel);
    periscope.position.set(0, 6.3, 0);
    this.laser.add(periscope);
    g.add(this.laser);
    this.anchors.laser = lb;

    // EUV: vacuum vessel with tin droplets, collector, plasma
    const vesselMat = M.panel();
    vesselMat.side = THREE.DoubleSide;
    const vessel = new THREE.Mesh(new THREE.SphereGeometry(0.72, 64, 32, Math.PI * 0.18, Math.PI * 1.64), vesselMat);
    vessel.position.set(0, 6.9, -2.3);
    vessel.castShadow = true;
    this.euv.add(vessel);
    const collector = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.35), this.lensMirror);
    collector.rotation.x = -Math.PI / 2 - 0.4;
    collector.position.set(0, 6.9, -2.62);
    (collector.material as THREE.MeshPhysicalMaterial).side = THREE.DoubleSide;
    this.euv.add(collector);
    this.plasma = new THREE.Sprite(new THREE.SpriteMaterial({ map: softSprite(), color: 0xcff7ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.plasma.position.set(0, 6.9, -2.2);
    this.plasma.scale.setScalar(0.4);
    this.euv.add(this.plasma);
    this.droplets = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 8, 6), M.chrome(), 24);
    this.euv.add(this.droplets);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 2.3, 32), panel);
    pipe.rotation.x = Math.PI / 2 - 0.42;
    pipe.position.set(0, 6.55, -1.05);
    this.euv.add(pipe);
    const euvPeri = new THREE.Mesh(roundedBox(0.5, 0.5, 0.5, 0.08), panel);
    euvPeri.position.set(0, 6.25, 0);
    this.euv.add(euvPeri);
    g.add(this.euv);
    this.anchors.euv = vessel;

    // ── beams
    this.srcBeam = new Beam('#fff', 0.07, 0.07);
    this.srcBeam2 = new Beam('#fff', 0.07, 0.07);
    this.illumBeam = new Beam('#fff', 0.36, 0.36);
    g.add(this.srcBeam, this.srcBeam2, this.illumBeam);
    for (let i = 0; i < 9; i++) {
      const o: Order = {
        beamIn: new Beam('#fff', 0.3, 0.25),
        beamOut: new Beam('#fff', 0.25, 0.02),
        beamOut2: new Beam('#fff', 0.02, 0.1),
        fx: 0,
        fz: 0,
        weight: 0,
        pass: 0,
        blockPt: null,
        splash: new THREE.Sprite(new THREE.SpriteMaterial({ map: softSprite(), color: 0xff6f61, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })),
      };
      o.beamIn.material.uniforms.uFadeIn.value = 0.02;
      o.beamOut.material.uniforms.uFadeOut.value = 0.02;
      o.beamOut2.material.uniforms.uFadeIn.value = 0.01;
      o.splash.scale.setScalar(0.18);
      o.splash.visible = false;
      g.add(o.beamIn, o.beamOut, o.beamOut2, o.splash);
      this.orders.push(o);
    }
    this.focusGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softSprite(), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.focusGlow.scale.setScalar(0.25);
    g.add(this.focusGlow);
    for (let i = 0; i < 2; i++) {
      const b = new Beam('#ff5a3c', 0.006, 0.006);
      b.material.uniforms.uStreaks.value = 0.3;
      this.alignBeams.push(b);
      g.add(b);
    }
    // alignment sensors
    for (const x of [-0.55, 0.55]) {
      const s = new THREE.Mesh(roundedBox(0.18, 0.12, 0.18, 0.03), dark);
      s.position.set(x, 1.6, 0.35);
      g.add(s);
    }
    this.anchors.stage = stageBody;
    this.anchors.lens = this.barrel;

    for (const o of [this.lamp, this.laser, this.euv, this.illum, this.condenser, this.reticle]) this.baseY.set(o, o.position.y);
  }

  private makeReticleMaterial() {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.05, transparent: true, clearcoat: 1, envMapIntensity: 1.3 });
    const U = this.reticleUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vRUv;\nvarying float vTopFace;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvRUv = uv; vTopFace = step(0.5, normal.y);');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vRUv; varying float vTopFace;
          uniform sampler2D uMask; uniform float uRepeat; uniform float uGlow; uniform float uAlign;
          float crossMark(vec2 p, vec2 c, float s, float w) { vec2 d = abs(p - c); return (step(d.x, w) * step(d.y, s) + step(d.y, w) * step(d.x, s)) > 0.0 ? 1.0 : 0.0; }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec2 q = vRUv;
          float inField = step(0.12, q.x) * step(q.x, 0.88) * step(0.12, q.y) * step(q.y, 0.88);
          float t = texture2D(uMask, (q - 0.12) / 0.76 * uRepeat).r;
          float chromeF = mix(1.0, 1.0 - t, inField);
          // alignment marks in the border
          float mk = crossMark(q, vec2(0.06, 0.5), 0.035, 0.006) + crossMark(q, vec2(0.94, 0.5), 0.035, 0.006);
          chromeF = clamp(chromeF - mk, 0.0, 1.0);
          chromeF = mix(0.0, chromeF, vTopFace);
          diffuseColor.rgb = mix(vec3(0.95, 0.98, 1.0), vec3(0.62, 0.64, 0.68), chromeF);
          diffuseColor.a = mix(0.14, 1.0, chromeF);
          float markGlow = mk * uAlign * vTopFace;
          `,
        )
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = chromeF;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.04, 0.22, chromeF);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.35, 0.22) * markGlow * 3.0 + vec3(0.73, 0.65, 1.0) * uGlow * (1.0 - chromeF) * inField * vTopFace;');
    };
    mat.customProgramCacheKey = () => 'reticle-v2';
    return mat;
  }

  setSource(src: SourceSpec) {
    this.src = src;
    const col = new THREE.Color(src.color);
    for (const b of [this.srcBeam, this.srcBeam2, this.illumBeam]) b.setColor(col);
    for (const o of this.orders) {
      o.beamIn.setColor(col);
      o.beamOut.setColor(col);
      o.beamOut2.setColor(col);
    }
    (this.focusGlow.material as THREE.SpriteMaterial).color.copy(col);
    (this.bulb.material as THREE.MeshBasicMaterial).color.copy(col).lerp(new THREE.Color('#ffffff'), 0.55).multiplyScalar(3);
    (this.laserWindow.material as THREE.MeshBasicMaterial).color.copy(col).multiplyScalar(2.5);
    const euv = src.kind === 'euv';
    for (const l of this.lenses)
      l.mesh.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).material = euv ? this.lensMirror : c.userData.cap ? this.lensCap : this.lensGlass;
      });
    this.condenser.material = euv ? this.lensMirror : this.lensGlass;
  }

  setExploded(e: number) {
    this.exploded = e;
    const lift = (o: THREE.Object3D, k: number) => (o.position.y = (this.baseY.get(o) ?? 0) + e * k);
    lift(this.lamp, 1.7);
    lift(this.laser, 1.7);
    lift(this.euv, 1.7);
    lift(this.illum, 1.25);
    lift(this.condenser, 1.0);
    lift(this.reticle, 0.7);
    for (const l of this.lenses) l.mesh.position.y = l.y + (l.y - 1.6) * e * 0.28;
    for (const m of this.barrelMats) {
      m.transparent = e > 0.01;
      m.opacity = 1 - e * 0.88;
      m.depthWrite = e < 0.5;
    }
  }

  /** Recompute diffraction orders for the current optics and pattern. */
  layoutOrders(p: Params) {
    const src = this.src!;
    const L = LAYOUTS[p.pattern];
    const P = L.pitch * p.halfPitch; // wafer-scale pitch
    const f1 = src.lambda / (P * src.NA); // pupil-normalised position of the first order
    const list: { fx: number; fz: number; w: number }[] = [{ fx: 0, fz: 0, w: 1 }];
    if (L.twoD) {
      list.push({ fx: f1, fz: 0, w: 0.55 }, { fx: -f1, fz: 0, w: 0.55 }, { fx: 0, fz: f1, w: 0.55 }, { fx: 0, fz: -f1, w: 0.55 });
    } else {
      list.push({ fx: f1, fz: 0, w: 0.6 }, { fx: -f1, fz: 0, w: 0.6 }, { fx: 2 * f1, fz: 0, w: 0.2 }, { fx: -2 * f1, fz: 0, w: 0.2 });
      if (p.pattern === 'logic') list.push({ fx: 0, fz: f1 * 0.9, w: 0.3 }, { fx: 0, fz: -f1 * 0.9, w: 0.3 });
    }
    this.orders.forEach((o, i) => {
      const d = list[i];
      if (!d) {
        o.weight = 0;
        return;
      }
      o.fx = d.fx;
      o.fz = d.fz;
      o.weight = d.w;
      const fr = Math.hypot(d.fx, d.fz);
      // fraction of the illumination disc (radius σ) inside the pupil
      o.pass = THREE.MathUtils.clamp((1 + SIGMA - fr) / (2 * SIGMA), 0, 1);
    });
    return { f1, capture: this.orders[1]?.pass ?? 0 };
  }

  /** Per-frame beam geometry. */
  updateBeams(time: number, on: number, flash: number, focusNm: number, reticleScan: number) {
    const src = this.src;
    if (!src) return;
    const ex = this.exploded;
    const srcY = this.lamp.position.y + 6.28 - (this.baseY.get(this.lamp) ?? 0);
    const illTop = this.illum.position.y - (this.baseY.get(this.illum) ?? 0) + 5.32;
    const illBot = illTop - 0.02;
    const retY = this.reticle.position.y - (this.baseY.get(this.reticle) ?? 0) + RETICLE_Y;
    const I = on * (0.42 + 1.25 * flash);
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    // source path
    if (src.kind === 'lamp') {
      this.srcBeam.span(v(0, srcY + 0.36, 0), v(0, illTop + 0.9, 0), 0.24, 0.3);
      this.srcBeam2.intensity = 0;
    } else if (src.kind === 'laser') {
      const y = 6.67 + ex * 1.7;
      this.srcBeam.span(v(0, y, -1.3), v(0, y, 0), 0.06, 0.06);
      this.srcBeam2.span(v(0, y, 0), v(0, illTop + 0.9, 0), 0.06, 0.2);
      this.srcBeam2.intensity = I;
    } else {
      const y = 6.9 + ex * 1.7;
      this.srcBeam.span(v(0, y, -2.2), v(0, 6.3 + ex * 1.7, 0), 0.03, 0.12);
      this.srcBeam2.span(v(0, 6.3 + ex * 1.7, 0), v(0, illTop + 0.9, 0), 0.12, 0.2);
      this.srcBeam2.intensity = I;
    }
    this.srcBeam.intensity = I;
    this.illumBeam.span(v(0, illBot, 0), v(0, retY + 0.02, 0), 0.3, 0.36);
    this.illumBeam.intensity = I * 0.8;
    for (const b of [this.srcBeam, this.srcBeam2, this.illumBeam]) b.tick(time);

    // diffraction orders: reticle → pupil → focus
    const pupilY = PUPIL_Y + ex * (PUPIL_Y - 1.6) * 0.28;
    const waferY = WAFER_TOP_SCANNER;
    const fY = waferY + THREE.MathUtils.clamp(focusNm, -420, 420) * 0.0011;
    const rs = SIGMA * PUPIL_R * 0.42;
    const top = v(reticleScan * 0.0, retY - 0.02, 0);
    let anyBlocked = false;
    for (const o of this.orders) {
      if (o.weight <= 0) {
        o.beamIn.intensity = 0;
        o.beamOut.intensity = 0;
        o.beamOut2.intensity = 0;
        o.splash.visible = false;
        continue;
      }
      const px = o.fx * PUPIL_R;
      const pz = o.fz * PUPIL_R;
      const pr = Math.hypot(px, pz);
      const wallR = 0.6;
      let end = v(px, pupilY, pz);
      let blocked = o.pass <= 0.001;
      if (pr > wallR) {
        // hits the barrel wall before the pupil
        const s = wallR / pr;
        end = v(px * s, top.y + (pupilY - top.y) * s, pz * s);
      }
      const a = o.weight * on;
      o.beamIn.span(top, end, 0.13, rs);
      o.beamIn.intensity = a * (0.5 + 1.2 * flash) * (blocked ? 0.7 : 1);
      o.beamIn.material.uniforms.uFadeOut.value = blocked ? 0.35 : 0.02;
      o.splash.visible = blocked && a > 0.01;
      if (blocked) {
        if (Math.abs(o.weight - 0.55) < 0.06 || Math.abs(o.weight - 0.6) < 0.01) anyBlocked = true;
        o.splash.position.copy(end);
        (o.splash.material as THREE.SpriteMaterial).opacity = 0.5 + 0.3 * Math.sin(time * 6);
        o.beamOut.intensity = 0;
        o.beamOut2.intensity = 0;
      } else {
        const pass = o.pass;
        const f = v(0, fY, 0);
        const P0 = v(px, pupilY, pz);
        if (fY >= waferY) {
          o.beamOut.span(P0, f, rs * pass + 0.03, 0.012);
          const dir = f.clone().sub(P0).normalize();
          const len = (fY - waferY) / Math.max(-dir.y, 0.1);
          o.beamOut2.span(f, f.clone().addScaledVector(dir, len), 0.012, 0.012 + len * 0.18);
          o.beamOut2.intensity = a * pass * (0.45 + 1.3 * flash);
        } else {
          const s = (pupilY - waferY) / (pupilY - fY);
          const e = P0.clone().lerp(f, s);
          o.beamOut.span(P0, e, rs * pass + 0.03, 0.012 + (rs * pass + 0.03) * (1 - s));
          o.beamOut2.intensity = 0;
        }
        o.beamOut.intensity = a * pass * (0.45 + 1.3 * flash);
      }
      o.beamIn.tick(time);
      o.beamOut.tick(time);
      o.beamOut2.tick(time);
    }
    this.focusGlow.position.set(0, fY, 0);
    (this.focusGlow.material as THREE.SpriteMaterial).opacity = on * (0.25 + flash);
    this.focusGlow.visible = on > 0.01;
    this.reticleUniforms.uGlow.value = on * (0.25 + flash * 1.4);
    const fe = (this.illum.userData as { fe: THREE.InstancedMesh }).fe;
    ((fe.material as THREE.MeshBasicMaterial).color as THREE.Color).set(src.color).multiplyScalar(0.3 + on * (0.8 + flash * 2));
    return anyBlocked;
  }

  updateSources(dt: number, time: number, kind: SourceSpec['kind'], on: number) {
    const target = { lamp: kind === 'lamp' ? 1 : 0, laser: kind === 'laser' ? 1 : 0, euv: kind === 'euv' ? 1 : 0 };
    const k = 1 - Math.exp(-dt * 5);
    (['lamp', 'laser', 'euv'] as const).forEach((key) => {
      this.sourceBlend[key] += (target[key] - this.sourceBlend[key]) * k;
      const grp = this[key];
      const s = this.sourceBlend[key];
      grp.visible = s > 0.02;
      grp.scale.setScalar(0.6 + 0.4 * THREE.MathUtils.smootherstep(s, 0, 1));
    });
    // lamp flicker / laser pulse / EUV plasma
    const bulb = this.bulb.material as THREE.MeshBasicMaterial;
    bulb.opacity = 1;
    this.plasma.scale.setScalar(0.15 + on * (0.35 + 0.25 * Math.max(0, Math.sin(time * 40))));
    (this.plasma.material as THREE.SpriteMaterial).opacity = 0.2 + on * 0.8;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 24; i++) {
      const f = (time * 0.9 + i / 24) % 1;
      m4.makeTranslation(0, 7.62 - f * 0.72 + (this.euv.position.y - 0), -2.2);
      this.droplets.setMatrixAt(i, m4);
    }
    this.droplets.instanceMatrix.needsUpdate = true;
  }

  alignLasers(on: number, time: number, target: THREE.Vector3) {
    this.alignBeams.forEach((b, i) => {
      const sx = i === 0 ? -0.55 : 0.55;
      const sweep = Math.sin(time * 2.2 + i * 1.7) * 0.05;
      b.span(new THREE.Vector3(sx, 1.56, 0.35), new THREE.Vector3(target.x + sx * 0.45 + sweep, WAFER_TOP_SCANNER + 0.002, target.z + 0.3), 0.006, 0.01);
      b.intensity = on * 1.4;
      b.tick(time);
    });
    this.reticleUniforms.uAlign.value = on;
  }
}

/** Lens element cut open like a museum section: a lathe with a gap facing the viewer plus glass caps showing the profile. */
function cutLens(R: number, sagTop: number, sagBottom: number, edge: number, glass: THREE.Material, cap: THREE.Material) {
  const g = new THREE.Group();
  const seg = 18;
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= seg; i++) {
    const r = (R * i) / seg;
    prof.push(new THREE.Vector2(r, edge / 2 + sagTop * (1 - (r / R) ** 2)));
  }
  for (let i = seg; i >= 0; i--) {
    const r = (R * i) / seg;
    prof.push(new THREE.Vector2(r, -edge / 2 - sagBottom * (1 - (r / R) ** 2)));
  }
  const gap = Math.PI * 0.62;
  const start = gap / 2;
  const len = Math.PI * 2 - gap;
  const lathe = new THREE.LatheGeometry(
    prof.map((p) => new THREE.Vector2(Math.max(p.x, 0.0001), p.y)),
    72,
    start,
    len,
  );
  lathe.computeVertexNormals();
  g.add(new THREE.Mesh(lathe, glass));
  const shape = new THREE.Shape(prof);
  const capGeo = new THREE.ShapeGeometry(shape);
  for (const phi of [start, start + len]) {
    const m = new THREE.Mesh(capGeo, cap);
    m.userData.cap = true;
    // shape lies in the XY plane with x = radius; rotate so +x points along the cut direction
    m.rotation.y = phi - Math.PI / 2;
    g.add(m);
  }
  return g;
}
