import type { PerformanceResult } from '@nchc/core';
import { Select, Typography } from 'antd';
import type { JSX } from 'react';
import { useLang, useT, type TFn } from '../i18n';
import { Explain } from './Explain';

const int = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/** 切法的白話說法（design §3.7）：tp 張卡合跑一份模型，共 replicas 份；Mac／Spark 每台一份。不說「副本」。 */
export function splitText(tp: number, replicas: number, unit: 'gpu' | 'machine', tr: TFn): string {
  const vars = { tp: int.format(tp), replicas: int.format(replicas) };
  if (unit === 'machine') return tr('split.machine', vars);
  return tr(tp === 1 ? 'split.gpu1' : 'split.gpu', vars);
}

/** The plain split text with SPLIT_HELP on hover / tap / focus. */
export function SplitText({ tp, replicas, unit }: { tp: number; replicas: number; unit: 'gpu' | 'machine' }): JSX.Element {
  const tr = useT();
  return (
    <Explain content={<div style={{ maxWidth: 300 }}>{tr('wb.split.help')}</div>}>
      <span tabIndex={0} className="help-text">
        {splitText(tp, replicas, unit, tr)}
      </span>
    </Explain>
  );
}

/**
 * 切法選單：core 的每個合法切法（perf.splits），各附每人速度、首字、人數上限；recommendedTp 那一項標「（建議）」。
 * `value` is the split shown (perf.shape.tp); picking one calls onPick(tp).
 */
export function SplitSelect({ perf, unit, onPick }: { perf: PerformanceResult; unit: 'gpu' | 'machine'; onPick: (tp: number) => void }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const f = (n: number, d: number) => new Intl.NumberFormat(lang, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  // Ruling W8: a split that cannot hold the model or one user is disabled and says 「放不下」 instead of a speed.
  const options = perf.splits.map((e) => {
    const split = splitText(e.shape.tp, e.shape.replicas, unit, tr);
    const noFit = !e.ok && e.maxConcurrent === 0;
    const label = noFit
      ? tr('wb.split.noFit', { split })
      : tr('wb.split.option', { split, tps: f(e.tokPerSecPerUser, 0), ttft: f(e.ttftSec, 1), max: f(e.maxConcurrent, 0) });
    return { value: e.shape.tp, disabled: noFit, label: label + (e.shape.tp === perf.recommendedTp ? tr('wb.split.recommended') : '') };
  });
  return (
    <div data-testid="split-select" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <Explain content={<div style={{ maxWidth: 300 }}>{tr('wb.split.help')}</div>}>
          <span tabIndex={0} className="help-text">
            {tr('wb.split')}
          </span>
        </Explain>
      </Typography.Text>
      <Select
        size="small"
        aria-label={tr('wb.split')}
        style={{ flex: '1 1 240px', minWidth: 0, maxWidth: '100%' }}
        popupMatchSelectWidth={false}
        value={perf.shape?.tp}
        options={options}
        onChange={(tp: number) => onPick(tp)}
      />
    </div>
  );
}
