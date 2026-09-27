import * as THREE from 'three';
import { h } from './dom';
import type { Annotation } from '../scene/types';

interface Item {
  el: HTMLDivElement;
  t: HTMLDivElement;
  s: HTMLDivElement;
  on: boolean;
}

/** Projects 3D annotations onto an HTML layer — crisp type, leader lines, soft fades. */
export class LabelLayer {
  el: HTMLDivElement;
  private items = new Map<string, Item>();
  private v = new THREE.Vector3();
  constructor() {
    this.el = h('div', { class: 'labels' });
  }
  update(list: Annotation[], camera: THREE.Camera, w: number, hgt: number) {
    const seen = new Set<string>();
    for (const a of list) {
      seen.add(a.id);
      let it = this.items.get(a.id);
      if (!it) {
        const t = h('div', { class: 't' });
        const sEl = h('div', { class: 's' });
        const el = h('div', { class: `lbl ${a.id === 'cd' ? 'metric' : ''} ${a.id === 'scale' ? 'scale' : ''}` }, h('div', { class: 'dot' }), h('div', { class: 'line' }), h('div', { class: 'txt' }, t, sEl));
        this.el.append(el);
        it = { el, t, s: sEl, on: false };
        this.items.set(a.id, it);
      }
      a.obj.getWorldPosition(this.v);
      if (a.offset) this.v.add(a.offset);
      this.v.project(camera);
      const inView = this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05;
      const on = a.visible && inView;
      if (on !== it.on) {
        it.on = on;
        it.el.classList.toggle('on', on);
      }
      if (!on) continue;
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * hgt;
      it.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      const side = a.side === 'left' ? 'side-l' : 'side-r';
      if (!it.el.classList.contains(side)) {
        it.el.classList.remove('side-l', 'side-r');
        it.el.classList.add(side);
      }
      it.el.classList.toggle('accent', !!a.accent && a.id !== 'cd');
      if (it.t.textContent !== a.title) it.t.textContent = a.title;
      const sub = a.sub ?? '';
      if (it.s.textContent !== sub) it.s.textContent = sub;
      it.s.style.display = sub ? '' : 'none';
    }
    for (const [id, it] of this.items)
      if (!seen.has(id) && it.on) {
        it.on = false;
        it.el.classList.remove('on');
      }
  }
  hideAll() {
    for (const it of this.items.values()) {
      it.on = false;
      it.el.classList.remove('on');
    }
  }
}
