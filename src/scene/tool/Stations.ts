import * as THREE from 'three';
import { M, roundedBox } from './materials';
import { Particles, softSprite } from '../fx';
import { t } from '../../i18n';

export const PLINTH_TOP = 0.9;
export const COATER_X = -6.1;
export const HOT_X = -2.55;
export const ETCH_X = 5.75;

/** Floor with a faint engineering grid, fading into darkness. */
export function makeFloor() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW;
      float grid(vec2 p, float s, float w) { vec2 g = abs(fract(p / s - 0.5) - 0.5) * s; vec2 fw = fwidth(p) * 1.2; vec2 l = 1.0 - smoothstep(vec2(0.0), fw + w, g); return max(l.x, l.y); }
      void main() {
        float r = length(vW.xz * vec2(0.8, 1.0));
        float fade = exp(-r * r * 0.0045);
        vec3 base = vec3(0.022, 0.024, 0.028) * (0.6 + 0.8 * fade);
        float g1 = grid(vW.xz, 1.0, 0.004) * 0.05;
        float g2 = grid(vW.xz, 5.0, 0.008) * 0.06;
        vec3 col = base + vec3(0.55, 0.58, 0.64) * (g1 + g2) * fade;
        // warm pool under the bench (yellow-room light)
        float pool = exp(-pow(vW.z * 0.55, 2.0) - pow(vW.x * 0.09, 2.0));
        col += vec3(0.16, 0.09, 0.03) * pool * 0.35;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), mat);
  floor.rotation.x = -Math.PI / 2;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), new THREE.ShadowMaterial({ opacity: 0.45 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  shadow.receiveShadow = true;
  const g = new THREE.Group();
  g.add(floor, shadow);
  return g;
}

/** The long bench that carries every station, with a glowing amber "yellow room" edge. */
export function makePlinth() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(roundedBox(15.6, PLINTH_TOP, 3.4, 0.18), M.panelWarm());
  body.position.set(-0.2, 0, -0.1);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const top = new THREE.Mesh(roundedBox(15.5, 0.02, 3.3, 0.16), M.darker());
  top.position.set(-0.2, PLINTH_TOP - 0.012, -0.1);
  top.receiveShadow = true;
  g.add(top);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(15.2, 0.018, 0.02), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffae42').multiplyScalar(2.2) }));
  strip.position.set(-0.2, 0.2, 1.605);
  g.add(strip);
  // recessed kick
  const kick = new THREE.Mesh(new THREE.BoxGeometry(15.0, 0.12, 3.0), M.darker());
  kick.position.set(-0.2, 0.06, -0.1);
  g.add(kick);
  // station labels engraved as thin plates
  return g;
}

