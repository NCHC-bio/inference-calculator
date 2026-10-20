import { DownOutlined, RightOutlined } from '@ant-design/icons';
import type { PlatformResult } from '@nchc/core';
import { Col, Row, Tag, theme, Typography } from 'antd';
import { useRef, type JSX, type MouseEvent } from 'react';
import { getBundle } from '../bundle';
import { useLang, useT } from '../i18n';
import { CapacityBar } from './CapacityBar';
import { Explain } from './Explain';
import { Isotype } from './Isotype';
import { WHY } from './why';

const fmt = (lang: string, n: number) => new Intl.NumberFormat(lang).format(n);
const stop = (e: MouseEvent) => e.stopPropagation();

/** Id of the detail region a row's toggle controls (Task 8 renders the detail with this id). */
export const rowDetailId = (platform: string): string => `platform-detail-${platform}`;

// Reset the native button look but keep the browser's focus ring.
const toggleStyle = {
  background: 'transparent',
  border: 0,
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  cursor: 'pointer',
  borderRadius: 4,
} as const;

function PlatformName({ name, sub }: { name: string; sub: string }) {
  return (
    <span style={{ display: 'block' }}>
      <span style={{ display: 'block', fontWeight: 700 }}>{name}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {sub}
      </Typography.Text>
    </span>
  );
}

/**
 * One platform: name, machine icons, big count and capacity bar; or, when infeasible, one short reason.
 * The expand control is a real <button> around the header (name + sub + chevron), so the row holds no nested
 * interactive content; the row container itself is not focusable.
 */
export function PlatformRow({ r, users, best, open, onToggle }: { r: PlatformResult; users: number; best: boolean; open: boolean; onToggle: () => void }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const { token } = theme.useToken();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const plat = getBundle().platforms[r.platform]!;
  const { expected, conservative } = r;
  const unit = tr(plat.unit === 'machine' ? 'unit.machine' : 'unit.gpu');
  const perNode = plat.gpusPerNode.value;

  // Mouse convenience: a click anywhere on a feasible row toggles it. Ignored: clicks on the toggle button (it toggles
  // itself) and clicks from portalled popups (React bubbles them here, but they are outside the row's DOM). The
  // capacity bar and the reason tag stop their own clicks. Keyboard and screen-reader users use the button.
  const onRowClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as Node;
    if (!expected.ok || !e.currentTarget.contains(t) || toggleRef.current?.contains(t)) return;
    onToggle();
  };

  let body: JSX.Element;
  if (expected.ok) {
    const consGpus = conservative.ok ? conservative.gpus : null;
    const extraNodes = consGpus === null ? 0 : Math.max(0, Math.ceil(consGpus / perNode) - Math.ceil(expected.gpus / perNode));
    const iconLabel = tr(plat.unit === 'machine' ? 'platforms.isotype.machine' : 'platforms.isotype.gpu', {
      perNode,
      expected: Math.ceil(expected.gpus / perNode),
      extra: extraNodes,
    });
    const countUnit = tr(plat.unit === 'machine' ? 'platforms.count.machine' : 'platforms.count.gpu');
    const under = !conservative.ok
      ? tr('platforms.conservativeNone', { unit: countUnit })
      : conservative.gpus > expected.gpus
        ? tr('platforms.conservative', { n: fmt(lang, conservative.gpus), unit })
        : countUnit;
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
        <Col xs={24} md={9}>
          <CapacityBar users={users} max={r.maxConcurrent} />
        </Col>
      </>
    );
  } else {
    body = (
      <Col xs={24} md={19}>
        <Explain content={<div style={{ maxWidth: 320 }}>{expected.detail}</div>}>
          <Tag color="error" tabIndex={0} onClick={stop} style={{ cursor: 'help' }}>
            ✗ {tr(WHY[expected.why])}
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
      onClick={onRowClick}
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
          {expected.ok ? (
            <button
              ref={toggleRef}
              type="button"
              data-testid="row-toggle"
              aria-expanded={open}
              aria-controls={rowDetailId(r.platform)}
              onClick={onToggle}
              style={toggleStyle}
            >
              <span aria-hidden style={{ color: token.colorTextTertiary, fontSize: 12 }}>
                {open ? <DownOutlined /> : <RightOutlined />}
              </span>
              <PlatformName name={plat.name} sub={plat.sub} />
            </button>
          ) : (
            <PlatformName name={plat.name} sub={plat.sub} />
          )}
        </Col>
        {body}
      </Row>
    </div>
  );
}
