import { h, fmt } from './dom';
import { t, nf } from '../i18n';
import { Slider, Chips, AlignPad } from './widgets';
import { PupilDiagram } from './charts';
import type { Store, AppState } from '../core/store';
import { STAGES, type ControlId } from '../core/stages';
import { SOURCES, SOURCE_ORDER, PATTERN_ORDER, RANGES, NOMINAL, resolutionLimit, depthOfFocus, spinRpm, PHYS, type Params } from '../core/params';
import type { SimController } from '../sim/controller';

const ICONS: Record<string, string> = {
  lines: '<svg width="22" height="14" viewBox="0 0 22 14"><g fill="currentColor"><rect x="2" y="1" width="2.4" height="12" rx=".6"/><rect x="7" y="1" width="2.4" height="12" rx=".6"/><rect x="12" y="1" width="2.4" height="12" rx=".6"/><rect x="17" y="1" width="2.4" height="12" rx=".6"/></g></svg>',
  contacts: '<svg width="22" height="14" viewBox="0 0 22 14"><g fill="currentColor"><rect x="3" y="2" width="3" height="3" rx=".5"/><rect x="9.5" y="2" width="3" height="3" rx=".5"/><rect x="16" y="2" width="3" height="3" rx=".5"/><rect x="3" y="9" width="3" height="3" rx=".5"/><rect x="9.5" y="9" width="3" height="3" rx=".5"/><rect x="16" y="9" width="3" height="3" rx=".5"/></g></svg>',
  logic: '<svg width="22" height="14" viewBox="0 0 22 14"><g stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="square"><path d="M3 2v10h6"/><path d="M8 2h11"/><path d="M13 6v6"/><path d="M17 6v6"/></g></svg>',
  ladder: '<svg width="22" height="14" viewBox="0 0 22 14"><g fill="currentColor"><rect x="1.5" y="1" width="3.2" height="12" rx=".6"/><rect x="7.5" y="1" width="2.4" height="12" rx=".6"/><rect x="12.2" y="1" width="1.7" height="12" rx=".5"/><rect x="15.8" y="1" width="1.2" height="12" rx=".4"/><rect x="18.8" y="1" width=".9" height="12" rx=".3"/></g></svg>',
  pos: '<svg width="16" height="12" viewBox="0 0 16 12"><rect x="1" y="4" width="14" height="7" rx="1" fill="none" stroke="currentColor"/><rect x="3.5" y="1" width="3" height="3" fill="currentColor"/><rect x="9.5" y="1" width="3" height="3" fill="currentColor"/></svg>',
  neg: '<svg width="16" height="12" viewBox="0 0 16 12"><rect x="1" y="4" width="14" height="7" rx="1" fill="none" stroke="currentColor"/><rect x="1" y="1" width="2.5" height="3" fill="currentColor"/><rect x="6.5" y="1" width="3" height="3" fill="currentColor"/><rect x="12.5" y="1" width="2.5" height="3" fill="currentColor"/></svg>',
};

export interface Preset {
  /** i18n: `preset.<id>` (label) and `preset.<id>.note`. */
  id: string;
  patch: Partial<Params>;
  cls?: string;
  /** Re-centre the dose on dose-to-size after applying, so only the intended failure shows. */
  sizeDose?: boolean;
}
export const PRESETS: Preset[] = [
  { id: 'nominal', patch: {}, cls: 'nominal' },
  { id: 'under', patch: { dose: 17 } },
  { id: 'over', patch: { dose: 52 } },
  { id: 'defocus', patch: { focus: 140 } },
  { id: 'misalign', patch: { alignX: 34, alignY: -22 } },
  { id: 'krf', patch: { source: 'krf' } },
  { id: 'collapse', patch: { thickness: 390 }, sizeDose: true },
  { id: 'punch', patch: { thickness: 45, etchDepth: 210 }, sizeDose: true },
  { id: 'euv', patch: { source: 'euv', halfPitch: 26, thickness: 60, etchDepth: 122 }, sizeDose: true },
];

export class Controls {
  el: HTMLElement;
  panel: HTMLDivElement;
  private head: HTMLDivElement;
  private presets: HTMLDivElement;
  private ctl: Record<ControlId, HTMLElement> = {} as Record<ControlId, HTMLElement>;
  private groups: { el: HTMLDivElement; ids: ControlId[] }[] = [];
  source: Chips;
  pattern: Chips;
  tone: Chips;
  dose: Slider;
  focus: Slider;
  hp: Slider;
  thick: Slider;
  dev: Slider;
  etch: Slider;
  align: AlignPad;
  pupil = new PupilDiagram(84);
  private srcTxt: HTMLDivElement;
  private last: Params | null = null;
  private lastKey = '';

