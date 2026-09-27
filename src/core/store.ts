import { NOMINAL, type Params } from './params';

export type Mode = 'guided' | 'sandbox';
export type BigView = 'tool' | 'micro';
export type MicroCam = '3d' | 'section' | 'top';
export type MicroLayer = 'none' | 'overlay' | 'aerial';

export interface AppState {
  mode: Mode;
  stage: number;
  /** Animation progress of each stage's action, 0 … 1. */
  progress: number[];
  params: Params;
  big: BigView;
  microCam: MicroCam;
  microLayer: MicroLayer;
  exploded: number;
  cut: number;
  /** Guided task completion per stage. */
  done: boolean[];
  voice: boolean;
  intro: boolean;
  waferMap: boolean;
  /** Stage currently playing its action. */
  playing: number;
}

type Listener = (s: AppState, prev: AppState) => void;

export class Store {
  private s: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.s = initial;
  }
  get(): AppState {
    return this.s;
  }
  set(patch: Partial<AppState>) {
    const prev = this.s;
    this.s = { ...prev, ...patch };
    for (const l of this.listeners) l(this.s, prev);
  }
  setParams(patch: Partial<Params>) {
    this.set({ params: { ...this.s.params, ...patch } });
  }
  setProgress(stage: number, v: number) {
    const progress = this.s.progress.slice();
    progress[stage] = v;
    this.set({ progress });
  }
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export function initialState(): AppState {
  return {
    mode: 'guided',
    stage: 0,
    progress: new Array(9).fill(0),
    params: { ...NOMINAL },
    big: 'tool',
    microCam: '3d',
    microLayer: 'none',
    exploded: 0,
    cut: 0.5,
    done: new Array(9).fill(false),
    voice: false,
    intro: true,
    waferMap: false,
    playing: -1,
  };
}
