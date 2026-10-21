import { CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, PushpinOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Table, Tag, theme } from 'antd';
import { useRef, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import type { Pin } from '../state/state';
import { useCalc } from '../state/store';
import { STATUS_COLOR } from './BasisModal';
import { subLabelText } from './PlatformRow';
import { withQuant } from './Workbench';

const fmt = (lang: string, n: number, d = 0) => new Intl.NumberFormat(lang, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

/**
 * Pinned setups side by side (design §4 item 6). The card is always mounted inside a `.reveal` so the first pin grows it
 * open and the last removal closes it; it keeps the last rows while closing so the content does not vanish first.
 * Pins are snapshots taken when 加入比較 was pressed, trust flags included (spec §2.1): a miss, 推估 and 自訂 are marked
 * per row and the warnings of any pin show under the table. A pin holds raw values; labels, units and number formats
 * follow the current language (v8 minor 6).
 */
export function CompareTable(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const [{ pins }, dispatch] = useCalc();
  const shown = useRef<Pin[]>(pins);
  if (pins.length > 0) shown.current = pins;
  const rows = shown.current;
  const { token } = theme.useToken();
  const warnings = [...new Map(rows.flatMap((p) => p.warnings).map((w) => [w.code, w])).values()];
  const num = (v: number | null, d = 0) => (v === null ? tr('status.unverified') : fmt(lang, v, d));
  return (
    <div className={'reveal' + (pins.length > 0 ? ' on' : '')} inert={pins.length === 0} aria-hidden={pins.length === 0}>
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
              {
                title: tr('compare.platform'),
                key: 'platform',
                render: (_, p) => (
                  <Flex gap={4} align="center" wrap="wrap">
                    {p.ok ? (
                      <CheckCircleOutlined aria-label={tr('compare.ok')} title={tr('compare.ok')} style={{ color: token.colorSuccess }} />
                    ) : (
                      <CloseCircleOutlined aria-label={tr('compare.miss')} title={tr('compare.miss')} style={{ color: token.colorError }} />
                    )}
                    <span>{`${p.platform.name} ${subLabelText(p.platform.sub, lang, tr)}`}</span>
                    {p.hasEstimate && (
                      <Tag color={STATUS_COLOR.estimate} style={{ borderStyle: 'dashed', marginInlineEnd: 0 }}>
                        {tr('tag.estimate')}
                      </Tag>
                    )}
                    {p.hasUser && (
                      <Tag color={STATUS_COLOR.user} style={{ marginInlineEnd: 0 }}>
                        {tr('tag.user')}
                      </Tag>
                    )}
                  </Flex>
                ),
              },
              { title: tr('compare.count'), key: 'count', render: (_, p) => `${fmt(lang, p.count)} ${tr(p.unit === 'machine' ? 'unit.machine' : 'unit.gpu')}` },
              { title: tr('compare.model'), key: 'model', render: (_, p) => (p.model.quant ? withQuant(p.model.name, p.model.quant, lang) : p.model.name) },
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
          {warnings.map((w) => (
            <Alert key={w.code} type="warning" showIcon title={w.text} style={{ marginTop: 8 }} />
          ))}
        </Card>
      </div>
    </div>
  );
}
