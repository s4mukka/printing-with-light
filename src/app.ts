import * as THREE from 'three';
import { Store, initialState, type AppState, type Mode } from './core/store';
import { STAGES, STAGE_COUNT, stageCopy } from './core/stages';
import { t, onLang, getLang, applyDocument } from './i18n';
import { NOMINAL, SOURCES } from './core/params';
import { SimController, processState } from './sim/controller';
import { N } from './sim/engine';
import { ToolScene } from './scene/tool/ToolScene';
import { MicroScene } from './scene/micro/MicroScene';
import { Viewport } from './render/Viewport';
import { LabelLayer } from './ui/Labels';
import { h } from './ui/dom';
import { Controls } from './ui/Controls';
import { Narration } from './ui/Narration';
import { Analysis } from './ui/Analysis';
import { Topbar, Timeline, Loupe, ViewBar, Intro, Toast } from './ui/Chrome';
import type { FrameContext } from './scene/types';

const GUIDED_MISALIGN = { alignX: 38, alignY: -26 };

export class App {
  store = new Store(initialState());
  sim: SimController;
  tool = new ToolScene();
  micro = new MicroScene();
  vpBig: Viewport;
  vpLoupe: Viewport;
  labels = new LabelLayer();
  stageCanvas: HTMLCanvasElement;
  topbar: Topbar;
  timeline: Timeline;
  narration: Narration;
  analysis: Analysis;
  controls: Controls;
  loupe: Loupe;
  viewbar: ViewBar;
  intro: Intro;
  toast = new Toast();
  left: HTMLElement;
  private holding = false;
  private manualCut = false;
  private lastSiteKey = '';
  private last = performance.now();
  private time = 0;
  private free = { l: 0, r: 0, t: 76, b: 104 };
  private layoutDirty = true;
  private blockedWas = false;
  private toastGate = 0;

  constructor(root: HTMLElement) {
    this.sim = new SimController(this.store.get().params);
    this.stageCanvas = h('canvas', { id: 'stage' });
    this.topbar = this.makeTopbar();
    this.timeline = this.makeTimeline();
    this.narration = this.makeNarration();
    this.analysis = new Analysis();
    this.controls = this.makeControls();
    this.loupe = new Loupe(() => this.swap());
    this.viewbar = this.makeViewBar();
    this.intro = this.makeIntro(true);
    this.left = h('aside', { class: 'left' }, this.narration.el, this.analysis.el);
    root.append(this.stageCanvas, this.labels.el, this.topbar.el, this.left, this.controls.el, this.loupe.el, this.viewbar.el, this.timeline.el, this.toast.el, this.intro.el);

    this.vpBig = new Viewport(this.stageCanvas, { maxDpr: 1.5, bloom: 0.62, samples: 2 });
    this.vpLoupe = new Viewport(this.loupe.canvas, { maxDpr: 1.5, bloom: 0.5, circle: true, shadows: false, samples: 2 });
    if (!this.vpBig.floatLinear) for (const t of [this.sim.fieldTex, this.sim.auxTex, this.sim.sectionTex]) t.minFilter = t.magFilter = THREE.NearestFilter;

    this.store.subscribe((s, prev) => {
      if (s.mode !== prev.mode || s.intro !== prev.intro || s.stage !== prev.stage) this.layoutDirty = true;
      // flipping the tone during development re-runs the developer so the inversion is seen happening
      if (s.params.tone !== prev.params.tone && s.stage === 6 && s.progress[6] >= 1) {
        const progress = s.progress.slice();
        progress[6] = 0.35;
        queueMicrotask(() => this.store.set({ progress, playing: 6 }));
      }
    });
    window.addEventListener('resize', () => (this.layoutDirty = true));
    this.bindKeys();
    this.applyVisibility();
    applyDocument();
    onLang(() => this.rebuildUI());
    if (new URLSearchParams(location.search).has('stats')) {
      // ?stats — frame time and adaptive resolution read-out for tuning on a given machine
      const el = h('div', { style: { position: 'absolute', right: '12px', bottom: '8px', zIndex: '30', font: '10px var(--mono)', color: 'var(--ink-3)', pointerEvents: 'none' } });
      root.append(el);
      setInterval(() => (el.textContent = `${(1000 / this.frameEMA).toFixed(0)} fps · ${this.frameEMA.toFixed(1)} ms · dpr ${this.vpBig.dpr.toFixed(2)}`), 500);
    }
    requestAnimationFrame(this.frame);
  }

