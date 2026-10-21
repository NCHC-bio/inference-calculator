import { DeleteOutlined, PushpinOutlined } from '@ant-design/icons';
import { Button, Card, Table } from 'antd';
import { useRef, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import type { Pin } from '../state/state';
import { useCalc } from '../state/store';

const fmt = (lang: string, n: number, d = 0) => new Intl.NumberFormat(lang, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

/**
 * Pinned setups side by side (design §4 item 6). The card is always mounted inside a `.reveal` so the first pin grows it
 * open and the last removal closes it; it keeps the last rows while closing so the content does not vanish first.
 * Pins are snapshots taken when 加入比較 was pressed.
 */
export function CompareTable(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const [{ pins }, dispatch] = useCalc();
  const shown = useRef<Pin[]>(pins);
  if (pins.length > 0) shown.current = pins;
  const rows = shown.current;
  const num = (v: number | null, d = 0) => (v === null ? tr('status.unverified') : fmt(lang, v, d));
  return (
    <div className={'reveal' + (pins.length > 0 ? ' on' : '')} aria-hidden={pins.length === 0}>
      <div>
        <Card
          data-testid="compare"
          className="compare-card"
          size="small"
          style={{ marginTop: 12 }}
          title={
            <span>
              <PushpinOutlined /> {tr('compare.title')}
            </span>
          }
          extra={
            <Button type="link" size="small" onClick={() => dispatch({ type: 'clearPins' })}>
              {tr('compare.clear')}
            </Button>
          }
        >
          <Table<Pin>
            size="small"
            pagination={false}
            scroll={{ x: true }}
            dataSource={rows}
            rowKey="id"
            columns={[
              { title: tr('compare.platform'), dataIndex: 'platform' },
              { title: tr('compare.count'), dataIndex: 'count' },
              { title: tr('compare.model'), dataIndex: 'model' },
              { title: tr('compare.users'), dataIndex: 'users', render: (v: number) => fmt(lang, v) },
              { title: tr('compare.tps'), dataIndex: 'tps', render: (v: number | null) => num(v) },
              { title: tr('compare.ttft'), dataIndex: 'ttft', render: (v: number | null) => num(v, 1) },
              { title: tr('compare.max'), dataIndex: 'max', render: (v: number) => fmt(lang, v) },
              { title: tr('compare.kw'), dataIndex: 'kw', render: (v: number | null) => num(v, 1) },
              {
                title: '',
                key: 'x',
                render: (_, p) => (
                  <Button size="small" type="text" aria-label={tr('compare.delete')} icon={<DeleteOutlined />} onClick={() => dispatch({ type: 'unpin', id: p.id })} />
                ),
              },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
