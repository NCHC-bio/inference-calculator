import { Button, InputNumber, Space, Typography } from 'antd';
import { useId, useState, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import { useTween } from '../motion/useTween';
import { COUNT_MAX } from '../state/state';

type Props = {
  unit: 'gpu' | 'machine';
  /** Core's fewest cards / machines. */
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
 * 「建議」按鈕＋卡數輸入（design §4 item 4）. While not adjusted the input shows the suggested amount, rolling from the
 * old value to the new one; what the user types is shown as typed. Only whole numbers 1..COUNT_MAX are set: anything
 * else marks the input invalid with the range hint and leaves the state alone (no min/max on InputNumber, which would
 * clamp on blur and dispatch the clamped value). Blur shows the value in use again.
 */
export function CountControl({ unit, suggested, count, adjusted, onSuggest, onSet, label }: Props): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const hintId = useId();
  const rolling = Math.round(useTween(suggested));
  const value = adjusted ? count : rolling;
  const [draft, setDraft] = useState<number | null>(value);
  const [editing, setEditing] = useState(false);
  const invalid = editing && !valid(draft);
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
          precision={0}
          style={{ width: 84 }}
          value={editing ? draft : value}
          onFocus={() => {
            setDraft(value);
            setEditing(true);
          }}
          onChange={(v) => {
            setDraft(v);
            if (valid(v) && !(adjusted && v === count)) onSet(v);
          }}
          onBlur={() => setEditing(false)}
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