/** Spin coater / developer: bowl, chuck, dispense arm. */
export class Coater {
  group = new THREE.Group();
  chuckY = PLINTH_TOP + 0.45;
  arm = new THREE.Group();
  nozzleTip = new THREE.Object3D();
  drop: THREE.Mesh;
  dropMat: THREE.MeshPhysicalMaterial;
  spray: Particles;
  fling: Particles;
  spinner: THREE.Mesh;
  anchor = new THREE.Object3D();
  constructor() {
    const g = this.group;
    g.position.x = COATER_X;
    const housing = new THREE.Mesh(roundedBox(2.9, 0.2, 2.9, 0.12), M.panel());
    housing.position.y = PLINTH_TOP;
    housing.castShadow = true;
    housing.receiveShadow = true;
    g.add(housing);
    // bowl: lathe profile with rim
    const pts = [
      new THREE.Vector2(0.4, 0.0),
      new THREE.Vector2(1.18, 0.02),
      new THREE.Vector2(1.26, 0.12),
      new THREE.Vector2(1.28, 0.45),
      new THREE.Vector2(1.2, 0.56),
      new THREE.Vector2(1.06, 0.6),
      new THREE.Vector2(1.02, 0.57),
      new THREE.Vector2(1.14, 0.5),
      new THREE.Vector2(1.16, 0.18),
      new THREE.Vector2(1.08, 0.1),
      new THREE.Vector2(0.4, 0.08),
    ];
    const bowlMat = new THREE.MeshPhysicalMaterial({ color: 0x77746f, roughness: 0.22, metalness: 0.05, clearcoat: 0.9, clearcoatRoughness: 0.15, side: THREE.DoubleSide });
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(pts, 96), bowlMat);
    bowl.scale.y = 0.6;
    bowl.position.y = PLINTH_TOP + 0.2;
    bowl.castShadow = true;
    bowl.receiveShadow = true;
    g.add(bowl);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.16, 0.02, 96), M.darker());
    inner.position.y = PLINTH_TOP + 0.24;
    g.add(inner);
    this.spinner = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.24, 48), M.steel());
    this.spinner.position.y = this.chuckY - 0.12;
    g.add(this.spinner);
    // dispense arm on a pivot
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.05, 24), M.panel());
    post.position.set(1.25, PLINTH_TOP + 0.2 + 0.52, -1.1);
    g.add(post);
    this.arm.position.set(1.25, PLINTH_TOP + 1.2, -1.1);
    const beam = new THREE.Mesh(roundedBox(0.12, 0.09, 1.72, 0.03), M.panel());
    beam.position.set(0, 0, 0.8);
    beam.castShadow = true;
    this.arm.add(beam);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.22, 16), M.steel());
    head.position.set(0, -0.12, 1.62);
    this.arm.add(head);
    this.nozzleTip.position.set(0, -0.24, 1.62);
    this.arm.add(this.nozzleTip);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.14, 24), M.dark());
    this.arm.add(hub);
    g.add(this.arm);
    this.dropMat = new THREE.MeshPhysicalMaterial({ color: 0xe0953a, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.95 });
    this.drop = new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 14), this.dropMat);
    this.drop.visible = false;
    g.add(this.drop);
    this.spray = new Particles(500, '#bfe4ff', 0.05, true, 0.55);
    this.spray.gravity.set(0, -3, 0);
    this.spray.drag = 0.4;
    this.fling = new Particles(600, '#ffb35c', 0.035, true, 0.8);
    this.fling.gravity.set(0, -2.5, 0);
    this.fling.drag = 0.6;
    g.add(this.spray.points, this.fling.points);
    this.anchor.position.set(0, PLINTH_TOP + 0.8, 0);
    g.add(this.anchor);
  }
}

