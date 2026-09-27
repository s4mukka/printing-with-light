import { h } from './dom';
import { STAGES, STAGE_COUNT, stageCopy } from '../core/stages';
import { t } from '../i18n';
import type { AppState } from '../core/store';

const EYE = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" stroke="currentColor" stroke-width="1"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1"/></svg>';
const SPEAK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 5h2.2L7.5 2.5v9L4.2 9H2z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.6 4.6a3.4 3.4 0 0 1 0 4.8M11.2 3a5.6 5.6 0 0 1 0 8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

export interface NarrationHandlers {
  onNext: () => void;
  onBack: () => void;
  onActionDown: () => void;
  onActionUp: () => void;
  onVoice: () => void;
  onSandbox: () => void;
}

/** Guided-mode card: one idea, one thing to do, one insight per step. */
export class Narration {
  el: HTMLDivElement;
  private kicker: HTMLDivElement;
  private title: HTMLHeadingElement;
  private body: HTMLParagraphElement;
  private watch: HTMLDivElement;
  private task: HTMLDivElement;
  private taskText: HTMLSpanElement;
  private action: HTMLButtonElement;
  private actionLabel: HTMLSpanElement;
  private actionFill: HTMLDivElement;
  private actionRing: SVGCircleElement;
  private insight: HTMLDivElement;
  private next: HTMLButtonElement;
  private back: HTMLButtonElement;
  private voice: HTMLButtonElement;
  private stage = -1;
  private pressed = false;

  constructor(hnd: NarrationHandlers) {
    this.kicker = h('div', { class: 'kicker' });
    this.voice = h('button', { class: 'iconbtn', title: t('narr.voice'), 'aria-label': t('narr.voice'), html: SPEAK });
    this.voice.addEventListener('click', () => hnd.onVoice());
    this.title = h('h1');
    this.body = h('p');
    this.watch = h('div', { class: 'watch' });
    this.taskText = h('span');
    this.actionLabel = h('span');
    this.actionFill = h('div', { class: 'fill' });
    const ringWrap = h('div', { class: 'ring' });
    ringWrap.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" stroke="rgba(238,235,228,.18)" stroke-width="1.5" fill="none"/><circle class="rp" cx="11" cy="11" r="9" stroke="#eeebe4" stroke-width="1.5" fill="none" stroke-linecap="round" transform="rotate(-90 11 11)" stroke-dasharray="56.55" stroke-dashoffset="56.55"/></svg>';
    this.actionRing = ringWrap.querySelector('.rp') as SVGCircleElement;
    this.action = h('button', { class: 'action' }, this.actionFill, ringWrap, this.actionLabel, h('span', { class: 'kbd' }, t('narr.space')));
    const down = (e: Event) => {
      e.preventDefault();
      this.pressed = true;
      this.action.classList.add('pressed');
      hnd.onActionDown();
    };
    const up = () => {
      if (!this.pressed) return;
      this.pressed = false;
      this.action.classList.remove('pressed');
      hnd.onActionUp();
    };
    this.action.addEventListener('pointerdown', down);
    this.action.addEventListener('pointerup', up);
    this.action.addEventListener('pointerleave', up);
    this.action.addEventListener('pointercancel', up);
    this.task = h('div', { class: 'task' }, h('div', { class: 'task-row' }, h('span', { class: 'chk' }), this.taskText), this.action);
    this.insight = h('div', { class: 'insight' });
    this.back = h('button', { class: 'btn ghost' }, t('narr.back'));
    this.back.addEventListener('click', () => hnd.onBack());
    this.next = h('button', { class: 'btn' }, t('narr.next'));
    this.next.addEventListener('click', () => (this.stage === STAGE_COUNT - 1 ? hnd.onSandbox() : hnd.onNext()));
    this.el = h(
      'div',
      { class: 'panel narr' },
      h('div', { class: 'narr-top' }, this.kicker, this.voice),
      h('div', {}, this.title),
      this.body,
      this.watch,
      this.task,
      this.insight,
      h('div', { class: 'narr-nav' }, this.back, this.next),
    );
  }

  render(state: AppState) {
    const st = STAGES[state.stage];
    if (this.stage !== state.stage) {
      const first = this.stage === -1;
      this.stage = state.stage;
      const apply = () => {
        const c = stageCopy(this.stage);
        this.kicker.textContent = t('narr.step', { n: String(st.n).padStart(2, '0'), total: String(STAGE_COUNT).padStart(2, '0') });
        this.title.textContent = c.title;
        this.body.textContent = c.narration;
        this.watch.innerHTML = `${EYE}<span>${c.watch}</span>`;
        this.taskText.textContent = c.task;
        this.insight.textContent = c.insight;
        this.action.style.display = st.action ? '' : 'none';
        this.el.classList.remove('swap');
      };
      if (first) apply();
      else {
        this.el.classList.add('swap');
        setTimeout(apply, 260);
      }
    }
    const done = state.done[state.stage];
    const p = state.progress[state.stage];
    this.task.classList.toggle('done', done);
    this.insight.classList.toggle('on', done);
    if (st.action) {
      const complete = p >= 1;
      const running = state.playing === state.stage && p > 0 && p < 1;
      this.actionLabel.textContent = complete ? (st.action.kind === 'hold' ? t('narr.doneHold') : t('narr.donePress')) : running && st.action.kind === 'press' ? t('narr.running') : stageCopy(state.stage).action;
      this.action.classList.toggle('complete', complete);
      this.actionFill.style.width = `${(complete ? 0 : p) * 100}%`;
      this.actionRing.setAttribute('stroke-dashoffset', String(56.55 * (1 - p)));
    }
    this.back.toggleAttribute('disabled', state.stage === 0);
    const last = state.stage === STAGE_COUNT - 1;
    this.next.textContent = last ? t('narr.sandbox') : done ? t('narr.next') : t('narr.skip');
    this.next.classList.toggle('primary', done);
    this.voice.classList.toggle('on', state.voice);
  }
}
