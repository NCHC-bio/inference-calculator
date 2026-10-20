import type { Queueing, ShapeUsage } from '@nchc/core';
import { Col, Row, Typography } from 'antd';
import type { JSX } from 'react';
import { useLang, useT } from '../i18n';
import { Explain } from './Explain';
import { MemoryBar } from './MemoryBar';
import { TypingDemo } from './TypingDemo';
import { UsageBars } from './UsageBars';

const num = (lang: string, n: number, digits: number, min = 0) =>
  new Intl.NumberFormat(lang, { minimumFractionDigits: min, maximumFractionDigits: digits }).format(n);
const small = { fontSize: 12 } as const;
const help = { ...small, cursor: 'help', textDecoration: 'underline dotted' } as const;

/**
 * 點開一列後的細節（spec §8.3.3）：打字示範、四根使用率條、記憶體組成，底部是配置、功耗與排隊。
 * `power` omitted → no power line (the have mode); `kw: null` → 「功耗未查證」 with `note` in a popover.
 */
export function RowDetail(props: {
  id?: string;
  usage: ShapeUsage;
  unit: 'gpu' | 'machine';
  demoText: string;
  power?: { kw: number | null; note?: string };
  queueing?: Queueing | null;
}): JSX.Element {
  const { id, usage, unit, demoText, power, queueing } = props;
  const tr = useT();
  const lang = useLang();
  const { tp, replicas } = usage.shape;
  const shape =
    unit === 'gpu' ? tr('detail.shape.gpu', { tp: num(lang, tp, 0), replicas: num(lang, replicas, 0) }) : tr('detail.shape.machine', { replicas: num(lang, replicas, 0) });

  let powerLine: JSX.Element | null = null;
  if (power) {
    if (power.kw !== null) powerLine = <span>{tr('detail.power', { kw: num(lang, power.kw, 1, 1) })}</span>;
    else if (power.note)
      powerLine = (
        <Explain content={<div style={{ maxWidth: 300 }}>{power.note}</div>}>
          <span tabIndex={0} style={help}>
            {tr('detail.powerUnknown')}
          </span>
        </Explain>
      );
    else powerLine = <span>{tr('detail.powerUnknown')}</span>;
  }

  return (
    <div id={id} data-testid="row-detail" style={{ padding: '4px 8px 16px' }}>
      <Row gutter={[24, 12]}>
        <Col xs={24} md={13}>
          <TypingDemo text={demoText} tokPerSec={usage.tokPerSecPerUser} ttftSec={usage.ttftSec} />
        </Col>
        <Col xs={24} md={11}>
          <UsageBars share={usage.share} />
          <MemoryBar memory={usage.memory} />
          <Typography.Text type="secondary" style={{ ...small, display: 'block' }}>
            <span>{shape}</span>
            {powerLine && <> · {powerLine}</>}
          </Typography.Text>
          {queueing && (
            <Typography.Text type="secondary" style={{ ...small, display: 'block' }}>
              <Explain content={<div style={{ maxWidth: 320 }}>{queueing.reason}</div>}>
                <span tabIndex={0} style={help}>
                  {tr('detail.queue', { sec: num(lang, queueing.waitSec, 1) })}
                </span>
              </Explain>
            </Typography.Text>
          )}
        </Col>
      </Row>
    </div>
  );
}
