import { Progress, Typography } from 'antd';
import type { JSX, MouseEvent } from 'react';
import { useLang, useT } from '../i18n';
import { Explain } from './Explain';

const fmt = (lang: string, n: number) => new Intl.NumberFormat(lang).format(n);

/** 顯示 `同時 {users} / {max} 人`：目前人數佔這些機器在要求速度下可同時服務上限的比例。 */
export function CapacityBar({ users, max }: { users: number; max: number }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const percent = max > 0 ? Math.min(100, (users / max) * 100) : 100;
  // The bar sits inside a clickable row: its own tap only opens the explanation.
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <Explain content={<div style={{ maxWidth: 280 }}>{tr('capacity.tip')}</div>}>
      <div data-testid="capacity" tabIndex={0} onClick={stop} style={{ cursor: 'help' }}>
        <Progress status="normal" percent={percent} showInfo={false} size="small" style={{ margin: 0 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tr('capacity.text', { users: fmt(lang, users), max: fmt(lang, max) })}
        </Typography.Text>
      </div>
    </Explain>
  );
}