/** Hot plate with a hinged lid, glowing heater and solvent vapour. */
export class HotPlate {
  group = new THREE.Group();
  plateY = PLINTH_TOP + 0.3;
  heat: THREE.Mesh;
  heatMat: THREE.ShaderMaterial;
  lid = new THREE.Group();
  vapor: Particles;
  anchor = new THREE.Object3D();
  constructor() {
    const g = this.group;
    g.position.x = HOT_X;
    const body = new THREE.Mesh(roundedBox(2.5, 0.28, 2.5, 0.12), M.panel());
    body.position.y = PLINTH_TOP;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    this.heatMat = new THREE.ShaderMaterial({
      uniforms: { uHeat: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uHeat; uniform float uTime; varying vec2 vUv;
        void main(){
          vec2 p = vUv * 2.0 - 1.0; float r = length(p);
          float rings = 0.5 + 0.5 * sin(r * 38.0 - uTime * 0.6);
          vec3 cold = vec3(0.07, 0.075, 0.085) + rings * 0.012;
          vec3 hot = mix(vec3(0.9, 0.22, 0.05), vec3(1.4, 0.62, 0.2), rings * 0.6) * (1.0 - r * 0.35);
          vec3 c = mix(cold, hot * 1.6, uHeat);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.heat = new THREE.Mesh(new THREE.CircleGeometry(1.0, 96), this.heatMat);
    this.heat.rotation.x = -Math.PI / 2;
    this.heat.position.y = this.plateY - 0.018;
    g.add(this.heat);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.025, 12, 96), M.steel());
    ring.rotation.x = Math.PI / 2;
    ring.position.y = this.plateY - 0.015;
    g.add(ring);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), M.ceramic());
      pin.position.set(Math.cos(a) * 0.5, this.plateY - 0.005, Math.sin(a) * 0.5);
      g.add(pin);
    }
    // lid, hinged at the back
    const lidBody = new THREE.Mesh(roundedBox(2.3, 0.16, 2.3, 0.14), M.panel());
    lidBody.position.set(0, 0, 1.15);
    lidBody.castShadow = true;
    this.lid.add(lidBody);
    const lidInner = new THREE.Mesh(new THREE.CircleGeometry(1.0, 64), M.steel());
    lidInner.rotation.x = Math.PI / 2;
    lidInner.position.set(0, -0.001, 1.15);
    this.lid.add(lidInner);
    this.lid.position.set(0, PLINTH_TOP + 0.62, -1.15);
    g.add(this.lid);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.0, 16), M.dark());
    hinge.rotation.z = Math.PI / 2;
    hinge.position.set(0, PLINTH_TOP + 0.6, -1.15);
    g.add(hinge);
    const stand = new THREE.Mesh(roundedBox(2.2, 0.36, 0.12, 0.04), M.panel());
    stand.position.set(0, PLINTH_TOP + 0.26, -1.18);
    g.add(stand);
    this.vapor = new Particles(400, '#e8dccb', 0.22, false, 0.16);
    this.vapor.gravity.set(0, 0.35, 0);
    this.vapor.drag = 1.2;
    g.add(this.vapor.points);
    this.anchor.position.set(0, PLINTH_TOP + 0.5, 0);
    g.add(this.anchor);
  }
  setLid(open: number) {
    this.lid.rotation.x = -open * 1.15;
  }
}

