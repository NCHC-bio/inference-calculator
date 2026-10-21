/**
 * User funnel (spec 2026-10-21 §5.5, main spec §4.3): total registered users -> peak concurrent users.
 * λ = total × dailyActiveShare × requestsPerActivePerDay × peakHourShare ÷ 3600 (requests/s in the busiest hour);
 * Little's law: concurrent = λ × service time. Pure; no Node or DOM APIs.
 */
import { z } from 'zod';
import type { Bundle } from '@nchc/schema';
import { MAX_USERS, SpeedInputSchema, WorkloadInputSchema, resolveWorkloadSpeed } from './api';
import { BasisCollector, fromSourced, fromUser, trustFlags, type BasisItem } from './basis';
import { CoreInputError, parseInput } from './errors';

const FunnelInputSchema = z.strictObject({
  total: z.number().int().min(1).max(1e9),
  dailyActiveShare: z.number().gt(0).max(1).optional(),
  requestsPerActivePerDay: z.number().gt(0).max(1e6).optional(),
  peakHourShare: z.number().gt(0).max(1).optional(),
  workload: WorkloadInputSchema,
  speed: SpeedInputSchema,
});
export type FunnelInput = z.input<typeof FunnelInputSchema>;

export type FunnelResult = {
  /** Peak concurrent users: max(1, ceil(arrivalPerSec × serviceSec)). */
  users: number;
  /** Requests per second in the peak hour. */
  arrivalPerSec: number;
  /** Service time per request used in Little's law: maxTtftSec + outputTokens ÷ minTokPerSec. */
  serviceSec: number;
  /** True when the raw result exceeded the requirement API bound (MAX_USERS) and `users` was clamped to it. */
  capped: boolean;
  /** Chinese note to show when `capped`; undefined otherwise. */
  capNote?: string;
  basis: BasisItem[];
  hasEstimate: boolean;
  hasUser: boolean;
};

/**
 * Only chat workloads convert (agent users are entered as concurrent sessions directly). Defaults come from
 * `bundle.funnel`; any value the caller gives is a user value (basis status 'user').
 * Throws CoreInputError('invalid-input') for out-of-range input or an agent workload, 'unknown-id' for an unknown preset.
 */
export function peakConcurrentFromTotal(bundle: Bundle, raw: FunnelInput): FunnelResult {
  const input = parseInput(FunnelInputSchema, raw);
  const basis = new BasisCollector();
  const { kind, workload, speed } = resolveWorkloadSpeed(bundle, input.workload, input.speed, basis);
  if (kind === 'agent') {
    throw new CoreInputError('invalid-input', '輸入不合法：研究助理類任務請直接填尖峰同時在線人數，不適用總人數換算');
  }

  const f = bundle.funnel;
  const pick = (
    k: 'dailyActiveShare' | 'requestsPerActivePerDay' | 'peakHourShare',
    label: string,
  ): number => {
    const user = input[k];
    if (user !== undefined) {
      basis.add(fromUser(`funnel.${k}`, label, user));
      return user;
    }
    basis.add(fromSourced(`funnel.${k}`, label, f[k]));
    return f[k].value;
  };
  const d = pick('dailyActiveShare', '每日活躍比例');
  const r = pick('requestsPerActivePerDay', '每位活躍者每日請求數');
  const p = pick('peakHourShare', '尖峰一小時佔每日請求比例');

  const arrivalPerSec = (input.total * d * r * p) / 3600;
  const serviceSec = speed.maxTtftSec + workload.outputTokens / speed.minTokPerSec;
  const rawUsers = Math.max(1, Math.ceil(arrivalPerSec * serviceSec - 1e-9));
  const capped = rawUsers > MAX_USERS;
  const users = capped ? MAX_USERS : rawUsers;
  const capNote = capped
    ? `換算結果超過上限，已以 ${MAX_USERS / 1e4} 萬位同時在線計算（原值約 ${rawUsers.toExponential(2)}）；請縮小總人數或改用較短的輸出。`
    : undefined;

  // Designer judgement (spec §5.5): the real service time depends on the result, so the speed target's upper bound is
  // used to avoid a circular dependency; the result errs on the high side.
  basis.add({
    path: 'funnel.serviceSec',
    status: 'derived',
    value: serviceSec,
    sourceIds: [],
    text: `服務時間（秒）= maxTtftSec + outputTokens ÷ minTokPerSec = ${speed.maxTtftSec} + ${workload.outputTokens} ÷ ${speed.minTokPerSec}；`
      + '實際服務時間取決於結果，這裡取速度標準的上限以避免循環，結果偏保守（同時人數偏多）。'
      + `同時人數 = 到達率 λ × 服務時間（Little's law），λ = 總人數 × 活躍比例 × 每日請求數 × 尖峰比例 ÷ 3600`,
  });

  const list = basis.list();
  return { users, arrivalPerSec, serviceSec, capped, ...(capNote ? { capNote } : {}), basis: list, ...trustFlags(list) };
}
