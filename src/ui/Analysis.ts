import { h, fmt, sign, Tween } from './dom';
import { AerialChart, ProcessWindowChart } from './charts';
import type { SimController } from '../sim/controller';
import type { Risk } from '../sim/engine';
import { t, nf } from '../i18n';

const RISK_IDS: Risk['id'][] = ['resolution', 'dose', 'focus', 'overlay', 'collapse', 'etch', 'stochastic'];

/** Localised explanation of a failure-mode lamp. */
export function riskNote(r: Risk) {
  const vars: Record<string, string> = {};
  if (r.vars) for (const [k, v] of Object.entries(r.vars)) vars[k] = typeof v === 'number' ? nf(v, 1) : v;
  return t(r.note, vars);
}

/** Sandbox read-out: numbers, the aerial image, the process window and the failure lamps. */
export class Analysis {
  el: HTMLDivElement;
  private cd: HTMLDivElement;
  private cdD: HTMLDivElement;
  private ler: HTMLDivElement;
  private lerD: HTMLDivElement;
  private dts: HTMLDivElement;
  private dtsD: HTMLDivElement;
  private yl: HTMLDivElement;
  private ylD: HTMLDivElement;
  private ybar: HTMLElement;
  private aerial = new AerialChart();
  private pw = new ProcessWindowChart();
  private riskEls = new Map<string, { lamp: HTMLElement; el: HTMLElement }>();
  private note: HTMLDivElement;
  private pwAside: HTMLSpanElement;
  private aerAside: HTMLSpanElement;
  private tCd = new Tween(0);
  private tY = new Tween(0);
  private hoverRisk: string | null = null;

  constructor() {
    const metric = (k: string) => {
      const v = h('div', { class: 'v' });
      const d = h('div', { class: 'd' });
      return { el: h('div', { class: 'metric' }, h('div', { class: 'k' }, k), v, d), v, d };
    };
    const a = metric(t('an.cd'));
    const b = metric(t('an.ler'));
    const c = metric(t('an.dts'));
    const d = metric(t('an.yield'));
    this.cd = a.v;
    this.cdD = a.d;
    this.ler = b.v;
    this.lerD = b.d;
    this.dts = c.v;
    this.dtsD = c.d;
    this.yl = d.v;
    this.ylD = d.d;
    this.ybar = h('i');
    d.el.append(h('div', { class: 'yieldbar' }, this.ybar));
    this.aerAside = h('span', { class: 'aside' });
    this.pwAside = h('span', { class: 'aside' });
    const risks = h('div', { class: 'risks' });
    for (const id of RISK_IDS) {
      const lamp = h('span', { class: 'lamp' });
      const el = h('div', { class: 'risk' }, lamp, h('span', { class: 'n' }, t(`risk.short.${id}`)));
      el.addEventListener('pointerenter', () => (this.hoverRisk = id));
      el.addEventListener('pointerleave', () => (this.hoverRisk = null));
      this.riskEls.set(id, { lamp, el });
      risks.append(el);
    }
    this.note = h('div', { class: 'risk-note' });
    const lg = (color: string, key: string) => h('span', { html: `<i style="background:${color}"></i>${t(key)}` });
    this.el = h(
      'div',
      { class: 'panel analysis' },
      h('div', {}, h('div', { class: 'sec-h' }, h('span', { class: 'kicker' }, t('an.printed')), h('span', { class: 'aside' }, t('an.site'))), h('div', { class: 'bigcd' }, a.el, b.el, c.el, d.el)),
      h('div', {}, h('div', { class: 'sec-h' }, h('span', { class: 'kicker' }, t('an.aerial')), this.aerAside), this.aerial.el, h('div', { class: 'legend' }, lg('#d9ceff', 'an.lg.light'), lg('repeating-linear-gradient(90deg,rgba(238,235,228,.5) 0 2px,transparent 2px 4px)', 'an.lg.mask'), lg('#ffb35c', 'an.lg.thr'))),
      h('div', {}, h('div', { class: 'sec-h' }, h('span', { class: 'kicker' }, t('an.pw')), this.pwAside), this.pw.el, h('div', { class: 'legend' }, lg('#7fe0b5', 'an.lg.ok'), lg('rgba(255,179,92,.6)', 'an.lg.wide'), lg('rgba(185,166,255,.6)', 'an.lg.narrow'))),
      h('div', {}, h('div', { class: 'sec-h' }, h('span', { class: 'kicker' }, t('an.fail')), h('span', { class: 'aside' }, t('an.hover'))), risks, this.note),
    );
  }

