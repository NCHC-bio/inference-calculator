import { Table, Typography } from 'antd';
import type { HTMLAttributes, JSX } from 'react';
import { getAccuracy, type PlatformAccuracy } from '../../accuracy';
import { getBundle } from '../../bundle';
import { useLang, useT, type Lang, type TFn } from '../../i18n';
import { fmt } from '../answerText';
import { CalcDrawer } from './CalcDrawer';

type Metric = 'decodeTokPerSec' | 'ttftSec';
type Row = { key: string; name: string; byMetric: Record<Metric, PlatformAccuracy[]> };

/** One metric's summaries, validate points first: 「平均 11%・最大 16%（8 點，驗證）」 per role; 「無實測」 when none. */
function Cell({ items, tr, lang }: { items: PlatformAccuracy[]; tr: TFn; lang: Lang }) {
  if (items.length === 0) return <Typography.Text type="secondary">{tr('acc.none')}</Typography.Text>;
  return (
    <>
      {items.map((a) => (
        <div key={a.role}>
          {tr('acc.cell', { mean: fmt(lang, a.meanAbsErrorPct), max: fmt(lang, a.maxAbsErrorPct), n: a.n, role: tr(`acc.role.${a.role}`) })}
        </div>
      ))}
    </>
  );
}

function Body(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const b = getBundle();
  const acc = getAccuracy().byPlatform;
  const order = { validate: 0, fit: 1 };
  const rows: Row[] = Object.values(b.platforms).map((p) => {
    const of = (metric: Metric) =>
      acc.filter((a) => a.platform === p.id && a.metric === metric && a.n > 0).sort((x, y) => order[x.role] - order[y.role]);
    return { key: p.id, name: `${p.name} ${p.sub}`, byMetric: { decodeTokPerSec: of('decodeTokPerSec'), ttftSec: of('ttftSec') } };
  });
  return (
    <>
      <Table<Row>
        size="small"
        pagination={false}
        rowKey="key"
        dataSource={rows}
        onRow={() => ({ 'data-testid': 'accuracy-row' }) as HTMLAttributes<HTMLElement>}
        columns={[
          { title: tr('acc.platform'), dataIndex: 'name' },
          { title: tr('acc.decode'), key: 'd', render: (_, r) => <Cell items={r.byMetric.decodeTokPerSec} tr={tr} lang={lang} /> },
          { title: tr('acc.ttft'), key: 't', render: (_, r) => <Cell items={r.byMetric.ttftSec} tr={tr} lang={lang} /> },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
        {tr('acc.note')}
      </Typography.Paragraph>
    </>
  );
}

/** 「準確度（以公開實測校正）」(design §6.4): calibrate's per-platform error summary; 「無實測」 where nothing was compared. */
export function AccuracyDrawer(): JSX.Element {
  const tr = useT();
  return (
    <CalcDrawer id="accuracy" title={tr('acc.title')}>
      <Body />
    </CalcDrawer>
  );
}
