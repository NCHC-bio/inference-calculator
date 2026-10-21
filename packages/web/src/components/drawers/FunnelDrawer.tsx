import { CoreInputError, peakConcurrentFromTotal, type FunnelResult } from '@nchc/core';
import { Alert, Button, Form, InputNumber, Typography } from 'antd';
import { useState, type JSX } from 'react';
import { getBundle } from '../../bundle';
import { useLang, useT, type MsgKey } from '../../i18n';
import { USERS_MAX, workloadId, type CalcState } from '../../state/state';
import { useCalc } from '../../state/store';
import { fmt } from '../answerText';
import { StatusTag } from '../BasisModal';
import { CalcDrawer } from './CalcDrawer';

type Share = 'dailyActiveShare' | 'requestsPerActivePerDay' | 'peakHourShare';
/** Shares are typed as percentages; requests per day as a count. */
const FIELDS: { key: Share; label: MsgKey; pct: boolean }[] = [
  { key: 'dailyActiveShare', label: 'funnel.daily', pct: true },
  { key: 'requestsPerActivePerDay', label: 'funnel.requests', pct: false },
  { key: 'peakHourShare', label: 'funnel.peak', pct: true },
];
/** Fraction ↔ percent for display, rounded so 0.05 shows as 5. */
const toPct = (v: number) => Math.round(v * 100 * 1e6) / 1e6;

type Funnel = { kind: 'result'; r: FunnelResult } | { kind: 'error'; message: string } | { kind: 'empty' };

/** core's funnel for what is typed; values left at the default are not passed (core uses its sourced defaults). */
function funnelOf(s: CalcState, total: number | null, user: Partial<Record<Share, number>>): Funnel {
  try {
    // Probing with one user still surfaces core's refusal (agent workload) before a total is typed.
    const r = peakConcurrentFromTotal(getBundle(), { total: total ?? 1, ...user, workload: s.workload, speed: s.speed });
    return total === null ? { kind: 'empty' } : { kind: 'result', r };
  } catch (e) {
    if (e instanceof CoreInputError) return { kind: 'error', message: e.message };
    throw e;
  }
}

function Body(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const b = getBundle();
  const [s, dispatch] = useCalc();
  const [total, setTotal] = useState<number | null>(null);
  const [user, setUser] = useState<Partial<Record<Share, number>>>({});
  const f = funnelOf(s, total, user);
  // Agent workloads are entered as concurrent sessions: only core's message, no conversion (design §5.5).
  if (b.workloads[workloadId(s.workload)]!.kind === 'agent') {
    return <Alert type="info" showIcon title={f.kind === 'error' ? f.message : ''} data-testid="funnel-refused" />;
  }
  return (
    <Form layout="vertical" name="funnel">
      <Form.Item label={tr('funnel.total')} htmlFor="funnel_total">
        <InputNumber<number>
          id="funnel_total"
          min={1}
          max={1e9}
          precision={0}
          placeholder={tr('funnel.total.ph')}
          style={{ width: '100%' }}
          value={total}
          onChange={(v) => setTotal(typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null)}
        />
      </Form.Item>
      {FIELDS.map(({ key, label, pct }) => {
        const def = b.funnel[key];
        const own = user[key];
        const shown = own ?? def.value;
        return (
          <Form.Item
            key={key}
            htmlFor={`funnel_${key}`}
            label={
              <span>
                {tr(label)} <StatusTag status={own === undefined ? def.status : 'user'} />
              </span>
            }
          >
            <InputNumber<number>
              id={`funnel_${key}`}
              min={0}
              max={pct ? 100 : 1e6}
              style={{ width: '100%' }}
              value={pct ? toPct(shown) : shown}
              onChange={(v) => {
                if (typeof v !== 'number') return;
                const next = pct ? v / 100 : v;
                setUser(({ [key]: _old, ...rest }) => (next === def.value ? rest : { ...rest, [key]: next }));
              }}
            />
          </Form.Item>
        );
      })}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {tr('funnel.hint')}
      </Typography.Paragraph>
      {f.kind === 'error' && <Alert type="error" showIcon title={f.message} />}
      {f.kind === 'result' && (
        <div data-testid="funnel-result" className="fade-in">
          <div style={{ fontSize: 20, fontWeight: 700 }}>{tr('funnel.result', { n: fmt(lang, f.r.users) })}</div>
          <Button
            type="primary"
            style={{ marginTop: 8 }}
            disabled={f.r.users > USERS_MAX}
            onClick={() => {
              dispatch({ type: 'users', value: f.r.users });
              dispatch({ type: 'dialog', id: null });
            }}
          >
            {tr('funnel.apply')}
          </Button>
        </div>
      )}
    </Form>
  );
}

/** 「從總人數換算同時人數」(design §5.5): core's funnel with the bundle defaults, applied to the sentence. */
export function FunnelDrawer(): JSX.Element {
  const tr = useT();
  return (
    <CalcDrawer id="funnel" title={tr('funnel.title')}>
      <Body />
    </CalcDrawer>
  );
}
