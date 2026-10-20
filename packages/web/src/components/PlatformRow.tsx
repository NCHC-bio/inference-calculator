import { DownOutlined, RightOutlined } from '@ant-design/icons';
import type { PlatformResult } from '@nchc/core';
import { Col, Row, Tag, theme, Typography } from 'antd';
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import { getBundle } from '../bundle';
import { useLang, useT, type MsgKey } from '../i18n';
import { CapacityBar } from './CapacityBar';
import { Explain } from './Explain';
import { Isotype } from './Isotype';

const fmt = (lang: string, n: number) => new Intl.NumberFormat(lang).format(n);
const stop = (e: MouseEvent) => e.stopPropagation();

/** One platform: name, machine icons, big count and capacity bar; or, when infeasible, one short reason. */
export function PlatformRow({ r, users, best, open, onToggle }: { r: PlatformResult; users: number; best: boolean; open: boolean; onToggle: () => void }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const { token } = theme.useToken();
  const plat = getBundle().platforms[r.platform]!;
  const { expected, conservative } = r;
  const unit = tr(plat.unit === 'machine' ? 'unit.machine' : 'unit.gpu');
  const perNode = plat.gpusPerNode.value;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onToggle();
  };
  const interactive = expected.ok
    ? { role: 'button', tabIndex: 0, 'aria-expanded': open, onClick: onToggle, onKeyDown }
    : {};

  let body: JSX.Element;
  if (expected.ok) {
    const consGpus = conservative.ok ? conservative.gpus : null;
    const extraNodes = consGpus === null ? 0 : Math.max(0, Math.ceil(consGpus / perNode) - Math.ceil(expected.gpus / perNode));
    const iconLabel = tr(plat.unit === 'machine' ? 'platforms.isotype.machine' : 'platforms.isotype.gpu', {
      perNode,
      expected: Math.ceil(expected.gpus / perNode),
      extra: extraNodes,
    });
    const under = !conservative.ok
      ? tr('platforms.conservativeNone')
      : conservative.gpus > expected.gpus
        ? tr('platforms.conservative', { n: fmt(lang, conservative.gpus), unit })
        : tr(plat.unit === 'machine' ? 'platforms.count.machine' : 'platforms.count.gpu');
    body = (
      <>
        <Col xs={0} md={7}>
          <span role="img" aria-label={iconLabel}>
            <Isotype expectedGpus={expected.gpus} conservativeGpus={consGpus} gpusPerNode={perNode} unit={plat.unit} />
          </span>
        </Col>
        <Col xs={12} md={3} style={{ textAlign: 'right' }}>
          <div data-testid="count" style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>
            {fmt(lang, expected.gpus)}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {under}
          </Typography.Text>
        </Col>
        <Col xs={22} md={8}>
          <CapacityBar users={users} max={r.maxConcurrent} />
        </Col>
        <Col xs={2} md={1} style={{ textAlign: 'right', color: token.colorTextTertiary }}>
          {open ? <DownOutlined /> : <RightOutlined />}
        </Col>
      </>
    );
  } else {
    body = (
      <Col xs={24} md={19}>
        <Explain content={<div style={{ maxWidth: 320 }}>{expected.detail}</div>}>
          <Tag color="error" tabIndex={0} onClick={stop} style={{ cursor: 'help' }}>
            ✗ {tr(`why.${expected.why}` as MsgKey)}
          </Tag>
        </Explain>
      </Col>
    );
  }

  return (
    <div
      data-testid="platform-row"
      data-platform={r.platform}
      data-best={String(best)}
      {...interactive}
      style={{
        cursor: expected.ok ? 'pointer' : 'default',
        padding: '12px 8px',
        borderRadius: token.borderRadiusLG,
        borderLeft: `3px solid ${best ? token.colorPrimary : 'transparent'}`,
        background: best ? token.colorFillTertiary : 'transparent',
      }}
    >
      <Row align="middle" gutter={[12, 8]} wrap>
        <Col xs={expected.ok ? 12 : 24} md={5}>
          <div style={{ fontWeight: 700 }}>{plat.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {plat.sub}
          </Typography.Text>
        </Col>
        {body}
      </Row>
    </div>
  );
}
