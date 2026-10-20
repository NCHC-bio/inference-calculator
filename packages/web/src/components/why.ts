import type { Why } from '@nchc/core';
import type { MsgKey } from '../i18n';

/** Short infeasibility reason per core code; a new core code fails to compile here. */
export const WHY: Record<Why, MsgKey> = {
  context: 'why.context',
  tp: 'why.tp',
  weights: 'why.weights',
  mem: 'why.mem',
  bw: 'why.bw',
  compute: 'why.compute',
  ttft: 'why.ttft',
};