  // ───────────────────────── UI factories (rebuilt on language change) ─────────────────────────

  private makeTopbar() {
    return new Topbar((m) => this.setMode(m));
  }
  private makeTimeline() {
    return new Timeline(
      (i) => this.goStage(i),
      () => this.goStage(Math.max(0, this.store.get().stage - 1)),
      () => this.goStage(Math.min(STAGE_COUNT - 1, this.store.get().stage + 1)),
    );
  }
  private makeNarration() {
    return new Narration({
      onNext: () => this.goStage(Math.min(STAGE_COUNT - 1, this.store.get().stage + 1)),
      onBack: () => this.goStage(Math.max(0, this.store.get().stage - 1)),
      onActionDown: () => this.actionDown(),
      onActionUp: () => this.actionUp(),
      onVoice: () => {
        const v = !this.store.get().voice;
        this.store.set({ voice: v });
        if (v) this.speak(this.store.get().stage);
        else window.speechSynthesis?.cancel();
      },
      onSandbox: () => this.setMode('sandbox'),
    });
  }
  private makeControls() {
    return new Controls(this.store, (p) => {
      this.store.setParams({ ...NOMINAL, pattern: this.store.get().params.pattern, ...p.patch });
      if (p.sizeDose) {
        this.sim.setParams(this.store.get().params);
        const d = this.sim.metrics.doseToSize;
        if (Number.isFinite(d)) this.store.setParams({ dose: Math.round(d * 2) / 2 });
      }
      this.manualCut = false;
      this.toast.show(t(`preset.${p.id}.note`));
    });
  }
  private makeViewBar() {
    return new ViewBar(
      (c) => this.store.set({ microCam: c }),
      (l) => this.store.set({ microLayer: l }),
      (v) => {
        this.manualCut = true;
        this.store.set({ cut: v });
      },
      (v) => this.store.set({ exploded: v }),
      () => this.tool.overview(),
    );
  }
  private makeIntro(animate: boolean) {
    return new Intro(
      () => this.begin('guided'),
      () => this.begin('sandbox'),
      animate,
    );
  }

  /** Swap every text-bearing component for a freshly built one; canvases and scenes stay untouched. */
  private rebuildUI() {
    const s = this.store.get();
    const langFocused = !!(document.activeElement as HTMLElement | null)?.closest('.lang');
    const swap = <T extends { el: HTMLElement }>(old: T, next: T) => {
      old.el.replaceWith(next.el);
      return next;
    };
    this.topbar = swap(this.topbar, this.makeTopbar());
    this.timeline = swap(this.timeline, this.makeTimeline());
    this.narration = swap(this.narration, this.makeNarration());
    this.analysis = swap(this.analysis, new Analysis());
    this.controls = swap(this.controls, this.makeControls());
    this.viewbar = swap(this.viewbar, this.makeViewBar());
    if (s.intro) this.intro = swap(this.intro, this.makeIntro(false));
    this.loupe.relabel();
    this.tool.plates.redraw();
    this.applyVisibility();
    this.layoutDirty = true;
    // keep keyboard focus on the switch that was just used
    if (langFocused) (this.topbar.el.querySelector('.lang button.on') as HTMLButtonElement | null)?.focus();
    if (s.voice) this.speak(s.stage);
  }

  // ───────────────────────── flow ─────────────────────────

