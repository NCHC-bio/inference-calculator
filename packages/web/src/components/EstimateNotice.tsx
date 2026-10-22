import { GithubOutlined } from '@ant-design/icons';
import type { ResultWarning } from '@nchc/core';
import type { EstimatedFeature } from '@nchc/data/hf';
import { Alert, Button, Collapse, Space, Tag, Typography } from 'antd';
import { useState, type JSX } from 'react';
import { useT, type MsgKey } from '../i18n';
import { transitionMs } from '../motion';
import { reportModelUrl } from '../reportModel';
import { useCalc } from '../state/store';

/** Every estimated structure has a name in each language (CLAUDE.md "Goal for imported models"). */
export const FEATURE: Record<EstimatedFeature, MsgKey> = {
  'linear-attention': 'est.feature.linear-attention',
  'short-conv': 'est.feature.short-conv',
  'moe-layout': 'est.feature.moe-layout',
  'heterogeneous-blocks': 'est.feature.heterogeneous-blocks',
  'compressed-attention': 'est.feature.compressed-attention',
  'cross-layer-kv': 'est.feature.cross-layer-kv',
  'sparse-indexer': 'est.feature.sparse-indexer',
  'lookup-tables': 'est.feature.lookup-tables',
  'memory-layers': 'est.feature.memory-layers',
  'recurrent-depth': 'est.feature.recurrent-depth',
  'native-quant': 'est.feature.native-quant',
  'unknown-layer-type': 'est.feature.unknown-layer-type',
  'sliding-window': 'est.feature.sliding-window',
  gguf: 'est.feature.gguf',
};
const featureKey = (f: string): MsgKey | undefined => (Object.hasOwn(FEATURE, f) ? FEATURE[f as EstimatedFeature] : undefined);

/** Models whose notice the user closed, until the page reloads (key: repo@sha, or the catalog id). */
const dismissed = new Set<string>();

/**
 * The notice of an estimated result (core's nonstandard-config warning): the model's config is not standard, so the
 * listed structures are conservative estimates. One sentence names them in the user's language; what was assumed for
 * each is one step away (Collapse); an imported model offers a pre-filled request to model the architecture
 * precisely, so later imports of that kind get precise numbers. Closable: it folds into a small 推估 tag that opens it
 * again (the close animates with antd's own motion); closed stays closed for that model until the page reloads.
 */
export function EstimateNotice({ warning }: { warning: ResultWarning }): JSX.Element {
  const tr = useT();
  const [s] = useCalc();
  const items = warning.items ?? [];
  const names = [...new Set(items.map((i) => i.feature))].map((f) => {
    const k = featureKey(f);
    return k ? tr(k) : f;
  });
  const hf = s.customModel?.kind === 'hf' ? s.customModel : undefined;
  const key = hf ? `${hf.repo}@${hf.sha}` : s.model;
  // Read on every render, so switching to another model shows its own state; `rerender` only redraws after a change.
  const [, rerender] = useState(0);
  const closed = dismissed.has(key);
  const reason = `estimated: ${items.map((i) => `${i.feature} (${i.detail})`).join('; ')}`;
  if (closed) {
    const reopen = () => {
      dismissed.delete(key);
      rerender((n) => n + 1);
    };
    return (
      <Tag
        data-testid="estimate-reopen"
        color="warning"
        role="button"
        tabIndex={0}
        aria-label={tr('est.reopen')}
        className="fade-in"
        style={{ marginTop: 8, cursor: 'pointer' }}
        onClick={reopen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            reopen();
          }
        }}
      >
        {tr('est.tag')}
      </Tag>
    );
  }
  return (
    <Alert
      data-testid="estimate-notice"
      type="warning"
      showIcon
      className="fade-in"
      style={{ marginTop: 8 }}
      closable={{ 'aria-label': tr('est.dismiss') }}
      onClose={() => {
        // antd animates the close with the shared motion token; the tag replaces it when that ends (0 ms when reduced).
        window.setTimeout(() => {
          dismissed.add(key);
          rerender((n) => n + 1);
        }, transitionMs());
      }}
      title={tr('est.title')}
      description={
        <>
          <div>{tr('est.body', { list: names.join(tr('hf.listSep')) })}</div>
          <Collapse
            ghost
            size="small"
            style={{ margin: '4px -16px 0' }}
            items={[{
              key: 'details',
              label: tr('est.details'),
              children: (
                <ul data-testid="estimate-details" style={{ margin: 0, paddingInlineStart: 18, overflowWrap: 'anywhere', fontSize: 12 }}>
                  {items.map((i) => <li key={`${i.feature}:${i.detail}`}>{i.detail}</li>)}
                </ul>
              ),
            }]}
          />
          {hf && (
            <Space orientation="vertical" size={2} style={{ marginTop: 8 }}>
              <Button
                size="small"
                icon={<GithubOutlined />}
                href={reportModelUrl(hf.repo, hf.sha, reason, 'support')}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="estimate-request"
              >
                {tr('est.request')}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{tr('est.request.help')}</Typography.Text>
            </Space>
          )}
        </>
      }
    />
  );
}
