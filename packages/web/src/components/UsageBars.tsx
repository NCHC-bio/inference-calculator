import type { ShapeUsage } from '@nchc/core';
import { Progress, theme, Typography } from 'antd';
import type { JSX } from 'react';
import { useT, type MsgKey } from '../i18n';
import { Explain } from './Explain';

type Share = ShapeUsage['share'];
const BARS: { key: keyof Share; label: MsgKey; tip: MsgKey }[] = [
  { key: 'mem', label: 'usage.mem', tip: 'usage.mem.tip' },
  { key: 'bw', label: 'usage.bw', tip: 'usage.bw.tip' },
  { key: 'compute', label: 'usage.compute', tip: 'usage.compute.tip' },
  { key: 'ttft', label: 'usage.ttft', tip: 'usage.ttft.tip' },
];

/** 四根使用率條（記憶體、頻寬、算力、首字）：percent = min(100, round(share × 100))；比例最大的那根是瓶頸，標成紅色。 */
export function UsageBars({ share }: { share: Share }): JSX.Element {
  const tr = useT();
  const { token } = theme.useToken();
  // The first of the largest shares is the bottleneck (raw shares, before the 100 % clamp).
  const top = BARS.reduce((best, b, i) => (share[b.key] > share[BARS[best]!.key] ? i : best), 0);
  return (
    <div>
      {BARS.map((b, i) => {
        const percent = Math.min(100, Math.round(share[b.key] * 100));
        const hot = i === top;
        return (
          <Explain key={b.key} content={<div style={{ maxWidth: 280 }}>{tr(b.tip)}</div>}>
            <div
              data-testid="usage-bar"
              data-bar={b.key}
              data-percent={percent}
              tabIndex={0}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'help' }}
            >
              <Typography.Text
                type={hot ? 'danger' : 'secondary'}
                data-bottleneck={hot ? 'true' : undefined}
                style={{ width: 64, flex: 'none', fontSize: 12, fontWeight: hot ? 700 : 400 }}
              >
                {tr(b.label)}
              </Typography.Text>
              <Progress
                status="normal"
                percent={percent}
                size="small"
                strokeColor={hot ? token.colorError : undefined}
                format={(p) => `${p}%`}
                style={{ flex: 1, margin: 0 }}
              />
            </div>
          </Explain>
        );
      })}
    </div>
  );
}
