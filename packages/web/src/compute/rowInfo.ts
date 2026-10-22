import type { Bundle } from '@nchc/schema';
import { customIndex, type CalcState, type RowKey, type SubLabel } from '../state/state';

/** What a row shows about its platform: catalog entry or the user's custom one. */
export type RowInfo = {
  name: string;
  /** Catalog sub-label, or the custom platform's memory × count and engine. */
  sub: SubLabel;
  unit: 'gpu' | 'machine';
  gpusPerNode: number;
  /** Index into customPlatforms for a custom row. */
  custom: number | null;
  /** Bundle group ('nchc' | 'self'); custom rows count as self-hosted. */
  self: boolean;
  /** Catalog hardware id (for its TDP record). */
  hardware: string | null;
};

export function rowInfo(b: Bundle, s: CalcState, row: RowKey): RowInfo {
  const i = customIndex(row);
  if (i !== null) {
    const p = s.customPlatforms[i]!;
    return {
      name: p.name,
      sub: { key: 'platforms.customSub', vars: { mem: p.memGB, gpn: p.gpusPerNode, engine: p.engine === 'mlx' ? 'MLX' : 'vLLM' } },
      unit: p.unit,
      gpusPerNode: p.gpusPerNode,
      custom: i,
      self: true,
      hardware: null,
    };
  }
  const p = b.platforms[row]!;
  return { name: p.name, sub: p.sub, unit: p.unit, gpusPerNode: p.gpusPerNode.value, custom: null, self: p.group === 'self', hardware: p.hardware };
}
