import type { BigView, MicroCam } from './store';
import { t } from '../i18n';

export type ControlId = 'source' | 'dose' | 'focus' | 'align' | 'pattern' | 'halfPitch' | 'thickness' | 'tone' | 'devTime' | 'etchDepth';
export type Station = 'coater' | 'hotplate' | 'scanner' | 'etcher' | 'inspect';

export interface StageAction {
  /** hold = progress only advances while pressed; press = one click plays it. */
  kind: 'hold' | 'press';
  duration: number; // seconds at full speed
}

export interface StageDef {
  n: number;
  key: string;
  station: Station;
  big: BigView;
  microCam: MicroCam;
  action?: StageAction;
  controls: ControlId[];
}

/** Choreography of the nine steps. All copy lives in the i18n dictionary under `stage.<key>.*`. */
export const STAGES: StageDef[] = [
  { n: 1, key: 'prep', station: 'coater', big: 'tool', microCam: '3d', action: { kind: 'hold', duration: 2.4 }, controls: [] },
  { n: 2, key: 'coat', station: 'coater', big: 'tool', microCam: '3d', action: { kind: 'press', duration: 3.6 }, controls: ['thickness'] },
  { n: 3, key: 'softbake', station: 'hotplate', big: 'tool', microCam: 'section', action: { kind: 'hold', duration: 2.2 }, controls: [] },
  { n: 4, key: 'align', station: 'scanner', big: 'tool', microCam: 'top', controls: ['align'] },
  { n: 5, key: 'expose', station: 'scanner', big: 'tool', microCam: 'section', action: { kind: 'press', duration: 5.5 }, controls: ['source', 'dose', 'focus'] },
  { n: 6, key: 'peb', station: 'hotplate', big: 'micro', microCam: 'section', action: { kind: 'hold', duration: 2.6 }, controls: [] },
  { n: 7, key: 'develop', station: 'coater', big: 'micro', microCam: '3d', action: { kind: 'press', duration: 3.4 }, controls: ['tone', 'devTime'] },
  { n: 8, key: 'etch', station: 'etcher', big: 'micro', microCam: '3d', action: { kind: 'press', duration: 3.6 }, controls: ['etchDepth'] },
  { n: 9, key: 'result', station: 'inspect', big: 'tool', microCam: '3d', action: { kind: 'press', duration: 2.6 }, controls: [] },
];

export const STAGE_COUNT = STAGES.length;

/** Localised copy of a stage. */
export function stageCopy(i: number) {
  const k = STAGES[i].key;
  const g = (f: string) => t(`stage.${k}.${f}`);
  return { title: g('title'), short: g('short'), narration: g('narration'), watch: g('watch'), task: g('task'), insight: g('insight'), action: g('action') };
}
