import { h, fmt, sign, Tween } from './dom';
import { Slider } from './widgets';
import { STAGES, stageCopy } from '../core/stages';
import type { AppState, Mode, MicroCam, MicroLayer } from '../core/store';
import type { SimController } from '../sim/controller';
import { fieldNm } from '../core/params';
import { t, nf, getLang, setLang, type Lang } from '../i18n';

const MARK = `<svg class="brand-mark" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="12.5" stroke="rgba(238,235,228,.55)" stroke-width="1"/><circle cx="14" cy="14" r="9" stroke="rgba(238,235,228,.14)" stroke-width="1"/><path d="M9 7.5v13M12.3 6.5v15M15.7 6.5v15M19 7.5v13" stroke="#b9a6ff" stroke-width="1.4" stroke-linecap="round"/></svg>`;

export class Topbar {
  el: HTMLElement;
  private modeBtns: Record<Mode, HTMLButtonElement>;
  private pill: HTMLDivElement;
  private ro: Record<string, { el: HTMLDivElement; v: HTMLDivElement; d: HTMLDivElement }> = {};
  private tw = { cd: new Tween(0), ov: new Tween(0), y: new Tween(0) };
  private mode: Mode | '' = '';
  constructor(onMode: (m: Mode) => void) {
    const brand = h('div', { class: 'brand' });
    brand.innerHTML = `${MARK}<div><div class="brand-name">${t('brand.name')}</div><div class="brand-sub">${t('brand.sub')}</div></div>`;
    this.pill = h('div', { class: 'pill' });
    this.modeBtns = {
      guided: h('button', { class: 'on' }, t('mode.guided')),
      sandbox: h('button', {}, t('mode.sandbox')),
    };
    this.modeBtns.guided.addEventListener('click', () => onMode('guided'));
    this.modeBtns.sandbox.addEventListener('click', () => onMode('sandbox'));
    const mode = h('div', { class: 'mode', role: 'tablist' }, this.pill, this.modeBtns.guided, this.modeBtns.sandbox);
    const readouts = h('div', { class: 'readouts' });
    for (const id of ['cd', 'ov', 'y']) {
      const v = h('div', { class: 'v' });
      const d = h('div', { class: 'd' });
      const el = h('div', { class: 'ro' }, h('div', { class: 'k' }, t(`ro.${id}`)), v, d);
      this.ro[id] = { el, v, d };
      readouts.append(el);
    }
    // language switch — always visible, also on the title screen
    const lang = h('div', { class: 'lang', role: 'group', 'aria-label': t('lang.aria') });
    for (const [id, label] of [
      ['en', 'EN'],
      ['pt', 'PT'],
    ] as [Lang, string][]) {
      const b = h('button', { class: getLang() === id ? 'on' : '', 'aria-pressed': String(getLang() === id), lang: id === 'pt' ? 'pt-BR' : 'en' }, label);
      b.addEventListener('click', () => setLang(id));
      lang.append(b);
    }
    this.el = h('header', { class: 'topbar' }, brand, mode, readouts, lang);
  }
  update(state: AppState, sim: SimController, dt: number) {
    if (this.mode !== state.mode) {
      this.mode = state.mode;
      for (const [k, b] of Object.entries(this.modeBtns)) b.classList.toggle('on', k === state.mode);
      requestAnimationFrame(() => {
        const b = this.modeBtns[state.mode];
        this.pill.style.left = b.offsetLeft + 'px';
        this.pill.style.width = b.offsetWidth + 'px';
      });
    }
    const m = sim.metrics;
    const g = state.mode === 'guided';
    const cdOn = !g || state.stage >= 6;
    const ovOn = !g || state.stage >= 3;
    const yOn = !g || (state.stage === 8 && state.progress[8] >= 1);
    this.ro.cd.el.classList.toggle('off', !cdOn);
    this.ro.ov.el.classList.toggle('off', !ovOn);
    this.ro.y.el.classList.toggle('off', !yOn);
    const cd = this.tw.cd.step(m.missing ? 0 : m.cd, dt);
    this.ro.cd.v.innerHTML = cdOn ? (m.missing || m.bridged ? '—' : `${nf(cd, 1)}<small>nm</small>`) : '—';
    const e = m.cdErr * 100;
    this.ro.cd.d.textContent = cdOn ? (m.unresolved ? t('ro.notResolved') : m.missing ? t('ro.notPrinted') : m.bridged ? t('ro.bridged') : t('ro.cd.of', { e: sign(e, 1), t: nf(m.cdTarget, 0) })) : t('ro.cd.after');
    this.ro.cd.d.className = 'd ' + (!cdOn ? '' : m.missing || m.bridged || Math.abs(e) > 10 ? 'bad' : Math.abs(e) > 5 ? 'warn' : 'ok');
    const ov = this.tw.ov.step(m.overlay, dt);
    this.ro.ov.v.innerHTML = ovOn ? `${nf(ov, 1)}<small>nm</small>` : '—';
    this.ro.ov.d.textContent = ovOn ? t('ro.ov.spec', { s: fmt(m.overlaySpec, 0) }) : t('ro.ov.after');
    this.ro.ov.d.className = 'd ' + (!ovOn ? '' : m.overlay > m.overlaySpec ? 'bad' : m.overlay > m.overlaySpec * 0.6 ? 'warn' : 'ok');
    const y = sim.wafer ? sim.wafer.yield * 100 : 0;
    const yv = this.tw.y.step(y, dt);
    this.ro.y.v.innerHTML = yOn ? `${nf(yv, 0)}<small>%</small>` : '—';
    this.ro.y.d.textContent = yOn ? t('ro.y.good', { n: sim.wafer?.dies.filter((d) => d.pass).length ?? 0 }) : t('ro.y.after');
    this.ro.y.d.className = 'd ' + (!yOn ? '' : y < 50 ? 'bad' : y < 85 ? 'warn' : 'ok');
  }
}

