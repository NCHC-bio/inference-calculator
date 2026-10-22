import { CheckCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import type { HfStep } from '@nchc/data/hf';
import { Timeline, Typography } from 'antd';
import type { JSX } from 'react';
import { useT, type MsgKey } from '../i18n';
import { useImportProgress } from '../state/importProgress';

const STEP: Record<HfStep, MsgKey> = {
  'model-info': 'hf.step.model-info',
  config: 'hf.step.config',
  'quant-config': 'hf.step.quant-config',
  'checkpoint-size': 'hf.step.checkpoint-size',
  'base-params': 'hf.step.base-params',
  'gguf-base': 'hf.step.gguf-base',
  parse: 'hf.step.parse',
};

/**
 * A running import, step by step: what is done (ticked) and what runs now (spinning), each step naming the repo it
 * reads (a GGUF repo moves on to its base model). New steps fade in (shared motion). Falls back to one line before the
 * first step arrives.
 */
export function ImportProgress({ repo }: { repo: string }): JSX.Element {
  const tr = useT();
  const p = useImportProgress();
  const steps = p?.repo === repo ? p.steps : [];
  return (
    <div data-testid="import-progress" style={{ marginTop: 12 }} aria-live="polite">
      <Typography.Text strong>{tr('hf.importing', { repo })}</Typography.Text>
      <Timeline
        style={{ marginTop: 12 }}
        items={(steps.length > 0 ? steps : [{ step: 'model-info' as const, repo }]).map((s, i, all) => {
          const last = i === all.length - 1;
          return {
            key: `${s.step}-${i}`,
            className: 'fade-in',
            color: last ? 'blue' : 'green',
            loading: last,
            icon: last ? <LoadingOutlined /> : <CheckCircleOutlined />,
            content: (
              <span data-testid={last ? 'import-step-current' : 'import-step-done'} style={{ overflowWrap: 'anywhere' }}>
                {tr(STEP[s.step], { repo: s.repo })}
              </span>
            ),
          };
        })}
      />
    </div>
  );
}