  begin(mode: Mode) {
    this.intro.hide();
    this.tool.introMode = false;
    this.store.set({ intro: false });
    if (mode === 'guided') {
      // the logic layout makes every lesson legible — especially the tone flip (wires ↔ trenches)
      this.store.set({ mode: 'guided', progress: new Array(STAGE_COUNT).fill(0), done: new Array(STAGE_COUNT).fill(false), params: { ...NOMINAL, pattern: 'logic' } });
      this.goStage(0, true);
    } else this.setMode('sandbox');
    this.applyVisibility();
  }

  setMode(m: Mode) {
    const s = this.store.get();
    if (s.intro) {
      this.begin(m);
      return;
    }
    if (m === s.mode) return;
    window.speechSynthesis?.cancel();
    if (m === 'sandbox') {
      this.store.set({ mode: 'sandbox', progress: new Array(STAGE_COUNT).fill(1), done: new Array(STAGE_COUNT).fill(true) });
      this.goStage(s.stage < 6 ? 6 : s.stage, true);
      this.toast.show(t('toast.sandbox'), 4200);
    } else {
      this.store.set({ mode: 'guided' });
      this.goStage(s.stage, true);
    }
    this.applyVisibility();
  }

  goStage(i: number, force = false) {
    const s = this.store.get();
    if (i === s.stage && !force) return;
    this.holding = false;
    const st = STAGES[i];
    const patch: Partial<AppState> = { stage: i, playing: -1, big: st.big };
    if (s.mode === 'guided') patch.microCam = st.microCam;
    if (s.mode === 'sandbox' && st.action) {
      const progress = s.progress.slice();
      progress[i] = 0;
      patch.progress = progress;
      patch.playing = i;
    }
    this.store.set(patch);
    if (s.mode === 'guided' && i === 3 && !s.done[3]) this.store.setParams(GUIDED_MISALIGN);
    if (s.mode === 'guided') this.speak(i);
    this.layoutDirty = true;
  }

  swap() {
    const s = this.store.get();
    this.store.set({ big: s.big === 'tool' ? 'micro' : 'tool' });
  }

  actionDown() {
    const s = this.store.get();
    const st = STAGES[s.stage];
    if (!st.action) return;
    const progress = s.progress.slice();
    if (progress[s.stage] >= 1) progress[s.stage] = 0;
    if (st.action.kind === 'hold' && s.mode === 'guided') {
      this.holding = true;
      this.store.set({ progress, playing: s.stage });
    } else this.store.set({ progress, playing: s.stage });
  }
  actionUp() {
    const s = this.store.get();
    const st = STAGES[s.stage];
    if (this.holding) {
      this.holding = false;
      if (st.action?.kind === 'hold') this.store.set({ playing: -1 });
    }
  }

