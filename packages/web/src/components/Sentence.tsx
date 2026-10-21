import { CloudDownloadOutlined, FormOutlined } from '@ant-design/icons';
import { Button, InputNumber, Popover, Space, Tag, Typography } from 'antd';
import { useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { getBundle } from '../bundle';
import { useDeferredState, useModelNotes, type ModelNotesView } from '../compute/useResults';
import { unitWord, useLang, useT, type Lang, type TFn } from '../i18n';
import { CUSTOM_MODEL_ID, USERS_MAX, quantChoices, workloadId, type Action, type CalcState } from '../state/state';
import { useCalc } from '../state/store';
import { fmt } from './answerText';
import { OptionSelect, type Opt } from './OptionSelect';
import { rowInfo } from './PlatformRow';

type CountProps = { value: number; max: number; ariaLabel: string; width: number; onChange: (v: number | null) => void; hint: (close: () => void) => ReactNode };

/**
 * Integer input. Every edit is dispatched and the reducer keeps the last valid value; the draft only mirrors
 * what is typed, and blur shows the store's value again. No min/max on InputNumber itself: it would clamp an
 * out-of-range entry on blur (0 → 1) and dispatch that, overwriting the last valid value. The range is still
 * announced through aria-valuemin / aria-valuemax. While the draft differs from the value in use (out of range or
 * empty), the input is marked invalid and a hint states the range, so the answer never silently disagrees with what
 * is typed (final review I3).
 *
 * While the field (or its popover) has focus, a popover under it holds the range hint and `hint` (the funnel entry,
 * design §3.1). The popover is rendered inside the clause, so Tab reaches its button and focus moving there keeps it
 * open; the range hint lives there too so it never widens the nowrap clause.
 */
function CountInput({ value, max, ariaLabel, width, onChange, hint }: CountProps) {
  const tr = useT();
  const lang = useLang();
  const hintId = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const [draft, setDraft] = useState<number | null>(value);
  const [editing, setEditing] = useState(false);
  const [focus, setFocus] = useState(false);
  const invalid = editing && draft !== value;
  const content = (
    <div style={{ whiteSpace: 'normal', maxWidth: 280 }}>
      {invalid && (
        <Typography.Text type="danger" id={hintId} style={{ display: 'block', fontSize: 12 }}>
          {tr('count.range', { max: new Intl.NumberFormat(lang).format(max) })}
        </Typography.Text>
      )}
      {hint(() => setFocus(false))}
    </div>
  );
  return (
    <span
      ref={wrap}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
    >
      <Popover open={focus} placement="bottomLeft" arrow={false} content={content} getPopupContainer={() => wrap.current ?? document.body}>
        <InputNumber<number>
          aria-label={ariaLabel}
          aria-valuemin={1}
          aria-valuemax={max}
          aria-invalid={invalid}
          aria-describedby={invalid ? hintId : undefined}
          status={invalid ? 'error' : undefined}
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
      </Popover>
    </span>
  );
}

/** 「只知道總人數？換算同時人數」 under the focused users field (design §3.1). */
function FunnelHint({ onOpen }: { onOpen: () => void }) {
  const tr = useT();
  return (
    // mousedown would blur the field and close the popover before the click lands.
    <Button size="small" type="link" style={{ padding: 0 }} onMouseDown={(e) => e.preventDefault()} onClick={onOpen}>
      {tr('users.funnelHint')}
    </Button>
  );
}

/** Model menu header: 「推估（參考用）這類任務建議：…」 (design §4 item 2). */
function TierNote({ workload }: { workload: string }) {
  const tr = useT();
  const note = getBundle().workloads[workload]!.tierNote;
  return (
    <div data-testid="tier-note" style={{ padding: '6px 10px', fontSize: 12, whiteSpace: 'normal' }}>
      <Tag color="orange">{note.status === 'estimate' ? tr('model.tierTag') : tr('model.tierTagRef')}</Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tr('model.tier', { tier: note.value })}
      </Typography.Text>
    </div>
  );
}

const HF_REPO_LIKE = /^[\w.-]+\/[\w.-]+$/;

/** Search matched no model: import from Hugging Face (pre-filled when it looks like `owner/name`) or enter by hand. */
function ModelNotFound({ search, close, dispatch }: { search: string; close: () => void; dispatch: (a: Action) => void }) {
  const tr = useT();
  const repo = HF_REPO_LIKE.test(search) ? search : '';
  const open = (a: Action) => {
    close();
    dispatch(a);
  };
  return (
    <div style={{ padding: 8, whiteSpace: 'normal' }}>
      <div style={{ marginBottom: 6 }}>{tr('model.notFound')}</div>
      <Space wrap>
        <Button size="small" icon={<CloudDownloadOutlined />} onClick={() => open({ type: 'dialog', id: 'hf', hfQuery: repo })}>
          {repo ? tr('model.importRepo', { repo }) : tr('model.importHf')}
        </Button>
        <Button size="small" icon={<FormOutlined />} onClick={() => open({ type: 'dialog', id: 'manualModel' })}>
          {tr('model.manual')}
        </Button>
      </Space>
    </div>
  );
}