export class Timeline {
  el: HTMLElement;
  private steps: { el: HTMLButtonElement; prog: HTMLElement }[] = [];
  private line: HTMLElement;
  constructor(onPick: (i: number) => void, onPrev: () => void, onNext: () => void) {
    this.line = h('i');
    const track = h('div', { class: 'tl-track' }, h('div', { class: 'tl-line' }, this.line));
    STAGES.forEach((st, i) => {
      const c = stageCopy(i);
      const prog = h('i');
      const el = h('button', { class: 'tl-step', title: c.title, 'aria-label': t('tl.step', { n: st.n, title: c.title }) }, h('span', { class: 'num' }, String(st.n).padStart(2, '0')), h('span', { class: 'dot' }), h('span', { class: 'name' }, c.short), h('span', { class: 'prog' }, prog));
      el.addEventListener('click', () => onPick(i));
      track.append(el);
      this.steps.push({ el, prog });
    });
    const prev = h('button', { class: 'iconbtn tl-arrow', 'aria-label': t('tl.prev'), html: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M7.5 2.5 4 6l3.5 3.5" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>' });
    const next = h('button', { class: 'iconbtn tl-arrow', 'aria-label': t('tl.next'), html: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4.5 2.5 8 6 4.5 9.5" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>' });
    prev.addEventListener('click', onPrev);
    next.addEventListener('click', onNext);
    this.el = h('nav', { class: 'timeline' }, prev, track, next);
  }
  update(state: AppState) {
    const n = STAGES.length;
    this.steps.forEach((s, i) => {
      s.el.classList.toggle('on', i === state.stage);
      s.el.classList.toggle('past', i < state.stage);
      s.el.classList.toggle('done', state.mode === 'guided' && state.done[i]);
      if (i === state.stage) s.prog.style.width = `${state.progress[i] * 100}%`;
    });
    this.line.style.width = `${(state.stage / (n - 1)) * 100}%`;
  }
}

/** Circular inset — whichever scene is not in the big view lives here. Persistent: it owns the loupe canvas. */
export class Loupe {
  el: HTMLDivElement;
  lens: HTMLDivElement;
  canvas: HTMLCanvasElement;
  private cap: HTMLDivElement;
  private ringSvg: SVGSVGElement;
  private swapLabel: HTMLSpanElement;
  constructor(onSwap: () => void) {
    this.canvas = h('canvas', { id: 'loupe' });
    this.lens = h('div', { class: 'loupe-lens', title: t('loupe.dbl') }, this.canvas);
    this.lens.addEventListener('dblclick', onSwap);
    this.cap = h('div', { class: 'loupe-cap' });
    const wrap = document.createElement('div');
    const ticks = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2;
      const r0 = i % 5 === 0 ? 144 : 147;
      return `<line x1="${150 + Math.cos(a) * r0}" y1="${150 + Math.sin(a) * r0}" x2="${150 + Math.cos(a) * 150}" y2="${150 + Math.sin(a) * 150}" stroke="rgba(238,235,228,${i % 5 === 0 ? 0.35 : 0.14})" stroke-width="1"/>`;
    }).join('');
    wrap.innerHTML = `<svg class="loupe-ring" viewBox="0 0 300 300" preserveAspectRatio="none">${ticks}</svg>`;
    this.ringSvg = wrap.firstElementChild as SVGSVGElement;
    this.swapLabel = h('span', {}, t('loupe.swap'));
    const swap = h('button', { class: 'iconbtn loupe-swap', html: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4.5h7.5L7.5 2.5M10 7.5H2.5l2 2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>' }, this.swapLabel);
    swap.addEventListener('click', onSwap);
    this.el = h('div', { class: 'loupe' }, this.ringSvg, this.lens, this.cap, h('div', { class: 'loupe-bar' }, swap));
  }
  /** Re-label after a language change (the element itself must survive — it holds the WebGL canvas). */
  relabel() {
    this.lens.title = t('loupe.dbl');
    this.swapLabel.textContent = t('loupe.swap');
    this.cap.innerHTML = '';
  }
  update(state: AppState, sim: SimController, solo: boolean) {
    const f = fieldNm(sim.params);
    const small = state.big === 'tool' ? 'micro' : 'tool';
    const field = f >= 1000 ? `${nf(f / 1000, 2)} µm` : `${nf(f, 0)} nm`;
    const html = `<div class="kicker">${small === 'micro' ? t('loupe.specimen', { f: field }) : t('loupe.bench')}</div>`;
    if (this.cap.innerHTML !== html) this.cap.innerHTML = html;
    this.el.classList.toggle('solo', solo);
  }
}

/** Toolbar for the big view: camera and layer modes for the specimen, optics explode for the tool. */
export class ViewBar {
  el: HTMLDivElement;
  private micro: HTMLDivElement;
  private tool: HTMLDivElement;
  private camBtns = new Map<MicroCam, HTMLButtonElement>();
  private layerBtns = new Map<MicroLayer, HTMLButtonElement>();
  cut: Slider;
  explode: Slider;
  constructor(
    onCam: (c: MicroCam) => void,
    onLayer: (l: MicroLayer) => void,
    onCut: (v: number) => void,
    onExplode: (v: number) => void,
    onOverview: () => void,
  ) {
    const cams = h('div', { class: 'seg' });
    for (const [id, l] of [
      ['3d', t('vb.3d')],
      ['section', t('vb.section')],
      ['top', t('vb.top')],
    ] as [MicroCam, string][]) {
      const b = h('button', {}, l);
      b.addEventListener('click', () => onCam(id));
      this.camBtns.set(id, b);
      cams.append(b);
    }
    const layers = h('div', { class: 'seg' });
    for (const [id, l] of [
      ['none', t('vb.material')],
      ['overlay', t('vb.overlay')],
      ['aerial', t('vb.aerial')],
    ] as [MicroLayer, string][]) {
      const b = h('button', {}, l);
      b.addEventListener('click', () => onLayer(id));
      this.layerBtns.set(id, b);
      layers.append(b);
    }
    this.cut = new Slider({ label: '', min: 0, max: 0.9, step: 0.001, value: 0.5, onInput: onCut });
    const cutTrk = this.cut.el.querySelector('.trk') as HTMLElement;
    this.micro = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, cams, h('span', { class: 'sep' }), layers, h('span', { class: 'sep' }), h('div', { class: 'cut' }, t('vb.cut'), cutTrk));
    this.explode = new Slider({ label: '', min: 0, max: 1, step: 0.01, value: 0, onInput: onExplode });
    const exTrk = this.explode.el.querySelector('.trk') as HTMLElement;
    const ov = h('button', {}, t('vb.overview'));
    ov.addEventListener('click', onOverview);
    this.tool = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h('div', { class: 'seg' }, ov), h('span', { class: 'sep' }), h('div', { class: 'cut' }, t('vb.explode'), exTrk));
    this.el = h('div', { class: 'vbar' }, this.micro, this.tool);
  }
  update(state: AppState) {
    const microBig = state.big === 'micro';
    this.micro.style.display = microBig ? 'flex' : 'none';
    this.tool.style.display = microBig ? 'none' : 'flex';
    for (const [k, b] of this.camBtns) b.classList.toggle('on', k === state.microCam);
    for (const [k, b] of this.layerBtns) b.classList.toggle('on', k === state.microLayer);
    if (Math.abs(this.cut.value - state.cut) > 1e-4) this.cut.set(state.cut);
    if (Math.abs(this.explode.value - state.exploded) > 1e-4) this.explode.set(state.exploded);
    const showTool = state.mode === 'sandbox' || state.stage === 4 || state.stage === 3;
    this.el.classList.toggle('off', !microBig && !showTool);
  }
}

export class Intro {
  el: HTMLDivElement;
  constructor(onGuided: () => void, onSandbox: () => void, animate = true) {
    const g = h('button', { class: 'btn primary' }, t('intro.guided'));
    const s = h('button', { class: 'btn' }, t('intro.sandbox'));
    g.addEventListener('click', onGuided);
    s.addEventListener('click', onSandbox);
    const fx = animate ? 'fadein' : '';
    this.el = h(
      'div',
      { class: 'intro' },
      h('div', { class: `kicker ${fx}`, style: { animationDelay: '0.2s' } }, t('brand.sub')),
      h('h2', { class: fx, style: { animationDelay: '0.35s' }, html: t('intro.title') }),
      h('p', { class: fx, style: { animationDelay: '0.55s' } }, t('intro.body')),
      h('div', { class: `row ${fx}`, style: { animationDelay: '0.75s' } }, g, s),
      h(
        'div',
        { class: `meta ${fx}`, style: { animationDelay: '1s' } },
        h('div', {}, t('intro.meta.g'), h('b', {}, t('intro.meta.gv'))),
        h('div', {}, t('intro.meta.s'), h('b', {}, t('intro.meta.sv'))),
        h('div', {}, t('intro.meta.m'), h('b', {}, t('intro.meta.mv'))),
      ),
    );
  }
  hide() {
    this.el.classList.add('gone');
  }
}

export class Toast {
  el: HTMLDivElement;
  private timer: number | null = null;
  constructor() {
    this.el = h('div', { class: 'toast' });
  }
  show(html: string, ms = 3200) {
    this.el.innerHTML = html;
    this.el.classList.add('on');
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('on'), ms);
  }
}
