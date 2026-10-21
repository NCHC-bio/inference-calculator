import { InputNumber, Tag, Typography } from 'antd';
import { useId, useMemo, useState, type JSX } from 'react';
import { getBundle } from '../bundle';
import { useModelNotes } from '../compute/useResults';
import { useLang, useT } from '../i18n';
import { USERS_MAX, quantChoices, workloadId } from '../state/state';
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
  const notes = useModelNotes(modelOpen);

  const workloads = useMemo(() => ofRecord(b.workloads, (w) => w.description), [b]);
  const speeds = useMemo(() => ofRecord(b.speedPresets, (p) => p.description), [b]);
  const models = useMemo<Opt[]>(
    () =>
      Object.entries(b.models).map(([value, m]) => {
        // The per-row notes (onRow / noFit) get their text with the v8 sentence (later task).
        const f = notes?.[value];
        const desc = f?.kind === 'platforms' ? (f.ok === 0 ? tr('model.runsNone') : tr('model.runsOn', { ok: f.ok, total: f.total })) : undefined;
        return { value, label: m.name, desc };
      }),
    [b, notes, tr],
  );
  const quants = useMemo<Opt[]>(
    () =>
      quantChoices(b, s.model, s.customModel).map((id) => {
        const q = b.quantization[id]!;
        return { value: id, label: q.name, desc: q.description };
      }),
    [b, s.model, s.customModel],
  );

  return (
    <div data-testid="sentence" style={{ fontSize: 20, lineHeight: 2.4, marginTop: 16 }}>
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
      </span>{' '}
      <span>
        {tr('sentence.workload.pre')}{' '}
        <OptionSelect
          value={workloadId(s.workload)}
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
          popupHeader={<TierNote workload={workloadId(s.workload)} />}
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
          value={typeof s.speed === 'string' ? s.speed : ''}
          options={speeds}
          width={100}
          ariaLabel={tr('aria.speed')}
          onChange={(id) => dispatch({ type: 'speed', id })}
        />
      </span>
    </div>
  );
}
