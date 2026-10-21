import { Progress, theme, Typography } from 'antd';
import type { JSX } from 'react';
import { useLang, useT } from '../i18n';
import { useTween } from '../motion/useTween';
import { Explain } from './Explain';

const fmt = (lang: string, n: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(n);

/**
 * 顯示 `同時 {users} / {max} 人`：目前人數佔這些機器在要求速度下可同時服務上限的比例；超過上限時紅色。
 * Both numbers roll to new values; antd animates the bar width.
 */
export function CapacityBar({ users, max }: { users: number; max: number }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const { token } = theme.useToken();
  const shownUsers = Math.round(useTween(users));
  const shownMax = Math.round(useTween(max));
  const over = users > max;
  const percent = max > 0 ? Math.min(100, (users / max) * 100) : 100;
  return (
    <Explain content={<div style={{ maxWidth: 280 }}>{tr('capacity.tip')}</div>}>
      <div data-testid="capacity" data-over={String(over)} tabIndex={0} style={{ cursor: 'help' }}>
        <Progress
          status="normal"
          percent={percent}
          showInfo={false}
          size="small"
          strokeColor={over ? token.colorError : token.colorPrimary}
          style={{ margin: 0 }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tr('capacity.text', { users: fmt(lang, shownUsers), max: fmt(lang, shownMax) })}
        </Typography.Text>
      </div>
    </Explain>
  );
}
