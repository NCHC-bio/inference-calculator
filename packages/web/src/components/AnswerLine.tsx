import { CopyOutlined, InfoCircleOutlined, ShareAltOutlined } from '@ant-design/icons';
import type { BasisItem, RequirementResult } from '@nchc/core';
import { Alert, App as AntApp, Button, Flex, Spin, Tag, theme, Typography } from 'antd';
import { useState, type JSX } from 'react';
import { getBundle } from '../bundle';
import { useMain } from '../compute/useResults';
import { useLang, useT, type TFn } from '../i18n';
import { useTween } from '../motion/useTween';
import { useCalc } from '../state/store';
import { STATUS_COLOR, StatusTag } from './BasisModal';
import { isWeak, topEstimates, uniqueByPath } from './weak';
import { bestCounts, needAnswerParts } from './answerText';
import { EstimateNotice } from './EstimateNotice';
import { Explain } from './Explain';
import { ImportProgress } from './ImportProgress';
import { pendingHf } from './drawers/HfImportDrawer';

export { needAnswerText } from './answerText';
export { topEstimates } from './weak';

/** How many estimates the 推估 popover lists (design §3.3). */
export const ESTIMATE_EXCERPT = 3;
/** Fixed popover width (design §3.3); longer lines are truncated. */
const EXCERPT_WIDTH = 300;

function EstimateExcerpt({ items, total, tr, onAll }: { items: BasisItem[]; total: number; tr: TFn; onAll: () => void }) {
  return (
    <div style={{ width: EXCERPT_WIDTH, maxWidth: 'calc(100vw - 48px)' }}>
      {items.map((x) => (
        <div
          key={x.path}
          data-testid="estimate-item"
          title={x.text}
          style={{ fontSize: 12, margin: '4px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          <StatusTag status={x.status} />
          {x.text}
        </div>
      ))}
      <Typography.Link onClick={onAll}>{tr('answer.estimates.all', { n: total })}</Typography.Link>
    </div>
  );
}

function Answer({ r }: { r: RequirementResult }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const [, dispatch] = useCalc();
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const [estOpen, setEstOpen] = useState(false);
  const target = bestCounts(r);
  // design §3.6: the big numbers roll from the old value to the new one, but only within one platform: when the best
  // platform changes they jump and the line fades in, so a name is never shown with another platform's count.
  const gpus = Math.round(useTween(target.gpus, r.best));
  const conservative = Math.round(useTween(target.conservative, r.best));
  const p = needAnswerParts(r, getBundle(), tr, lang, { gpus, conservative });

  const bestBasis = r.perPlatform.find((x) => x.platform === r.best)?.basis;
  const weakTotal = uniqueByPath(r.basis.filter(isWeak)).length;
  const excerpt = topEstimates(r.basis, ESTIMATE_EXCERPT, bestBasis);
  const openBasis = (basisFilter: 'est' | 'all') => dispatch({ type: 'dialog', id: 'basis', basisFilter });
  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      void message.success(tr('answer.share.done'));
    } catch {
      void message.error(tr('answer.share.fail'));
    }
  };

  return (
    <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 14, marginTop: 6 }}>
      <Flex align="center" gap={12} wrap="wrap">
        <div style={{ minWidth: 0 }}>
          <div key={`main:${r.best ?? ''}`} className="fade-in" data-testid="answer-main" style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.2, overflowWrap: 'anywhere' }}>
            {p.feasible ? (
              <>
                <span style={{ color: token.colorPrimary }}>{p.head}</span>{' '}
                <Typography.Text type="secondary" style={{ fontSize: 15, fontWeight: 500 }}>
                  {p.tail}
                </Typography.Text>
              </>
            ) : (
              <span style={{ color: token.colorError }}>{p.head}</span>
            )}
          </div>
          <Typography.Text key={`sub:${r.best ?? ''}`} type="secondary" className="fade-in" data-testid="answer-sub" style={{ display: 'inline-block' }}>
            {p.sub}
          </Typography.Text>
        </div>
        {r.hasEstimate && (
          <Explain
            open={estOpen}
            onOpenChange={setEstOpen}
            title={tr('answer.estimates.title', { n: excerpt.length })}
            content={
              <EstimateExcerpt
                items={excerpt}
                total={weakTotal}
                tr={tr}
                onAll={() => {
                  setEstOpen(false);
                  openBasis('est');
                }}
              />
            }
          >
            <Tag color={STATUS_COLOR.estimate} tabIndex={0} style={{ borderStyle: 'dashed', cursor: 'pointer' }}>
              {tr('tag.estimate')}
            </Tag>
          </Explain>
        )}
        {r.hasUser && (
          <Explain content={tr('tag.user.tip')}>
            <Tag color={STATUS_COLOR.user} tabIndex={0} className="fade-in" style={{ cursor: 'pointer' }}>
              {tr('tag.user')}
            </Tag>
          </Explain>
        )}
        <div style={{ flex: 1 }} />
        <Flex gap={4} wrap="wrap">
          <Button type="text" icon={<InfoCircleOutlined />} onClick={() => openBasis('all')}>
            {tr('answer.basis')}
          </Button>
          <Button type="text" icon={<CopyOutlined />} onClick={() => dispatch({ type: 'dialog', id: 'cite' })}>
            {tr('answer.cite')}
          </Button>
          <Button type="text" icon={<ShareAltOutlined />} onClick={() => void share()}>
            {tr('answer.share')}
          </Button>
        </Flex>
      </Flex>
      {r.warnings.map((w, i) =>
        w.code === 'nonstandard-config' ? (
          <EstimateNotice key={`${w.code}-${i}`} warning={w} />
        ) : (
          <Alert key={`${w.code}-${i}`} type="warning" showIcon title={w.text} style={{ marginTop: 8 }} className="fade-in" />
        ),
      )}
    </div>
  );
}

/** The one-line answer: always the suggestion, never the user's adjusted counts (design §4 item 3). */
export function AnswerLine(): JSX.Element {
  const view = useMain();
  const [s] = useCalc();
  if (view.kind === 'loading') {
    // An HF model being imported: the steps, not a bare spinner.
    const pending = pendingHf(s);
    return (
      <div data-testid="answer-loading">
        {pending ? <ImportProgress repo={pending.repo} /> : <Spin style={{ marginTop: 12 }} />}
      </div>
    );
  }
  if (view.kind === 'error') {
    return <Alert type="error" showIcon title={view.message} style={{ marginTop: 12 }} data-testid="answer-error" />;
  }
  return <Answer r={view.result} />;
}
