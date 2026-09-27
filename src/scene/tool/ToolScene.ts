import * as THREE from 'three';
import { OrbitRig, shot, type Shot } from '../OrbitRig';
import { WaferMesh, makeDieTexture, DIE_OFF, DIE_TEX, WAFER_R } from './Wafer';
import { Scanner, SCANNER_X } from './Scanner';
import { makeFloor, makePlinth, makeStationPlates, Coater, HotPlate, Etcher, Inspection, COATER_X, HOT_X, ETCH_X, PLINTH_TOP } from './Stations';
import { STAGES, type Station } from '../../core/stages';
import { SOURCES, spinRpm } from '../../core/params';
import { t, tOpt, nf } from '../../i18n';
import { ALL_DIES } from '../../sim/engine';
import type { Annotation, FrameContext } from '../types';
import { easeInOut, smoothstep, damp } from '../fx';

const SHOTS: Shot[] = [
  shot(COATER_X, 1.3, 0, 9.4, 24, 52), // prep
  shot(COATER_X, 1.3, 0, 8.8, 12, 47), // coat
  shot(HOT_X, 1.3, 0.1, 9.2, 20, 55), // soft bake
  shot(SCANNER_X, 3.3, 0, 13.5, 26, 74), // align
  shot(SCANNER_X, 4.3, 0, 17.5, 30, 79), // expose
  shot(HOT_X, 1.3, 0.1, 9.2, -16, 55), // PEB
  shot(COATER_X, 1.3, 0, 9.0, -18, 48), // develop
  shot(ETCH_X, 1.7, 0.1, 10.5, -22, 64), // etch
  shot(-0.3, 3.75, 2.2, 6.2, 4, 86), // result
];
const OVERVIEW = shot(0.4, 3.0, 0, 25, 18, 71);

/** Serpentine exposure order across the wafer. */
const EXPOSE_ORDER = [...ALL_DIES].sort((a, b) => (a.j !== b.j ? b.j - a.j : (b.j % 2 === 0 ? 1 : -1) * (a.i - b.i)));

export class ToolScene {
  scene = new THREE.Scene();
  rig = new OrbitRig(30);
  scanner = new Scanner();
  coater = new Coater();
  hot = new HotPlate();
  etcher = new Etcher();
  inspect = new Inspection();
  wafer = new WaferMesh();
  carrier = new THREE.Group();
  dieTex = makeDieTexture();
  annotations: Annotation[] = [];
  private at: Station = 'coater';
  private trip: { curve: THREE.CatmullRomCurve3; t: number; dur: number; to: Station; yaw0: number } | null = null;
  private yaw = 0;
  private spin = 0;
  private lastStage = -1;
  private lastExposed = -1;
  private lastPass = '';
  private heat = 0;
  private lid = 0;
  private bell = 0;
  private plasma = 0;
  private beamsOn = 0;
  private puddle = 0;
  private map = 0;
  private float = 0;
  private stageOff = new THREE.Vector2();
  keyLight: THREE.DirectionalLight;
  plates: ReturnType<typeof makeStationPlates>;
  exposingInfo = { die: -1, total: EXPOSE_ORDER.length };
  blockedOrders = false;
  firstOrderCapture = 1;
  /** While the title screen is up the camera idles on a slow overview orbit. */
  introMode = true;

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color('#07080a');
    s.fog = new THREE.FogExp2('#07080a', 0.021);
    s.add(makeFloor(), makePlinth());
    this.plates = makeStationPlates();
    s.add(this.plates.group);
    s.add(this.coater.group, this.hot.group, this.scanner.group, this.etcher.group);
    this.carrier.add(this.wafer, this.inspect.group);
    s.add(this.carrier);
    this.wafer.u.uDies.value = this.dieTex;

