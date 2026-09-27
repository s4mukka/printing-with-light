import { nf } from '../i18n';

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (SVGElement | null)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c);
  return el;
}

export function svgHTML(markup: string, w: number, hgt: number, cls = '') {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<svg class="${cls}" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" fill="none" xmlns="${SVGNS}">${markup}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** Tween a displayed number toward a target for calm, readable read-outs. */
export class Tween {
  v: number;
  constructor(v = 0) {
    this.v = v;
  }
  step(target: number, dt: number, rate = 12) {
    if (!Number.isFinite(target)) return (this.v = target);
    if (!Number.isFinite(this.v)) this.v = target;
    this.v += (target - this.v) * (1 - Math.exp(-rate * dt));
    return this.v;
  }
}

export const fmt = (v: number, d = 1) => nf(v, d);
export const sign = (v: number, d = 1) => (Number.isFinite(v) ? (v >= 0 ? '+' : '−') + nf(Math.abs(v), d) : '—');