  update(sim: SimController, dt: number) {
    const m = sim.metrics;
    const p = sim.params;
    const cdv = this.tCd.step(m.missing ? 0 : m.cd, dt);
    this.cd.innerHTML = m.missing || m.bridged ? '—' : `${nf(cdv, 1)}<small>nm</small>`;
    const e = m.cdErr * 100;
    this.cdD.textContent = m.unresolved ? t('an.cd.unres') : m.missing ? t('an.cd.missing') : m.bridged ? t('an.cd.bridged') : t('an.cd.vs', { e: sign(e, 1), t: nf(m.cdTarget, 0), kind: t(`kind.${m.featureKind}`) });
    this.cdD.className = 'd ' + (m.missing || m.bridged || Math.abs(e) > 10 ? 'bad' : Math.abs(e) > 5 ? 'warn' : 'ok');
    this.ler.innerHTML = m.missing ? '—' : `${fmt(m.ler, 1)}<small>nm 3σ</small>`;
    const lr = m.cdTarget ? m.ler / m.cdTarget : 0;
    this.lerD.textContent = m.missing ? t('an.ler.none') : lr > 0.2 ? t('an.ler.bad') : lr > 0.1 ? t('an.ler.warn') : t('an.ler.ok');
    this.lerD.className = 'd ' + (m.missing ? '' : lr > 0.2 ? 'bad' : lr > 0.1 ? 'warn' : 'ok');
    this.dts.innerHTML = Number.isFinite(m.doseToSize) ? `${fmt(m.doseToSize, 1)}<small>mJ/cm²</small>` : '—';
    const dd = Number.isFinite(m.doseToSize) ? (p.dose / m.doseToSize - 1) * 100 : NaN;
    this.dtsD.textContent = Number.isFinite(dd) ? t('an.dts.you', { d: nf(p.dose, 1), p: sign(dd, 0) }) : t('an.dts.none');
    this.dtsD.className = 'd ' + (!Number.isFinite(dd) || Math.abs(dd) > 20 ? 'bad' : Math.abs(dd) > 7 ? 'warn' : 'ok');
    const y = sim.wafer ? sim.wafer.yield * 100 : 0;
    const yv = this.tY.step(y, dt);
    this.yl.innerHTML = `${nf(yv, 0)}<small>%</small>`;
    const n = sim.wafer?.dies.length ?? 0;
    this.ylD.textContent = t('an.y.dies', { g: Math.round((y / 100) * n), n });
    this.ylD.className = 'd ' + (y < 50 ? 'bad' : y < 85 ? 'warn' : 'ok');
    this.ybar.style.width = `${yv}%`;
    this.ybar.style.backgroundPosition = `${-(1 - yv / 100) * 200}px 0`;

    this.aerial.update(sim);
    this.pw.update(sim);
    this.aerAside.textContent = t('an.contrast', { c: nf(m.contrast * 100, 0) });
    let inSpec = 0;
    if (sim.pw) for (const v of sim.pw.err) if (!Number.isNaN(v) && Math.abs(v) <= 0.1) inSpec++;
    this.pwAside.textContent = sim.pw ? t('an.pw.spec', { p: nf((inSpec / sim.pw.err.length) * 100, 0) }) : '';

    const prio: Record<string, number> = { collapse: 0.03, etch: 0.025, overlay: 0.02, focus: 0.015, resolution: 0.012, stochastic: 0.008, dose: 0 };
    let worst = m.risks[0];
    for (const r of m.risks) {
      const it = this.riskEls.get(r.id)!;
      const c = r.level > 0.66 ? 'var(--bad)' : r.level > 0.33 ? 'var(--warn)' : 'var(--ok)';
      it.lamp.style.background = c;
      it.lamp.style.color = c;
      it.el.title = riskNote(r);
      if (r.level + prio[r.id] > worst.level + prio[worst.id]) worst = r;
    }
    const show = this.hoverRisk ? m.risks.find((r) => r.id === this.hoverRisk)! : worst;
    const txt = show.level < 0.33 && !this.hoverRisk ? t('an.allclear') : `<b>${t(`risk.${show.id}`)}.</b> ${riskNote(show)}`;
    if (this.note.innerHTML !== txt) this.note.innerHTML = txt;
  }
}
