import { s } from './dom';
import type { SimController } from '../sim/controller';
import { N } from '../sim/engine';
import { LAYOUTS } from '../sim/patterns';
import { SOURCES, RANGES, PHYS } from '../core/params';
import { t, t as tr, nf, getLang } from '../i18n';

/**
 * Aerial image along the metrology row: the blurred light the resist actually receives,
 * the mask it came from, the print threshold at the current dose, and what printed.
 */
export class AerialChart {
  el: SVGSVGElement;
  private area: SVGPathElement;
  private curve: SVGPathElement;
  private mask: SVGPathElement;
  private thr: SVGLineElement;
  private thrT: SVGTextElement;
  private printed: SVGGElement;
  private design: SVGGElement;
  private W = 320;
  private H = 128;
  private key = '';
  constructor() {
    const { W, H } = this;
    this.el = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', height: H });
    const defs = s('defs');
    const lg = s('linearGradient', { id: 'aerialFill', x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.append(s('stop', { offset: '0', 'stop-color': '#b9a6ff', 'stop-opacity': '0.42' }), s('stop', { offset: '1', 'stop-color': '#b9a6ff', 'stop-opacity': '0.02' }));
    defs.append(lg);
    this.el.append(defs);
    for (let i = 0; i <= 4; i++) this.el.append(s('line', { x1: 0, x2: W, y1: 8 + ((H - 34) * i) / 4, y2: 8 + ((H - 34) * i) / 4, stroke: 'rgba(238,235,228,0.05)' }));
    this.mask = s('path', { stroke: 'rgba(238,235,228,0.28)', 'stroke-width': 1, fill: 'none', 'stroke-dasharray': '2 2' });
    this.area = s('path', { fill: 'url(#aerialFill)' });
    this.curve = s('path', { stroke: '#d9ceff', 'stroke-width': 1.5, fill: 'none', 'vector-effect': 'non-scaling-stroke' });
    this.thr = s('line', { stroke: '#ffb35c', 'stroke-width': 1, 'stroke-dasharray': '4 3', x1: 0, x2: W });
    this.thrT = s('text', { x: W - 4, 'text-anchor': 'end' });
    this.thrT.textContent = t('ch.thr');
    (this.thrT as SVGTextElement).style.fill = '#ffb35c';
    this.design = s('g');
    this.printed = s('g');
    this.el.append(this.mask, this.area, this.curve, this.thr, this.thrT, this.design, this.printed);
    const t1 = s('text', { x: 2, y: H - 3 });
    t1.textContent = t('ch.printed');
    const t2 = s('text', { x: 2, y: H - 15 });
    t2.textContent = t('ch.design');
    this.el.append(t1, t2);
  }
  update(sim: SimController) {
    const key = `${sim.version}`;
    if (key === this.key) return;
    this.key = key;
    const { W, H } = this;
    const o = sim.optics;
    const m = sim.metrics;
    const p = sim.params;
    const L = LAYOUTS[p.pattern];
    const site = p.tone === 'positive' ? L.site.positive : L.site.negative;
    const row = ((m.siteRow % N) + N) % N;
    const pxPerHp = p.halfPitch / o.px;
    const cx = site.cx * pxPerHp + o.shiftPx[0];
    const span = 6 * pxPerHp * Math.max(1, site.width);
    const x0 = cx - span / 2;
    const top = 8;
    const bot = H - 34;
    const yOf = (v: number) => bot - (bot - top) * Math.min(1.15, v) / 1.15;
    const xOf = (px: number) => ((px - x0) / span) * W;
    const at = (arr: Float32Array | Uint8Array, px: number) => {
      const i = Math.floor(px);
      const f = px - i;
      const a = arr[row * N + (((i % N) + N) % N)];
      const b = arr[row * N + ((((i + 1) % N) + N) % N)];
      return a * (1 - f) + b * f;
    };
    const steps = 160;
    let d = '';
    let dm = '';
    for (let k = 0; k <= steps; k++) {
      const px = x0 + (span * k) / steps;
      const I = at(o.aerial, px);
      d += `${k ? 'L' : 'M'}${xOf(px).toFixed(1)},${yOf(I).toFixed(1)}`;
      const T = at(o.maskShifted, px) > 0.5 ? 1 : 0;
      dm += `${k ? 'L' : 'M'}${xOf(px).toFixed(1)},${yOf(T).toFixed(1)}`;
    }
    this.curve.setAttribute('d', d);
    this.area.setAttribute('d', d + `L${W},${bot}L0,${bot}Z`);
    this.mask.setAttribute('d', dm);
    const ty = yOf(m.thr);
    this.thr.setAttribute('y1', String(ty));
    this.thr.setAttribute('y2', String(ty));
    this.thrT.setAttribute('y', String(Math.max(12, ty - 4)));
    // design and printed bars
    const bar = (g: SVGGElement, arr: Float32Array | Uint8Array, thr: number, y: number, color: string, outline: boolean, shift: number) => {
      while (g.firstChild) g.firstChild.remove();
      let start = -1;
      for (let k = 0; k <= steps; k++) {
        const px = x0 + (span * k) / steps;
        const v = k < steps ? at(arr, px - shift) > thr : false;
        if (v && start < 0) start = k;
        if (!v && start >= 0) {
          const xa = (start / steps) * W;
          const xb = (k / steps) * W;
          g.append(s('rect', { x: xa, y, width: Math.max(0.5, xb - xa), height: 5, rx: 1, fill: outline ? 'none' : color, stroke: outline ? color : 'none', 'stroke-width': 1 }));
          start = -1;
        }
      }
    };
    bar(this.design, sim.target, 0.5, H - 24, 'rgba(238,235,228,0.55)', true, 0);
    bar(this.printed, sim.devFinal, o.t / 2, H - 12, '#e3a14e', false, 0);
  }
}

/** Dose × focus process window: where the CD stays within ±10 %. */
export class ProcessWindowChart {
  el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private key = '';
  private W = 320;
  private H = 150;
  constructor() {
    this.el = document.createElement('canvas');
    this.el.className = 'chart';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.width = this.W * dpr;
    this.el.height = this.H * dpr;
    this.el.style.height = this.H + 'px';
    this.ctx = this.el.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }
  update(sim: SimController) {
    const pw = sim.pw;
    const p = sim.params;
    const key = `${pw?.version}|${p.dose}|${p.focus}|${getLang()}`;
    if (!pw || key === this.key) return;
    this.key = key;
    const { W, H, ctx } = this;
    const L = 30;
    const B = 18;
    const T = 6;
    const R = 6;
    const pw_ = W - L - R;
    const ph = H - T - B;
    ctx.clearRect(0, 0, W, H);
    const nd = pw.doses.length;
    const nq = pw.focuses.length;
    const cw = pw_ / nd;
    const ch = ph / nq;
    for (let q = 0; q < nq; q++)
      for (let d = 0; d < nd; d++) {
        const e = pw.err[q * nd + d];
        if (Number.isNaN(e)) continue;
        const ae = Math.abs(e);
        let col: string;
        if (ae <= 0.1) col = `rgba(127,224,181,${0.25 + 0.6 * (1 - ae / 0.1)})`;
        else if (ae <= 0.3) col = e > 0 ? `rgba(255,179,92,${0.22 * (1 - (ae - 0.1) / 0.2) + 0.04})` : `rgba(185,166,255,${0.22 * (1 - (ae - 0.1) / 0.2) + 0.04})`;
        else col = 'rgba(238,235,228,0.025)';
        ctx.fillStyle = col;
        ctx.fillRect(L + d * cw + 0.5, T + (nq - 1 - q) * ch + 0.5, cw - 1, ch - 1);
      }
    // axes
    ctx.strokeStyle = 'rgba(238,235,228,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, T + ph / 2 + 0.5);
    ctx.lineTo(L + pw_, T + ph / 2 + 0.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(238,235,228,0.42)';
    ctx.font = '9px "Geist Mono Variable", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('+400', L - 4, T + 7);
    ctx.fillText('0', L - 4, T + ph / 2 + 3);
    ctx.fillText('−400', L - 4, T + ph);
    const d0 = pw.doses[0];
    const d1 = pw.doses[nd - 1];
    ctx.textAlign = 'left';
    ctx.fillText(nf(d0, 0), L, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${nf(d1, 0)} mJ/cm²`, L + pw_, H - 4);
    ctx.textAlign = 'center';
    ctx.fillText(t('ch.dose'), L + pw_ / 2, H - 4);
    // current operating point (pinned to the edge when outside the plotted range)
    const xOf = (dose: number) => L + Math.min(1, Math.max(0, (dose - d0) / (d1 - d0))) * pw_;
    const yOf = (f: number) => T + ((RANGES.focus.max - f) / (RANGES.focus.max - RANGES.focus.min)) * ph;
    const x = xOf(p.dose);
    const y = yOf(p.focus);
    ctx.strokeStyle = 'rgba(238,235,228,0.35)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, T);
    ctx.lineTo(x + 0.5, T + ph);
    ctx.moveTo(L, y + 0.5);
    ctx.lineTo(L + pw_, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#07080a';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#eeebe4';
    ctx.stroke();
    // focus label
    ctx.save();
    ctx.translate(9, T + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(238,235,228,0.42)';
    ctx.fillText(t('ch.focus'), 0, 0);
    ctx.restore();
  }
}

/** Pupil view: where the diffraction orders land relative to the lens aperture (NA). */
export class PupilDiagram {
  el: SVGSVGElement;
  private g: SVGGElement;
  private key = '';
  constructor(private size = 84) {
    const S = size;
    this.el = s('svg', { class: 'pupil', width: S, height: S, viewBox: `0 0 ${S} ${S}` });
    this.el.append(s('circle', { cx: S / 2, cy: S / 2, r: S * 0.3, stroke: 'rgba(238,235,228,0.5)', fill: 'rgba(238,235,228,0.03)' }));
    this.el.append(s('line', { x1: 4, x2: S - 4, y1: S / 2, y2: S / 2, stroke: 'rgba(238,235,228,0.07)' }));
    this.g = s('g');
    this.el.append(this.g);
    const t = s('text', { x: S / 2, y: S - 3, 'text-anchor': 'middle' });
    t.textContent = tr('ch.pupil');
    t.style.fontFamily = 'var(--mono)';
    t.style.fontSize = '8.5px';
    t.style.fill = 'rgba(238,235,228,0.4)';
    this.el.append(t);
  }
  update(sim: SimController) {
    const p = sim.params;
    const key = `${p.source}|${p.pattern}|${p.halfPitch}`;
    if (key === this.key) return;
    this.key = key;
    const src = SOURCES[p.source];
    const L = LAYOUTS[p.pattern];
    const f1 = src.lambda / (L.pitch * p.halfPitch * src.NA);
    const S = this.size;
    const R = S * 0.3;
    const sig = 0.5;
    while (this.g.firstChild) this.g.firstChild.remove();
    const orders: [number, number][] = L.twoD
      ? [
          [0, 0],
          [f1, 0],
          [-f1, 0],
          [0, f1],
          [0, -f1],
        ]
      : [
          [0, 0],
          [f1, 0],
          [-f1, 0],
          [2 * f1, 0],
          [-2 * f1, 0],
        ];
    for (const [fx, fy] of orders) {
      const fr = Math.hypot(fx, fy);
      const pass = Math.max(0, Math.min(1, (1 + sig - fr) / (2 * sig)));
      const cx = S / 2 + fx * R;
      const cy = S / 2 - fy * R;
      if (Math.abs(cx - S / 2) > S / 2 + R * sig || Math.abs(cy - S / 2) > S / 2 + R * sig) continue;
      this.g.append(
        s('circle', {
          cx,
          cy,
          r: R * sig * 0.9,
          fill: pass > 0 ? `rgba(185,166,255,${0.15 + 0.55 * pass})` : 'none',
          stroke: pass > 0 ? '#b9a6ff' : 'rgba(255,116,102,0.8)',
          'stroke-dasharray': pass > 0 ? '0' : '2 2',
          'stroke-width': 1,
        }),
      );
    }
    void PHYS;
  }
}
