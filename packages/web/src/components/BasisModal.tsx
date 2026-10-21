import type { BasisItem } from '@nchc/core';
import type { CoreStatus } from '@nchc/schema';
import type { Source } from '@nchc/schema';
import { Card, Flex, List, Modal, Segmented, Tag, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../bundle';
import { useMain } from '../compute/useResults';
import { useLang, useT, type Lang, type TFn } from '../i18n';
import { workloadId, type BasisFilter } from '../state/state';
import { sourcesOf } from './citeText';
import { isWeak, uniqueByPath } from './weak';

export { isWeak, uniqueByPath } from './weak';
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


const JSON_MAX = 120;

/** Ruling R-P4: BasisItem carries no unit, so the value is shown as-is (numbers localised, objects as short JSON). */
export function formatBasisValue(v: unknown, lang: Lang): string {
  if (typeof v === 'number') return new Intl.NumberFormat(lang, { maximumFractionDigits: 6 }).format(v);
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v) ?? String(v);
  return s.length > JSON_MAX ? s.slice(0, JSON_MAX - 1) + '…' : s;
}

const isHttp = (url: string) => /^https?:\/\//.test(url);

function SourceLinks({ ids, sources, tr }: { ids: string[]; sources: Record<string, Source>; tr: TFn }) {
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

function BasisRow({ item, sources, lang, tr }: { item: BasisItem; sources: Record<string, Source>; lang: Lang; tr: TFn }) {
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
        <SourceLinks ids={item.sourceIds} sources={sources} tr={tr} />
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


/** Every basis item of the result (or only the estimated and unverified ones), with values and sources (design §3.3). */
export function BasisModal(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const [{ dialog, basisFilter, workload, customModel }, dispatch] = useCalc();
  const view = useMain();
  const all = view.kind === 'main' ? uniqueByPath(view.result.basis) : [];
  const weak = all.filter(isWeak);
  const items = basisFilter === 'est' ? weak : all;
  const sources = sourcesOf(getBundle(), customModel);
  return (
    <Modal
      title={tr('basis.title')}
      open={dialog === 'basis'}
      onCancel={() => dispatch({ type: 'dialog', id: null })}
      footer={null}
      width={640}
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
    >
      <Flex vertical gap="middle">
        <Segmented<BasisFilter>
          block
          value={basisFilter}
          onChange={(v) => dispatch({ type: 'dialog', id: 'basis', basisFilter: v })}
          options={[
            { value: 'est', label: tr('basis.filter.est', { n: weak.length }) },
            { value: 'all', label: tr('basis.filter.all', { n: all.length }) },
          ]}
        />
        <ConcurrencyReading workload={workloadId(workload)} tr={tr} />
        <List
          size="small"
          dataSource={items}
          rowKey="path"
          renderItem={(item) => <BasisRow item={item} sources={sources} lang={lang} tr={tr} />}
        />
      </Flex>
    </Modal>
  );
}