/** One model option's note (design §4 item 2): speed / 放不下 on the adjusted row, else how many platforms run it. */
function modelDesc(view: ModelNotesView | null, id: string, s: CalcState, tr: TFn, lang: Lang): string | undefined {
  const note = view?.notes[id];
  if (!view || !note) return undefined;
  if (note.kind === 'platforms') return note.ok === 0 ? tr('model.runsNone') : tr('model.runsOn', { ok: note.ok, total: note.total });
  if (!view.row) return undefined;
  const info = rowInfo(getBundle(), s, view.row.row);
  const where = { count: fmt(lang, view.row.count), unit: unitWord(tr, info.unit, view.row.count), name: info.name };
  if (note.kind === 'noFit') return tr('model.noFit', where);
  return tr('model.onRow', { ...where, tps: fmt(lang, note.tps) }) + (note.ok ? '' : tr('model.onRowMiss'));
}

const ofRecord = <T extends { name: string }>(rec: Record<string, T>, desc: (x: T) => string | undefined): Opt[] =>
  Object.entries(rec).map(([value, x]) => ({ value, label: x.name, desc: desc(x) }));

/**
 * 「同時最多有 [人數] 人會使用，做 [工作] 任務，模型用 [模型]，模型精度用 [量化]，希望回應速度 [速度]」(spec §8.3.3). One
 * complete sentence: each clause keeps together (nowrap) and the sentence wraps between clauses (demo v8 `.clause`).
 */
export function Sentence(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const b = getBundle();
  const [s, dispatch] = useCalc();
  // The notes describe the deferred inputs; the row they name is looked up in the same state.
  const deferred = useDeferredState();
  const [modelOpen, setModelOpen] = useState(false);
  const notes = useModelNotes(modelOpen);

  const workloads = useMemo(() => ofRecord(b.workloads, (w) => w.description), [b]);
  const speeds = useMemo(() => ofRecord(b.speedPresets, (p) => p.description), [b]);
  const models = useMemo<Opt[]>(() => {
    const list: Opt[] = Object.entries(b.models).map(([value, m]) => ({ value, label: m.name, desc: modelDesc(notes, value, deferred, tr, lang) }));
    const c = s.customModel;
    // The custom model is the current value: listed so the field shows its name instead of the internal id.
    if (c) list.push({ value: CUSTOM_MODEL_ID, label: c.kind === 'hf' ? c.repo : (c.value.name ?? tr('opt.custom')) });
    return list;
  }, [b, notes, deferred, tr, lang, s.customModel]);
  const quants = useMemo<Opt[]>(
    () =>
      quantChoices(b, s.model, s.customModel).map((id) => {
        const q = b.quantization[id]!;
        return { value: id, label: q.name, desc: q.description };
      }),
    [b, s.model, s.customModel],
  );

  return (
    <div className="sent" data-testid="sentence">
      <span className="clause">
        {tr('sentence.users.pre')}{' '}
        <CountInput
          value={s.users}
          max={USERS_MAX}
          width={110}
          ariaLabel={tr('aria.users')}
          onChange={(value) => dispatch({ type: 'users', value })}
          hint={(close) => (
            <FunnelHint
              onOpen={() => {
                close();
                dispatch({ type: 'dialog', id: 'funnel' });
              }}
            />
          )}
        />{' '}
        {tr('sentence.users.post')}
      </span>{' '}
      <span className="clause">
        {tr('sentence.workload.pre')}{' '}
        <OptionSelect
          value={workloadId(s.workload)}
          options={workloads}
          width={150}
          popupWidth={280}
          ariaLabel={tr('aria.workload')}
          onChange={(id) => dispatch({ type: 'workload', id })}
          custom={{ desc: tr('opt.custom.workload'), selected: typeof s.workload !== 'string', onPick: () => dispatch({ type: 'dialog', id: 'workload' }) }}
        />{' '}
        {tr('sentence.workload.post')}
      </span>{' '}
      <span className="clause">
        {tr('sentence.model.pre')}{' '}
        <OptionSelect
          value={s.model}
          options={models}
          width={250}
          popupWidth={340}
          showSearch
          ariaLabel={tr('aria.model')}
          onChange={(id) => dispatch({ type: 'model', id })}
          onOpenChange={setModelOpen}
          popupHeader={<TierNote workload={workloadId(s.workload)} />}
          notFound={(search, close) => <ModelNotFound search={search} close={close} dispatch={dispatch} />}
        />
        {tr('sentence.model.post')}
      </span>{' '}
      <span className="clause">
        {tr('sentence.quant.pre')}{' '}
        <OptionSelect
          value={s.quant}
          options={quants}
          width={100}
          popupWidth={240}
          ariaLabel={tr('aria.quant')}
          onChange={(id) => dispatch({ type: 'quant', id })}
        />
        {tr('sentence.quant.post')}
      </span>{' '}
      <span className="clause">
        {tr('sentence.speed.pre')}{' '}
        <OptionSelect
          value={typeof s.speed === 'string' ? s.speed : ''}
          options={speeds}
          width={110}
          popupWidth={280}
          ariaLabel={tr('aria.speed')}
          onChange={(id) => dispatch({ type: 'speed', id })}
          custom={{ desc: tr('opt.custom.speed'), selected: typeof s.speed !== 'string', onPick: () => dispatch({ type: 'dialog', id: 'speed' }) }}
        />
      </span>
    </div>
  );
}