    const hemi = new THREE.HemisphereLight(0x39404c, 0x0a0a0c, 0.35);
    s.add(hemi);
    const key = new THREE.DirectionalLight(0xfff0dc, 1.7);
    key.position.set(-7, 15, 11);
    key.target.position.set(0, 1, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -11;
    sc.right = 11;
    sc.top = 9;
    sc.bottom = -6;
    sc.near = 1;
    sc.far = 45;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.025;
    s.add(key, key.target);
    this.keyLight = key;
    const rim = new THREE.DirectionalLight(0x9fb3ff, 1.3);
    rim.position.set(5, 7, -11);
    s.add(rim);
    const warm = new THREE.PointLight(0xffa640, 18, 18, 2);
    warm.position.set(-1, 2.6, 6);
    s.add(warm);
    const warm2 = new THREE.PointLight(0xffb45a, 14, 12, 2);
    warm2.position.set(-7, 3.5, 3);
    s.add(warm2);

    this.rig.minR = 2.2;
    this.rig.maxR = 30;
    this.rig.maxPhi = 1.52;
    this.rig.targetClamp = new THREE.Box3(new THREE.Vector3(-9, 0.5, -3), new THREE.Vector3(9, 7, 4));
    this.rig.shot(OVERVIEW, 0);

    // annotations
    const A = (id: string, title: string, obj: THREE.Object3D, offset: [number, number, number], side: 'left' | 'right' = 'right', sub?: string): Annotation => ({ id, title, sub, obj, offset: new THREE.Vector3(...offset), visible: false, side });
    const sc2 = this.scanner.anchors;
    this.annotations = [
      A('source', 'Light source', sc2.lamp, [0.55, 0.45, 0], 'right'),
      A('illum', 'Illuminator', sc2.illum, [0.75, 0.5, 0], 'right', 'Shapes and evens out the light'),
      A('reticle', 'Photomask', sc2.reticle, [-0.52, 0.02, 0.3], 'left', 'Chrome on quartz · pattern at 4×'),
      A('lens', 'Projection lens', sc2.lens, [-0.72, 0.4, 0], 'left', 'Shrinks the image 4×'),
      A('pupil', 'Pupil', sc2.pupil, [0.5, 0, 0], 'right', 'Orders outside it are lost'),
      A('water', 'Immersion water', sc2.water, [0.25, 0, 0.1], 'right', 'Raises NA to 1.35'),
      A('stage', 'Wafer stage', sc2.stage, [1.02, 0.1, 0.6], 'right', 'Steps die to die, nm-precise'),
      A('coater', 'Spin coater', this.coater.anchor, [1.25, 0.1, 0], 'right'),
      A('hot', 'Hot plate', this.hot.anchor, [1.25, 0.2, 0], 'right'),
      A('etcher', 'Plasma etcher', this.etcher.anchor, [1.35, 0.3, 0], 'right', 'Directional ion etch'),
      A('wafer', 'Silicon wafer', this.wafer, [WAFER_R * 0.7, 0.02, WAFER_R * 0.5], 'right', '300 mm'),
    ];
  }

  private pose(st: Station, out: THREE.Vector3) {
    switch (st) {
      case 'coater':
        return out.set(COATER_X, this.coater.chuckY, 0);
      case 'hotplate':
        return out.set(HOT_X, this.hot.plateY + 0.01, 0);
      case 'scanner':
        return this.scanner.waferSocket.getWorldPosition(out);
      case 'etcher':
        return out.set(ETCH_X, this.etcher.chuckY, 0);
      case 'inspect':
        return out.set(-0.3, 3.7, 2.2);
    }
  }

  private startTrip(to: Station) {
    const a = this.pose(this.at, new THREE.Vector3());
    const b = this.pose(to, new THREE.Vector3());
    const hi = 2.35;
    const front = 2.0;
    const pts = [a.clone(), new THREE.Vector3(a.x, hi, a.z + 0.2)];
    if (this.at === 'scanner') pts.splice(1, 1, new THREE.Vector3(a.x, a.y, 0.9), new THREE.Vector3(a.x, a.y + 0.05, front), new THREE.Vector3(a.x, hi, front));
    else pts.push(new THREE.Vector3(a.x + (b.x - a.x) * 0.12, hi + 0.15, front));
    if (to === 'scanner') pts.push(new THREE.Vector3(b.x - (b.x - a.x) * 0.12, hi, front), new THREE.Vector3(b.x, b.y + 0.05, front), new THREE.Vector3(b.x, b.y, 0.9), b.clone());
    else if (to === 'inspect') pts.push(new THREE.Vector3(b.x, b.y - 0.3, b.z + 0.3), b.clone());
    else pts.push(new THREE.Vector3(b.x - (b.x - a.x) * 0.12, hi + 0.15, front), new THREE.Vector3(b.x, hi, b.z + 0.2), b.clone());
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const dist = a.distanceTo(b);
    this.trip = { curve, t: 0, dur: THREE.MathUtils.clamp(1.4 + dist * 0.12, 1.6, 2.8), to, yaw0: this.yaw };
  }

