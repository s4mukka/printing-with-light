import { EN, PT } from './strings';

export type Lang = 'en' | 'pt';

const DICTS: Record<Lang, Record<string, string>> = { en: EN, pt: PT };
const STORAGE_KEY = 'litho.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'pt') return saved;
  } catch {
    /* storage unavailable — fall through to the browser language */
  }
  return (navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

let lang: Lang = detect();
const listeners = new Set<(l: Lang) => void>();

export function getLang() {
  return lang;
}

export function setLang(l: Lang) {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
  applyDocument();
  for (const fn of listeners) fn(l);
}

export function onLang(fn: (l: Lang) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Translate a key; `{name}` placeholders are filled from `vars`. Falls back to English, then the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[lang][key] ?? EN[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Like `t` but returns '' when the key is missing. */
export function tOpt(key: string, vars?: Record<string, string | number>): string {
  return key in EN || key in DICTS[lang] ? t(key, vars) : '';
}

const nfCache = new Map<string, Intl.NumberFormat>();
/** Locale-aware number: 82.2 → "82,2" in Portuguese. */
export function nf(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  const key = `${lang}|${digits}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    nfCache.set(key, f);
  }
  return f.format(v);
}

export function applyDocument() {
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  document.title = t('doc.title');
}
