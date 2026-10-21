import { CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import type { Bundle } from '@nchc/schema';
import { Button, Space, Tag, theme, Typography } from 'antd';
import type { JSX } from 'react';
import type { OkRow } from '../compute/compute';
import { useLang, useT } from '../i18n';
import type { TFn } from '../i18n/t';
import { useTween } from '../motion/useTween';
import { customIndex, type CalcState, type RowKey, type SubLabel } from '../state/state';
import { CapacityBar } from './CapacityBar';
import { CountControl } from './CountControl';
import { Explain } from './Explain';
import { Isotype } from './Isotype';
import { WHY } from './why';

const fmt = (lang: string, n: number, digits = 0) =>
  new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

/** What a row shows about its platform: catalog entry or the user's custom one. */
export type RowInfo = {
  name: string;
  /** Catalog sub-label, or the custom platform's memory × count and engine. */
  sub: SubLabel;
  unit: 'gpu' | 'machine';
  gpusPerNode: number;
  /** Index into customPlatforms for a custom row. */
  custom: number | null;
  /** Bundle group ('nchc' | 'self'); custom rows count as self-hosted. */
  self: boolean;
  /** Catalog hardware id (for its TDP record). */
  hardware: string | null;
};

export function rowInfo(b: Bundle, s: CalcState, row: RowKey): RowInfo {
  const i = customIndex(row);
  if (i !== null) {
    const p = s.customPlatforms[i]!;
    return {
      name: p.name,
      sub: { key: 'platforms.customSub', vars: { mem: p.memGB, gpn: p.gpusPerNode, engine: p.engine === 'mlx' ? 'MLX' : 'vLLM' } },
      unit: p.unit,
      gpusPerNode: p.gpusPerNode,
      custom: i,
      self: true,
      hardware: null,
    };
  }
  const p = b.platforms[row]!;
  return { name: p.name, sub: p.sub, unit: p.unit, gpusPerNode: p.gpusPerNode.value, custom: null, self: p.group === 'self', hardware: p.hardware };
}

/** A sub-label as text in `lang` (catalog sub as is; a message with its numbers formatted). */
export function subLabelText(sub: SubLabel, lang: string, tr: TFn): string {
  return typeof sub === 'string'
    ? sub
    : tr(sub.key, Object.fromEntries(Object.entries(sub.vars).map(([k, v]) => [k, typeof v === 'number' ? fmt(lang, v) : v])));
}

/** The sub-label as text (catalog sub, or the custom platform's memory × count and engine). */
export function useSubText(info: RowInfo): string {
  const tr = useT();
  const lang = useLang();
  return subLabelText(info.sub, lang, tr);
}

/** Header label (the only part that toggles the row): name, 「自訂」 tag, sub-label. */
export function RowName({ info }: { info: RowInfo }): JSX.Element {
  const tr = useT();
  const sub = useSubText(info);
  return (
    <div data-testid="row-name" style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
        {info.name}
        {info.custom !== null && (
          <Tag color="geekblue" style={{ marginInlineStart: 6 }}>
            {tr('tag.user')}
          </Tag>
        )}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
        {sub}
      </Typography.Text>
    </div>
  );
}

/** Infeasible row: red reason tag; core's detail on hover / tap / focus. */
export function WhyTag({ why, detail }: { why: keyof typeof WHY; detail: string }): JSX.Element {
  const tr = useT();
  return (
    <div className="fade-in">
      <Explain content={<div style={{ maxWidth: 320 }}>{detail}</div>}>
        <Tag data-testid="why-tag" color="error" icon={<CloseCircleOutlined />} tabIndex={0} style={{ cursor: 'help', whiteSpace: 'normal' }}>
          {tr(WHY[why])}
        </Tag>
      </Explain>
    </div>
  );
}

/** Edit / delete buttons of a custom hardware row. */
export function CustomActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }): JSX.Element {
  const tr = useT();
  return (
    <Space size={4}>
      <Button size="small" type="text" aria-label={tr('row.edit')} icon={<EditOutlined />} onClick={onEdit} />
      <Button size="small" type="text" danger aria-label={tr('row.delete')} icon={<DeleteOutlined />} onClick={onDelete} />
    </Space>
  );
}

/** The extra line of an adjusted row: speed and TTFT at the user's count, and what the suggested count gives. */
function SpeedLine({ r, unit }: { r: OkRow; unit: 'gpu' | 'machine' }) {
  const tr = useT();
  const lang = useLang();
  const { token } = theme.useToken();
  const { perf, suggestedPerf } = r;
  const tps = useTween(perf.usage?.tokPerSecPerUser ?? 0);
  const ttft = useTween(perf.usage?.ttftSec ?? 0);
  const unitText = tr(unit === 'machine' ? 'unit.machine' : 'unit.gpu');
  return (
    <Typography.Text data-testid="speed-line" style={{ fontSize: 13 }}>
      {perf.ok ? <CheckCircleOutlined style={{ color: token.colorSuccess }} /> : <CloseCircleOutlined style={{ color: token.colorError }} />}{' '}
      {perf.usage && tr('row.speed', { tps: fmt(lang, tps), ttft: fmt(lang, ttft, 1) })}
      {!perf.ok && perf.why && <Typography.Text type="danger">{tr('row.speedWhy', { why: tr(WHY[perf.why]) })}</Typography.Text>}
      {suggestedPerf.usage && (
        <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 12 }}>
          {tr('row.suggested', { n: fmt(lang, r.suggested), unit: unitText, tps: fmt(lang, suggestedPerf.usage.tokPerSecPerUser) })}
        </Typography.Text>
      )}
    </Typography.Text>
  );
}

type ExtraProps = {
  r: OkRow;
  info: RowInfo;
  users: number;
  onSuggest: () => void;
  onSet: (n: number) => void;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * Feasible row header `extra` (outside the toggle): machine icons, count control, capacity bar, custom edit / delete,
 * and — for an adjusted row — the speed line, which opens with a `grid-template-rows` 0fr → 1fr transition.
 */
export function RowExtra({ r, info, users, onSuggest, onSet, onEdit, onDelete }: ExtraProps): JSX.Element {
  const tr = useT();
  return (
    <div className="row-extra fade-in">
      <div className="row-icons">
        {/* Adjusted rows draw no conservative outline: it belongs to the suggested amount (design §3.5). */}
        <Isotype expected={r.count} conservative={r.adjusted ? null : r.conservative} unit={info.unit} gpusPerNode={info.gpusPerNode} />
      </div>
      <CountControl
        unit={info.unit}
        suggested={r.suggested}
        count={r.count}
        adjusted={r.adjusted}
        onSuggest={onSuggest}
        onSet={onSet}
        label={tr('row.count', { name: info.name })}
      />
      <div className="row-capacity">
        <CapacityBar users={users} max={r.perf.maxConcurrent} />
      </div>
      {info.custom !== null && <CustomActions onEdit={onEdit} onDelete={onDelete} />}
      <div className={'reveal row-speed' + (r.adjusted ? ' on' : '')} aria-hidden={!r.adjusted}>
        <div>{r.adjusted && <SpeedLine r={r} unit={info.unit} />}</div>
      </div>
    </div>
  );
}