  /** Called when the stage changes. */
  enterStage(stage: number, instant = false) {
    const st = STAGES[stage].station;
    if (instant) {
      this.at = st;
      this.trip = null;
    } else if (st !== this.at || this.trip) {
      if (this.trip) this.at = this.trip.to;
      if (st !== this.at) this.startTrip(st);
    }
    this.rig.shot(SHOTS[stage], instant ? 0 : 2.3);
    this.lastStage = stage;
  }

  overview() {
    this.rig.shot(OVERVIEW, 2);
  }

  update(ctx: FrameContext) {
    const { dt, time, state, ps, sim } = ctx;
    const stage = state.stage;
    const p = state.progress[stage];
    const params = sim.params;
    const src = SOURCES[params.source];
    if (this.introMode) this.rig.goal.theta += dt * 0.025;
    else if (this.lastStage !== stage) this.enterStage(stage);
    const playing = state.playing === stage && p > 0 && p < 1;

    // ── scanner configuration
    this.scanner.setSource(src);
    this.scanner.setExploded(state.exploded);
    const orderInfo = this.scanner.layoutOrders(params);
    this.firstOrderCapture = orderInfo.capture;
    this.scanner.water.visible = src.immersion;
    this.scanner.updateSources(dt, time, src.kind, this.beamsOn);

    // stage stepping & alignment offset (exaggerated ×4000 for visibility)
    const alignK = 0.004;
    let tx = params.alignX * alignK;
    let tz = -params.alignY * alignK;
    let flash = 0;
    let exposedCount = stage > 4 ? EXPOSE_ORDER.length : 0;
    if (stage === 4 && p > 0) {
      const s = Math.min(p, 0.9999) * EXPOSE_ORDER.length;
      const i0 = Math.floor(s);
      const f = s - i0;
      const d0 = EXPOSE_ORDER[i0];
      const d1 = EXPOSE_ORDER[Math.min(i0 + 1, EXPOSE_ORDER.length - 1)];
      const fx = THREE.MathUtils.lerp(d0.x, d1.x, smoothstep(0.55, 1, f));
      const fy = THREE.MathUtils.lerp(d0.y, d1.y, smoothstep(0.55, 1, f));
      if (p < 1) {
        tx += -fx * WAFER_R;
        tz += fy * WAFER_R;
        flash = playing ? Math.pow(Math.sin(Math.PI * Math.min(f / 0.55, 1)), 2) : 0;
        this.wafer.u.uFlashDie.value.set(d0.i, d0.j);
        this.exposingInfo.die = i0;
      }
      exposedCount = p >= 1 ? EXPOSE_ORDER.length : i0;
    } else this.exposingInfo.die = -1;
    this.stageOff.x = damp(this.stageOff.x, tx, stage === 4 && playing ? 30 : 6, dt);
    this.stageOff.y = damp(this.stageOff.y, tz, stage === 4 && playing ? 30 : 6, dt);
    this.scanner.stage.position.set(this.stageOff.x, 0, this.stageOff.y);
    this.wafer.u.uFlash.value = flash;
    (this.wafer.u.uFlashColor.value as THREE.Color).set(src.color);

    // die texture: exposure + yield map
    const passKey = sim.wafer ? sim.version + ':' + sim.wafer.yield : '';
    if (exposedCount !== this.lastExposed || passKey !== this.lastPass) {
      this.lastExposed = exposedCount;
      this.lastPass = passKey;
      const data = this.dieTex.image.data as Uint8Array;
      data.fill(0);
      EXPOSE_ORDER.forEach((d, k) => {
        const idx = ((d.j + DIE_OFF) * DIE_TEX + (d.i + DIE_OFF)) * 4;
        data[idx] = k < exposedCount ? 255 : 0;
        data[idx + 2] = 255;
      });
      if (sim.wafer)
        for (const d of sim.wafer.dies) {
          const idx = ((d.j + DIE_OFF) * DIE_TEX + (d.i + DIE_OFF)) * 4;
          data[idx + 1] = d.pass ? 255 : 0;
        }
      this.dieTex.needsUpdate = true;
    }

    // beams
    const beamTarget = this.introMode ? 0.75 : stage === 4 ? 1 : 0;
    this.beamsOn = damp(this.beamsOn, beamTarget, 4, dt);
    this.blockedOrders = !!this.scanner.updateBeams(time, this.beamsOn, flash, params.focus, 0);
    const alignOn = stage === 3 ? 1 : 0;
    this.scanner.alignLasers(alignOn, time, new THREE.Vector3(this.stageOff.x, 0, this.stageOff.y));
    const rc = (this.scanner.reticle.userData as { carriage: THREE.Group }).carriage;
    rc.position.x = flash > 0 || playing ? Math.sin(time * 9) * 0.06 : damp(rc.position.x, 0, 4, dt);

    // ── coater choreography
    const c = this.coater;
    const atCoater = this.at === 'coater' && !this.trip;
    let armIn = 0;
    let spinRate = 0;
    let coatR = stage > 1 ? 1.2 : 0;
    const u = this.wafer.u;
    let wet = 0;
    const tmpV = new THREE.Vector3();
    if (atCoater && stage === 0) {
      armIn = playing || (p > 0 && p < 1) ? 1 : 0;
      spinRate = p > 0 && p < 1 ? 18 : 0;
      if (p > 0 && p < 1) {
        wet = 1;
        for (let k = 0; k < 6; k++) {
          c.nozzleTip.getWorldPosition(tmpV);
          c.spray.emit(tmpV.sub(c.group.position), new THREE.Vector3((Math.random() - 0.5) * 0.4, -2.5, (Math.random() - 0.5) * 0.4), 0.5);
          const a = Math.random() * Math.PI * 2;
          c.fling.emit(new THREE.Vector3(Math.cos(a) * WAFER_R, c.chuckY + 0.02, Math.sin(a) * WAFER_R), new THREE.Vector3(Math.cos(a) * 2.2 - Math.sin(a) * 1.4, 0.4, Math.sin(a) * 2.2 + Math.cos(a) * 1.4), 0.5);
        }
        (c.fling.points.material as THREE.ShaderMaterial).uniforms.uColor.value.set('#bfe4ff');
      }
    }
    if (atCoater && stage === 1) {
      armIn = p > 0 && p < 0.8 ? 1 : 0;
      const drop = p > 0.02 && p < 0.16;
      c.drop.visible = drop;
      if (drop) {
        const f = (p - 0.02) / 0.14;
        c.nozzleTip.getWorldPosition(tmpV);
        tmpV.sub(c.group.position);
        c.drop.position.set(0, THREE.MathUtils.lerp(tmpV.y, c.chuckY + 0.03, f * f), 0);
        c.drop.scale.set(1, 1 + f * 0.6, 1);
      }
      coatR = p < 0.16 ? 0 : p < 0.35 ? THREE.MathUtils.lerp(0.02, 0.35, (p - 0.16) / 0.19) : p < 0.72 ? THREE.MathUtils.lerp(0.35, 1.05, easeInOut((p - 0.35) / 0.37)) : 1.2;
      spinRate = p < 0.16 ? 0 : p < 0.35 ? 3 : p < 0.9 ? 30 : 30 * (1 - (p - 0.9) / 0.1);
      if (p > 0.45 && p < 0.9) {
        (c.fling.points.material as THREE.ShaderMaterial).uniforms.uColor.value.set('#ffb35c');
        for (let k = 0; k < 5; k++) {
          const a = Math.random() * Math.PI * 2;
          c.fling.emit(new THREE.Vector3(Math.cos(a) * WAFER_R, c.chuckY + 0.02, Math.sin(a) * WAFER_R), new THREE.Vector3(Math.cos(a) * 2.6 - Math.sin(a) * 1.8, 0.3, Math.sin(a) * 2.6 + Math.cos(a) * 1.8), 0.45);
        }
      }
    } else c.drop.visible = false;
    if (atCoater && stage === 6) {
      armIn = p > 0 && p < 0.25 ? 1 : 0;
      this.puddle = damp(this.puddle, p > 0.05 && p < 0.88 ? 1 : 0, 5, dt);
      spinRate = p > 0.88 && p < 1 ? 26 : p > 0.05 && p < 0.88 ? 0.6 : 0;
    } else this.puddle = damp(this.puddle, stage === 0 && p > 0 && p < 1 ? 0.6 : 0, 5, dt);
    c.arm.rotation.y = damp(c.arm.rotation.y, armIn ? -0.62 : 0.55, 4, dt);
    this.spin = damp(this.spin, atCoater ? spinRate : 0, 3, dt);
    this.yaw += this.spin * dt;
    c.spinner.rotation.y = this.yaw;
    c.spray.update(dt);
    c.fling.update(dt);
    // puddle geometry (developer / DI water)
    const pr = this.puddle;
    this.wafer.puddle.scale.set(WAFER_R * 0.98 * Math.min(1, pr * 1.3), 0.03 * pr + 0.0001, WAFER_R * 0.98 * Math.min(1, pr * 1.3));
    this.wafer.puddle.visible = pr > 0.01;
    wet = Math.max(wet, pr);

    // ── hot plate
    const atHot = this.at === 'hotplate' && !this.trip;
    const baking = atHot && (stage === 2 || stage === 5) && p > 0 && p < 1 && state.playing === stage;
    this.heat = damp(this.heat, baking ? 1 : atHot && (stage === 2 || stage === 5) && p < 1 ? 0.08 : 0, baking ? 3 : 1.5, dt);
    this.hot.heatMat.uniforms.uHeat.value = this.heat;
    this.hot.heatMat.uniforms.uTime.value = time;
    const lidClosed = atHot && (stage === 2 || stage === 5) && p > 0 && p < 1;
    this.lid = damp(this.lid, lidClosed ? 0.12 : 1, 3, dt);
    this.hot.setLid(this.lid);
    if (baking && stage === 2) {
      for (let k = 0; k < 2; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * WAFER_R;
        this.hot.vapor.emit(new THREE.Vector3(Math.cos(a) * r, this.hot.plateY + 0.03, Math.sin(a) * r), new THREE.Vector3((Math.random() - 0.5) * 0.1, 0.25 + Math.random() * 0.2, (Math.random() - 0.5) * 0.1), 2.2);
      }
    }
    this.hot.vapor.update(dt, (l) => Math.min(1, l) * Math.min(1, (2.2 - l) * 3));
    u.uHeat.value = atHot ? this.heat : 0;

    // ── etcher
    const atEtch = this.at === 'etcher' && !this.trip;
    const loading = (this.trip && (this.trip.to === 'etcher' || this.at === 'etcher')) || (atEtch && (p <= 0 || p >= 1) && stage === 7 && false);
    this.bell = damp(this.bell, loading ? 1 : 0, 3, dt);
    this.etcher.bell.position.y = this.bell * 1.15;
    const etching = atEtch && stage === 7 && p > 0 && p < 1;
    this.plasma = damp(this.plasma, etching ? 1 : 0, etching ? 5 : 2, dt);
    const pm = this.etcher.plasmaMat.uniforms;
    pm.uOn.value = this.plasma * (0.85 + 0.15 * Math.sin(time * 31));
    pm.uTime.value = time;
    const core = (this.etcher.plasma.userData as { core: THREE.Sprite }).core;
    (core.material as THREE.SpriteMaterial).opacity = this.plasma * 0.28;
    this.etcher.glowLight.intensity = this.plasma * 4;
    this.etcher.coilMat.color.set('#d08b4c').multiplyScalar(1 + this.plasma * 2.5);
    if (etching) {
      for (let k = 0; k < 8; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * WAFER_R;
        this.etcher.ions.emit(new THREE.Vector3(Math.cos(a) * r, this.etcher.chuckY + 0.85, Math.sin(a) * r), new THREE.Vector3(0, -2.4, 0), 0.35);
      }
    }
    this.etcher.ions.update(dt);

    // ── inspection
    const atInspect = this.at === 'inspect' && !this.trip;
    this.inspect.ringMat.color.set('#f5efe4').multiplyScalar(atInspect ? 1.15 : 0.001);
    this.inspect.group.visible = stage === 8 && this.at === 'inspect';
    this.inspect.group.scale.setScalar(0.9 + 0.1 * this.float);
    this.map = damp(this.map, stage === 8 && (p >= 1 || state.waferMap) ? 1 : 0, 3, dt);
    u.uMap.value = this.map;

    // ── wafer transport
    const pos = new THREE.Vector3();
    let tilt = 0;
    if (this.trip) {
      this.trip.t += dt / this.trip.dur;
      const e = easeInOut(Math.min(1, this.trip.t));
      this.trip.curve.getPointAt(e, pos);
      const turns = Math.round(this.trip.yaw0 / (Math.PI * 2));
      this.yaw = THREE.MathUtils.lerp(this.trip.yaw0, turns * Math.PI * 2, e);
      if (this.trip.to === 'inspect') tilt = e * 1.12;
      if (this.at === 'inspect') tilt = (1 - e) * 1.12;
      if (this.trip.t >= 1) {
        this.at = this.trip.to;
        this.trip = null;
      }
    } else {
      this.pose(this.at, pos);
      if (this.at === 'inspect') tilt = 1.12;
    }
    this.float = damp(this.float, this.at === 'inspect' && !this.trip ? 1 : 0, 2, dt);
    if (this.float > 0.001) {
      pos.y += Math.sin(time * 0.9) * 0.03 * this.float;
      this.yaw += dt * 0.12 * this.float;
    }
    this.carrier.position.copy(pos);
    this.carrier.rotation.set(tilt, 0, 0);
    this.wafer.rotation.y = this.yaw;

    // ── wafer surface state
    const th = params.thickness;
    u.uClean.value = ps.clean;
    u.uCoatR.value = coatR;
    const thickDisplay = stage === 1 ? th * 1.12 : stage === 2 ? th * (1.12 - 0.12 * ps.softBake) : th;
    const erosion = (params.etchDepth * ps.etched) / 4;
    u.uResist.value = ps.coat > 0 || stage > 1 ? Math.max(0, (ps.developed > 0 ? th - erosion : thickDisplay) * (1 - ps.stripped)) : 0;
    u.uThick.value = th;
    u.uPatterned.value = ps.developed;
    u.uLatent.value = ps.exposed > 0 ? 1 - ps.developed : 0;
    u.uIrid.value = ps.developed * (0.4 + 0.6 * ps.stripped);
    u.uWet.value = wet;
    u.uTime.value = time;
    u.uPattern.value = sim.waferTex;
    this.scanner.reticleUniforms.uMask.value = sim.maskTex;

    // ── station LEDs: the active station glows and breathes
    for (const [id, mat] of Object.entries(this.plates.leds)) {
      const active = !this.introMode && STAGES[stage].station === id;
      const busy = active && playing;
      const k = active ? (busy ? 2.2 + 1.4 * Math.sin(time * 9) : 1.4 + 0.5 * Math.sin(time * 2.2)) : 0.18;
      mat.color.set(busy ? '#b9a6ff' : '#ffae42').multiplyScalar(k);
    }

    // ── annotations
    const vis: Record<string, boolean> = {
      source: stage === 4,
      illum: stage === 4 && state.exploded > 0.3,
      reticle: stage === 3 || stage === 4,
      lens: stage === 3 || stage === 4,
      pupil: stage === 4,
      water: stage === 4 && src.immersion,
      stage: stage === 3,
      coater: (stage === 0 || stage === 1 || stage === 6) && !this.trip,
      hot: (stage === 2 || stage === 5) && !this.trip,
      etcher: stage === 7 && !this.trip,
      wafer: stage === 0 && !this.trip,
    };
    for (const a of this.annotations) {
      a.visible = !!vis[a.id] && ctx.big;
      if (!a.visible) continue;
      a.title = t(`ann.${a.id}`);
      a.sub = tOpt(`ann.${a.id}.sub`) || undefined;
      if (a.id === 'source') {
        a.obj = src.kind === 'lamp' ? this.scanner.anchors.lamp : src.kind === 'laser' ? this.scanner.anchors.laser : this.scanner.anchors.euv;
        a.offset = src.kind === 'lamp' ? new THREE.Vector3(0.56, 0.3, 0) : new THREE.Vector3(0.4, 0.35, 0.8);
        a.sub = `${t(`src.label.${src.id}`)} · ${nf(src.lambda, src.lambda < 20 ? 1 : 0)} nm · ${t(`src.era.${src.id}`)}`;
      }
      if (a.id === 'coater' && stage === 1) a.sub = `${nf(spinRpm(th), 0)} rpm → ${nf(th, 0)} nm`;
      else if (a.id === 'coater') a.sub = stage === 6 ? t('ann.coater.dev') : t('ann.coater.rinse');
      if (a.id === 'hot') a.sub = stage === 2 ? '≈ 100 °C · 60 s' : '≈ 110 °C · 60 s';
      if (a.id === 'pupil') a.sub = this.firstOrderCapture <= 0.001 ? t('ann.pupil.blocked') : this.firstOrderCapture < 0.999 ? t('ann.pupil.partial') : t('ann.pupil.ok');
      a.accent = a.id === 'pupil' && this.firstOrderCapture < 0.35;
    }
    void PLINTH_TOP;
  }
}
