import { quantOptions } from '@nchc/core';
import { InputNumber, Tag, Typography } from 'antd';
import { useId, useMemo, useState, type JSX } from 'react';
import { getBundle } from '../bundle';
import { useModelFeasibility } from '../compute/useResults';
import { useLang, useT } from '../i18n';
import { HAVE_MAX, USERS_MAX } from '../state/state';
import { useCalc } from '../state/store';
import { OptionSelect, type Opt } from './OptionSelect';

type CountProps = { value: number; max: number; ariaLabel: string; width: number; onChange: (v: number | null) => void };

/**
 * Integer input. Every edit is dispatched and the reducer keeps the last valid value; the draft only mirrors
 * what is typed, and blur shows the store's value again. No min/max on InputNumber itself: it would clamp an
 * out-of-range entry on blur (0 → 1) and dispatch that, overwriting the last valid value. The range is still
 * announced through aria-valuemin / aria-valuemax. While the draft differs from the value in use (out of range or
 * empty), the input is marked invalid and a hint states the range, so the answer never silently disagrees with what
 * is typed (final review I3).
 */
function CountInput({ value, max, ariaLabel, width, onChange }: CountProps) {
  const tr = useT();
  const lang = useLang();
  const hintId = useId();
  const [draft, setDraft] = useState<number | null>(value);
  const [editing, setEditing] = useState(false);
  const invalid = editing && draft !== value;
  return (
    <>
      <InputNumber<number>
        aria-label={ariaLabel}
        aria-valuemin={1}
        aria-valuemax={max}
        aria-invalid={invalid}
        aria-describedby={invalid ? hintId : undefined}
        status={invalid ? 'error' : undefined}
        variant="underlined"
        size="large"
        precision={0}
        style={{ width }}
        value={editing ? draft : value}
        onFocus={() => {
          setDraft(value);
          setEditing(true);
        }}
        onChange={(v) => {
          setDraft(v);
          onChange(v);
        }}
        onBlur={() => setEditing(false)}
      />
      {invalid && (
        <Typography.Text type="danger" id={hintId} style={{ fontSize: 12, marginInlineStart: 4 }}>
          {tr('count.range', { max: new Intl.NumberFormat(lang).format(max) })}
        </Typography.Text>
      )}
    </>
  );
}

function TierNote({ workload }: { workload: string }) {
  const tr = useT();
  const note = getBundle().workloads[workload]!.tierNote;
  return (
    <Typography.Text style={{ fontSize: 12, whiteSpace: 'normal' }}>
      {tr('model.tier', { tier: note.value })}
      {note.status === 'estimate' && (
        <Tag style={{ marginInlineStart: 6 }}>{tr('tag.estimate')}</Tag>
      )}
    </Typography.Text>
  );
}

const ofRecord = <T extends { name: string }>(rec: Record<string, T>, desc: (x: T) => string | undefined): Opt[] =>
  Object.entries(rec).map(([value, x]) => ({ value, label: x.name, desc: desc(x) }));

/** 「同時最多有 [人數] 人會使用，做 [工作] 任務，模型用 [模型]，模型精度用 [量化]，希望回應速度 [速度]」(spec §8.3.3). */
export function Sentence(): JSX.Element {
  const tr = useT();
  const b = getBundle();
  const [s, dispatch] = useCalc();
  const [modelOpen, setModelOpen] = useState(false);
  const feasibility = useModelFeasibility(modelOpen);

  const workloads = useMemo(() => ofRecord(b.workloads, (w) => w.description), [b]);
  const speeds = useMemo(() => ofRecord(b.speedPresets, (p) => p.description), [b]);
  // No description: the label already is name + sub, and a line repeating it adds nothing (final review).
  const platforms = useMemo<Opt[]>(
    () => Object.entries(b.platforms).map(([value, p]) => ({ value, label: p.sub ? `${p.name} ${p.sub}` : p.name })),
    [b],
  );
  const models = useMemo<Opt[]>(
    () =>
      Object.entries(b.models).map(([value, m]) => {
        const f = feasibility?.[value];
        const desc = f && (f.ok === 0 ? tr('model.runsNone') : tr('model.runsOn', { ok: f.ok, total: f.total }));
        return { value, label: m.name, desc };
      }),
    [b, feasibility, tr],
  );
  const quants = useMemo<Opt[]>(
    () =>
      quantOptions(b, s.model).map((id) => {
        const q = b.quantization[id]!;
        return { value: id, label: q.name, desc: q.description };
      }),
    [b, s.model],
  );

  const unit = b.platforms[s.havePlatform]!.unit === 'machine' ? tr('unit.machine') : tr('unit.gpu');
  return (
    <div data-testid="sentence" style={{ fontSize: 20, lineHeight: 2.4, marginTop: 16 }}>
      {s.mode === 'need' ? (
        <span>
          {tr('sentence.users.pre')}{' '}
          <CountInput
            value={s.users}
            max={USERS_MAX}
            width={120}
            ariaLabel={tr('aria.users')}
            onChange={(value) => dispatch({ type: 'users', value })}
          />{' '}
          {tr('sentence.users.post')}
        </span>
      ) : (
        <span>
          {tr('sentence.have.pre')}{' '}
          <CountInput
            value={s.haveCount}
            max={HAVE_MAX}
            width={90}
            ariaLabel={tr('aria.haveCount')}
            onChange={(value) => dispatch({ type: 'haveCount', value })}
          />{' '}
          {unit}{' '}
          <OptionSelect
            value={s.havePlatform}
            options={platforms}
            width={150}
            ariaLabel={tr('aria.platform')}
            onChange={(id) => dispatch({ type: 'havePlatform', id })}
          />
          {tr('sentence.have.post')}
        </span>
      )}{' '}
      <span>
        {tr('sentence.workload.pre')}{' '}
        <OptionSelect
          value={s.workload}
          options={workloads}
          width={130}
          ariaLabel={tr('aria.workload')}
          onChange={(id) => dispatch({ type: 'workload', id })}
        />{' '}
        {tr('sentence.workload.post')}
      </span>{' '}
      <span>
        {tr('sentence.model.pre')}{' '}
        <OptionSelect
          value={s.model}
          options={models}
          width={190}
          showSearch
          ariaLabel={tr('aria.model')}
          onChange={(id) => dispatch({ type: 'model', id })}
          onOpenChange={setModelOpen}
          popupHeader={<TierNote workload={s.workload} />}
        />
        {tr('sentence.model.post')}
      </span>{' '}
      <span>
        {tr('sentence.quant.pre')}{' '}
        <OptionSelect
          value={s.quant}
          options={quants}
          width={90}
          ariaLabel={tr('aria.quant')}
          onChange={(id) => dispatch({ type: 'quant', id })}
        />
        {tr('sentence.quant.post')}
      </span>{' '}
      <span>
        {tr('sentence.speed.pre')}{' '}
        <OptionSelect
          value={s.speed}
          options={speeds}
          width={100}
          ariaLabel={tr('aria.speed')}
          onChange={(id) => dispatch({ type: 'speed', id })}
        />
      </span>
    </div>
  );
}
