import { CopyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { BasisItem, CapacityResult, RequirementResult } from '@nchc/core';
import type { Bundle } from '@nchc/schema';
import { Alert, Button, Flex, Tag, theme, Tooltip, Typography } from 'antd';
import type { JSX, ReactNode } from 'react';
import { getBundle } from '../bundle';
import { useView } from '../compute/useResults';
import { useLang, useT, type Lang, type TFn } from '../i18n';
import { useCalc } from '../state/store';
import { STATUS_COLOR, uniqueByPath } from './BasisDrawer';
import { Explain } from './Explain';

const fmt = (lang: Lang, n: number, digits = 0) =>
  new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

type NeedParts = { feasible: boolean; head: string; tail: string; sub: string };

/** The need-mode answer split into its primary head and secondary tail (platform sub + node count). */
function needAnswerParts(r: RequirementResult, bundle: Bundle, t: TFn, lang: Lang): NeedParts {
  const row = r.best === null ? undefined : r.perPlatform.find((p) => p.platform === r.best);
  if (!row || !row.expected.ok) {
    return { feasible: false, head: t('answer.need.none'), tail: '', sub: t('answer.need.noneHint') };
  }
  const plat = bundle.platforms[row.platform]!;
  const unit = t(plat.unit === 'machine' ? 'unit.machine' : 'unit.gpu');
  const gpus = row.expected.gpus;
  const perNode = plat.gpusPerNode.value;
  // spec §10.2: from one node up, the node count with one decimal, none when it divides evenly.
  const nodes = gpus >= perNode ? t('answer.need.nodes', { nodes: fmt(lang, gpus / perNode, gpus % perNode ? 1 : 0) }) : '';
  return {
    feasible: true,
    head: t('answer.need.main', { name: plat.name, gpus: fmt(lang, gpus), unit }),
    tail: `${plat.sub}${nodes}`,
    sub: row.conservative.ok ? t('answer.need.sub', { gpus: fmt(lang, row.conservative.gpus), unit }) : t('answer.need.subNone'),
  };
}

/** 主答案的文字，供 AnswerLine 與 e2e 使用。 */
export function needAnswerText(r: RequirementResult, bundle: Bundle, t: TFn, lang: Lang = 'zh-TW'): { main: string; sub: string } {
  const p = needAnswerParts(r, bundle, t, lang);
  return { main: p.tail ? `${p.head} ${p.tail}` : p.head, sub: p.sub };
}

type Shown = { main: ReactNode; sub: ReactNode };

function needShown(r: RequirementResult, lang: Lang, tr: TFn, primary: string, error: string): Shown {
  const p = needAnswerParts(r, getBundle(), tr, lang);
  if (!p.feasible) return { main: <span style={{ color: error }}>{p.head}</span>, sub: p.sub };
  return {
    main: (
      <>
        <span style={{ color: primary }}>{p.head}</span>{' '}
        <Typography.Text type="secondary" style={{ fontSize: 15, fontWeight: 500 }}>
          {p.tail}
        </Typography.Text>
      </>
    ),
    sub: p.sub,
  };
}

function haveShown(r: CapacityResult, lang: Lang, tr: TFn, primary: string, error: string): Shown {
  if (r.expected.n === 0) {
    return { main: <span style={{ color: error }}>{tr('answer.have.none')}</span>, sub: r.detail ?? '' };
  }
  const n = fmt(lang, r.expected.n);
  return {
    main: <span style={{ color: primary }}>{tr(r.saturated ? 'answer.have.saturated' : 'answer.have.main', { n })}</span>,
    sub: (
      <>
        {tr('answer.have.sub', { n: fmt(lang, r.conservative.n) })}
        {r.saturated && r.saturatedNote && <div>{r.saturatedNote}</div>}
      </>
    ),
  };
}

function EstimateList({ basis, tr, onAll }: { basis: BasisItem[]; tr: TFn; onAll: () => void }) {
  const est = uniqueByPath(basis.filter((x) => x.status === 'estimate'));
  return (
    <div style={{ maxWidth: 340 }}>
      {est.map((x) => (
        <div key={x.path} style={{ fontSize: 12, margin: '4px 0' }}>
          • {x.text}
        </div>
      ))}
      <Button type="link" size="small" style={{ padding: 0 }} onClick={onAll}>
        {tr('answer.estimates.all')}
      </Button>
    </div>
  );
}

export function AnswerLine(): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const [, dispatch] = useCalc();
  const { token } = theme.useToken();
  const view = useView();
  if (view.kind === 'error') {
    return <Alert type="error" showIcon title={view.message} style={{ marginTop: 12 }} data-testid="answer-error" />;
  }
  const r = view.result;
  const shown =
    view.kind === 'need'
      ? needShown(view.result, lang, tr, token.colorPrimary, token.colorError)
      : haveShown(view.result, lang, tr, token.colorPrimary, token.colorError);
  const openBasis = () => dispatch({ type: 'basis', open: true });
  return (
    <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 14, marginTop: 6 }}>
      <Flex align="center" gap={12} wrap="wrap">
        <div>
          <div data-testid="answer-main" style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.2 }}>
            {shown.main}
          </div>
          <Typography.Text type="secondary" data-testid="answer-sub">
            {shown.sub}
          </Typography.Text>
        </div>
        {r.hasEstimate && (
          <Explain title={tr('answer.estimates.title')} content={<EstimateList basis={r.basis} tr={tr} onAll={openBasis} />}>
            <Tag color={STATUS_COLOR.estimate} tabIndex={0} style={{ borderStyle: 'dashed', cursor: 'pointer' }}>
              {tr('tag.estimate')}
            </Tag>
          </Explain>
        )}
        {r.hasUser && (
          <Tooltip title={tr('tag.user.tip')}>
            <Tag color={STATUS_COLOR.user} tabIndex={0}>
              {tr('tag.user')}
            </Tag>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        <Button icon={<InfoCircleOutlined />} onClick={openBasis}>
          {tr('answer.basis')}
        </Button>
        <Tooltip title={tr('answer.cite.soon')}>
          <Button icon={<CopyOutlined />} disabled>
            {tr('answer.cite')}
          </Button>
        </Tooltip>
      </Flex>
      {r.warnings.map((w) => (
        <Alert key={w.code} type="warning" showIcon title={w.text} style={{ marginTop: 8 }} />
      ))}
    </div>
  );
}
