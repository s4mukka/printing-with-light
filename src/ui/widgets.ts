import { h, s } from './dom';
import { t, nf } from '../i18n';

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  log?: boolean;
  nominal?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

/** Range input with a value read-out, optional tolerance band and labelled marks. */
export class Slider {
  el: HTMLDivElement;
  input: HTMLInputElement;
  private out: HTMLOutputElement;
  private fill: HTMLDivElement;
  private band: HTMLDivElement;
  private marks = new Map<string, HTMLDivElement>();
  private trk: HTMLDivElement;
  foot: HTMLDivElement;
  value: number;
  constructor(private o: SliderOpts) {
    this.value = o.value;
    this.input = h('input', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': o.label });
    this.out = h('output');
    this.fill = h('div', { class: 'fill' });
    this.band = h('div', { class: 'band', style: { display: 'none' } });
    this.trk = h('div', { class: 'trk' }, h('div', { class: 'rail' }), this.band, this.fill, this.input);
    this.foot = h('div', { class: 'ctl-foot' });
    this.el = h('div', { class: 'ctl' }, h('div', { class: 'ctl-head' }, h('label', {}, o.label), this.out), this.trk, this.foot);
    this.input.addEventListener('input', () => {
      const v = this.fromPos(Number(this.input.value) / 1000);
      this.value = v;
      this.paint();
      o.onInput(v);
    });
    this.input.addEventListener('dblclick', () => {
      if (o.nominal === undefined) return;
      this.set(o.nominal);
      o.onInput(o.nominal);
    });
    if (o.nominal !== undefined) this.setMark('nom', o.nominal, '', 'nom');
    this.set(o.value);
  }
  private toPos(v: number) {
    const { min, max, log } = this.o;
    return log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  }
  private fromPos(t: number) {
    const { min, max, log, step } = this.o;
    let v = log ? min * Math.pow(max / min, t) : min + (max - min) * t;
    if (step) v = Math.round(v / step) * step;
    return Math.min(max, Math.max(min, v));
  }
  set(v: number) {
    this.value = v;
    this.input.value = String(Math.round(this.toPos(v) * 1000));
    this.paint();
  }
  private paint() {
    const t = this.toPos(this.value);
    this.fill.style.width = `calc(${t * 100}% )`;
    const f = this.o.format ? this.o.format(this.value) : String(this.value);
    this.out.innerHTML = `${f}${this.o.unit ? `<span>${this.o.unit}</span>` : ''}`;
  }
  setBand(lo: number | null, hi?: number) {
    if (lo === null || hi === undefined) {
      this.band.style.display = 'none';
      return;
    }
    const a = Math.max(0, this.toPos(Math.max(lo, this.o.min)));
    const b = Math.min(1, this.toPos(Math.min(hi, this.o.max)));
    this.band.style.display = b > a ? '' : 'none';
    this.band.style.left = `calc(${a * 100}% )`;
    this.band.style.width = `calc(${(b - a) * 100}% )`;
  }
  setMark(id: string, v: number | null, label: string, cls = '') {
    let m = this.marks.get(id);
    if (!m) {
      m = h('div', { class: 'mark ' + cls });
      this.trk.insertBefore(m, this.input);
      this.marks.set(id, m);
    }
    if (v === null || !Number.isFinite(v) || v < this.o.min || v > this.o.max) {
      m.style.opacity = '0';
      return;
    }
    m.style.opacity = '1';
    m.dataset.l = label;
    m.style.left = `calc(${this.toPos(v) * 100}% )`;
  }
  setFoot(html: string) {
    if (this.foot.innerHTML !== html) this.foot.innerHTML = html;
  }
}

export interface ChipOpt {
  id: string;
  label: string;
  sub?: string;
  swatch?: string;
  icon?: string;
  title?: string;
}

export class Chips {
  el: HTMLDivElement;
  private btns = new Map<string, HTMLButtonElement>();
  value: string;
  constructor(opts: ChipOpt[], value: string, cols: number, onPick: (id: string) => void, cls = 'chips') {
    this.value = value;
    this.el = h('div', { class: `${cls} c${cols}`, role: 'radiogroup' });
    for (const o of opts) {
      const b = h('button', { class: 'chip', role: 'radio', title: o.title ?? '', 'aria-label': o.label });
      if (o.icon) b.insertAdjacentHTML('beforeend', o.icon);
      if (o.swatch) b.append(h('span', { class: 'sw', style: { background: o.swatch, boxShadow: `0 0 10px ${o.swatch}` } }));
      b.append(h('span', { class: 'cl' }, o.label));
      if (o.sub) b.append(h('span', { class: 'cs' }, o.sub));
      b.addEventListener('click', () => {
        this.set(o.id);
        onPick(o.id);
      });
      this.btns.set(o.id, b);
      this.el.append(b);
    }
    this.set(value);
  }
  set(id: string) {
    this.value = id;
    for (const [k, b] of this.btns) {
      b.classList.toggle('on', k === id);
      b.setAttribute('aria-checked', String(k === id));
    }
  }
}

/** 2D alignment pad: drag the crosshair to null the overlay error. */
export class AlignPad {
  el: HTMLDivElement;
  private pad: HTMLDivElement;
  private knob: HTMLDivElement;
  private spec: SVGCircleElement;
  private ghost: SVGGElement;
  private vx: HTMLElement;
  private vy: HTMLElement;
  private vo: HTMLElement;
  x = 0;
  y = 0;
  private range: number;
  constructor(range: number, private onChange: (x: number, y: number) => void) {
    this.range = range;
    const S = 132;
    const svg = s('svg', { width: S, height: S, viewBox: `0 0 ${S} ${S}` });
    for (let i = 1; i < 6; i++) {
      const p = (i * S) / 6;
      svg.append(s('line', { x1: p, y1: 0, x2: p, y2: S, stroke: 'rgba(238,235,228,0.05)' }), s('line', { x1: 0, y1: p, x2: S, y2: p, stroke: 'rgba(238,235,228,0.05)' }));
    }
    svg.append(s('line', { x1: S / 2, y1: 0, x2: S / 2, y2: S, stroke: 'rgba(238,235,228,0.16)' }), s('line', { x1: 0, y1: S / 2, x2: S, y2: S / 2, stroke: 'rgba(238,235,228,0.16)' }));
    this.spec = s('circle', { cx: S / 2, cy: S / 2, r: 10, stroke: 'rgba(127,224,181,0.55)', 'stroke-dasharray': '2 3', fill: 'rgba(127,224,181,0.05)' });
    svg.append(this.spec);
    // box-in-box overlay target: the outer box is the previous layer, the inner the new print
    const box = s('g', {});
    box.append(s('rect', { x: S / 2 - 16, y: S / 2 - 16, width: 32, height: 32, stroke: 'rgba(238,235,228,0.35)', fill: 'none' }));
    svg.append(box);
    this.ghost = s('g', {});
    this.ghost.append(s('rect', { x: -8, y: -8, width: 16, height: 16, stroke: '#b9a6ff', fill: 'rgba(185,166,255,0.1)' }));
    svg.append(this.ghost);
    this.knob = h('div', { class: 'knob' });
    this.pad = h('div', { class: 'apad', tabindex: 0, role: 'slider', 'aria-label': t('align.aria') });
    this.pad.append(svg, this.knob);
    this.vx = h('b');
    this.vy = h('b');
    this.vo = h('div', { class: 'ov' });
    const vals = h('div', { class: 'apad-vals' }, h('div', {}, 'X ', this.vx), h('div', {}, 'Y ', this.vy), h('div', { class: 'kicker', style: { marginTop: '8px' } }, t('align.overlay')), this.vo);
    this.el = h('div', { class: 'ctl' }, h('div', { class: 'ctl-head' }, h('label', {}, t('align.label')), h('output', { html: `<span>${t('align.hint')}</span>` })), h('div', { class: 'apad-wrap' }, this.pad, vals));

    const toVal = (e: PointerEvent) => {
      const r = this.pad.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width - 0.5;
      const fy = (e.clientY - r.top) / r.height - 0.5;
      // soft magnet near zero makes perfect alignment tactile
      let x = fx * 2 * this.range;
      let y = -fy * 2 * this.range;
      if (Math.hypot(x, y) < 2.2) {
        x = 0;
        y = 0;
      }
      return [Math.round(x), Math.round(y)];
    };
    let dragging = false;
    this.pad.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.pad.setPointerCapture(e.pointerId);
      this.pad.classList.add('drag');
      const [x, y] = toVal(e);
      this.set(x, y);
      this.onChange(x, y);
    });
    this.pad.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const [x, y] = toVal(e);
      this.set(x, y);
      this.onChange(x, y);
    });
    const up = () => {
      dragging = false;
      this.pad.classList.remove('drag');
    };
    this.pad.addEventListener('pointerup', up);
    this.pad.addEventListener('pointercancel', up);
    this.pad.addEventListener('dblclick', () => {
      this.set(0, 0);
      this.onChange(0, 0);
    });
    this.pad.addEventListener('keydown', (e) => {
      const k = e.shiftKey ? 5 : 1;
      let { x, y } = this;
      if (e.key === 'ArrowLeft') x -= k;
      else if (e.key === 'ArrowRight') x += k;
      else if (e.key === 'ArrowUp') y += k;
      else if (e.key === 'ArrowDown') y -= k;
      else return;
      e.preventDefault();
      e.stopPropagation();
      x = Math.max(-this.range, Math.min(this.range, x));
      y = Math.max(-this.range, Math.min(this.range, y));
      this.set(x, y);
      this.onChange(x, y);
    });
  }
  set(x: number, y: number) {
    this.x = x;
    this.y = y;
    const S = 132;
    const px = S / 2 + (x / this.range) * (S / 2);
    const py = S / 2 - (y / this.range) * (S / 2);
    this.knob.style.left = px + 'px';
    this.knob.style.top = py + 'px';
    this.ghost.setAttribute('transform', `translate(${px} ${py})`);
    this.vx.textContent = `${x >= 0 ? '+' : '−'}${Math.abs(x)} nm`;
    this.vy.textContent = `${y >= 0 ? '+' : '−'}${Math.abs(y)} nm`;
    const ov = Math.hypot(x, y);
    this.vo.textContent = `${nf(ov, 1)} nm`;
  }
  setSpec(specNm: number) {
    const r = Math.max(3, (specNm / this.range) * 66);
    this.spec.setAttribute('r', String(r));
    this.pad.classList.toggle('ok', Math.hypot(this.x, this.y) <= specNm);
  }
}
