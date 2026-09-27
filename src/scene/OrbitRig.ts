import * as THREE from 'three';
import { easeInOut } from './fx';

export interface Shot {
  target: THREE.Vector3;
  radius: number;
  theta: number; // azimuth (rad), 0 = +z
  phi: number; // polar from +y (rad)
}

/**
 * Cinematic orbit camera: eased shot-to-shot moves, damped user orbit/zoom, gentle idle sway.
 * The rig is bound to one DOM element at a time so it can follow a scene between canvases.
 */
export class OrbitRig {
  camera: THREE.PerspectiveCamera;
  cur: Shot;
  goal: Shot;
  private from: Shot | null = null;
  private to: Shot | null = null;
  private tweenT = 0;
  private tweenDur = 1;
  private el: HTMLElement | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastInteract = -1e9;
  private clock = 0;
  minR = 1;
  maxR = 40;
  minPhi = 0.05;
  maxPhi = Math.PI * 0.49;
  sway = 1;
  enabled = true;
  /** Optional clamp for the orbit target. */
  targetClamp: THREE.Box3 | null = null;

  constructor(fov = 32) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 400);
    const s = { target: new THREE.Vector3(), radius: 10, theta: 0.4, phi: 1.1 };
    this.cur = cloneShot(s);
    this.goal = cloneShot(s);
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.from = this.to = null;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const h = this.el?.clientHeight || 800;
    const k = 2.4 / h;
    if (e.shiftKey) {
      // pan in the view plane
      const cam = this.camera;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const s = this.goal.radius * 0.0016;
      this.goal.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    } else {
      this.goal.theta -= dx * k;
      this.goal.phi = THREE.MathUtils.clamp(this.goal.phi - dy * k, this.minPhi, this.maxPhi);
    }
    this.lastInteract = this.clock;
  };
  private onUp = () => {
    this.dragging = false;
  };
  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.from = this.to = null;
    const f = Math.exp(e.deltaY * 0.0012);
    this.goal.radius = THREE.MathUtils.clamp(this.goal.radius * f, this.minR, this.maxR);
    this.lastInteract = this.clock;
  };

  attach(el: HTMLElement) {
    if (this.el === el) return;
    this.detach();
    this.el = el;
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }
  detach() {
    if (!this.el) return;
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el = null;
  }

  get interacting() {
    return this.dragging || this.clock - this.lastInteract < 2.5;
  }

  /** Move to a shot. duration 0 = cut. */
  shot(s: Shot, duration = 1.8) {
    const to = cloneShot(s);
    // take the short way round in azimuth
    const d = to.theta - this.goal.theta;
    to.theta = this.goal.theta + Math.atan2(Math.sin(d), Math.cos(d));
    if (duration <= 0) {
      this.goal = cloneShot(to);
      this.cur = cloneShot(to);
      this.from = this.to = null;
      return;
    }
    this.from = cloneShot(this.goal);
    this.to = to;
    this.tweenT = 0;
    this.tweenDur = duration;
  }

  update(dt: number) {
    this.clock += dt;
    if (this.from && this.to) {
      this.tweenT += dt / this.tweenDur;
      const e = easeInOut(Math.min(1, this.tweenT));
      lerpShot(this.from, this.to, e, this.goal);
      // arc upward slightly mid-move for a crane feel
      this.goal.phi -= Math.sin(Math.PI * Math.min(1, this.tweenT)) * 0.06;
      if (this.tweenT >= 1) this.from = this.to = null;
    }
    if (this.targetClamp) this.goal.target.clamp(this.targetClamp.min, this.targetClamp.max);
    const k = 1 - Math.exp(-9 * dt);
    lerpShot(this.cur, this.goal, k, this.cur);
    const sw = this.sway * (this.interacting ? 0 : 1);
    const theta = this.cur.theta + Math.sin(this.clock * 0.13) * 0.035 * sw;
    const phi = this.cur.phi + Math.sin(this.clock * 0.17 + 1.3) * 0.02 * sw;
    const r = this.cur.radius;
    const t = this.cur.target;
    this.camera.position.set(t.x + r * Math.sin(phi) * Math.sin(theta), t.y + r * Math.cos(phi), t.z + r * Math.sin(phi) * Math.cos(theta));
    this.camera.lookAt(t);
  }
}

function cloneShot(s: Shot): Shot {
  return { target: s.target.clone(), radius: s.radius, theta: s.theta, phi: s.phi };
}
function lerpShot(a: Shot, b: Shot, t: number, out: Shot) {
  out.target.lerpVectors(a.target, b.target, t);
  out.radius = a.radius * Math.pow(b.radius / a.radius, t);
  out.theta = a.theta + (b.theta - a.theta) * t;
  out.phi = a.phi + (b.phi - a.phi) * t;
  return out;
}

export function shot(x: number, y: number, z: number, radius: number, thetaDeg: number, phiDeg: number): Shot {
  return { target: new THREE.Vector3(x, y, z), radius, theta: THREE.MathUtils.degToRad(thetaDeg), phi: THREE.MathUtils.degToRad(phiDeg) };
}