/** Plasma etch chamber with a viewport, RF coil and glowing plasma. */
export class Etcher {
  group = new THREE.Group();
  bell = new THREE.Group();
  chuckY = PLINTH_TOP + 0.38;
  plasma: THREE.Mesh;
  plasmaMat: THREE.ShaderMaterial;
  coilMat: THREE.MeshBasicMaterial;
  ions: Particles;
  glowLight: THREE.PointLight;
  anchor = new THREE.Object3D();
  constructor() {
    const g = this.group;
    g.position.x = ETCH_X;
    const base = new THREE.Mesh(roundedBox(2.9, 0.22, 2.9, 0.12), M.panel());
    base.position.y = PLINTH_TOP;
    base.castShadow = true;
    g.add(base);
    const chuck = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 1.02, 0.16, 96), M.dark());
    chuck.position.y = this.chuckY - 0.08;
    g.add(chuck);
    // chamber: steel lower wall, then a bell jar (glass band + lid + RF coil) that lifts to load
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(1.34, 1.34, 0.26, 96, 1, true), M.steel());
    (lower.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    lower.position.y = PLINTH_TOP + 0.22 + 0.13;
    g.add(lower);
    const bell = this.bell;
    g.add(bell);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(1.34, 1.34, 0.95, 96, 1, true), M.window());
    glass.position.y = PLINTH_TOP + 0.48 + 0.475;
    bell.add(glass);
    for (const y of [PLINTH_TOP + 0.48, PLINTH_TOP + 1.43]) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.035, 12, 96), M.steel());
      r.rotation.x = Math.PI / 2;
      r.position.y = y;
      bell.add(r);
    }
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.22, 96), M.panel());
    lid.position.y = PLINTH_TOP + 1.54;
    lid.castShadow = true;
    bell.add(lid);
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.28, 64), M.ceramic());
    dome.position.y = PLINTH_TOP + 1.79;
    bell.add(dome);
    // RF coil: helix on top
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 400; i++) {
      const a = (i / 400) * Math.PI * 2 * 3.5;
      const r = 0.25 + (i / 400) * 0.6;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    this.coilMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#d08b4c') });
    const coil = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 400, 0.022, 8), this.coilMat);
    coil.position.y = PLINTH_TOP + 1.95;
    bell.add(coil);
    // plasma volume
    this.plasmaMat = new THREE.ShaderMaterial({
      uniforms: { uOn: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color('#d56bff') } },
      vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        uniform float uOn; uniform float uTime; uniform vec3 uColor;
        varying vec3 vP; varying vec3 vN; varying vec3 vV;
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
        float n3(vec3 p){ vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x), mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x), f.y),
                     mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x), mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x), f.y), f.z); }
        void main(){
          float facing = pow(abs(dot(normalize(vN), normalize(vV))), 1.2);
          float n = n3(vP * 3.0 + vec3(0.0, -uTime * 0.8, uTime * 0.3)) * 0.6 + n3(vP * 7.0 + uTime) * 0.4;
          float vert = smoothstep(-0.5, 0.2, vP.y) * smoothstep(0.55, 0.0, vP.y);
          float a = facing * (0.45 + n * 0.9) * vert * uOn;
          gl_FragColor = vec4(uColor * a * 1.6, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.plasma = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.2, 0.9, 64, 8, true), this.plasmaMat);
    this.plasma.position.y = this.chuckY + 0.42;
    g.add(this.plasma);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: softSprite(), color: 0xd56bff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    core.scale.set(2.6, 1.0, 1);
    core.position.y = this.chuckY + 0.4;
    g.add(core);
    (this.plasma.userData as { core: THREE.Sprite }).core = core;
    this.ions = new Particles(500, '#e6a8ff', 0.03, true, 0.9);
    this.ions.drag = 0;
    g.add(this.ions.points);
    this.glowLight = new THREE.PointLight(0xc86bff, 0, 6, 2);
    this.glowLight.position.y = this.chuckY + 0.6;
    g.add(this.glowLight);
    this.anchor.position.set(0, PLINTH_TOP + 1.2, 0);
    g.add(this.anchor);
  }
}

/** Inspection pedestal: a ring light the finished wafer floats inside. */
export class Inspection {
  group = new THREE.Group();
  ringMat: THREE.MeshBasicMaterial;
  constructor() {
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#f5efe4') });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.008, 12, 200), this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    this.group.add(ring);
  }
}

/** Engraved station plates along the front of the bench, with status LEDs. */
export function makeStationPlates() {
  const g = new THREE.Group();
  const leds: Record<string, THREE.MeshBasicMaterial> = {};
  const items: [string, string, number][] = [
    ['coater', '01 · 02 · 07', COATER_X],
    ['hotplate', '03 · 06', HOT_X],
    ['scanner', '04 · 05', 1.7],
    ['etcher', '08', ETCH_X],
  ];
  const draw = () => {
    for (const [id, num, x] of items) {
      const name = t(`plate.${id}`);
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 160;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = 'rgba(238,235,228,0.46)';
      ctx.font = '500 40px "Geist Mono Variable", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      const spaced = (t: string) => t.toUpperCase().split('').join(' ');
      ctx.fillText(spaced(num), 70, 52);
      ctx.fillStyle = 'rgba(238,235,228,0.78)';
      ctx.font = '400 62px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(name, 70, 116);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.297), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      plate.position.set(x - 0.35, 0.52, 1.603);
      g.add(plate);
      const ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffae42') });
      const led = new THREE.Mesh(new THREE.CircleGeometry(0.018, 20), ledMat);
      led.position.set(x - 1.2, 0.575, 1.604);
      g.add(led);
      leds[id] = ledMat;
    }
  };
  const redraw = () => {
    while (g.children.length) g.remove(g.children[0]);
    draw();
  };
  // draw once fonts are ready so the canvas uses the real type
  if (document.fonts?.ready) document.fonts.ready.then(redraw);
  draw();
  return { group: g, leds, redraw };
}
