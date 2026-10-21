import { Form, InputNumber, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../../bundle';
import { useT } from '../../i18n';
import type { SpeedSel } from '../../state/state';
import { useCalc } from '../../state/store';
import { CalcDrawer } from './CalcDrawer';

type Custom = Exclude<SpeedSel, string>;

/** The current speed target as two numbers: the custom one, else the preset's values. */
export function speedValues(sp: SpeedSel): Custom {
  if (typeof sp !== 'string') return sp;
  const p = getBundle().speedPresets[sp]!;
  return { minTokPerSec: p.minTokensPerSec.value, maxTtftSec: p.maxTtftSec.value };
}

function Body(): JSX.Element {
  const tr = useT();
  const [s, dispatch] = useCalc();
  const v = speedValues(s.speed);
  const set = (patch: Partial<Custom>) => dispatch({ type: 'speedCustom', value: { ...v, ...patch } });
  return (
    <Form layout="vertical" name="speed">
      <Form.Item label={tr('speed.tps')} htmlFor="speed_tps">
        <InputNumber<number>
          id="speed_tps"
          min={0.1}
          style={{ width: '100%' }}
          value={v.minTokPerSec}
          onChange={(x) => typeof x === 'number' && x > 0 && set({ minTokPerSec: x })}
        />
      </Form.Item>
      <Form.Item label={tr('speed.ttft')} htmlFor="speed_ttft">
        <InputNumber<number>
          id="speed_ttft"
          min={0.1}
          style={{ width: '100%' }}
          value={v.maxTtftSec}
          onChange={(x) => typeof x === 'number' && x > 0 && set({ maxTtftSec: x })}
        />
      </Form.Item>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tr('speed.hint')}
      </Typography.Text>
    </Form>
  );
}

/** 「自訂速度」: per-user speed and the longest wait for the first word; every change is live. */
export function SpeedDrawer(): JSX.Element {
  const tr = useT();
  return (
    <CalcDrawer id="speed" title={tr('speed.title')}>
      <Body />
    </CalcDrawer>
  );
}
