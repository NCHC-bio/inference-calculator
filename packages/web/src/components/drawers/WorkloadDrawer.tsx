import { Form, InputNumber, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../../bundle';
import { useT, type MsgKey } from '../../i18n';
import { workloadId, type WorkloadSel } from '../../state/state';
import { useCalc } from '../../state/store';
import { CalcDrawer } from './CalcDrawer';

type Custom = Exclude<WorkloadSel, string>;
type Field = 'inputTokens' | 'outputTokens' | 'cacheHitRate';
const FIELDS: { key: Field; label: MsgKey; min: number; max?: number; pct?: boolean }[] = [
  { key: 'inputTokens', label: 'workload.input', min: 0 },
  { key: 'outputTokens', label: 'workload.output', min: 1 },
  { key: 'cacheHitRate', label: 'workload.hit', min: 0, max: 99.9, pct: true },
];
const toPct = (v: number) => Math.round(v * 100 * 1e6) / 1e6;

/** The current workload as its three numbers: the custom one, else the preset's values. */
export function workloadValues(w: WorkloadSel): Custom {
  if (typeof w !== 'string') return w;
  const p = getBundle().workloads[w]!;
  return { base: w, inputTokens: p.inputTokens.value, outputTokens: p.outputTokens.value, cacheHitRate: p.cacheHitRate.value };
}

function Body(): JSX.Element {
  const tr = useT();
  const [s, dispatch] = useCalc();
  const base = workloadId(s.workload);
  const name = getBundle().workloads[base]!.name;
  const v = workloadValues(s.workload);
  return (
    <Form layout="vertical" name="workload">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {tr('workload.hint', { name })}
      </Typography.Paragraph>
      {FIELDS.map(({ key, label, min, max, pct }) => (
        <Form.Item key={key} label={tr(label)} htmlFor={`workload_${key}`}>
          <InputNumber<number>
            id={`workload_${key}`}
            min={min}
            max={max}
            precision={pct ? undefined : 0}
            style={{ width: '100%' }}
            value={pct ? toPct(v[key]) : v[key]}
            onChange={(x) => {
              if (typeof x !== 'number') return;
              // The reducer keeps the last valid workload when a value is out of range.
              dispatch({ type: 'workloadCustom', value: { ...v, [key]: pct ? x / 100 : x } });
            }}
          />
        </Form.Item>
      ))}
      <Typography.Link
        onClick={() => {
          dispatch({ type: 'workload', id: base });
          dispatch({ type: 'dialog', id: null });
        }}
      >
        {tr('workload.reset', { name })}
      </Typography.Link>
    </Form>
  );
}

/** 「自訂工作」: input / output length and cache hit rate on top of the selected preset; every change is live. */
export function WorkloadDrawer(): JSX.Element {
  const tr = useT();
  return (
    <CalcDrawer id="workload" title={tr('workload.title')}>
      <Body />
    </CalcDrawer>
  );
}
