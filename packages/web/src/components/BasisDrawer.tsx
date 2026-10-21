import type { BasisItem } from '@nchc/core';
import type { CoreStatus } from '@nchc/schema';
import { Card, Drawer, Flex, List, Tag, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../bundle';
import { useMain } from '../compute/useResults';
import { useLang, useT, type Lang, type TFn } from '../i18n';
import { workloadId } from '../state/state';
import { useCalc } from '../state/store';

/** The one status → antd preset colour mapping (answer-line tags use it too). */
export const STATUS_COLOR: Record<CoreStatus, string> = {
  official: 'blue',
  measured: 'green',
  derived: 'cyan',
  estimate: 'orange',
  unverified: 'red',
  user: 'geekblue',
};

export function StatusTag({ status }: { status: CoreStatus }): JSX.Element {
  const tr = useT();
  return <Tag color={STATUS_COLOR[status]}>{tr(`status.${status}`)}</Tag>;
}

/** First item per path, in core's order. */
export function uniqueByPath(items: BasisItem[]): BasisItem[] {
  const seen = new Set<string>();
  return items.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true)));
}

const JSON_MAX = 120;

/** Ruling R-P4: BasisItem carries no unit, so the value is shown as-is (numbers localised, objects as short JSON). */
export function formatBasisValue(v: unknown, lang: Lang): string {
  if (typeof v === 'number') return new Intl.NumberFormat(lang, { maximumFractionDigits: 6 }).format(v);
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v) ?? String(v);
  return s.length > JSON_MAX ? s.slice(0, JSON_MAX - 1) + '…' : s;
}

const isHttp = (url: string) => /^https?:\/\//.test(url);

function SourceLinks({ ids, tr }: { ids: string[]; tr: TFn }) {
  const sources = getBundle().sources;
  const known = ids.filter((id) => Object.hasOwn(sources, id));
  if (known.length === 0) return null;
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {tr('basis.sources')}
      {known.map((id, i) => {
        const s = sources[id]!;
        return (
          <span key={id}>
            {i > 0 && '、'}
            {isHttp(s.url) ? (
              <Typography.Link href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title}
              </Typography.Link>
            ) : (
              s.title
            )}
          </span>
        );
      })}
    </Typography.Text>
  );
}

function BasisRow({ item, lang, tr }: { item: BasisItem; lang: Lang; tr: TFn }) {
  return (
    <List.Item data-testid="basis-item">
      <Flex vertical gap={2} style={{ width: '100%' }}>
        <div>
          <StatusTag status={item.status} />
          {item.text}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {tr('basis.value', { value: formatBasisValue(item.value, lang) })}
          {item.lecRef && <Tag style={{ marginInlineStart: 8 }}>{tr('basis.lecRef', { ref: item.lecRef })}</Tag>}
        </Typography.Text>
        <SourceLinks ids={item.sourceIds} tr={tr} />
      </Flex>
    </List.Item>
  );
}

function ConcurrencyReading({ workload, tr }: { workload: string; tr: TFn }) {
  const b = getBundle();
  const kind = b.workloads[workload]?.kind;
  if (!kind) return null;
  const rule = kind === 'chat' ? b.concurrency.chatRule : b.concurrency.agentRule;
  return (
    <Card size="small" title={tr('basis.concurrency')} data-testid="concurrency-reading">
      <StatusTag status={rule.status} />
      {rule.value}
    </Card>
  );
}

export function BasisDrawer(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const [{ dialog, workload }, dispatch] = useCalc();
  const view = useMain();
  const items = view.kind === 'main' ? uniqueByPath(view.result.basis) : [];
  return (
    <Drawer
      title={tr('basis.title')}
      open={dialog === 'basis'}
      onClose={() => dispatch({ type: 'dialog', id: null })}
      size={520}
    >
      <Flex vertical gap="middle">
        <ConcurrencyReading workload={workloadId(workload)} tr={tr} />
        <List
          size="small"
          dataSource={items}
          rowKey="path"
          renderItem={(item) => <BasisRow item={item} lang={lang} tr={tr} />}
        />
      </Flex>
    </Drawer>
  );
}
