import type * as THREE from 'three';
import type { AppState } from '../core/store';
import type { ProcessState, SimController } from '../sim/controller';

export interface Annotation {
  id: string;
  title: string;
  sub?: string;
  obj: THREE.Object3D;
  offset?: THREE.Vector3;
  visible: boolean;
  /** Which side of the anchor the label sits on. */
  side?: 'left' | 'right';
  accent?: boolean;
}

export interface FrameContext {
  dt: number;
  time: number;
  state: AppState;
  ps: ProcessState;
  sim: SimController;
  /** True when this scene is rendered in the big view. */
  big: boolean;
  /** Canvas size and the horizontal bounds of the unobstructed area (px). */
  view: { w: number; h: number; l: number; r: number };
}