  constructor(store: Store, onPreset: (p: Preset) => void) {
    const set = (patch: Partial<Params>) => store.setParams(patch);
    const P = store.get().params;
    this.source = new Chips(
      SOURCE_ORDER.map((id) => ({ id, label: id === 'arfi' ? 'ArF-i' : SOURCES[id].label, sub: `${SOURCES[id].short} nm`.replace('193i nm', '193 nm').replace('13.5', nf(13.5, 1)), swatch: SOURCES[id].color, title: t(`src.era.${id}`) })),
      P.source,
      3,
      (id) => set({ source: id as Params['source'] }),
    );
    this.srcTxt = h('div', { class: 'txt' });
    const srcCtl = h('div', { class: 'ctl' }, h('div', { class: 'ctl-head' }, h('label', {}, t('ctl.source')), h('output', { html: `<span>${t('ctl.source.aside')}</span>` })), this.source.el, h('div', { class: 'srcinfo' }, this.pupil.el, this.srcTxt));
    this.dose = new Slider({ label: t('ctl.dose'), min: RANGES.dose.min, max: RANGES.dose.max, step: RANGES.dose.step, value: P.dose, unit: 'mJ/cm²', nominal: NOMINAL.dose, format: (v) => nf(v, 1), onInput: (v) => set({ dose: v }) });
    this.focus = new Slider({ label: t('ctl.focus'), min: RANGES.focus.min, max: RANGES.focus.max, step: RANGES.focus.step, value: P.focus, unit: 'nm', nominal: 0, format: (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + nf(Math.abs(v), 0), onInput: (v) => set({ focus: v }) });
    this.pattern = new Chips(
      PATTERN_ORDER.map((id) => ({ id, label: t(`pattern.${id}`), icon: ICONS[id], title: t(`pattern.${id}.hint`) })),
      P.pattern,
      4,
      (id) => set({ pattern: id as Params['pattern'] }),
    );
    const patCtl = h('div', { class: 'ctl' }, h('div', { class: 'ctl-head' }, h('label', {}, t('ctl.pattern')), h('output', { html: `<span>${t('ctl.pattern.aside')}</span>` })), this.pattern.el);
    this.hp = new Slider({ label: t('ctl.hp'), min: RANGES.halfPitch.min, max: RANGES.halfPitch.max, log: true, value: P.halfPitch, unit: t('ctl.hp.unit'), nominal: NOMINAL.halfPitch, format: (v) => nf(v, 0), onInput: (v) => set({ halfPitch: Math.round(v) }) });
    this.align = new AlignPad(RANGES.align.max, (x, y) => set({ alignX: x, alignY: y }));
    this.tone = new Chips(
      [
        { id: 'positive', label: t('ctl.tone.pos'), icon: ICONS.pos, title: t('ctl.tone.pos.t') },
        { id: 'negative', label: t('ctl.tone.neg'), icon: ICONS.neg, title: t('ctl.tone.neg.t') },
      ],
      P.tone,
      2,
      (id) => set({ tone: id as Params['tone'] }),
      'tone',
    );
    const toneCtl = h('div', { class: 'ctl' }, h('div', { class: 'ctl-head' }, h('label', {}, t('ctl.tone')), h('output', { html: `<span>${t('ctl.tone.aside')}</span>` })), this.tone.el);
    this.thick = new Slider({ label: t('ctl.thick'), min: RANGES.thickness.min, max: RANGES.thickness.max, step: RANGES.thickness.step, value: P.thickness, unit: 'nm', nominal: NOMINAL.thickness, format: (v) => nf(v, 0), onInput: (v) => set({ thickness: v }) });
    this.dev = new Slider({ label: t('ctl.dev'), min: RANGES.devTime.min, max: RANGES.devTime.max, step: RANGES.devTime.step, value: P.devTime, unit: 's', nominal: NOMINAL.devTime, format: (v) => nf(v, 0), onInput: (v) => set({ devTime: v }) });
    this.etch = new Slider({ label: t('ctl.etch'), min: RANGES.etchDepth.min, max: RANGES.etchDepth.max, step: RANGES.etchDepth.step, value: P.etchDepth, unit: 'nm', nominal: NOMINAL.etchDepth, format: (v) => nf(v, 0), onInput: (v) => set({ etchDepth: v }) });
    this.etch.setMark('film', PHYS.FILM, t('mark.film'), '');

    this.ctl = { source: srcCtl, dose: this.dose.el, focus: this.focus.el, pattern: patCtl, halfPitch: this.hp.el, align: this.align.el, tone: toneCtl, thickness: this.thick.el, devTime: this.dev.el, etchDepth: this.etch.el };
    const group = (title: string, ids: ControlId[]) => {
      const el = h('div', { class: 'grp' }, h('div', { class: 'grp-h' }, h('span', { class: 'kicker' }, title)), ...ids.map((i) => this.ctl[i]));
      this.groups.push({ el, ids });
      return el;
    };
    this.head = h('div', { class: 'presets' });
    this.presets = h('div', { class: 'row' });
    for (const p of PRESETS) {
      const b = h('button', { class: p.cls ?? '' }, t(`preset.${p.id}`));
      b.addEventListener('click', () => onPreset(p));
      this.presets.append(b);
    }
    this.head.append(h('div', { class: 'kicker' }, t('presets.title')), this.presets);
    const body = h('div', { class: 'controls' }, group(t('grp.light'), ['source', 'dose', 'focus']), group(t('grp.mask'), ['pattern', 'halfPitch', 'align']), group(t('grp.resist'), ['tone', 'thickness']), group(t('grp.process'), ['devTime', 'etchDepth']));
    this.panel = h('div', { class: 'panel', style: { display: 'flex', flexDirection: 'column', minHeight: '0' } }, this.head, body);
    this.el = h('aside', { class: 'right' }, this.panel);
  }

  render(state: AppState, sim: SimController) {
    const P = state.params;
    // sync widget values when changed from outside (presets, guided set-up)
    const L = this.last;
    if (!L || L.source !== P.source) this.source.set(P.source);
    if (!L || L.pattern !== P.pattern) this.pattern.set(P.pattern);
    if (!L || L.tone !== P.tone) this.tone.set(P.tone);
    if (!L || L.dose !== P.dose) this.dose.set(P.dose);
    if (!L || L.focus !== P.focus) this.focus.set(P.focus);
    if (!L || L.halfPitch !== P.halfPitch) this.hp.set(P.halfPitch);
    if (!L || L.thickness !== P.thickness) this.thick.set(P.thickness);
    if (!L || L.devTime !== P.devTime) this.dev.set(P.devTime);
    if (!L || L.etchDepth !== P.etchDepth) this.etch.set(P.etchDepth);
    if (!L || L.alignX !== P.alignX || L.alignY !== P.alignY) this.align.set(P.alignX, P.alignY);
    this.last = P;

    // visibility
    const sandbox = state.mode === 'sandbox';
    const allowed = new Set<ControlId>(sandbox ? (Object.keys(this.ctl) as ControlId[]) : STAGES[state.stage].controls);
    for (const [id, el] of Object.entries(this.ctl) as [ControlId, HTMLElement][]) {
      el.classList.toggle('hidden', !allowed.has(id));
      el.classList.toggle('pulse', !sandbox && allowed.has(id) && !state.done[state.stage]);
    }
    for (const g of this.groups) g.el.classList.toggle('hidden', !g.ids.some((i) => allowed.has(i)));
    this.head.style.display = sandbox ? '' : 'none';
    this.el.classList.toggle('empty', allowed.size === 0);

    // derived annotations on controls
    const key = `${sim.version}|${state.mode}|${state.stage}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const src = SOURCES[P.source];
    const m = sim.metrics;
    const lim = resolutionLimit(src);
    const dof = depthOfFocus(src);
    this.srcTxt.innerHTML = t('src.info', { l: nf(src.lambda, src.lambda < 20 ? 1 : 0), na: nf(src.NA, 2), lim: nf(lim, 0), dof: nf(dof, 0) }) + (src.visible ? '' : `<br><span style="opacity:.7">${t('src.invisible')}</span>`);
    this.pupil.update(sim);
    this.dose.setMark('size', Number.isFinite(m.doseToSize) ? m.doseToSize : null, t('mark.size'));
    this.dose.setFoot(Number.isFinite(m.doseToSize) ? `<span>${t('dose.foot', { d: fmt(m.doseToSize, 1) })}</span><span>${P.dose < m.doseToSize * 0.93 ? t('dose.under') : P.dose > m.doseToSize * 1.07 ? t('dose.over') : t('dose.on')}</span>` : `<span>${t('dose.none')}</span>`);
    this.focus.setBand(-dof, dof);
    this.focus.setFoot(`<span>${t('focus.dof', { d: nf(dof, 0) })}</span><span>${Math.abs(P.focus) <= dof ? t('focus.in') : t('focus.out')}</span>`);
    this.hp.setMark('lim', lim, t('mark.limit'));
    this.hp.setFoot(`<span>${t('hp.pitch', { p: nf(P.halfPitch * 2, 0) })}</span><span>${P.halfPitch < lim ? t('hp.below') : t('hp.times', { x: nf(P.halfPitch / lim, 1) })}</span>`);
    this.align.setSpec(m.overlaySpec);
    this.thick.setFoot(`<span>${t('thick.spin', { rpm: nf(spinRpm(P.thickness), 0) })}</span><span>${t('thick.ar', { ar: nf(m.aspect, 1) })}</span>`);
    this.dev.setFoot(`<span>${t('dev.dev')}</span><span>${P.devTime < 35 ? t('dev.short') : P.devTime > 90 ? t('dev.long') : t('dev.std')}</span>`);
    const consumed = P.etchDepth / PHYS.SELECTIVITY;
    this.etch.setFoot(`<span>${t('etch.used', { u: nf(consumed, 0), t: nf(P.thickness, 0) })}</span><span>${P.etchDepth < PHYS.FILM * 0.95 ? t('etch.notCleared') : P.etchDepth > PHYS.FILM + 60 ? t('etch.intoSi') : t('etch.stop')}</span>`);
  }
}