  private speak(stage: number) {
    const s = this.store.get();
    const synth = window.speechSynthesis;
    if (!s.voice || !synth) return;
    synth.cancel();
    const c = stageCopy(stage);
    const u = new SpeechSynthesisUtterance(`${c.title}. ${c.narration} ${c.task}`);
    const voices = synth.getVoices();
    const pt = getLang() === 'pt';
    u.lang = pt ? 'pt-BR' : 'en-GB';
    const pick = pt
      ? (voices.find((v) => /pt-BR/i.test(v.lang) && /Natural|Online|Google|Francisca|Thalita|Antonio/i.test(v.name)) ?? voices.find((v) => /pt-BR/i.test(v.lang)) ?? voices.find((v) => /^pt/i.test(v.lang)))
      : (voices.find((v) => /en-GB/.test(v.lang) && /Natural|Online|Google|Daniel|Libby|Sonia/i.test(v.name)) ?? voices.find((v) => /^en/.test(v.lang) && /Natural|Online|Google|Samantha|Aria|Jenny/i.test(v.name)) ?? voices.find((v) => /^en/.test(v.lang)));
    if (pick) u.voice = pick;
    u.rate = 0.97;
    u.pitch = 1;
    synth.speak(u);
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      const s = this.store.get();
      if (s.intro) {
        // Enter on a focused button (e.g. the language switch) must only press that button
        if (e.key === 'Enter' && tag !== 'BUTTON') this.begin('guided');
        return;
      }
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        this.actionDown();
      } else if (tag !== 'INPUT' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (e.target as HTMLElement).getAttribute('role') !== 'slider') {
        this.goStage(Math.max(0, Math.min(STAGE_COUNT - 1, s.stage + (e.key === 'ArrowRight' ? 1 : -1))));
      } else if (e.key === 'v' || e.key === 'V') this.swap();
      else if (e.key === 'g' || e.key === 'G') this.setMode('guided');
      else if (e.key === 's' || e.key === 'S') this.setMode('sandbox');
      else if (e.key === '1') this.store.set({ microCam: '3d' });
      else if (e.key === '2') this.store.set({ microCam: 'section' });
      else if (e.key === '3') this.store.set({ microCam: 'top' });
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.actionUp();
    });
  }

  private applyVisibility() {
    const s = this.store.get();
    const vis = (el: HTMLElement, on: boolean) => el.classList.toggle('ui-off', !on);
    const ui = !s.intro;
    vis(this.topbar.el.querySelector('.brand') as HTMLElement, ui);
    vis(this.topbar.el.querySelector('.mode') as HTMLElement, ui);
    vis(this.topbar.el.querySelector('.readouts') as HTMLElement, ui);
    vis(this.left, ui);
    vis(this.controls.el, ui);
    vis(this.loupe.el, ui);
    vis(this.timeline.el, ui);
    vis(this.viewbar.el, ui);
    this.narration.el.style.display = s.mode === 'guided' ? '' : 'none';
    this.analysis.el.style.display = s.mode === 'sandbox' ? '' : 'none';
  }

  private measure() {
    const s = this.store.get();
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (s.intro) {
      this.free = { l: W * 0.3, r: W, t: 0, b: H * 0.8 };
      return;
    }
    const lr = this.left.getBoundingClientRect();
    const rr = this.controls.el.getBoundingClientRect();
    const rightOn = !this.controls.el.classList.contains('empty') && rr.width > 0;
    const lp = this.loupe.el.getBoundingClientRect();
    const b = lp.height > 0 ? Math.min(H - 104, lp.top + 40) : H - 104;
    this.free = { l: lr.width > 0 ? lr.right + 12 : 0, r: rightOn ? rr.left - 12 : W, t: 110, b };
  }

  // ───────────────────────── loop ─────────────────────────

  private frameEMA = 16;
  private frameCount = 0;
  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const interval = now - this.last;
    if (interval > 0 && interval < 200) {
      this.frameEMA += (interval - this.frameEMA) * 0.08;
      this.vpBig.adapt(this.frameEMA);
      this.vpLoupe.adapt(this.frameEMA);
    }
    this.step(now);
  };

  /** Deterministic fast-forward (used for automated visual checks when the page is not being painted). */
  advance(seconds: number, fps = 60) {
    const n = Math.round(seconds * fps);
    for (let i = 0; i < n; i++) this.step(this.last + 1000 / fps);
  }

  private step(now: number) {
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    let s = this.store.get();

    // stage action progress
    const st = STAGES[s.stage];
    if (st.action && s.playing === s.stage) {
      const speed = s.mode === 'sandbox' ? 1.35 : 1;
      const advancing = st.action.kind === 'press' || s.mode === 'sandbox' || this.holding;
      if (advancing) {
        const progress = s.progress.slice();
        progress[s.stage] = Math.min(1, progress[s.stage] + (dt / st.action.duration) * speed);
        const patch: Partial<AppState> = { progress };
        if (progress[s.stage] >= 1) {
          patch.playing = -1;
          this.holding = false;
          const done = s.done.slice();
          done[s.stage] = true;
          patch.done = done;
          if (s.mode === 'guided' && s.stage === 4) setTimeout(() => this.store.get().stage === 4 && this.toast.show(t('toast.tryG'), 5200), 900);
        }
        this.store.set(patch);
      }
    }
    s = this.store.get();
    // alignment task
    if (s.stage === 3 && !s.done[3] && Math.hypot(s.params.alignX, s.params.alignY) <= 3) {
      const done = s.done.slice();
      done[3] = true;
      const progress = s.progress.slice();
      progress[3] = 1;
      this.store.set({ done, progress });
    }
    s = this.store.get();

    // simulation
    this.sim.setParams(s.params);
    const siteKey = `${s.params.pattern}|${s.params.halfPitch}|${s.params.tone}`;
    if (siteKey !== this.lastSiteKey) {
      this.lastSiteKey = siteKey;
      this.manualCut = false;
    }
    if (!this.manualCut) {
      const cut = (this.sim.metrics.siteRow + 0.5) / N;
      const c = Math.min(0.9, Math.max(0, ((cut % 1) + 1) % 1));
      if (Math.abs(c - s.cut) > 1e-6) this.store.set({ cut: c });
    }
    s = this.store.get();
    const ps = processState(s.stage, s.progress);
    this.sim.updateDisplay(ps, s.cut);

    // scenes
    const toolBig = s.big === 'tool';
    const ctxBase: Omit<FrameContext, 'big'> = { dt, time: this.time, state: s, ps, sim: this.sim, view: { w: window.innerWidth, h: window.innerHeight, l: this.free.l, r: this.free.r } };
    this.tool.update({ ...ctxBase, big: toolBig && !s.intro });
    this.micro.update({ ...ctxBase, big: !toolBig && !s.intro });
    this.tool.rig.update(dt);
    this.micro.rig.update(dt);

    // guided hints on pupil clipping
    if (this.tool.blockedOrders && !this.blockedWas && s.stage === 4 && this.time > this.toastGate) {
      this.toast.show(t('toast.blocked', { l: SOURCES[s.params.source].lambda }), 4200);
      this.toastGate = this.time + 6;
    }
    this.blockedWas = this.tool.blockedOrders;

    // layout
    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.applyVisibility();
      requestAnimationFrame(() => this.measure());
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.vpBig.setSize(W, H);
    const lr = this.loupe.lens.getBoundingClientRect();
    this.vpLoupe.setSize(lr.width, lr.height);
    const bigRig = toolBig ? this.tool.rig : this.micro.rig;
    const smallRig = toolBig ? this.micro.rig : this.tool.rig;
    bigRig.attach(this.stageCanvas);
    smallRig.attach(this.loupe.lens);
    const cam = bigRig.camera;
    cam.aspect = W / H;
    const cx = (this.free.l + this.free.r) / 2;
    const cy = (this.free.t + this.free.b) / 2;
    cam.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
    cam.updateProjectionMatrix();
    const sc = smallRig.camera;
    sc.aspect = 1;
    sc.clearViewOffset();
    sc.updateProjectionMatrix();

    const bigScene = toolBig ? this.tool.scene : this.micro.scene;
    const smallScene = toolBig ? this.micro.scene : this.tool.scene;
    this.frameCount++;
    this.vpBig.render(bigScene, cam, this.time, toolBig ? 0.3 : 0.55);
    // the loupe is small and secondary: 30 fps is plenty
    if (!s.intro && (this.frameCount % 2 === 0 || smallRig.interacting)) this.vpLoupe.render(smallScene, sc, this.time, toolBig ? 0.55 : 0.3);

    // labels & UI
    this.labels.update(toolBig ? this.tool.annotations : this.micro.annotations, cam, W, H);
    this.topbar.update(s, this.sim, dt);
    this.timeline.update(s);
    if (s.mode === 'guided') this.narration.render(s);
    else this.analysis.update(this.sim, dt);
    this.controls.render(s, this.sim);
    const solo = this.controls.el.classList.contains('empty');
    this.loupe.update(s, this.sim, solo);
    this.viewbar.update(s);
  }
}
