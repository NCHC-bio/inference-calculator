import { GithubOutlined } from '@ant-design/icons';
import type { ResultWarning } from '@nchc/core';
import type { EstimatedFeature } from '@nchc/data/hf';
import { Alert, Button, Collapse, Space, Typography } from 'antd';
import type { JSX } from 'react';
import { useT, type MsgKey } from '../i18n';
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

/**
 * The notice of an estimated result (core's nonstandard-config warning): the model's config is not standard, so the
 * listed structures are conservative estimates. One sentence names them in the user's language; what was assumed for
 * each is one step away (Collapse); an imported model offers a pre-filled request to model the architecture
 * precisely, so later imports of that kind get precise numbers.
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
  const reason = `estimated: ${items.map((i) => `${i.feature} (${i.detail})`).join('; ')}`;
  return (
    <Alert
      data-testid="estimate-notice"
      type="warning"
      showIcon
      className="fade-in"
      style={{ marginTop: 8 }}
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
