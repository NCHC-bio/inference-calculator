import { CopyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { BasisItem, RequirementResult } from '@nchc/core';
import { Alert, Button, Flex, Tag, theme, Tooltip, Typography } from 'antd';
import type { JSX, ReactNode } from 'react';
import { getBundle } from '../bundle';
import { useView } from '../compute/useResults';
import { useLang, useT, type Lang, type TFn } from '../i18n';
import { useCalc } from '../state/store';
import { STATUS_COLOR, StatusTag, uniqueByPath } from './BasisDrawer';
import { fmt, needAnswerParts } from './answerText';
import { Explain } from './Explain';

export { needAnswerText } from './answerText';

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

/** Every estimate and unverified input of the result, each with its status tag (spec §2.1 rule 2: the weakest inputs are listed). */
function EstimateList({ basis, tr, onAll }: { basis: BasisItem[]; tr: TFn; onAll: () => void }) {
  const weak = uniqueByPath(basis.filter((x) => x.status === 'estimate' || x.status === 'unverified'));
  return (
    <div style={{ maxWidth: 340 }}>
      {weak.map((x) => (
        <div key={x.path} data-testid="estimate-item" style={{ fontSize: 12, margin: '4px 0' }}>
          <StatusTag status={x.status} />
          {x.text}
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
  const shown = needShown(view.result, lang, tr, token.colorPrimary, token.colorError);
  const openBasis = () => dispatch({ type: 'dialog', id: 'basis' });
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
          <Explain content={tr('tag.user.tip')}>
            <Tag color={STATUS_COLOR.user} tabIndex={0} style={{ cursor: 'pointer' }}>
              {tr('tag.user')}
            </Tag>
          </Explain>
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
      {r.warnings.map((w, i) => (
        <Alert key={`${w.code}-${i}`} type="warning" showIcon title={w.text} style={{ marginTop: 8 }} />
      ))}
    </div>
  );
}
