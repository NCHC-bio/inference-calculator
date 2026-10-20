import { describe, expect, it } from 'vitest';
import { fromSourced } from '../src/basis';

describe('fromSourced (spec §2.1)', () => {
  it('unverified: the text carries the conflict and every conflicting source id', () => {
    const b = fromSourced('hardware.x.tdpW', 'X TDP', {
      value: null,
      status: 'unverified',
      source: 's1',
      sources: ['s1', 's2'],
      conflict: '兩個來源不一致',
    });
    expect(b.text).toContain('未查證');
    expect(b.text).toContain('兩個來源不一致');
    expect(b.text).toContain('s1、s2');
    expect(b.sourceIds).toEqual(['s1', 's2']);
  });
  it('unverified with only a conflict keeps its single source', () => {
    const b = fromSourced('p', 'L', { value: null, status: 'unverified', source: 's1', conflict: '查無可查證的數值' });
    expect(b.text).toBe('L；未查證：查無可查證的數值');
    expect(b.sourceIds).toEqual(['s1']);
  });
});
