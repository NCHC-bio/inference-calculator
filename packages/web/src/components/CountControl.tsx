import { Button, InputNumber, Space, Typography } from 'antd';
import { useId, useRef, useState, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import { useTween } from '../motion/useTween';
import { COUNT_MAX } from '../state/state';

type Props = {
  unit: 'gpu' | 'machine';
  /** Core's fewest cards / machines (the count in use while not adjusted). */
  suggested: number;
  /** The count in use (the override's, else `suggested`). */
  count: number;
  /** The user set this row's count. */
  adjusted: boolean;
  onSuggest: () => void;
  onSet: (n: number) => void;
  /** Accessible name of the number input. */
  label?: string;
};

const valid = (v: number | null): v is number => v !== null && Number.isInteger(v) && v >= 1 && v <= COUNT_MAX;

/**
 * 「建議」按鈕＋卡數輸入（design §4 item 4; Ruling W6）. The field shows the count in use, rolling from the old value to
 * the new one (a new suggestion, 「建議」 after an override, a committed entry); while focused it shows what is typed.
 * A value is committed on Enter, on blur and on the −/+ step buttons (and arrow keys) only, never per keystroke. Only
 * whole numbers 1..COUNT_MAX commit: anything else (out of range, decimal, empty) marks the input invalid with the
 * range hint and dispatches nothing, and blur shows the last committed count again. No min/max/precision on
 * InputNumber: they would clamp or round the entry and commit that instead.
 */
export function CountControl({ unit, count, adjusted, onSuggest, onSet, label }: Props): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const hintId = useId();
  // When not adjusted count === suggested, so suggestion changes roll too.
  const shown = Math.round(useTween(count));
  const [draft, setDraft] = useState<number | null>(count);
  const draftRef = useRef<number | null>(count);
  const [editing, setEditing] = useState(false);
  const invalid = editing && !valid(draft);
  const setBoth = (v: number | null) => {
    draftRef.current = v;
    setDraft(v);
  };
  const commit = (v: number | null) => {
    if (valid(v) && v !== count) onSet(v);
  };
  return (
    <span data-testid="count-control" style={{ display: 'inline-flex', flexDirection: 'column', maxWidth: '100%' }}>
      <Space.Compact size="small">
        <Button type={adjusted ? 'default' : 'primary'} aria-pressed={!adjusted} onClick={onSuggest}>
          {tr('row.suggest')}
        </Button>
        <InputNumber<number>
          aria-label={label}
          aria-valuemin={1}
          aria-valuemax={COUNT_MAX}
          aria-invalid={invalid}
          aria-describedby={invalid ? hintId : undefined}
          status={invalid ? 'error' : undefined}
          style={{ width: 84 }}
          value={editing ? draft : shown}
          onFocus={() => {
            setBoth(count);
            setEditing(true);
          }}
          onChange={(v) => setBoth(v)}
          onStep={(v) => {
            setBoth(v);
            commit(v);
          }}
          onPressEnter={() => commit(draftRef.current)}
          onBlur={() => {
            commit(draftRef.current);
            setEditing(false);
          }}
        />
        <Space.Addon>{tr(unit === 'machine' ? 'unit.machine' : 'unit.gpu')}</Space.Addon>
      </Space.Compact>
      {invalid && (
        <Typography.Text type="danger" id={hintId} style={{ fontSize: 12 }}>
          {tr('count.range', { max: new Intl.NumberFormat(lang).format(COUNT_MAX) })}
        </Typography.Text>
      )}
    </span>
  );
}
